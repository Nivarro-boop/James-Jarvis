import { useEffect, useState, type JSX } from 'react'
import type { ActivityItem, ActivitySnapshot, PlanStep } from '@shared/types'

/**
 * Die Live-Anzeige: was James gerade tut.
 *
 * Oben der Plan, den er sich für längere Aufgaben selbst schreibt, darunter
 * die einzelnen Schritte mit Zustand und Dauer. Unteragenten erscheinen als
 * eigener Eintrag, ihre Schritte eingerückt darunter.
 *
 * Die Tafel blendet sich von selbst ein, sobald etwas läuft, und nach einer
 * Weile Ruhe wieder aus. Über den Knopf oben lässt sie sich dauerhaft
 * zeigen oder wegklicken — die Kugel bleibt die Hauptsache.
 */

/** So lange bleibt die Tafel nach dem letzten Schritt noch sichtbar. */

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

function Row({ item, now, nested }: { item: ActivityItem; now: number; nested?: boolean }): JSX.Element {
  const elapsed = item.durationMs ?? now - item.startedAt
  return (
    <li className={`act-row${nested ? ' act-nested' : ''}`} title={item.detail ?? item.label}>
      <StepIcon status={item.status} />
      <div className="act-text">
        <span className="act-label">{item.label}</span>
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

export function ActivityPanel({ snapshot }: { snapshot: ActivitySnapshot }): JSX.Element {
  const busy = snapshot.items.some((i) => i.status === 'running')
  const now = useNow(busy)
  const top = snapshot.items.filter((i) => !i.parentId).slice(0, 14)
  const children = (id: string): ActivityItem[] =>
    snapshot.items.filter((i) => i.parentId === id).reverse().slice(-6)
  const plan = snapshot.plan
  const done = plan ? plan.steps.filter((s) => s.status === 'erledigt').length : 0

  return (
    <aside className="act-panel" aria-label="Aktionslog" aria-live="polite">
      <header className="activity-drawer-head"><strong>Aktionslog</strong><button className="home-nav-btn" onClick={() => void window.jarvis.invoke('app:openSettings', { section: 'audit' })}>Gesamter Verlauf ↗</button></header>
      {plan && (
        <section className="act-plan">
          <header>
            <strong>{plan.title}</strong>
            <span>
              {done}/{plan.steps.length}
            </span>
          </header>
          <div className="act-progress" aria-hidden="true">
            <span style={{ width: `${(done / Math.max(1, plan.steps.length)) * 100}%` }} />
          </div>
          <ol>
            {plan.steps.map((step, i) => (
              <li key={i} className={`act-step act-step-${step.status === 'läuft' ? 'run' : step.status === 'erledigt' ? 'ok' : step.status === 'fehlgeschlagen' ? 'err' : 'todo'}`}>
                <StepIcon status={step.status} />
                <span>{step.text}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {top.length === 0 && !plan ? (
        <p className="act-empty">Noch nichts zu tun. Sobald James ein Werkzeug benutzt, steht es hier.</p>
      ) : (
        <ul className="act-list">
          {top.map((item) => (
            <li key={item.id} className="act-group">
              <ul>
                <Row item={item} now={now} />
                {item.source === 'agent' &&
                  children(item.id).map((child) => <Row key={child.id} item={child} now={now} nested />)}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}
