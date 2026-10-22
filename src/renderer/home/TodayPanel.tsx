import { useEffect, useState, type JSX } from 'react'
import type { ReminderEntry, TimerEntry } from '@shared/types'
import { summarizeToday, type TodaySummary } from './todaySummary'
import './today.css'

type LoadState = 'loading' | 'ready' | 'error'

function localTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
}

function remaining(timestamp: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((timestamp - now) / 60_000))
  if (minutes < 60) return `in ${minutes} Min.`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `in ${hours} Std. ${rest} Min.` : `in ${hours} Std.`
}

function errorText(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message
  return 'Lokale Daten konnten nicht geladen werden.'
}

function ReminderList({ title, entries, total, empty }: {
  title: string
  entries: ReminderEntry[]
  total: number
  empty: string
}): JSX.Element {
  return <section className="today-group" aria-label={title}>
    <h3>{title}<span className="today-count">{total}</span></h3>
    {total === 0 ? <p className="today-empty">{empty}</p> : <ul className="today-list">
      {entries.map((entry) => <li key={entry.id} title={entry.text}>
        <span className="today-item-text">{entry.text}</span>
        <time className="today-item-time" dateTime={new Date(entry.dueAt).toISOString()}>{localTime(entry.dueAt)}</time>
      </li>)}
    </ul>}
    {total > entries.length && <p className="today-status">+ {total - entries.length} weitere</p>}
  </section>
}

export function TodayPanel(): JSX.Element {
  const [summary, setSummary] = useState<TodaySummary | null>(null)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let disposed = false
    let requestId = 0
    const load = (): void => {
      const id = ++requestId
      setNow(Date.now())
      setLoadState('loading')
      setError('')
      void Promise.all([
        window.jarvis.invoke('reminder:list'),
        window.jarvis.invoke('timers:list')
      ]).then(([reminders, timers]) => {
        if (disposed || id !== requestId) return
        setSummary(summarizeToday(reminders, timers, Date.now()))
        setUpdatedAt(Date.now())
        setLoadState('ready')
      }).catch((cause: unknown) => {
        if (disposed || id !== requestId) return
        setError(errorText(cause))
        setLoadState('error')
      })
    }
    const refresh = (): void => load()
    load()
    const poll = window.setInterval(load, 60_000)
    const armMidnightRefresh = (): number => {
      const current = Date.now()
      const midnight = new Date(current)
      midnight.setHours(24, 0, 0, 50)
      return window.setTimeout(() => {
        load()
        midnightTimer = armMidnightRefresh()
      }, Math.max(50, midnight.getTime() - current))
    }
    let midnightTimer = armMidnightRefresh()
    const offReminder = window.jarvis.on('reminder:changed', refresh)
    const offReminderDue = window.jarvis.on('reminder:due', refresh)
    const offTimerDue = window.jarvis.on('timer:due', refresh)
    window.addEventListener('jarvis:today-refresh', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      disposed = true
      requestId++
      window.clearInterval(poll)
      window.clearTimeout(midnightTimer)
      offReminder()
      offReminderDue()
      offTimerDue()
      window.removeEventListener('jarvis:today-refresh', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  const view = summary ?? summarizeToday([], [], now)
  const dateLabel = new Date(now).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })
  return <section className="today-panel" aria-labelledby="today-heading" aria-busy={loadState === 'loading'}>
    <div className="today-head">
      <div className="today-title"><h2 id="today-heading">Heute</h2><span className="today-date">{dateLabel}</span></div>
      <button className="today-retry" type="button" onClick={() => {
        // Retry uses the same effect-owned refresh path through a local event.
        window.dispatchEvent(new Event('jarvis:today-refresh'))
      }} disabled={loadState === 'loading'}>Erneut laden</button>
    </div>
    <p className="today-note"><strong>Lokale Erinnerungen</strong> · Kalenderdaten sind hier nicht enthalten.</p>
    {loadState === 'loading' && <p className="today-loading" role="status">Lokale Übersicht wird geladen …</p>}
    {loadState === 'error' && <p className="today-error" role="alert">Laden fehlgeschlagen: {error}{summary ? ' · Angezeigt werden die zuletzt geladenen Daten.' : ''}</p>}
    {summary && <>
      <div className="today-grid">
        <ReminderList title="Überfällig" entries={view.overdue} total={view.overdueTotal} empty="Nichts überfällig" />
        <ReminderList title="Heute fällig" entries={view.dueToday} total={view.dueTodayTotal} empty="Heute nichts fällig" />
        <section className="today-group" aria-label="Laufende Timer">
          <h3>Laufende Timer<span className="today-count">{view.timerTotal}</span></h3>
          {view.timerTotal === 0 ? <p className="today-empty">Keine laufenden Timer</p> : <ul className="today-list">
            {view.timers.map((timer: TimerEntry) => <li key={timer.id} title={timer.label}>
              <span className="today-item-text">{timer.label}</span><span className="today-item-time">{remaining(timer.dueAt, now)}</span>
            </li>)}
          </ul>}
          {view.timerTotal > view.timers.length && <p className="today-status">+ {view.timerTotal - view.timers.length} weitere</p>}
        </section>
      </div>
      <p className="today-status">{view.openTotal} offene lokale {view.openTotal === 1 ? 'Erinnerung' : 'Erinnerungen'} insgesamt{view.laterTotal ? ` · ${view.laterTotal} erst später fällig` : ''}{updatedAt ? ` · aktualisiert ${localTime(updatedAt)}` : ''}</p>
    </>}
  </section>
}
