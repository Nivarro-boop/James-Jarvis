/**
 * Ein Fehler als Satz — auch wenn er keinen Text mitbringt.
 *
 * Der Anlass stand viermal im Protokoll: `Mikrofon nicht verfügbar:` und dahinter
 * nichts. `getUserMedia` wirft DOMExceptions, und deren `message` ist je nach
 * Fall leer (ein `OverconstrainedError` etwa trägt nur den Namen und die
 * betroffene Eigenschaft). Wer nur `err.message` ausgibt, schreibt dann eine
 * Zeile, aus der sich nichts mehr ablesen lässt. Und gibt man das Objekt selbst
 * an `console.warn`, kommt im Protokoll `[object DOMException]` an.
 *
 * Hier wird deshalb zusammengesetzt, was da ist: Name, Text, betroffene
 * Eigenschaft — und nur wenn gar nichts da ist, der Ersatztext des Aufrufers.
 */
export function describeError(err: unknown, fallback = 'unbekannter Fehler'): string {
  if (err === null || err === undefined) return fallback
  if (typeof err === 'string') return err.trim() || fallback
  if (typeof err !== 'object') return String(err)

  const { name, message, constraint } = err as {
    name?: unknown
    message?: unknown
    constraint?: unknown
  }
  const text = typeof message === 'string' ? message.trim() : ''
  // „Error“ sagt nichts, was der Text nicht auch sagte.
  const kind = typeof name === 'string' && name !== 'Error' ? name.trim() : ''
  const property = typeof constraint === 'string' && constraint ? ` (${constraint})` : ''

  if (text) return kind && !text.includes(kind) ? `${kind}: ${text}${property}` : text
  if (kind) return `${kind}${property}`

  // Kein Name, kein Text: was `String` daraus macht, wenn es mehr als eine
  // Typangabe ist, sonst der Ersatz. Ein leeres `new Error('')` ergibt dort
  // bloß „Error“ — auch das sagt nichts.
  const plain = String(err).trim()
  return !plain || plain === 'Error' || /^\[object [^\]]*\]$/.test(plain) ? fallback : plain
}
