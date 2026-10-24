import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { extractSources, friendlyGeminiError, geminiClient } from '../../providers/gemini'
import { reserveBudget } from '../../agent/budget'
import { getSettings } from '../../store/settings'
import { getResearch, listResearch, upsertResearch } from '../../db'
import { broadcast, sendToSettings } from '../../ipc/emit'
import type { ResearchRun } from '@shared/types'

/**
 * Tiefe Recherche über den Deep-Research-Agenten.
 *
 * Läufe dauern typischerweise fünf bis zwanzig Minuten. Blockierend wäre das
 * in einer Sprachanwendung untragbar — der Nutzer säße minutenlang vor einem
 * stummen Kristall. Deshalb läuft es im Hintergrund: das Werkzeug kehrt sofort
 * zurück, der Kristall zeigt den Recherche-Ring, und wenn der Bericht da ist,
 * meldet James sich von selbst.
 */

/** Grobe Erfahrungswerte aus der Google-Dokumentation, für die Kostenanzeige. */
const COST_ESTIMATE_USD = {
  'deep-research-preview-04-2026': 2.0,
  'deep-research-max-preview-04-2026': 5.0
} as const

const active = new Map<string, AbortController>()

const deepResearch = defineTool({
  name: 'deep_research',
  group: 'research',
  description:
    'Startet eine gründliche Recherche mit vielen Suchen und Quellenauswertung. ' +
    'Dauert mehrere Minuten und läuft im Hintergrund — du kannst normal weiterreden. ' +
    'Nutze das für alles, was eine echte Ausarbeitung braucht: Kaufberatung, Vergleiche, ' +
    'Hintergründe, Marktübersichten. Für eine schnelle Faktenfrage nimm web_search.',
  schema: z.object({
    query: z.string().describe('Die Rechercheaufgabe, so konkret wie möglich formuliert.'),
    depth: z
      .enum(['normal', 'maximal'])
      .optional()
      .describe(
        'normal dauert etwa zehn Minuten, maximal deutlich länger und kostet spürbar mehr. Standard ist normal.'
      )
  }),
  spokenHint: 'Mhm.',
  async execute({ query, depth }, ctx) {
    const settings = getSettings()
    const agent =
      depth === 'maximal' ? 'deep-research-max-preview-04-2026' : settings.researchAgent

    // Vor dem Start prüfen, nicht danach. Ein Lauf kostet je nach Tiefe zwei
    // bis sieben Dollar, und er lässt sich nicht zurücknehmen, sobald er läuft.
    ctx.signal.throwIfAborted()
    geminiClient() // Do not reserve money when no credential is configured.
    reserveBudget(COST_ESTIMATE_USD[agent] ?? 2.0, 'research', `Schätzung beim Start: ${query.slice(0, 120)}`)

    const localId = randomUUID()
    const run: ResearchRun = {
      id: localId,
      query,
      status: 'in_progress',
      agent,
      startedAt: Date.now(),
      finishedAt: null,
      lastThought: null,
      report: null,
      sources: null
    }
    upsertResearch(run)

    const abort = new AbortController()
    active.set(localId, abort)

    // Der Not-Aus bricht auch eine laufende Recherche ab. Der Horcher wird
    // wieder abgemeldet, wenn der Lauf durch ist: das Abbruchsignal lebt so
    // lange wie die App, und ein Horcher pro Recherche bliebe sonst für immer
    // daran hängen.
    const onKill = (): void => abort.abort()
    ctx.signal.addEventListener('abort', onKill, { once: true })

    // Bewusst nicht awaited: der Aufruf soll sofort zurückkehren.
    void runInBackground(run, abort.signal).finally(() =>
      ctx.signal.removeEventListener('abort', onKill)
    )

    return {
      started: true,
      id: localId,
      note:
        'Die Recherche läuft jetzt im Hintergrund. Sag dem Nutzer kurz, dass du dich meldest, ' +
        'sobald du fertig bist, und rede dann normal weiter. Frag nicht nach.'
    }
  }
}) as ToolDefinition

async function runInBackground(run: ResearchRun, signal: AbortSignal): Promise<void> {
  let remoteId: string | undefined
  let cancelRequested = false
  const cancelRemote = (): void => {
    if (!remoteId || cancelRequested) return
    cancelRequested = true
    const id = remoteId
    void Promise.resolve().then(() => geminiClient().interactions.cancel(id, undefined, { timeout: 15_000, maxRetries: 0 }))
      .catch((error) => console.warn('[research] Anbieter-Stornierung nicht bestätigt:', error))
  }
  signal.addEventListener('abort', cancelRemote, { once: true })
  try {
    const client = geminiClient()
    signal.throwIfAborted()
    // Die Interactions-API erwartet snake_case — anders als der Rest des SDK.
    const stream = await client.interactions.create({
      input: run.query,
      agent: run.agent,
      background: true,
      stream: true,
      agent_config: {
        type: 'deep-research',
        // Liefert Zwischenschritte, damit James auf Nachfrage sagen kann,
        // woran er gerade ist.
        thinking_summaries: 'auto'
      }
    }, { fetchOptions: { signal }, maxRetries: 0 })

    let report = ''
    const sources = new Set<string>()

    for await (const event of stream) {
      signal.throwIfAborted()

      // Die Ereignistypen sind eine Union; wir greifen nur auf die zwei
      // Formen zu, die uns interessieren, und zwar defensiv.
      const raw = event as Record<string, any>
      const id = raw.interaction?.id ?? raw.interaction_id
      if (typeof id === 'string') remoteId = id
      const delta = raw.delta ?? raw
      const kind = delta?.type ?? raw?.type

      if (kind === 'thought' || delta?.thought) {
        const thought = String(delta.thought ?? delta.text ?? '').slice(0, 400)
        if (thought) {
          run.lastThought = thought
          upsertResearch(run)
          /*
            An das Einstellungsfenster, nicht an die Kugel.

            Bisher ging der Gedanke an die Kugel, und dort hörte ihn niemand —
            die Startseite hat keinen Platz für Text, das ist ihr ganzer
            Entwurf. Gehört wird er in der Liste unter Recherchen, wo bis eben
            nur "läuft" stand und sich eine Viertelstunde lang nichts rührte.
          */
          sendToSettings('research:progress', { id: run.id, thought })
        }
      } else if (kind === 'text' && typeof delta.text === 'string') {
        report += delta.text
      }

      for (const url of extractSources(event)) sources.add(url)
    }

    if (signal.aborted) {
      run.status = 'failed'
      run.finishedAt = Date.now()
      upsertResearch(run)
      return
    }

    run.status = 'completed'
    run.finishedAt = Date.now()
    run.report = report.trim() || 'Die Recherche hat kein verwertbares Ergebnis geliefert.'
    run.sources = [...sources].slice(0, 40)
    upsertResearch(run)

    // Für die Sprachausgabe reicht der Anfang — der vollständige Bericht
    // steht im Einstellungsfenster.
    broadcast('research:done', {
      id: run.id,
      summary: run.report.slice(0, 2500)
    })
  } catch (err) {
    run.status = 'failed'
    run.finishedAt = Date.now()
    run.report = signal.aborted ? 'Vom Nutzer abgebrochen. Bereits angefallene Anbieter-Kosten können bestehen bleiben.' : friendlyGeminiError(err)
    upsertResearch(run)
    if (!signal.aborted) broadcast('research:done', {
      id: run.id,
      summary: `Die Recherche ist fehlgeschlagen: ${run.report}`
    })
  } finally {
    if (signal.aborted) cancelRemote()
    signal.removeEventListener('abort', cancelRemote)
    active.delete(run.id)
  }
}

const researchStatus = defineTool({
  name: 'research_status',
  group: 'research',
  description:
    'Sagt, wie weit eine laufende Recherche ist, oder gibt das Ergebnis einer abgeschlossenen zurück. ' +
    'Nutze das, wenn der Nutzer nachfragt, wie weit du bist.',
  schema: z.object({
    id: z.string().optional().describe('Kennung der Recherche. Ohne Angabe die zuletzt gestartete.')
  }),
  async execute({ id }) {
    const run = id ? getResearch(id) : listResearch(1)[0]
    if (!run) return { found: false, note: 'Es läuft gerade keine Recherche.' }

    if (run.status === 'in_progress') {
      const minutes = Math.round((Date.now() - run.startedAt) / 60000)
      return {
        status: 'läuft',
        seit: `${minutes} Minuten`,
        aktuellerSchritt: run.lastThought ?? 'Noch keine Zwischenmeldung.'
      }
    }

    return {
      status: run.status === 'completed' ? 'fertig' : 'fehlgeschlagen',
      bericht: run.report?.slice(0, 4000),
      quellenAnzahl: run.sources?.length ?? 0
    }
  }
}) as ToolDefinition

export const researchTools: ToolDefinition[] = [deepResearch, researchStatus]
