import { Notification } from 'electron'
import type { ReminderEntry } from '@shared/types'
import { insertReminder, listDueReminders, listReminders, updateReminder } from '../db'
import { broadcast, sendToCrystal } from '../ipc/emit'

let ticker: NodeJS.Timeout | null = null

export function reminderDueAt(input: { at?: string; inMinutes?: number }, now = Date.now()): number {
  if ((input.at !== undefined) === (input.inMinutes !== undefined)) throw new Error('Genau eine Zeitangabe verwenden: at oder inMinutes.')
  if (input.at !== undefined) {
    const parts = typeof input.at === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(input.at)
    if (!parts || Number(parts[2]) < 1 || Number(parts[2]) > 12 || Number(parts[3]) < 1 ||
      Number(parts[3]) > new Date(Date.UTC(Number(parts[1]), Number(parts[2]), 0)).getUTCDate() ||
      Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6] ?? 0) > 59) {
      throw new Error('Gültiges Datum mit Uhrzeit und Zeitzone angeben, etwa 2026-10-04T09:00:00+02:00.')
    }
  }
  if (input.inMinutes !== undefined && typeof input.inMinutes !== 'number') throw new Error('inMinutes muss eine Zahl sein.')
  const dueAt = input.at !== undefined ? Date.parse(input.at) : now + input.inMinutes! * 60_000
  if (!Number.isFinite(dueAt) || dueAt <= now || dueAt > now + 5 * 366 * 86_400_000) {
    throw new Error('Die Erinnerung braucht eine gültige zukünftige Zeit innerhalb von fünf Jahren.')
  }
  return dueAt
}

/** Advance the local calendar rather than adding 24h, preserving clock time across DST. */
export function nextReminderDue(dueAt: number, repeat: 'daily' | 'weekly', now: number): number {
  const next = new Date(dueAt)
  do { next.setDate(next.getDate() + (repeat === 'daily' ? 1 : 7)) } while (next.getTime() <= now)
  return next.getTime()
}

export function createReminder(input: { text: string; at?: string; inMinutes?: number; repeat?: ReminderEntry['repeat'] }): ReminderEntry {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Ungültige Erinnerungsdaten.')
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  if (!text || text.length > 2000) throw new Error('Erinnerungstext muss 1 bis 2000 Zeichen haben.')
  if (!['none', 'daily', 'weekly'].includes(input.repeat ?? 'none')) throw new Error('Ungültige Wiederholung.')
  const reminder = insertReminder(text, reminderDueAt(input), input.repeat ?? 'none')
  broadcast('reminder:changed', undefined)
  return reminder
}

/** Bearbeitet nur vorhandene, nicht erledigte Einträge; eine Zeitänderung reaktiviert bereits gemeldete Erinnerungen. */
export function editReminder(input: unknown): ReminderEntry {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Ungültige Erinnerungsdaten.')
  const value = input as { id?: unknown; text?: unknown; at?: unknown; inMinutes?: unknown; repeat?: unknown }
  if (typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id <= 0) throw new Error('Ungültige Erinnerungskennung.')
  const hasText = value.text !== undefined
  const hasAt = value.at !== undefined
  const hasMinutes = value.inMinutes !== undefined
  const hasRepeat = value.repeat !== undefined
  if (!hasText && !hasAt && !hasMinutes && !hasRepeat) throw new Error('Mindestens eine Änderung angeben.')
  const text = hasText ? (typeof value.text === 'string' ? value.text.trim() : '') : undefined
  if (hasText && (!text || text.length > 2000)) throw new Error('Erinnerungstext muss 1 bis 2000 Zeichen haben.')
  if (hasRepeat && !['none', 'daily', 'weekly'].includes(value.repeat as string)) throw new Error('Ungültige Wiederholung.')
  if (hasAt && hasMinutes) throw new Error('Genau eine Zeitangabe verwenden: at oder inMinutes.')
  const dueAt = hasAt || hasMinutes
    ? reminderDueAt(hasAt ? { at: value.at as string } : { inMinutes: value.inMinutes as number })
    : undefined
  const existing = listReminders().find(reminder => reminder.id === value.id)
  if (!existing) throw new Error('Diese aktive Erinnerung existiert nicht.')
  updateReminder(value.id, {
    ...(text !== undefined ? { text } : {}),
    ...(dueAt !== undefined ? { dueAt, state: 'pending' as const } : {}),
    ...(hasRepeat ? { repeat: value.repeat as ReminderEntry['repeat'] } : {})
  })
  const updated = listReminders().find(reminder => reminder.id === value.id)
  if (!updated) throw new Error('Diese aktive Erinnerung existiert nicht.')
  broadcast('reminder:changed', undefined)
  return updated
}

export function completeReminder(id: number): void {
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new Error('Ungültige Erinnerungskennung.')
  updateReminder(id, { state: 'done' })
  broadcast('reminder:changed', undefined)
}

export function snoozeReminder(id: number, minutes: number): void {
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new Error('Ungültige Erinnerungskennung.')
  const reminder = listReminders().find(r => r.id === id)
  if (!reminder) throw new Error('Diese aktive Erinnerung existiert nicht.')
  updateReminder(id, { dueAt: reminderDueAt({ inMinutes: minutes }), state: 'pending' })
  broadcast('reminder:changed', undefined)
}

function notify(reminder: ReminderEntry): boolean {
  let delivered = false
  try {
    if (Notification.isSupported()) {
      const notification = new Notification({ title: 'James – Erinnerung', body: reminder.text })
      notification.show()
      delivered = true
    }
  } catch (error) { console.warn('[reminders] Windows-Benachrichtigung fehlgeschlagen:', error) }
  return sendToCrystal('reminder:due', reminder) || delivered
}

export function tickReminders(now = Date.now(), deliver = notify): void {
  for (const reminder of listDueReminders(now)) {
    if (!deliver(reminder)) continue
    updateReminder(reminder.id, reminder.repeat === 'none'
      ? { state: 'notified', lastNotifiedAt: now }
      : { dueAt: nextReminderDue(reminder.dueAt, reminder.repeat, now), lastNotifiedAt: now })
    broadcast('reminder:changed', undefined)
  }
}

export function startReminders(): void {
  if (ticker) return
  ticker = setInterval(() => tickReminders(), 1000)
  ticker.unref?.()
}
export function stopReminders(): void { if (ticker) clearInterval(ticker); ticker = null }
