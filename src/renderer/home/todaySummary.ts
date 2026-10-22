import type { ReminderEntry, TimerEntry } from '@shared/types'

export interface TodaySummary {
  overdue: ReminderEntry[]
  dueToday: ReminderEntry[]
  timers: TimerEntry[]
  overdueTotal: number
  dueTodayTotal: number
  openTotal: number
  laterTotal: number
  timerTotal: number
  nextDayStart: number
}

/** Local calendar boundaries, not fixed 24-hour durations (DST-safe). */
export function localDayBounds(now: Date | number = Date.now()): { start: number; end: number } {
  const date = new Date(now)
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()
  return { start, end }
}

/**
 * Summarize locally stored, unfinished reminders. A notified reminder remains
 * open until completed; anything due before now is overdue. Tomorrow is excluded.
 */
export function summarizeToday(
  reminders: readonly ReminderEntry[],
  timers: readonly TimerEntry[],
  now: Date | number = Date.now(),
  limit = 4
): TodaySummary {
  const timestamp = typeof now === 'number' ? now : now.getTime()
  const { start, end } = localDayBounds(timestamp)
  const open = reminders.filter((item) => item.state !== 'done')
  const overdue = open.filter((item) => item.dueAt < timestamp).sort((a, b) => a.dueAt - b.dueAt)
  const dueToday = open.filter((item) => item.dueAt >= timestamp && item.dueAt < end).sort((a, b) => a.dueAt - b.dueAt)
  const laterTotal = open.filter((item) => item.dueAt >= end).length
  const activeTimers = timers.filter((timer) => !timer.fired && timer.dueAt > timestamp).sort((a, b) => a.dueAt - b.dueAt)
  const safeLimit = Math.max(0, Math.floor(limit))
  return {
    overdue: overdue.slice(0, safeLimit),
    dueToday: dueToday.slice(0, safeLimit),
    timers: activeTimers.slice(0, safeLimit),
    overdueTotal: overdue.length,
    dueTodayTotal: dueToday.length,
    openTotal: open.length,
    laterTotal,
    timerTotal: activeTimers.length,
    nextDayStart: end
  }
}
