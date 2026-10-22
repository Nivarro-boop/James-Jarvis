import React, { useEffect, useState, type JSX } from 'react'
import type { ActivityItem, ActivitySnapshot, PlanStep } from '@shared/types'
import './activity-filters.css'

/** Die Live-Anzeige: was James gerade tut. */

function useActivity(): ActivitySnapshot {
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>({ items: [], plan: null })
  useEffect(() => {
    void window.jarvis.invoke('activity:get').then(setSnapshot).catch(() => undefined)
    return window.jarvis.on('activity:update', setSnapshot)
  }, [])
  return snapshot
}

/** Sekundentakt, damit laufende Schritte ihre Dauer zeigen. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

function seconds(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  const s = ms / 1000
  return s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`
}

const STATUS_TEXT: Record<ActivityItem['status'], string> = {
  running: 'läuft',
  ok: 'erledigt',
  error: 'fehlgeschlagen',
  waiting: 'wartet auf dich'
}

const FILTERS: { value: ActivityItem['status'] | 'all'; label: string }[] = [
  { value: 'all', label: 'Alle' },
  { value: 'running', label: 'Läuft' },
  { value: 'waiting', label: 'Wartet' },
  { value: 'error', label: 'Fehlgeschlagen' },
  { value: 'ok', label: 'Erledigt' }
]

type StatusFilter = (typeof FILTERS)[number]['value']

function StepIcon({ status }: { status: ActivityItem['status'] | PlanStep['status'] }): JSX.Element {
  const kind =
    status === 'running' || status === 'läuft'
      ? 'run'
      : status === 'ok' || status === 'erledigt'
        ? 'ok'
        : status === 'error' || status === 'fehlgeschlagen'
          ? 'err'
          : status === 'waiting'
            ? 'wait'
            : 'todo'
  return <span className={`act-icon act-${kind}`} aria-hidden="true" />
}

function Row({ item, now, nested, context }: { item: ActivityItem; now: number; nested?: boolean; context?: boolean }): JSX.Element {
  const elapsed = item.durationMs ?? now - item.startedAt
  return (
    <li className={`act-row${nested ? ' act-nested' : ''}${context ? ' act-context' : ''}`} title={item.detail ?? item.label}>
      <StepIcon status={item.status} />
      <div className="act-text">
        <span className="act-label">{item.label}</span>
        {context && <span className="act-detail">Elternaktion als Kontext</span>}
        {item.detail && item.status !== 'running' && <span className="act-detail">{item.detail}</span>}
      </div>
      <span className="act-time" aria-label={STATUS_TEXT[item.status]}>
        {item.status === 'waiting' ? 'Zusage?' : seconds(Math.max(0, elapsed))}
      </span>
    </li>
  )
}

export function ActivityToggle({
  open,
  busy,
  onToggle
}: {
  open: boolean
  busy: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <button
      className={`home-chip act-toggle${busy ? ' act-busy' : ''}`}
      onClick={onToggle}
      aria-pressed={open}
      aria-expanded={open}
      title={open ? 'Aktionslog schließen' : 'Aktionslog öffnen'}
    >
      <span className="act-dot" aria-hidden="true" />
      Aktionslog <span aria-hidden="true">{open ? '−' : '+'}</span>
    </button>
  )
}

/** Hält fest, ob die Tafel offen ist — von Hand gesetzt schlägt das automatische Ein- und Ausblenden. */
export function useActivityPanel(): {
  snapshot: ActivitySnapshot
  open: boolean
  busy: boolean
  toggle: () => void
} {
  const snapshot = useActivity()
  const [pinned, setPinned] = useState<boolean | null>(() => {
    try {
      const stored = window.localStorage.getItem('jarvis.activityPinned')
      return stored === null ? null : stored === 'true'
    } catch {
      return null
    }
  })
  const busy = snapshot.items.some((i) => i.status === 'running' || i.status === 'waiting')
  const open = pinned ?? false

  const toggle = (): void => {
    const next = !open
    setPinned(next)
    try {
      window.localStorage.setItem('jarvis.activityPinned', String(next))
    } catch {
      // Dann gilt es eben nur bis zum Schließen des Fensters.
    }
  }
  return { snapshot, open, busy, toggle }
}

type ActivityGroup = {
  parent: ActivityItem
  children: ActivityItem[]
  parentMatches: boolean
  matchingChildren: ActivityItem[]
}

function searchableText(item: ActivityItem): string {
  // Die aktuelle ActivityItem-Struktur benutzt `tool`; das optionale
  // toolName deckt auch Snapshots ab, die dieses Feld bereits mitliefern.
  const toolName = (item as ActivityItem & { toolName?: string }).toolName
  return [item.label, item.detail, item.tool, toolName].filter(Boolean).join(' ').toLocaleLowerCase('de-DE')
}

export function ActivityPanel({ snapshot }: { snapshot: ActivitySnapshot }): JSX.Element {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const busy = snapshot.items.some((i) => i.status === 'running')
  const now = useNow(busy)
  const normalizedQuery = query.trim().toLocaleLowerCase('de-DE')
  const hasFilters = normalizedQuery.length > 0 || status !== 'all'

  const matches = (item: ActivityItem): boolean => {
    const statusMatches = status === 'all' || item.status === status
    return statusMatches && (!normalizedQuery || searchableText(item).includes(normalizedQuery))
  }

  // Jede Abfrage arbeitet auf dem gesamten Snapshot. Parent-Aktionen, die
  // nur wegen eines passenden Kindes erscheinen, sind Kontext und zählen
  // nicht als eigener Treffer.
  const itemById = new Map(snapshot.items.map((item) => [item.id, item]))
  const groups: ActivityGroup[] = []
  const groupedChildIds = new Set<string>()
  for (const parent of snapshot.items) {
    if (parent.parentId && itemById.has(parent.parentId)) continue
    const children = snapshot.items.filter((item) => item.parentId === parent.id)
    for (const child of children) groupedChildIds.add(child.id)
    const parentMatches = matches(parent)
    const matchingChildren = children.filter(matches)
    if (!hasFilters || parentMatches || matchingChildren.length > 0) {
      groups.push({ parent, children, parentMatches, matchingChildren })
    }
  }
  // Verwaiste Unteragentenaktionen bleiben sichtbar, auch wenn der Parent
  // im Snapshot bereits herausgefallen ist.
  for (const child of snapshot.items) {
    if (child.parentId && !itemById.has(child.parentId) && !groupedChildIds.has(child.id) && (!hasFilters || matches(child))) {
      groups.push({ parent: child, children: [], parentMatches: matches(child), matchingChildren: [] })
    }
  }

  const matchCount = snapshot.items.filter(matches).length
  const isTrulyEmpty = snapshot.items.length === 0 && !hasFilters
  const noMatches = !isTrulyEmpty && matchCount === 0

  return (
    <aside className="act-panel" aria-label="Aktionslog" aria-live="polite">
      <header className="activity-drawer-head"><strong>Aktionslog</strong><button className="home-nav-btn" onClick={() => void window.jarvis.invoke('app:openSettings', { section: 'audit' })}>Gesamter Verlauf ↗</button></header>
      {snapshot.plan && (
        <section className="act-plan">
          <header>
            <strong>{snapshot.plan.title}</strong>
            <span>
              {snapshot.plan.steps.filter((step) => step.status === 'erledigt').length}/{snapshot.plan.steps.length}
            </span>
          </header>
          <div className="act-progress" aria-hidden="true">
            <span style={{ width: `${(snapshot.plan.steps.filter((step) => step.status === 'erledigt').length / Math.max(1, snapshot.plan.steps.length)) * 100}%` }} />
          </div>
          <ol>
            {snapshot.plan.steps.map((step, i) => (
              <li key={i} className={`act-step act-step-${step.status === 'läuft' ? 'run' : step.status === 'erledigt' ? 'ok' : step.status === 'fehlgeschlagen' ? 'err' : 'todo'}`}>
                <StepIcon status={step.status} />
                <span>{step.text}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="act-filters" aria-label="Aktionslog filtern">
        <label className="act-search-label" htmlFor="act-search">Suchen</label>
        <input
          id="act-search"
          className="act-search"
          type="search"
          placeholder="Aktionen durchsuchen …"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <div className="act-status-filters" role="group" aria-label="Nach Status filtern">
          {FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              className={`act-filter${status === filter.value ? ' is-active' : ''}`}
              aria-pressed={status === filter.value}
              onClick={() => setStatus(filter.value)}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <div className="act-results">
          <span role="status" aria-live="polite">{matchCount} Treffer</span>
          {hasFilters && <button type="button" className="act-reset" onClick={() => { setQuery(''); setStatus('all') }}>Filter zurücksetzen</button>}
        </div>
      </section>

      {isTrulyEmpty ? (
        <p className="act-empty">Noch nichts zu tun. Sobald James ein Werkzeug benutzt, steht es hier.</p>
      ) : noMatches ? (
        <p className="act-empty" role="status">Kein Treffer für die aktuellen Filter.</p>
      ) : groups.length > 0 ? (
        <ul className="act-list">
          {groups.map(({ parent, children, parentMatches, matchingChildren }) => (
            <li key={parent.id} className="act-group">
              <ul>
                <Row item={parent} now={now} context={hasFilters && !parentMatches} />
                {(hasFilters ? matchingChildren : [...children].reverse()).map((child) => (
                  <Row key={child.id} item={child} now={now} nested />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        <p className="act-empty">Noch nichts zu tun. Sobald James ein Werkzeug benutzt, steht es hier.</p>
      )}
    </aside>
  )
}
