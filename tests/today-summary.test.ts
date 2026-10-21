import { after, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ReminderEntry, TimerEntry } from '@shared/types'
import { localDayBounds, summarizeToday } from '../src/renderer/home/todaySummary'

const originalTimezone = process.env.TZ
function inTimezone<T>(zone: string, run: () => T): T {
  process.env.TZ = zone
  try { return run() } finally {
    if (originalTimezone === undefined) delete process.env.TZ
    else process.env.TZ = originalTimezone
  }
}
after(() => {
  if (originalTimezone === undefined) delete process.env.TZ
  else process.env.TZ = originalTimezone
})

function reminder(id: number, dueAt: number, state: ReminderEntry['state'] = 'pending'): ReminderEntry {
  return { id, text: `Erinnerung ${id}`, dueAt, repeat: 'none', state, createdAt: dueAt - 1000, lastNotifiedAt: null }
}
function timer(id: number, dueAt: number, fired = false): TimerEntry {
  return { id, label: `Timer ${id}`, dueAt, createdAt: dueAt - 10_000, fired }
}

it('bildet lokale Tagesgrenzen als Kalendergrenzen statt als feste 24 Stunden', () => {
  inTimezone('America/New_York', () => {
    const springDay = new Date(2024, 2, 10, 12).getTime()
    const spring = localDayBounds(springDay)
    assert.equal(spring.end - spring.start, 23 * 60 * 60 * 1000)
    assert.equal(new Date(spring.start).getHours(), 0)
    assert.equal(new Date(spring.end).getHours(), 0)

    const fallDay = new Date(2024, 10, 3, 12).getTime()
    const fall = localDayBounds(fallDay)
    assert.equal(fall.end - fall.start, 25 * 60 * 60 * 1000)
    assert.equal(new Date(fall.start).getHours(), 0)
    assert.equal(new Date(fall.end).getHours(), 0)
  })
})

it('trennt Überfälliges und heute Fälliges, behält notified offen und schließt morgen sowie erledigt aus den Tageslisten aus', () => {
  inTimezone('Europe/Berlin', () => {
    const now = new Date(2026, 9, 21, 12).getTime()
    const { start, end } = localDayBounds(now)
    const items = [
      reminder(1, start - 1),
      reminder(2, start),
      reminder(3, end - 1),
      reminder(4, end),
      reminder(5, now + 10, 'notified'),
      reminder(6, now, 'notified'),
      reminder(7, now + 20, 'done')
    ]
    const result = summarizeToday(items, [], now)
    assert.deepEqual(result.overdue.map((item) => item.id), [1, 2])
    assert.deepEqual(result.dueToday.map((item) => item.id), [6, 5, 3])
    assert.equal(result.openTotal, 6)
    assert.equal(result.laterTotal, 1)
    assert.equal(result.nextDayStart, end)
  })
})

it('begrenzt Listen, zählt Gesamtmengen und zeigt nur laufende Timer', () => {
  const now = new Date(2026, 9, 21, 12).getTime()
  const { start } = localDayBounds(now)
  const items = Array.from({ length: 7 }, (_, index) => reminder(index + 1, now + index * 1000))
  const timers = [timer(1, now + 60_000), timer(2, now + 120_000), timer(3, now - 1), timer(4, now + 30_000, true)]
  const result = summarizeToday(items, timers, now, 3)
  assert.equal(result.dueToday.length, 3)
  assert.equal(result.dueTodayTotal, 7)
  assert.equal(result.openTotal, 7)
  assert.deepEqual(result.timers.map((item) => item.id), [1, 2])
  assert.equal(result.timerTotal, 2)
})
