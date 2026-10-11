/**
 * Meldet einen Zustand nur dann, wenn er neu ist.
 *
 * Prüfungen laufen im Takt: alle fünf Minuten die Selbstheilung, bei jedem Öffnen
 * die Einstellungsseite, bei jedem Weckwort ein Sitzungsaufbau. Fehlt dabei etwas
 * Dauerhaftes — ein Schlüssel, eine Stimme, ein Zugang —, steht derselbe Satz
 * jedes Mal wieder im Protokoll, und aus dem einen Hinweis werden 27 Zeilen in
 * der Stunde, unter denen die eine echte Neuigkeit verschwindet.
 *
 * Gemerkt wird je Schlüssel der zuletzt gemeldete Zustand. Gemeldet wird erst
 * wieder, wenn er sich ändert oder die Frist abläuft (dann als Erinnerung, dass
 * es immer noch so ist).
 */
export interface StateGate {
  /** `true`, wenn dieser Zustand jetzt ins Protokoll soll. */
  changed(key: string, state: string): boolean
  /** Der Zustand ist vorbei (behoben, Schlüssel gewechselt): Nächstes Mal wieder melden. */
  forget(key: string): void
  clear(): void
}

export function createStateGate(repeatAfterMs: number, now: () => number = Date.now): StateGate {
  const seen = new Map<string, { state: string; at: number }>()
  return {
    changed(key, state) {
      const t = now()
      const before = seen.get(key)
      if (before && before.state === state && t - before.at < repeatAfterMs) return false
      seen.set(key, { state, at: t })
      return true
    },
    forget(key) {
      seen.delete(key)
    },
    clear() {
      seen.clear()
    }
  }
}
