import type { PauseState } from '@shared/types'

/**
 * Der Stilllege-Zustand im Hauptprozess.
 *
 * Ausgeführt wird die Pause weiterhin im Renderer — dort hängen Mikrofon,
 * Weckwort und Live-Sitzung. Hier steht, was alle anderen davon wissen
 * müssen: das Häkchen im Tray, der globale Hotkey und die Werkzeuge.
 *
 * Dazugekommen ist die Frist. "Sei mal eine halbe Stunde still" war vorher
 * nicht möglich — man konnte ihn nur abschalten und musste selbst daran
 * denken, ihn zurückzuholen. Der Wecker dafür läuft hier und nicht im
 * Renderer: Der Renderer ist genau das, was währenddessen stillgelegt ist.
 *
 * Eigenes Modul, weil sonst `index.ts` und `ipc/bridge.ts` einander
 * importieren müssten — und im CommonJS-Build ist ein solcher Ring genau die
 * Sorte Fehler, die sich erst zur Laufzeit als "undefined is not a function"
 * zeigt.
 */

let paused = false
let until: number | null = null
let wakeTimer: NodeJS.Timeout | null = null

const listeners = new Set<(state: PauseState) => void>()

export function isPaused(): boolean {
  return paused
}

export function pauseState(): PauseState {
  return { paused, until }
}

/**
 * Legt still oder holt zurück.
 *
 * `untilMs` ist der Zeitpunkt des selbsttätigen Aufwachens. Der Wecker wird
 * bei jedem Aufruf neu gestellt — auch beim Zurückholen, damit ein alter
 * Wecker nicht Minuten später eine Pause aufhebt, die längst vorbei ist.
 */
export function setPaused(value: boolean, untilMs: number | null = null): void {
  const next = value ? untilMs : null
  const changed = paused !== value || until !== next
  paused = value
  until = next

  clearWakeTimer()
  if (paused && until !== null) {
    // Mindestens eine Sekunde. Ein Zeitpunkt in der Vergangenheit ergäbe
    // einen Wecker, der sofort wieder klingelt — die Pause wäre gesetzt und
    // im selben Wimpernschlag aufgehoben, und übrig bliebe ein Kristall, der
    // ohne erkennbaren Grund kurz aufblinkt.
    const delay = Math.max(1000, until - Date.now())
    wakeTimer = setTimeout(() => {
      wakeTimer = null
      setPaused(false)
    }, delay)
    // Der Wecker darf das Beenden der App nicht aufhalten.
    wakeTimer.unref?.()
  }

  if (changed) notify()
}

export function onPauseChanged(fn: (state: PauseState) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Beim Beenden — sonst bleibt ein Wecker im Umlauf, der nichts mehr weckt. */
export function stopPauseTimer(): void {
  clearWakeTimer()
}

function clearWakeTimer(): void {
  if (wakeTimer) clearTimeout(wakeTimer)
  wakeTimer = null
}

function notify(): void {
  const state = pauseState()
  for (const fn of listeners) fn(state)
}
