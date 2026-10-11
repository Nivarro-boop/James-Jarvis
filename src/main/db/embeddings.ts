import { geminiAvailable, geminiClient } from '../providers/gemini'
import { ollamaEmbed } from '../providers/ollama'
import { getSettings } from '../store/settings'

/**
 * Vektoren für das Langzeitgedächtnis.
 *
 * Drei Wege, in dieser Reihenfolge:
 *
 * 1. **Gemini**, weil der Schlüssel ohnehin da ist: ein Aufruf mit wenigen
 *    Dutzend Token, ein paar Millisekunden, nichts zu installieren.
 * 2. **Ollama**, falls es läuft und ein Einbettungsmodell darin liegt. Das
 *    schließt die Lücke, in der das Gedächtnis zwingend ans Netz musste: Wer
 *    Ollama ohnehin hat, merkt vom Ausfall der Leitung nichts mehr.
 * 3. **transformers.js** mit all-MiniLM-L6-v2. Bleibt als letzter Rückfall
 *    drin, ist aber nur noch optional: Das Paket zieht mitsamt onnxruntime
 *    rund zweihundert Megabyte in node_modules — für eine Funktion, die die
 *    beiden Wege davor genauso erfüllen.
 *
 * Schlägt alles fehl, fällt das Gedächtnis auf reine Wortsuche zurück —
 * schlechter, aber es bleibt benutzbar.
 *
 * ── Warum die Länge nichts ausmacht ──
 *
 * Die drei Wege liefern verschieden lange Vektoren: 768 bei Gemini, 768 bei
 * nomic-embed-text, 384 bei all-MiniLM. Vergleichen lassen sich nur gleich
 * lange, und `cosine` gibt für ungleiche 0 zurück. Ein Wechsel der Quelle
 * macht damit alte Einträge nicht kaputt — sie fallen still auf die
 * Wortsuche zurück, statt falsche Treffer zu erzeugen.
 */

/** 768 statt der vollen Breite: kleinere Blobs, praktisch gleiche Trefferqualität. */
const GEMINI_MODEL = 'gemini-embedding-001'
const DIMENSIONS = 768

type FeatureExtractor = (
  text: string,
  opts: { pooling: 'mean'; normalize: boolean }
) => Promise<{ data: Float32Array }>

let extractor: FeatureExtractor | null = null
let localLoading: Promise<FeatureExtractor | null> | null = null
let localUnavailable = false
let remoteUnavailable = false

/** Kosinus-Ähnlichkeit setzt normalisierte Vektoren voraus. */
function normalize(values: number[]): Float32Array {
  let sum = 0
  for (const v of values) sum += v * v
  const length = Math.sqrt(sum) || 1
  const out = new Float32Array(values.length)
  for (let i = 0; i < values.length; i++) out[i] = values[i] / length
  return out
}

async function embedRemote(text: string): Promise<Float32Array | null> {
  if (remoteUnavailable || !geminiAvailable()) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = geminiClient() as any
    const response = await client.models.embedContent({
      model: GEMINI_MODEL,
      contents: text,
      config: { outputDimensionality: DIMENSIONS }
    })
    const values: number[] | undefined =
      response?.embeddings?.[0]?.values ?? response?.embedding?.values
    if (!values || values.length === 0) return null
    return normalize(values)
  } catch (err) {
    // Einmal merken und nicht bei jedem Merksatz erneut ins Messer laufen.
    console.error('[embeddings] Gemini nicht nutzbar, versuche lokal:', err)
    remoteUnavailable = true
    return null
  }
}

async function getLocal(): Promise<FeatureExtractor | null> {
  if (extractor) return extractor
  if (localUnavailable) return null
  if (localLoading) return localLoading

  localLoading = (async () => {
    try {
      // Der Name steht bewusst in einer Variablen: das Paket ist optional und
      // in der Regel gar nicht installiert. Ein direkter Import-Ausdruck würde
      // sowohl den Typprüfer als auch den Bundler dazu bringen, es fest
      // einzubinden — und dann bricht der Build ohne das Paket.
      const moduleName = '@xenova/transformers'
      const { pipeline, env } = (await import(/* @vite-ignore */ moduleName)) as {
        pipeline: (task: string, model: string) => Promise<unknown>
        env: { allowLocalModels: boolean }
      }
      // Nur lokale bzw. gecachte Modelle; kein Telemetrie-Ping.
      env.allowLocalModels = true
      const pipe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
      extractor = pipe as unknown as FeatureExtractor
      return extractor
    } catch (err) {
      console.info('[embeddings] kein lokales Modell, nutze Wortsuche:', String(err).slice(0, 140))
      localUnavailable = true
      return null
    } finally {
      localLoading = null
    }
  })()

  return localLoading
}

/**
 * Vektoren über ein Ollama-Modell auf diesem Rechner.
 *
 * Ollama normalisiert nicht von sich aus — `cosine` setzt das aber voraus,
 * sonst wären die Ähnlichkeiten nicht auf −1 bis 1 begrenzt und die Schwelle
 * im Gedächtnis bedeutete für jede Quelle etwas anderes.
 */
async function embedOllama(text: string): Promise<Float32Array | null> {
  const values = await ollamaEmbed(text, getSettings().localFallback.baseUrl)
  return values ? normalize(values) : null
}

export async function embed(text: string): Promise<Float32Array | null> {
  const remote = await embedRemote(text)
  if (remote) return remote

  const local = await embedOllama(text)
  if (local) return local

  const pipe = await getLocal()
  if (!pipe) return null
  const out = await pipe(text, { pooling: 'mean', normalize: true })
  return new Float32Array(out.data)
}

/** Beide Vektoren sind normalisiert, das Skalarprodukt ist also die Kosinus-Ähnlichkeit. */
export function cosine(a: Float32Array, b: Float32Array): number {
  // Unterschiedliche Länge heißt: aus einer anderen Modellgeneration. Solche
  // Alteinträge fallen still durch die Textsuche, statt Unsinn zu treffen.
  if (a.length !== b.length) return 0
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
}

export function embeddingsAvailable(): boolean {
  return !remoteUnavailable || !localUnavailable
}
