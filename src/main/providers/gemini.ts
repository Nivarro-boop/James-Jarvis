import { GoogleGenAI } from '@google/genai'
import { GEMINI_FALLBACK_MODELS } from '@shared/config/defaults'
import { isQuotaError, quotaBackoffUntil, withModelFallback } from '@shared/geminiQuota'
import { getSecret } from '../secrets/keystore'
import { consumeModelCall } from '../agent/modelBudget'
import { abortable } from '@shared/async'

/**
 * Gemini-Zugang für alles außerhalb der Live-Sitzung: Websuche mit Grounding,
 * URL-Kontext, tiefe Recherche und der Vision-Loop für die Computersteuerung.
 *
 * Der Client wird zwischengespeichert, aber verworfen, sobald sich der
 * Schlüssel ändert — sonst arbeitet die App nach einem Key-Wechsel weiter mit
 * dem alten und meldet Fehler, die nicht mehr stimmen.
 */

let client: GoogleGenAI | null = null
let clientKey: string | null = null

export function geminiClient(): GoogleGenAI {
  const apiKey = getSecret('gemini')
  if (!apiKey) {
    throw new Error(
      'Es ist kein Gemini Zugang hinterlegt. Sag dem Nutzer, er soll den Schlüssel in den Einstellungen eintragen.'
    )
  }
  if (!client || clientKey !== apiKey) {
    client = new GoogleGenAI({ apiKey })
    clientKey = apiKey
  }
  return client
}

export const GEMINI_TEXT_FALLBACKS = GEMINI_FALLBACK_MODELS
export { isQuotaError, quotaBackoffUntil }

type GenerateParams = Parameters<GoogleGenAI['models']['generateContent']>[0]
type GenerateResult = Awaited<ReturnType<GoogleGenAI['models']['generateContent']>>

/**
 * `generateContent` mit Ausweichen bei leerem Kontingent, siehe
 * `shared/geminiQuota.ts`.
 */
export function generateWithFallback(params: GenerateParams): Promise<GenerateResult> {
  // Bound the complete model/fallback round, including SDK retries and body
  // reads. A caller cancellation must release James even if the SDK is stuck.
  const timeoutMs = params.config?.httpOptions?.timeout ?? 60_000
  const deadline = AbortSignal.timeout(timeoutMs)
  const parent = params.config?.abortSignal
  const signal = parent ? AbortSignal.any([parent, deadline]) : deadline
  const config = { ...params.config, abortSignal: signal,
    httpOptions: { ...params.config?.httpOptions, timeout: timeoutMs } }
  return withModelFallback(params.model, (model) => {
    signal.throwIfAborted()
    consumeModelCall()
    return abortable(geminiClient().models.generateContent({ ...params, model, config }), signal)
  })
}

export function geminiAvailable(): boolean {
  return getSecret('gemini') !== null
}

/** Rohe API-Fehler sind zum Vorlesen ungeeignet. */
export function friendlyGeminiError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const lower = raw.toLowerCase()
  if (lower.includes('api key') || lower.includes('401') || lower.includes('unauthenticated')) {
    return 'Der Gemini Zugang wird nicht akzeptiert.'
  }
  if (lower.includes('429') || lower.includes('quota') || lower.includes('resource_exhausted')) {
    return 'Das Gemini-Kontingent ist bei allen Textmodellen aufgebraucht. Ist es das Tageslimit, geht es ab 9 Uhr früh wieder.'
  }
  if (lower.includes('404') || lower.includes('not found')) {
    return 'Das angefragte Modell gibt es nicht.'
  }
  if (lower.includes('safety') || lower.includes('blocked')) {
    return 'Die Anfrage wurde von den Sicherheitsfiltern abgelehnt.'
  }
  return raw.slice(0, 300)
}

/**
 * Sammelt Quellenangaben aus der Grounding-Antwort.
 * Die Struktur schwankt zwischen den API-Versionen, deshalb defensiv.
 */
export function extractSources(response: unknown): string[] {
  const sources = new Set<string>()
  const visit = (node: unknown, depth = 0): void => {
    if (depth > 8 || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }
    const obj = node as Record<string, unknown>
    const uri = obj.uri ?? obj.url
    if (typeof uri === 'string' && uri.startsWith('http')) sources.add(uri)
    for (const value of Object.values(obj)) visit(value, depth + 1)
  }
  visit(response)
  return [...sources]
}

/** Für die Sprachausgabe: Domain statt vollständiger URL. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
