import { GEMINI_FALLBACK_MODELS } from './config/defaults'

/**
 * Ausweichen bei leerem Gemini-Kontingent.
 *
 * Google zählt das Gratiskontingent je Modell. Ist es bei Flash für heute
 * aufgebraucht, hat Flash Lite meistens noch reichlich — und umgekehrt. Ohne
 * dieses Ausweichen stand James nach ein paar Dutzend Anfragen bis Mitternacht
 * (pazifischer Zeit) still, obwohl derselbe Schlüssel bei einem anderen Modell
 * noch hätte antworten können.
 *
 * Hier und nicht im Hauptprozess, weil der Kaskadenweg im Renderer dieselbe
 * Regel braucht. Jeder Prozess führt seine eigene Sperrliste.
 */

/** Modell → bis wann es übersprungen wird. */
const exhaustedUntil = new Map<string, number>()

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function isQuotaError(err: unknown): boolean {
  const raw = message(err).toLowerCase()
  return raw.includes('429') || raw.includes('resource_exhausted') || raw.includes('quota')
}

export function isMissingModel(err: unknown): boolean {
  const raw = message(err).toLowerCase()
  return raw.includes('404') || (raw.includes('not found') && raw.includes('model'))
}

/**
 * Wie lange ein Modell nach einem 429 gemieden wird.
 *
 * Ein Tageslimit gilt bis Mitternacht pazifischer Zeit, dann setzt Google es
 * zurück. Alles andere (Anfragen oder Token pro Minute) ist nach einer Minute
 * wieder frei.
 */
export function quotaBackoffUntil(err: unknown, now = Date.now()): number {
  if (!/per ?day|perday|daily/i.test(message(err))) return now + 60_000
  const pacific = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }))
  const offset = now - pacific.getTime()
  const midnight = new Date(pacific)
  midnight.setHours(24, 0, 0, 0)
  return midnight.getTime() + offset
}

/**
 * Einen Gemini-Aufruf mit Ausweichen ausführen.
 *
 * Erst das gewünschte Modell, dann `GEMINI_FALLBACK_MODELS`. Ein Modell, das
 * gerade ein 429 geliefert hat, wird bis zum Ende seiner Sperre gar nicht erst
 * gefragt — jede abgewiesene Anfrage kostet sonst eine Rundreise. Andere
 * Fehler gehen sofort durch, außer ein Ausweichmodell gibt es nicht (mehr).
 */
export async function withModelFallback<T>(preferred: string, run: (model: string) => Promise<T>): Promise<T> {
  const now = Date.now()
  const candidates = [preferred, ...GEMINI_FALLBACK_MODELS.filter((m) => m !== preferred)]
  const open = candidates.filter((m) => (exhaustedUntil.get(m) ?? 0) <= now)
  // Sind alle gesperrt, trotzdem das gewünschte versuchen: Die Sperre ist nur geschätzt.
  const order = open.length > 0 ? open : [preferred]

  let firstError: unknown = null
  for (const model of order) {
    try {
      const result = await run(model)
      if (model !== preferred) console.info(`[gemini] ${preferred} ist ausgeschöpft, ${model} hat geantwortet`)
      return result
    } catch (err) {
      firstError ??= err
      if (isQuotaError(err)) {
        exhaustedUntil.set(model, quotaBackoffUntil(err))
        console.warn(`[gemini] Kontingent für ${model} aufgebraucht`)
        continue
      }
      if (model !== preferred && isMissingModel(err)) continue
      throw err
    }
  }
  throw firstError
}
