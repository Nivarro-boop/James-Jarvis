import { listTimers, markTimerFired, pruneTimers } from '../db'
import { sendToCrystal } from '../ipc/emit'

/**
 * Kurzzeitwecker.
 *
 * Bewusst nicht über node-cron: Timer sind einmalig und minutengenau bis
 * sekundengenau, Cron ist auf Wiederholung ausgelegt. Ein Tick pro Sekunde
 * gegen die Datenbank ist billig genug und übersteht nebenbei einen Neustart
 * der App — abgelaufene Timer melden sich dann eben verspätet, statt still
 * verloren zu gehen.
 */

const TICK_MS = 1000
/** Abgelaufene Timer nach einem Tag wegräumen. */
const KEEP_MS = 24 * 60 * 60 * 1000

let ticker: NodeJS.Timeout | null = null

function tick(): void {
  const now = Date.now()
  for (const timer of listTimers()) {
    if (timer.dueAt > now) continue

    /*
      Erst melden, dann abhaken — und nur, wenn die Meldung ankam.

      Vorher stand das Abhaken davor. Ist das Fenster in dem Augenblick zu — mit
      Alt+F4 geschlossen, oder gerade beim Neustart —, dann verpuffte die
      Meldung, der Wecker galt aber als erledigt. Er kam nie wieder, und der
      Nutzer erfuhr nichts davon: Ein Wecker, der nicht klingelt, sieht aus wie
      einer, den man nie gestellt hat.

      Bleibt es beim Nichtzustellen, versucht der nächste Tick es erneut. Das
      ist genau die Zusage aus dem Kopf dieser Datei — verspätet statt verloren.
    */
    const delivered = sendToCrystal('timer:due', {
      id: timer.id,
      label: timer.label || 'Timer'
    })
    if (delivered) markTimerFired(timer.id)
  }
}

export function startTimers(): void {
  if (ticker) return
  pruneTimers(KEEP_MS)
  ticker = setInterval(tick, TICK_MS)
  // Ein einzelner Wecker darf die App nicht am Beenden hindern.
  ticker.unref?.()
}

export function stopTimers(): void {
  if (ticker) clearInterval(ticker)
  ticker = null
}
