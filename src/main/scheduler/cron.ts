import { schedule, validate, type ScheduledTask } from 'node-cron'
import { listSchedules, listWatches, markScheduleRun } from '../db'
import { speak } from '../ipc/emit'
import { checkWatch } from '../tools/impl/priceWatch'

/**
 * Zeitplaner.
 *
 * Fällige Aufträge lässt James von sich aus sprechen — es gibt keine
 * Oberfläche, in der eine Erinnerung stehen könnte.
 *
 * Die Aufträge stehen in der Datenbank, die laufenden Jobs aber nur im
 * Speicher. Wer die Datenbank ändert, muss deshalb `reloadSchedules` aufrufen —
 * das tun das Werkzeug `schedule_task` und die IPC-Handler des
 * Einstellungsfensters. An den Einstellungen hängt das bewusst nicht: ein
 * Zeitplan ist keine Einstellung, und ein Neuaufbau bei jedem Schieberegler
 * wäre nur Arbeit ohne Wirkung.
 */

const jobs = new Map<number, ScheduledTask>()
let watchJob: ScheduledTask | null = null

/**
 * Ob ein Cron-Ausdruck überhaupt planbar ist.
 *
 * Wird vor dem Speichern geprüft, nicht erst beim Einplanen: Ein Auftrag, den
 * `scheduleEntry` still verwirft, stünde sonst in der Übersicht und würde nie
 * feuern — und James hätte dem Nutzer trotzdem "eingerichtet" gemeldet.
 */
export function isValidCron(expr: string): boolean {
  return validate(expr)
}

function scheduleEntry(id: number, expr: string, prompt: string): void {
  if (!validate(expr)) {
    console.error(`[scheduler] Ungültiger Ausdruck für Auftrag ${id}: ${expr}`)
    return
  }
  const task = schedule(
    expr,
    () => {
      markScheduleRun(id)
      // Der Prompt geht als gesprochener Auftrag an die laufende Session.
      // Der Renderer nimmt ihn entgegen und schickt ihn als Nutzer-Turn rein.
      speak(prompt, false)
    },
    { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
  )
  jobs.set(id, task)
}

/** Wie viele Aufträge gerade wirklich eingeplant sind. Für die Diagnose. */
export function scheduledJobCount(): number {
  return jobs.size
}

export function reloadSchedules(): void {
  for (const task of jobs.values()) task.stop()
  jobs.clear()
  for (const entry of listSchedules()) {
    if (entry.active) scheduleEntry(entry.id, entry.cron, entry.prompt)
  }
}

/**
 * Preiswächter laufen gebündelt alle 30 Minuten statt jeder für sich —
 * so bleibt die Last auf den Shops überschaubar und wir sehen weniger Sperren.
 */
function startWatchLoop(): void {
  watchJob = schedule('*/30 * * * *', () => {
    void (async () => {
      for (const watch of listWatches(true)) {
        try {
          await checkWatch(watch)
        } catch (err) {
          console.error(`[scheduler] Preisprüfung für ${watch.productName} fehlgeschlagen:`, err)
        }
      }
    })()
  })
}

export function startScheduler(): void {
  reloadSchedules()
  startWatchLoop()
}

export function stopScheduler(): void {
  for (const task of jobs.values()) task.stop()
  jobs.clear()
  watchJob?.stop()
  watchJob = null
}
