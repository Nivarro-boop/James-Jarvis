/**
 * Ollama auf demselben Rechner — die Reserve, wenn Gemini nicht antwortet.
 *
 * Der Zweck ist bewusst eng gefasst. Ein lokales Achtmilliarden-Modell ist
 * kein Ersatz für Gemini: Websuche, Seitenabruf und Preisvergleich hängen am
 * googleSearch-Grounding, die Bildschirmarbeit am Bildeingang, die
 * Sprachschleife an nativem Audio über die Live API. Nichts davon kann ein
 * Modell liefern, das nur Text kann und keine Werkzeuge ans Netz hat.
 *
 * Was es kann, ist der Rest: übersetzen, verdichten, umformulieren. Genau da
 * springt es ein — und nur dann, wenn Gemini gerade nicht geht oder das
 * Kontingent leer ist. Es ist eine Reserve, kein zweiter Hauptweg, und es
 * meldet auch so: jede Antwort trägt das benutzte Modell mit, damit niemand
 * eine lokale Übersetzung für eine von Gemini hält.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import type { LocalModel, OllamaHealth } from '@shared/types'
import { getSettings } from '../store/settings'

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434'

/**
 * Wo Ollama unter Windows landet, wenn man es normal installiert.
 *
 * Gebraucht wird das für eine einzige Unterscheidung, die aber den ganzen
 * Unterschied macht: „nicht erreichbar" beantwortet die Frage nicht, ob man
 * Ollama installieren oder bloß starten muss. Das eine ist ein Download von
 * mehreren hundert Megabyte, das andere ein Doppelklick — und wer das nicht
 * weiß, probiert entweder das Falsche oder gar nichts.
 */
const OLLAMA_LOCATIONS = [
  join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'Ollama', 'ollama.exe'),
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Ollama', 'ollama.exe'),
  join(homedir(), '.ollama', 'ollama.exe')
]

/**
 * Liegt das Programm auf der Platte?
 *
 * Nur die üblichen Orte, kein Durchsuchen des PATH mit einem Unterprozess:
 * Die Antwort wird in den Einstellungen gebraucht, also während jemand
 * hinsieht, und ein `where ollama` kostet dort mehr Zeit als es wert ist.
 * Liegt es woanders, meldet die Adresse trotzdem „erreichbar", sobald der
 * Dienst läuft — dann ist diese Frage ohnehin beantwortet.
 */
export function ollamaInstalled(): boolean {
  return OLLAMA_LOCATIONS.some((path) => existsSync(path))
}

function ollamaExecutable(): string | null {
  return OLLAMA_LOCATIONS.find((path) => existsSync(path)) ?? null
}

/**
 * Wie lange die Erreichbarkeitsprüfung gilt.
 *
 * Ollama läuft entweder oder nicht; sich das für eine Minute zu merken spart
 * bei jedem Rückfall einen Netzaufruf, ohne dass ein zwischenzeitlich
 * gestarteter Dienst länger als eine Minute übersehen wird.
 */
const REACHABILITY_TTL_MS = 60_000

interface Reachability {
  reachable: boolean
  checkedAt: number
  baseUrl: string
}

let lastCheck: Reachability | null = null
let starting: Promise<boolean> | null = null

/**
 * Dieselbe Form, die auch die Oberfläche sieht.
 *
 * Sie steht in `@shared/types`, damit es sie genau einmal gibt — der
 * Hauptprozess füllt sie, das Einstellungsfenster liest sie, und ein neues
 * Feld fällt beim Übersetzen auf beiden Seiten auf statt nur auf einer.
 */
export type OllamaModel = LocalModel

function normalizeBaseUrl(raw: string | undefined): string {
  const value = (raw ?? '').trim() || DEFAULT_BASE_URL
  return value.replace(/\/+$/, '')
}

/**
 * Ein Aufruf mit Zeitschranke.
 *
 * Ohne die hängt der Rückfall bei einem Ollama, das zwar den Port offen hat
 * aber nicht antwortet, genauso lange wie die Aufgabe selbst gedauert hätte —
 * und die Reserve wäre schlimmer als gar keine.
 */
async function request(
  baseUrl: string,
  path: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  // Keep the deadline alive through response.json()/text(), not just until
  // headers arrive. A daemon can send headers and then stall loading a model.
  const deadline = AbortSignal.timeout(timeoutMs)
  return fetch(`${baseUrl}${path}`, { ...init,
    signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline })
}

/** Läuft dort etwas, das nach Ollama aussieht? */
export async function ollamaReachable(baseUrl?: string): Promise<boolean> {
  const url = normalizeBaseUrl(baseUrl)
  const now = Date.now()
  if (lastCheck && lastCheck.baseUrl === url && now - lastCheck.checkedAt < REACHABILITY_TTL_MS) {
    return lastCheck.reachable
  }
  let reachable = false
  try {
    const response = await request(url, '/api/tags', { method: 'GET' }, 2000)
    reachable = response.ok
  } catch {
    reachable = false
  }
  lastCheck = { reachable, checkedAt: now, baseUrl: url }
  return reachable
}

/**
 * Startet eine vorhandene lokale Ollama-Installation und wartet auf den Port.
 *
 * Das geschieht nur für Loopback-Adressen. Wer bewusst ein Ollama auf einem
 * anderen Rechner eingetragen hat, möchte nicht stattdessen unbemerkt den
 * lokalen Dienst benutzen. Der Prozess bleibt unabhängig von James laufen —
 * genauso wie beim Start über Ollamas Tray-Anwendung.
 */
export async function startOllama(baseUrl?: string): Promise<boolean> {
  const url = normalizeBaseUrl(baseUrl)
  let hostname: string
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname)) return false

  if (await ollamaReachable(url)) return true
  if (starting) return starting

  starting = (async () => {
    const executable = ollamaExecutable()
    if (!executable) return false

    try {
      const child = spawn(executable, ['serve'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
      // Ein fehlgeschlagener Windows-Start wird asynchron als `error`
      // gemeldet. Der Bereitschaftstest unten liefert dann einfach false;
      // ohne Zuhörer würde Node daraus eine unbehandelte Ausnahme machen.
      child.on('error', () => undefined)
      child.unref()
    } catch {
      return false
    }

    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300))
      try {
        const response = await request(url, '/api/tags', { method: 'GET' }, 1000)
        if (response.ok) {
          lastCheck = { reachable: true, checkedAt: Date.now(), baseUrl: url }
          return true
        }
      } catch {
        // Der Dienst lädt noch. Bis zur Frist weiterprobieren.
      }
    }
    lastCheck = { reachable: false, checkedAt: Date.now(), baseUrl: url }
    return false
  })().finally(() => {
    starting = null
  })

  return starting
}

/** Verwirft die gemerkte Erreichbarkeit — nach einem Wechsel der Adresse. */
export function forgetOllamaReachability(): void {
  lastCheck = null
  forgetOllamaCapabilities()
  // Auch die Modellwahl fürs Gedächtnis: Sie gehört zu einer Adresse. Wer auf
  // ein anderes Ollama umstellt, bekäme sonst weiter Vektoren von einem
  // Modell, das dort gar nicht liegt — und der Fehler fiele nur als
  // Gedächtnis auf, das plötzlich nichts mehr findet.
  forgetOllamaEmbedModel()
}

/**
 * Was ein Modell kann, steht nicht in der Liste.
 *
 * ── Der Fehler, den das behebt ──
 *
 * `/api/tags` liefert Name, Größe und Parameterzahl — und sonst nichts. Ein
 * Feld `capabilities` gibt es dort nicht; das steht ausschließlich in
 * `/api/show`. Vorher wurde es trotzdem von `/api/tags` gelesen, also war
 * `tools` bei *jedem* Modell falsch: In den Einstellungen stand nie „kann
 * Werkzeuge", und die Selbstwahl der Reserve suchte mit
 * `find((m) => m.tools)` nach etwas, das es in dieser Liste nie gab. Sie fiel
 * damit immer auf „das zuletzt geänderte" zurück — was bei Ollama das zuletzt
 * heruntergeladene ist, und das kann gut ein Einbettungsmodell sein, das
 * keinen einzigen Satz übersetzen kann.
 *
 * Ein Aufruf pro Modell klingt teuer und ist es nicht: `/api/show` liest nur
 * die Beschreibung von der Platte, lädt nichts in den Speicher, und die
 * Antwort wird gemerkt. Bei einem Dutzend Modellen sind das einmalig ein paar
 * hundert Millisekunden — und nur, wenn jemand die Einstellungen aufmacht.
 */
const capabilityCache = new Map<string, string[]>()

async function capabilities(baseUrl: string, model: string): Promise<string[]> {
  const key = `${baseUrl}::${model}`
  const known = capabilityCache.get(key)
  if (known) return known

  try {
    const response = await request(
      baseUrl,
      '/api/show',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model })
      },
      4000
    )
    if (!response.ok) return []
    const data = (await response.json()) as { capabilities?: string[] }
    const found = data.capabilities ?? []
    capabilityCache.set(key, found)
    return found
  } catch {
    // Ohne Auskunft bleibt das Modell in der Liste, nur ohne Merkmale. Es
    // wegzulassen wäre schlechter: Ein Ollama, das `/api/show` nicht kennt,
    // hätte dann gar keine Modelle.
    return []
  }
}

/**
 * Die Modelle, die auf diesem Rechner rechnen.
 *
 * ── Warum die Wolkenmodelle herausfallen ──
 *
 * Ollama führt seit einiger Zeit auch Modelle, die es gar nicht selbst
 * ausführt: `glm-5.2:cloud` und Verwandte tragen ein `remote_host` und werden
 * an ollama.com weitergereicht. In `/api/tags` stehen sie neben den echten,
 * und von außen sind sie nicht zu unterscheiden — dasselbe Format, dieselbe
 * Parameterzahl.
 *
 * Für diese Reserve sind sie das Gegenteil dessen, wofür es sie gibt. Sie
 * springt ein, wenn Gemini nicht antwortet — Kontingent leer, Leitung weg. Ein
 * Modell, das seinerseits übers Netz geht, ist in genau diesem Moment ebenso
 * still. Die Reserve wäre keine, und gemerkt hätte man es erst im Ernstfall.
 *
 * Dazu kommt, was der Nutzer erwartet: Die Einstellung heißt „Lokales Modell",
 * und die Auswahlliste ist die einzige Stelle, an der er sie sieht. Einen Satz
 * zum Übersetzen an ollama.com zu schicken, weil dort ein Eintrag stand, der
 * lokal aussah, ist nichts, wofür er sich entschieden hat.
 *
 * Es reicht auch nicht, sie bloß nicht zu bevorzugen: `sections.tsx` wählt ohne
 * eigene Angabe selbst eines aus, und `/api/tags` sortiert nach Änderungsdatum
 * — wer zuletzt ein Wolkenmodell geholt hat, bekäme genau das als „Reserve"
 * eingetragen.
 */
export async function listOllamaModels(baseUrl?: string): Promise<OllamaModel[]> {
  const url = normalizeBaseUrl(baseUrl)
  try {
    const response = await request(url, '/api/tags', { method: 'GET' }, 4000)
    if (!response.ok) return []
    const data = (await response.json()) as {
      models?: {
        name?: string
        details?: { parameter_size?: string }
        remote_host?: string
        remote_model?: string
      }[]
    }

    const local = (data.models ?? []).filter(
      (m) => Boolean(m.name) && !m.remote_host && !m.remote_model
    )

    return await Promise.all(
      local.map(async (m) => {
        const caps = await capabilities(url, m.name as string)
        return {
          name: m.name as string,
          parameterSize: m.details?.parameter_size,
          tools: caps.includes('tools'),
          // `completion` fehlt bei reinen Einbettungsmodellen — das ist das
          // sichere Unterscheidungsmerkmal. Am Namen zu erkennen versuchen
          // („enthält embed") ginge auch schief, sobald jemand sein Modell
          // anders benennt.
          embedding: caps.includes('embedding') && !caps.includes('completion')
        }
      })
    )
  } catch {
    return []
  }
}

/** Verwirft die gemerkten Fähigkeiten — nach einem Wechsel der Adresse. */
export function forgetOllamaCapabilities(): void {
  capabilityCache.clear()
}

/**
 * Wie lange das Modell nach einer Anfrage im Speicher bleibt.
 *
 * Ollamas Vorgabe sind fünf Minuten. Für eine Reserve ist das zu kurz: Sie
 * wird selten gebraucht, und wenn, dann soll sie antworten und nicht erst
 * neun Gigabyte von der Platte holen.
 */
const KEEP_ALIVE = '30m'

/**
 * Zeitschranke für eine Textaufgabe.
 *
 * Gemessen auf diesem Rechner: ein Achtmilliarden-Modell braucht kalt über
 * eine Minute, bis der erste Token kommt — das meiste davon ist Laden, nicht
 * Rechnen. Warm sind es Sekunden. Die Schranke muss den Kaltstart überstehen,
 * sonst versagt die Reserve genau beim ersten Mal, also in dem Moment, für
 * den es sie gibt. Zwei Minuten sind lang; ohne Antwort dazustehen ist
 * schlechter.
 */
const THINK_TIMEOUT_MS = 120_000

/**
 * Das Modell in den Speicher holen, ohne etwas zu erzeugen.
 *
 * Ollama lädt ein Modell auf eine Anfrage mit leerem Prompt und behält es
 * `keep_alive` lang. Aufgerufen wird das, wenn der Nutzer in den
 * Einstellungen nachsieht — dann ist die Reserve schon warm, bevor sie
 * gebraucht wird, und der Kaltstart fällt nicht in den Ernstfall.
 *
 * Fehler sind hier belanglos: Klappt es nicht, dauert der erste echte Aufruf
 * eben länger.
 */
export async function warmOllama(model: string, baseUrl?: string): Promise<void> {
  if (!model) return
  try {
    await request(
      normalizeBaseUrl(baseUrl),
      '/api/generate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: '', keep_alive: KEEP_ALIVE })
      },
      THINK_TIMEOUT_MS
    )
  } catch {
    // Aufwärmen ist eine Bequemlichkeit, kein Schritt, der gelingen muss.
  }
}

/**
 * Denkblöcke aus der Antwort schneiden.
 *
 * ── Warum das nötig ist ──
 *
 * Die verbreiteten kleinen Modelle sind inzwischen fast alle Denkmodelle:
 * qwen3, deepseek-r1, gpt-oss. Sie schreiben ihre Überlegung in die Antwort,
 * eingefasst in `<think>…</think>`, und erst danach kommt das Ergebnis. Neuere
 * Ollama-Fassungen trennen das in ein eigenes Feld `thinking`, ältere und
 * manche Modelle nicht.
 *
 * Ungeschnitten ist das Ergebnis unbrauchbar, und zwar auf die unauffällige
 * Art: Die Übersetzung eines Satzes kommt als drei Absätze Selbstgespräch mit
 * der Übersetzung am Ende zurück — und wird dann vorgelesen.
 *
 * `think: false` mitzuschicken wäre der direktere Weg und ist trotzdem falsch:
 * Ollama antwortet einem Modell ohne Denkfähigkeit darauf mit einem Fehler,
 * und dann wäre die Reserve für die Mehrheit der Modelle tot. Schneiden
 * funktioniert für beide.
 */
export function stripThinking(raw: string): string {
  let text = raw
  // Geschlossene Blöcke, auch mehrere. `[\s\S]` statt des s-Schalters, damit
  // es auch mit älteren Übersetzungszielen läuft.
  text = text.replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, '')
  /*
   * Ein offener Block ohne Ende bedeutet: Das Token-Budget war vor dem
   * Abschluss aufgebraucht. Dann ist alles ab dort Überlegung und nichts
   * davon Ergebnis — stehen zu lassen wäre schlechter als wegzulassen, denn
   * vorgelesen klingt es wie eine Antwort.
   */
  text = text.replace(/<(think|thinking)>[\s\S]*$/i, '')
  return text.trim()
}

/**
 * Eine einmalige Textaufgabe an das lokale Modell.
 *
 * `stream: false` sammelt die Antwort im Dienst und liefert sie in einem
 * Stück — für Übersetzen und Verdichten reicht das, und der Aufrufer muss
 * keinen Datenstrom auseinandernehmen.
 */
export async function ollamaThink(
  model: string,
  system: string,
  user: string,
  options: { baseUrl?: string; maxTokens?: number; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<string> {
  const url = normalizeBaseUrl(options.baseUrl)
  const response = await request(
    url,
    '/api/chat',
    {
      method: 'POST',
      signal: options.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: KEEP_ALIVE,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        options: { num_predict: options.maxTokens ?? 1200 }
      })
    },
    options.timeoutMs ?? THINK_TIMEOUT_MS
  )

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    /*
     * Ein 404 heißt hier nie „falsche Adresse" — die Erreichbarkeit wurde
     * vorher geprüft. Es heißt immer: Dieses Modell liegt nicht auf der
     * Platte. Das ist der häufigste Fehler überhaupt, weil ein Modellname in
     * den Einstellungen stehen bleibt, nachdem er gelöscht wurde, und
     * „Ollama antwortet mit 404" bringt niemanden auf `ollama pull`.
     */
    if (response.status === 404) {
      throw new Error(
        `Ollama kennt das Modell "${model}" nicht. Entweder ist es nicht heruntergeladen ` +
          `(ein "ollama pull ${model}" holt es), oder in den Einstellungen steht ein alter Name.`
      )
    }
    throw new Error(`Ollama antwortet mit ${response.status}: ${detail.slice(0, 200)}`)
  }

  const data = (await response.json()) as { message?: { content?: string } }
  return stripThinking(data.message?.content ?? '')
}


// ─────────────────────────────────────────────────────────────
// Vektoren fürs Gedächtnis
// ─────────────────────────────────────────────────────────────

/**
 * Ein Einbettungsmodell, das die meisten ohnehin schon haben.
 *
 * Die Reihenfolge ist nach Verbreitung sortiert, nicht nach Qualität: Gesucht
 * wird nicht das beste Modell, sondern eines, das da ist. Wer keines davon
 * hat, bekommt weiter Geminis Vektoren — das ist der Normalfall und kein
 * Mangel.
 */
const EMBED_MODELS = ['nomic-embed-text', 'mxbai-embed-large', 'all-minilm', 'bge-m3']

let chosenEmbedModel: string | null | undefined

/**
 * Welches Modell hier Vektoren erzeugt — oder `null`, wenn keines da ist.
 *
 * Die Antwort wird gemerkt, auch das `null`: Ein Ollama ohne
 * Einbettungsmodell bekommt sonst bei jedem einzelnen Merksatz eine
 * Modellliste abgefragt, und das Gedächtnis schreibt bei jedem Gespräch mit.
 */
async function embedModel(baseUrl?: string): Promise<string | null> {
  if (chosenEmbedModel !== undefined) return chosenEmbedModel

  const models = await listOllamaModels(baseUrl)
  const embedders = models.filter((m) => m.embedding)

  // Erst die bekannten Namen der Reihe nach, dann irgendein Einbettungsmodell.
  // Der Namensvergleich ohne Marke, weil sie fast immer `:latest` heißen.
  const preferred = EMBED_MODELS.map((wanted) =>
    embedders.find((m) => m.name.split(':')[0] === wanted)
  ).find(Boolean)

  chosenEmbedModel = (preferred ?? embedders[0])?.name ?? null
  return chosenEmbedModel
}

/** Verwirft die gemerkte Modellwahl — nach einem Wechsel der Adresse. */
export function forgetOllamaEmbedModel(): void {
  chosenEmbedModel = undefined
}

/**
 * Vektoren auf diesem Rechner.
 *
 * Das schließt die letzte Lücke, in der das Gedächtnis noch zwingend ans Netz
 * musste. Vorher gab es zwei Wege: Gemini, oder `@xenova/transformers` — ein
 * optionales Paket, das mitsamt onnxruntime rund zweihundert Megabyte in
 * node_modules zieht und deshalb bei kaum jemandem installiert ist. Wer Ollama
 * ohnehin laufen hat, hat damit einen dritten, der nichts kostet und nichts
 * zusätzlich installiert.
 *
 * `null` heißt: geht hier nicht. Kein Fehler — der Aufrufer hat andere Wege,
 * und am Ende immer noch die Wortsuche.
 */
export async function ollamaEmbed(text: string, baseUrl?: string): Promise<number[] | null> {
  const url = normalizeBaseUrl(baseUrl)
  if (!(await ollamaReachable(url))) return null

  const model = await embedModel(url)
  if (!model) return null

  try {
    const response = await request(
      url,
      '/api/embed',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: text, keep_alive: KEEP_ALIVE })
      },
      // Kurz: Ein Merksatz ist ein paar Dutzend Token, und das läuft auch auf
      // schwacher Hardware in Sekundenbruchteilen. Hängt es länger, ist etwas
      // anderes kaputt, und dann soll das Gedächtnis nicht das Gespräch
      // aufhalten.
      15_000
    )
    if (!response.ok) {
      // Das Modell ist verschwunden oder taugt doch nicht — beim nächsten Mal
      // neu suchen, statt dauerhaft auf einem toten Namen zu beharren.
      chosenEmbedModel = undefined
      return null
    }

    const data = (await response.json()) as { embeddings?: number[][] }
    const values = data.embeddings?.[0]
    return values && values.length > 0 ? values : null
  } catch {
    return null
  }
}

/**
 * Läuft es, ist das eingestellte Modell da, und kann es genug?
 *
 * Der Unterschied zwischen „Ollama läuft nicht" und „das Modell ist nicht
 * geholt" ist der zwischen zwei ganz verschiedenen nächsten Schritten. Wer ihn
 * verwischt, schickt den Nutzer in die falsche Richtung.
 *
 * Gefragt wird nach dem Modell aus `settings.ollama` — dem Kopf, der die
 * Sprachschleife bedient. Die Reserve weiter oben in dieser Datei hat ihr
 * eigenes Feld und ihre eigene Frage; beide sprechen mit demselben Dienst,
 * meinen aber nicht dasselbe Modell.
 *
 * Drei Fragen und nicht eine, weil jede zu einem anderen nächsten Schritt
 * führt: den Dienst starten, ein Modell holen, ein anderes Modell wählen. Die
 * dritte fehlte anfangs ganz, und sie fiel beim ersten Testlauf auf: gemma
 * stand ordentlich in der Liste, die Anzeige war grün, und die erste Frage
 * endete trotzdem mit "does not support tools".
 */
export async function ollamaHealth(): Promise<OllamaHealth> {
  const settings = getSettings().ollama
  const baseUrl = normalizeBaseUrl(settings?.baseUrl)
  const models = await listOllamaModels(baseUrl)

  if (models.length === 0) {
    return { ok: false, tools: false, detail: `unter ${baseUrl} antwortet nichts`, models }
  }

  const wanted = settings?.model?.trim() ?? ''
  if (!wanted) {
    const usable = models.filter((m) => m.tools).length
    return {
      ok: false,
      tools: false,
      detail:
        `läuft, ${models.length} ${models.length === 1 ? 'Modell' : 'Modelle'} — noch keines gewählt` +
        (usable === 0 ? '. Keines davon kann Werkzeuge.' : `, ${usable} davon mit Werkzeugen`),
      models
    }
  }

  const found = models.find((m) => m.name === wanted || m.name.split(':')[0] === wanted)
  if (!found) {
    return { ok: false, tools: false, detail: `läuft, kennt aber ${wanted} nicht`, models }
  }

  return {
    ok: true,
    tools: found.tools,
    detail: found.tools
      ? `läuft mit ${wanted}`
      : `läuft mit ${wanted} — Werkzeuge laufen über den langsameren JSON-Kompatibilitätsmodus.`,
    models
  }
}
