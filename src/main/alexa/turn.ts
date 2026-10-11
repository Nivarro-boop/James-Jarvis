import { randomUUID } from 'node:crypto'
import { friendlyGeminiError, geminiAvailable, generateWithFallback } from '../providers/gemini'
import { getSettings } from '../store/settings'
import { buildSystemPrompt } from '../agent/prompt'
import { runTool } from '../tools/runner'
import { alexaToolDeclarations, alexaToolNames } from './tools'
import { modelTurn } from '../providers/geminiTurn'
import { capabilityGaps, withGapUserText } from '../agent/capabilityGaps'

/**
 * Ein Gesprächszug über den Echo — Text hinein, Text heraus.
 *
 * Das ist der erste Agentenlauf im Hauptprozess, der nicht an der Live-API
 * hängt. Am Rechner sitzt die Werkzeugschleife im Renderer und arbeitet auf
 * Audio; am Telefon ebenso. Über Alexa gibt es beides nicht: Amazon hat schon
 * transkribiert, will eine Zeichenkette zurück und spricht sie selbst aus.
 *
 * ── Die acht Sekunden ──
 *
 * Alles hier dreht sich um eine einzige Zahl. Alexa bricht ab, wenn die
 * Antwort nicht in ungefähr acht Sekunden steht, und der Nutzer hört dann
 * „James antwortet gerade nicht" — die schlechteste aller Rückmeldungen, weil
 * sie nicht sagt, ob etwas passiert ist.
 *
 * Deshalb ist der Lauf hart gedeckelt, und der Deckel ist eine Antwort und
 * kein Abbruch: Läuft die Zeit ab, sagt James, dass es länger dauert, und
 * arbeitet am Rechner weiter. Das Ergebnis kommt dann dort aus dem Kristall.
 * Ein halber Satz mehr ist besser als Stille — und ehrlicher als so zu tun,
 * als wäre die Frage erledigt.
 */

/**
 * Wie lange der ganze Zug dauern darf.
 *
 * Sechs Sekunden, nicht acht: Amazons Grenze gilt für die Antwort auf der
 * Leitung, und dazwischen liegen noch der Tunnel und die Signaturprüfung. Wer
 * die Grenze ausreizt, verliert genau die Anfragen, bei denen es knapp war.
 */
const BUDGET_MS = 6000

/**
 * Wie lange ein einzelnes Werkzeug laufen darf.
 *
 * Kürzer als das Gesamtbudget, damit nach einem langsamen Werkzeug noch Zeit
 * bleibt, aus dem Ergebnis einen Satz zu machen.
 */
const TOOL_TIMEOUT_MS = 3500

/** Wie viele Werkzeugrunden höchstens. Mehr passt in die Zeit ohnehin nicht. */
const MAX_ROUNDS = 3

export interface TurnResult {
  text: string
  /** Ob das Zeitbudget abgelaufen ist und am Rechner weitergearbeitet wird. */
  overran: boolean
}

/**
 * Was über Alexa anders gilt als am Rechner.
 *
 * Kommt zum gewöhnlichen Systemprompt dazu statt ihn zu ersetzen: Ton,
 * Haltung und die Regeln zum Vorlesen sollen dieselben sein — es ist derselbe
 * Assistent, nur ein anderer Lautsprecher.
 */
function alexaAddendum(): string {
  const tools = alexaToolNames()
  return [
    '',
    '## Gerade sprichst du über einen Echo',
    '',
    'Deine Antwort wird von Alexa vorgelesen. Das ändert drei Dinge:',
    '',
    '- Fass dich kürzer als sonst. Ein bis zwei Sätze. Es gibt keinen Bildschirm,',
    '  auf dem jemand nachlesen könnte, und keine Möglichkeit zurückzuspulen.',
    '- Du kannst nicht zwischendurch reden. Am Rechner sagst du „einen Moment"',
    '  und arbeitest weiter; hier gibt es genau eine Antwort. Sag also nichts an,',
    '  was du erst danach tust.',
    '- Es hört jeder mit, der im Raum steht. Lies nichts vor, was du einem',
    '  Besucher nicht sagen würdest — bei Terminen reicht, dass einer ist, wenn',
    '  du den Titel für heikel hältst.',
    '',
    tools.length > 0
      ? `Verfügbar sind hier nur diese Werkzeuge: ${tools.join(', ')}. Alles andere gibt es über Alexa nicht — sag das in einem halben Satz und biete an, es am Rechner zu machen.`
      : 'Werkzeuge stehen hier gerade keine bereit. Antworte aus dem, was du weißt, und sag dazu, dass du dafür an den Rechner müsstest.',
    ''
  ].join('\n')
}

interface Part {
  text?: string
  functionCall?: { name?: string; args?: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
}

interface Content {
  role: 'user' | 'model'
  parts: Part[]
}

/**
 * Ein Werkzeug mit eigener Frist ausführen.
 *
 * `runTool` hat keine, und das ist am Rechner richtig — dort dreht sich der
 * Kristall und man sieht, dass etwas passiert. Hier zählt jede Sekunde gegen
 * Amazons Deckel, also bekommt das Modell nach der Frist einen Fehler, den es
 * vorlesen kann, statt weiter zu warten.
 */
async function callWithTimeout(name: string, args: Record<string, unknown>): Promise<unknown> {
  // Wie am Telefon: Nur was deklariert wurde, darf laufen. Ein Name aus dem
  // Prompttext — oder tool_use, das jedes Werkzeug erreicht — bekommt eine Absage.
  if (!alexaToolNames().includes(name)) {
    return { error: `${name} gibt es über Alexa nicht. Biete an, es am Rechner zu erledigen.` }
  }
  const result = await Promise.race([
    runTool({ id: randomUUID(), name, args }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), TOOL_TIMEOUT_MS))
  ])

  if (result === null) {
    return { fehler: `${name} hat zu lange gebraucht. Sag, dass das über Alexa nicht geht.` }
  }
  return result.ok ? (result.result ?? { erledigt: true }) : { fehler: result.error }
}

/**
 * Eine Frage beantworten.
 *
 * Wirft nicht. Alles, was schiefgehen kann, wird zu einem Satz, den Alexa
 * vorlesen kann — eine Skill, die einen Fehler zurückgibt, sagt beim Nutzer
 * „James antwortet gerade nicht", und das ist keine Auskunft.
 */
export async function runAlexaTurn(question: string): Promise<TurnResult> {
  if (!geminiAvailable()) {
    return {
      text: 'Am Rechner ist gerade kein Zugang zu Gemini hinterlegt. Ohne den kann ich nichts beantworten.',
      overran: false
    }
  }

  const deadline = Date.now() + BUDGET_MS
  const settings = getSettings()
  const system = `${buildSystemPrompt({ lazyTools: false })}\n${alexaAddendum()}`
  const tools = alexaToolDeclarations()

  const contents: Content[] = [{ role: 'user', parts: [{ text: question }] }]

  try {
    for (let round = 0; round <= MAX_ROUNDS; round++) {
      const response = await generateWithFallback({
        model: settings.brainModel,
        contents: contents as never,
        config: {
          systemInstruction: system,
          ...(tools.length > 0 ? { tools: tools as never } : {})
        }
      })

      const calls = response.functionCalls ?? []

      if (calls.length === 0) {
        const text = response.text?.trim()
        // Lehnt James ab, ist das eine Fähigkeitslücke. Der Sammler prüft das
        // selbst und wirft nie; ohne Zustimmung tut er nichts.
        if (text) capabilityGaps()?.answer({ request: question, answer: text, channel: 'alexa' })
        return {
          text: text || 'Dazu fällt mir gerade nichts ein.',
          overran: false
        }
      }

      /*
       * Keine Zeit mehr für eine weitere Runde.
       *
       * Das Modell will noch etwas nachschlagen, aber danach bliebe keine Zeit,
       * daraus einen Satz zu machen. Statt in Amazons Zeitüberschreitung zu
       * laufen wird hier abgebrochen — mit einer Antwort, nicht mit Stille.
       */
      if (Date.now() > deadline) {
        return {
          text: 'Das dauert länger, als Alexa mir zugesteht. Ich mache am Rechner weiter und melde mich dort.',
          overran: true
        }
      }

      contents.push(
        modelTurn(
          response,
          calls.map((call) => ({
            functionCall: { name: call.name, args: call.args as Record<string, unknown> }
          }))
        )
      )

      const results = await Promise.all(
        calls.map(async (call) => ({
          functionResponse: {
            name: call.name ?? 'unbekannt',
            response: {
              // Mit der Frage: Ein Werkzeugfehler landet so beim selben
              // Lückenbericht wie die Absage, statt ohne Anfrage daneben.
              result: await withGapUserText(question, () => callWithTimeout(
                call.name ?? '',
                (call.args ?? {}) as Record<string, unknown>
              ))
            }
          }
        }))
      )

      contents.push({ role: 'user', parts: results as Part[] })
    }

    // Alle Runden aufgebraucht und das Modell will immer noch Werkzeuge.
    return {
      text: 'Da komme ich über Alexa nicht weiter. Frag mich das nochmal am Rechner.',
      overran: true
    }
  } catch (err) {
    console.error('[alexa] Gesprächszug fehlgeschlagen:', err)
    return { text: friendlyGeminiError(err).slice(0, 300), overran: false }
  }
}
