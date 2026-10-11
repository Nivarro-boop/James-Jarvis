// Nur als Typ. Die Bibliothek selbst wird unten per `import()` nachgeladen —
// sie kostet beim Laden 184 Millisekunden, und zwar bisher bei jedem Start,
// obwohl OpenRouter ein Zusatzzugang ist, den die meisten nie hinterlegen.
// Wer ihn hat, wartet die 184 ms einmalig beim ersten Übersetzen ab.
import type OpenAI from 'openai'
import { getSecret } from '../secrets/keystore'

/**
 * OpenRouter für alles, was nicht in Echtzeit laufen muss.
 *
 * Die Sprachschleife bleibt bei Gemini — dort ist natives Audio ohne Umweg
 * über Transkription der entscheidende Vorteil. OpenRouter kommt dort zum
 * Zug, wo Modellvielfalt mehr wert ist als Latenz: Hintergrundüberlegungen,
 * Verdichten langer Recherchen, günstige Massenaufgaben. Dazu die
 * Spracherkennung als Rückfallebene, falls Gemini gerade nicht erreichbar ist.
 */

const BASE_URL = 'https://openrouter.ai/api/v1'

let client: OpenAI | null = null
let clientKey: string | null = null

export function openRouterAvailable(): boolean {
  return getSecret('openrouter') !== null
}

export async function openRouterClient(): Promise<OpenAI> {
  const apiKey = getSecret('openrouter')
  if (!apiKey) {
    throw new Error('Es ist kein OpenRouter Zugang hinterlegt.')
  }
  if (!client || clientKey !== apiKey) {
    const { default: OpenAI } = await import('openai')
    client = new OpenAI({
      apiKey,
      baseURL: BASE_URL,
      timeout: 60_000,
      maxRetries: 0,
      defaultHeaders: {
        // OpenRouter nutzt das für seine Nutzungsstatistik; ohne die Angaben
        // landet man in der Rangliste unter "unbekannt".
        'HTTP-Referer': 'https://github.com/void/jarvis',
        'X-Title': 'James-Jarvis'
      }
    })
    clientKey = apiKey
  }
  return client
}

/** Einmalige Textaufgabe an ein beliebiges OpenRouter-Modell. */
export async function think(
  model: string,
  system: string,
  user: string,
  maxTokens = 1200,
  signal?: AbortSignal
): Promise<string> {
  const openai = await openRouterClient()
  const response = await openai.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  }, { signal })
  return response.choices[0]?.message?.content ?? ''
}

/**
 * Spracherkennung als Rückfallebene.
 *
 * Wird im Normalbetrieb nicht gebraucht — die Live API transkribiert selbst.
 * Nützlich, wenn ein Sprachschnipsel nachträglich ausgewertet werden soll
 * oder Gemini gerade nicht erreichbar ist.
 */
export async function transcribe(
  wavBuffer: Buffer,
  model = 'openai/gpt-4o-mini-transcribe',
  signal?: AbortSignal
): Promise<string> {
  const apiKey = getSecret('openrouter')
  if (!apiKey) throw new Error('Es ist kein OpenRouter Zugang hinterlegt.')

  const form = new FormData()
  // Über Uint8Array statt direkt über Buffer: Node-Buffer kann auf einem
  // SharedArrayBuffer sitzen, und den akzeptiert die Blob-Signatur nicht.
  //
  // Der Ausschnitt muss dabei über byteOffset und byteLength laufen. Node legt
  // Buffer unter 8 Kilobyte in einen gemeinsamen Pool, `buffer` ist dann der
  // ganze Pool — wer den kopiert, schickt fremde Daten mit und die Erkennung
  // bekommt Müll statt einer WAV-Datei.
  const bytes = new Uint8Array(
    wavBuffer.buffer.slice(
      wavBuffer.byteOffset,
      wavBuffer.byteOffset + wavBuffer.byteLength
    ) as ArrayBuffer
  )
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', model)

  const res = await fetch(`${BASE_URL}/audio/transcriptions`, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  })

  if (!res.ok) {
    throw new Error(`Die Spracherkennung ist fehlgeschlagen (${res.status}).`)
  }

  const data = (await res.json()) as { text?: string }
  return data.text ?? ''
}

/** Verfügbare Modelle für die Auswahl in den Einstellungen. */
export async function listModels(): Promise<{ id: string; name: string; context: number }[]> {
  const res = await fetch(`${BASE_URL}/models`, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) return []
  const data = (await res.json()) as {
    data: { id: string; name: string; context_length: number }[]
  }
  return data.data
    .map((m) => ({ id: m.id, name: m.name, context: m.context_length }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
