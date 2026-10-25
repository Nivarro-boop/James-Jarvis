/**
 * Abgerissene Netzverbindungen (Handy weg, WLAN gewechselt, Gegenstelle
 * geschlossen). Sie sind kein Programmfehler: protokollieren ja, dem Nutzer
 * eine Fehlermeldung „read ECONNRESET“ zeigen nein.
 */
const TRANSIENT = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_STREAM_PREMATURE_CLOSE'])

export function isTransientNetworkError(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
  return typeof code === 'string' && TRANSIENT.has(code)
}
