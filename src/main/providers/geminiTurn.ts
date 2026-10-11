/**
 * Der Zug des Modells, so wie er für die nächste Runde zurück in den Verlauf muss.
 *
 * Gemini 3 hängt an jeden Funktionsaufruf eine `thoughtSignature` und lehnt
 * die nächste Anfrage mit „Function call is missing a thought_signature" ab,
 * wenn sie fehlt. Ein aus Name und Argumenten nachgebauter Aufruf hat sie
 * nicht — deshalb die Teile der Antwort unverändert übernehmen und nur
 * nachbauen, wenn die Antwort keine liefert.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function modelTurn(response: any, fallback: Record<string, unknown>[]): { role: 'model'; parts: Record<string, unknown>[] } {
  const parts = response?.candidates?.[0]?.content?.parts
  const usable = Array.isArray(parts) && parts.some((p) => p?.functionCall)
  return { role: 'model', parts: usable ? parts : fallback }
}
