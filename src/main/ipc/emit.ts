import type { IpcEventMap } from '@shared/ipc'
import { getCrystalWindow } from '../windows/crystal'
import { getSettingsWindow } from '../windows/settings'

/**
 * Main → Kristallfenster.
 *
 * Der Rückgabewert ist nicht Zierrat: Er sagt, ob es überhaupt ein Fenster gab,
 * an das die Meldung gehen konnte. Ein Wecker, der abläuft, während das Fenster
 * geschlossen ist, wurde vorher trotzdem als erledigt abgehakt — und war damit
 * still weg. Wer etwas Einmaliges meldet, hakt es erst ab, wenn hier `true`
 * herauskommt.
 *
 * `isDestroyed` steht zusätzlich zur Prüfung auf null: Zwischen dem Zerstören
 * des Fensters und dem `closed`-Ereignis, das die Bezugsgröße auf null setzt,
 * liegt ein Augenblick, in dem `webContents` eine Ausnahme wirft.
 */
export function sendToCrystal<C extends keyof IpcEventMap>(
  channel: C,
  payload: IpcEventMap[C]
): boolean {
  const win = getCrystalWindow()
  try {
    if (!win || win.isDestroyed()) return false
    win.webContents.send(channel as string, payload)
    return true
  } catch {
    // Das Fenster kann zwischen Prüfung und Zustellung zerstört werden.
    // Timer/Erinnerungen dürfen dann später erneut zustellen, nicht abstürzen.
    return false
  }
}

/**
 * Sieht jemand das Kristallfenster gerade?
 *
 * Für Antwortkarten: Steht die Karte sichtbar da, darf die Stimme sich kurz
 * fassen. Im Infobereich oder minimiert sieht niemand eine Karte.
 */
export function crystalVisible(): boolean {
  const win = getCrystalWindow()
  try {
    if (!win || win.isDestroyed()) return false
    return win.isVisible() && !win.isMinimized()
  } catch {
    return false
  }
}

/** Main → Einstellungsfenster (nur wenn offen). */
export function sendToSettings<C extends keyof IpcEventMap>(
  channel: C,
  payload: IpcEventMap[C]
): boolean {
  const win = getSettingsWindow()
  try {
    if (!win || win.isDestroyed()) return false
    win.webContents.send(channel as string, payload)
    return true
  } catch {
    return false
  }
}

export function broadcast<C extends keyof IpcEventMap>(channel: C, payload: IpcEventMap[C]): void {
  sendToCrystal(channel, payload)
  sendToSettings(channel, payload)
}

/**
 * Lässt James von sich aus etwas sagen — Zeitplan, Preisalarm,
 * fertige Recherche.
 */
export function speak(text: string, interrupt = false): boolean {
  return sendToCrystal('speak:request', { text, interrupt })
}
