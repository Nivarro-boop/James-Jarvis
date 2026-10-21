import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent, type JSX, type ReactNode } from 'react'
import type { WorkspaceCalendarEvent, WorkspaceCalendarRead, WorkspaceIpcMap, WorkspaceLayout, WorkspaceSnapshot, WorkspaceTask, WorkspaceWidgetId } from '@shared/workspace'
import { WORKSPACE_WIDGET_IDS } from '@shared/workspace'
import { TodayPanel } from './TodayPanel'
import './workspace-board.css'

type WorkspaceChannel = keyof WorkspaceIpcMap
function invokeWorkspace<C extends WorkspaceChannel>(channel: C, payload?: WorkspaceIpcMap[C]['req']): Promise<WorkspaceIpcMap[C]['res']> {
  return window.jarvis.invoke(channel, payload)
}
function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Die Änderung konnte nicht gespeichert werden.'
}
function eventTime(event: WorkspaceCalendarEvent): string {
  return event.allDay ? 'Ganztägig' : new Date(event.start).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
}
const labels: Record<WorkspaceWidgetId, string> = {
  today: 'Heute', calendar: 'Termine', tasks: 'Aufgaben', 'next-steps': 'Nächste Schritte', 'feature-packs': 'Feature-Packs'
}

export interface WorkspaceBoardProps {
  featurePackWidgets?: ReactNode
  dataAndAi?: ReactNode
}

export function WorkspaceBoard({ featurePackWidgets, dataAndAi }: WorkspaceBoardProps = {}): JSX.Element {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null)
  const snapshotRef = useRef<WorkspaceSnapshot | null>(null)
  const [calendar, setCalendar] = useState<WorkspaceCalendarRead | null>(null)
  const [calendarBusy, setCalendarBusy] = useState(false)
  const [layoutBusy, setLayoutBusy] = useState(false)
  const [taskTitle, setTaskTitle] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [calendarError, setCalendarError] = useState('')
  const [dragging, setDragging] = useState<WorkspaceWidgetId | null>(null)
  const alive = useRef(false)
  const snapshotRequest = useRef(0)
  const calendarGeneration = useRef(0)
  const desiredLayout = useRef<Pick<WorkspaceLayout, 'order' | 'hidden'> | null>(null)
  const runningLayoutSave = useRef(false)

  const adopt = useCallback((next: WorkspaceSnapshot) => {
    if (!alive.current) return
    snapshotRef.current = next
    setSnapshot(next)
  }, [])
  const reload = useCallback(async () => {
    const request = ++snapshotRequest.current
    try {
      const next = await invokeWorkspace('workspace:get')
      if (alive.current && request === snapshotRequest.current) adopt(next)
    } catch (cause) { if (alive.current && request === snapshotRequest.current) setError(message(cause)) }
  }, [adopt])
  useEffect(() => {
    alive.current = true
    void reload()
    return () => { alive.current = false; snapshotRequest.current++; calendarGeneration.current++; desiredLayout.current = null }
  }, [reload])

  const saveLayout = useCallback((order: WorkspaceWidgetId[], hidden: WorkspaceWidgetId[]) => {
    const current = snapshotRef.current
    if (!current) return
    const desired = { order: [...order], hidden: [...hidden] }
    desiredLayout.current = desired
    adopt({ ...current, layout: { ...current.layout, ...desired } })
    if (runningLayoutSave.current) return
    runningLayoutSave.current = true
    setLayoutBusy(true)
    void (async () => {
      try {
        while (desiredLayout.current) {
          const requested = desiredLayout.current
          desiredLayout.current = null
          const currentSnapshot = snapshotRef.current
          if (!currentSnapshot) break
          const saved = await invokeWorkspace('workspace:layout-set', { ...requested, revision: currentSnapshot.layout.revision })
          const latest = snapshotRef.current
          if (alive.current && latest) adopt({ ...latest, layout: saved })
          if (!alive.current) break
          if (desiredLayout.current) {
            // If a newer local arrangement was requested while the IPC was in flight, carry forward its order with the new server revision.
            continue
          }
        }
      } catch (cause) {
        desiredLayout.current = null
        if (alive.current) setError(message(cause))
        try {
          const fresh = await invokeWorkspace('workspace:get')
          if (alive.current) adopt(fresh)
        } catch (reloadCause) { if (alive.current) setError(`${message(cause)} ${message(reloadCause)}`) }
      } finally {
        runningLayoutSave.current = false
        if (alive.current) setLayoutBusy(false)
      }
    })()
  }, [adopt])

  const changeLayout = (update: (layout: WorkspaceLayout) => Pick<WorkspaceLayout, 'order' | 'hidden'>): void => {
    if (!snapshot) return
    const next = update(snapshot.layout)
    saveLayout(next.order, next.hidden)
  }
  const move = (id: WorkspaceWidgetId, offset: -1 | 1): void => changeLayout((layout) => {
    const order = [...layout.order]
    const at = order.indexOf(id)
    const destination = Math.max(0, Math.min(order.length - 1, at + offset))
    if (at < 0 || at === destination) return layout
    ;[order[at], order[destination]] = [order[destination], order[at]]
    return { order, hidden: [...layout.hidden] }
  })
  const hide = (id: WorkspaceWidgetId): void => changeLayout((layout) => ({ order: layout.order.filter((widget) => widget !== id), hidden: [...layout.hidden, id] }))
  const restore = (id: WorkspaceWidgetId): void => changeLayout((layout) => ({ order: [...layout.order, id], hidden: layout.hidden.filter((widget) => widget !== id) }))
  const reorderDrop = (event: DragEvent, target: WorkspaceWidgetId): void => {
    event.preventDefault()
    const source = dragging
    setDragging(null)
    if (!snapshot || !source || source === target) return
    const order = [...snapshot.layout.order]
    const from = order.indexOf(source), to = order.indexOf(target)
    if (from < 0 || to < 0) return
    order.splice(from, 1)
    order.splice(to, 0, source)
    saveLayout(order, [...snapshot.layout.hidden])
  }

  const refreshCalendar = async (): Promise<void> => {
    if (!snapshot?.calendarEnabled || calendarBusy) return
    const request = ++calendarGeneration.current
    setCalendarBusy(true)
    setCalendarError('')
    try {
      const result = await invokeWorkspace('workspace:calendar-read')
      if (alive.current && request === calendarGeneration.current && snapshotRef.current?.calendarEnabled) setCalendar(result)
    } catch (cause) { if (alive.current && request === calendarGeneration.current) setCalendarError(message(cause)) }
    finally { if (alive.current && request === calendarGeneration.current) setCalendarBusy(false) }
  }
  const enableCalendar = async (): Promise<void> => {
    if (pending || !snapshot) return
    setPending(true)
    setCalendarError('')
    try {
      const next = await invokeWorkspace('workspace:calendar-enabled', { enabled: true })
      if (!alive.current) return
      adopt(next)
      // This click both gives explicit consent and makes one bounded, read-only request; no background refresh follows.
      const request = ++calendarGeneration.current
      setCalendarBusy(true)
      try {
        const result = await invokeWorkspace('workspace:calendar-read')
        if (alive.current && request === calendarGeneration.current && snapshotRef.current?.calendarEnabled) setCalendar(result)
      } catch (cause) { if (alive.current && request === calendarGeneration.current) setCalendarError(message(cause)) }
      finally { if (alive.current && request === calendarGeneration.current) setCalendarBusy(false) }
    } catch (cause) { if (alive.current) setCalendarError(message(cause)) }
    finally { if (alive.current) setPending(false) }
  }
  const disableCalendar = async (): Promise<void> => {
    if (!snapshot || pending) return
    calendarGeneration.current++
    setCalendar(null)
    setCalendarBusy(false)
    setPending(true)
    try {
      const next = await invokeWorkspace('workspace:calendar-enabled', { enabled: false })
      adopt(next)
      setCalendar(null)
    } catch (cause) { if (alive.current) setCalendarError(message(cause)) }
    finally { if (alive.current) setPending(false) }
  }
  const addTask = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!taskTitle.trim() || pending) return
    setPending(true)
    try {
      const next = await invokeWorkspace('workspace:task-create', { title: taskTitle })
      if (alive.current) { adopt(next); setTaskTitle('') }
    } catch (cause) { if (alive.current) setError(message(cause)) }
    finally { if (alive.current) setPending(false) }
  }
  const setTaskDone = async (task: WorkspaceTask, done: boolean): Promise<void> => {
    if (pending || !snapshot) return
    setPending(true)
    try { adopt(await invokeWorkspace('workspace:task-set-done', { id: task.id, done })) }
    catch (cause) { if (alive.current) setError(message(cause)) }
    finally { if (alive.current) setPending(false) }
  }
  const deleteTask = async (task: WorkspaceTask): Promise<void> => {
    if (pending || !snapshot) return
    setPending(true)
    try { adopt(await invokeWorkspace('workspace:task-delete', { id: task.id })) }
    catch (cause) { if (alive.current) setError(message(cause)) }
    finally { if (alive.current) setPending(false) }
  }

  const renderWidget = (id: WorkspaceWidgetId, index: number): JSX.Element => <article
    className={`workspace-widget${dragging === id ? ' is-dragging' : ''}`}
    key={id}
    draggable
    onDragStart={(event) => { setDragging(id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', id) }}
    onDragEnd={() => setDragging(null)}
    onDragOver={(event) => event.preventDefault()}
    onDrop={(event) => reorderDrop(event, id)}
    aria-label={`${labels[id]} Widget`}
  >
    <header className="workspace-widget-head">
      <span className="workspace-drag" aria-hidden="true" title="Zum Verschieben ziehen">⠿</span>
      <h2>{labels[id]}</h2>
      <div className="workspace-widget-tools">
        <button type="button" disabled={index === 0 || layoutBusy} aria-label={`${labels[id]} nach oben verschieben`} onClick={() => move(id, -1)}>Hoch</button>
        <button type="button" disabled={!snapshot || index === snapshot.layout.order.length - 1 || layoutBusy} aria-label={`${labels[id]} nach unten verschieben`} onClick={() => move(id, 1)}>Runter</button>
        <button type="button" disabled={layoutBusy} aria-label={`${labels[id]} ausblenden`} onClick={() => hide(id)}>Ausblenden</button>
      </div>
    </header>
    {id === 'today' && <TodayPanel />}
    {id === 'calendar' && <CalendarWidget enabled={Boolean(snapshot?.calendarEnabled)} result={calendar} busy={calendarBusy} error={calendarError} onEnable={() => void enableCalendar()} onDisable={() => void disableCalendar()} onRefresh={() => void refreshCalendar()} pending={pending} />}
    {id === 'tasks' && <TasksWidget tasks={snapshot?.tasks ?? []} title={taskTitle} setTitle={setTaskTitle} add={addTask} setDone={(task, done) => void setTaskDone(task, done)} remove={(task) => void deleteTask(task)} pending={pending} />}
    {id === 'next-steps' && <NextStepsWidget goal={snapshot?.workingGoal ?? ''} steps={snapshot?.nextSteps ?? []} />}
    {id === 'feature-packs' && (featurePackWidgets ?? <p className="workspace-empty">Feature-Pack-Inhalte werden hier angezeigt, sobald sie eingebunden sind.</p>)}
  </article>

  if (!snapshot) return <section className="workspace-board"><p className="workspace-loading">Arbeitsbereich wird geladen …</p>{error && <p className="workspace-error" role="alert">{error}</p>}</section>
  return <section className="workspace-board" aria-label="Arbeitsbereich Heute">
    <div className="workspace-board-heading"><div><p className="workspace-eyebrow">Tagesübersicht</p><h1>Heute</h1><p className="workspace-subtitle">Dein anpassbarer Arbeitsbereich. Ziehe Widgets oder nutze die Tastatur-Steuerung.</p></div>
      {layoutBusy && <span className="workspace-saving" role="status">Anordnung wird gespeichert …</span>}
    </div>
    {error && <p className="workspace-error" role="alert">{error}<button type="button" onClick={() => { setError(''); void reload() }}>Erneut laden</button></p>}
    <div className="workspace-grid">{snapshot.layout.order.map((id, index) => renderWidget(id, index))}</div>
    {snapshot.layout.hidden.length > 0 && <section className="workspace-hidden" aria-label="Ausgeblendete Widgets">
      <h2>Ausgeblendete Widgets</h2><div>{WORKSPACE_WIDGET_IDS.filter((id) => snapshot.layout.hidden.includes(id)).map((id) => <button type="button" key={id} disabled={layoutBusy} onClick={() => restore(id)}>„{labels[id]}“ wiederherstellen</button>)}</div>
    </section>}
    {dataAndAi && <section className="workspace-extra" aria-label="Daten und KI"><h2>Daten &amp; KI</h2>{dataAndAi}</section>}
  </section>
}

function CalendarWidget({ enabled, result, busy, error, onEnable, onDisable, onRefresh, pending }: {
  enabled: boolean; result: WorkspaceCalendarRead | null; busy: boolean; error: string
  onEnable: () => void; onDisable: () => void; onRefresh: () => void; pending: boolean
}): JSX.Element {
  const events = result ? [...result.sources.google.events, ...result.sources.ical.events].sort((a, b) => a.start - b.start) : []
  const visibleEvents = events.slice(0, 12)
  return <div className="workspace-calendar">
    <p className="workspace-privacy"><strong>Privat und optional:</strong> Beim Laden werden Termine ausschließlich aus verbundenen Kalendern gelesen. Titel, Uhrzeit und Ort werden <strong>nicht an eine KI gesendet</strong>. Keine Kalenderänderungen, keine automatische Anmeldung und kein Hintergrund-Polling.</p>
    {!enabled ? <button type="button" className="workspace-primary" disabled={pending} onClick={onEnable}>Kalenderzugriff aktivieren &amp; heute einmal laden</button> : <div className="workspace-calendar-actions"><span className="workspace-enabled">Kalenderzugriff eingeschaltet</span><button type="button" disabled={busy || pending} onClick={onRefresh}>{busy ? 'Lädt …' : 'Heute aus Kalendern laden'}</button><button type="button" disabled={pending} onClick={onDisable}>Zugriff ausschalten</button></div>}
    {error && <p className="workspace-error" role="alert">{error}</p>}
    {result && <>
      <p className="workspace-status">Lokaler Tag · {result.timezone} · {new Date(result.from).toLocaleDateString('de-DE')}</p>
      <div className="workspace-sources">{(['google', 'ical'] as const).map((key) => <SourceStatus key={key} label={key === 'google' ? 'Google Kalender' : 'Kalender-Link (iCal)'} source={result.sources[key]} staleAfter={result.to} />)}</div>
      <p className="workspace-status">{events.length} geladene Termine insgesamt · höchstens 50 je Quelle abgerufen · höchstens 12 werden direkt angezeigt</p>
      {events.length === 0 && <p className="workspace-empty">{result.sources.google.state === 'error' || result.sources.ical.state === 'error' ? 'Keine Termine konnten geladen werden. Prüfe die jeweilige Quelle und versuche es erneut.' : 'Für heute wurden keine Termine gefunden.'}</p>}
      {events.length > 0 && <><ul className="workspace-events">{visibleEvents.map((event) => <li key={`${event.source}:${event.id}`}><time dateTime={new Date(event.start).toISOString()}>{eventTime(event)}</time><div><strong>{event.title}</strong><span>{[event.calendar, event.location, event.source === 'ical' ? 'iCal' : 'Google'].filter(Boolean).join(' · ')}</span></div></li>)}</ul>{events.length > visibleEvents.length && <p className="workspace-status">+ {events.length - visibleEvents.length} weitere geladene Termine</p>}</>}
    </>}
  </div>
}
function SourceStatus({ label, source, staleAfter }: { label: string; source: WorkspaceCalendarRead['sources']['google']; staleAfter: number }): JSX.Element {
  const stale = source.fetchedAt !== undefined && Date.now() >= staleAfter
  const loadedAt = source.fetchedAt === undefined ? '' : ` · ${new Date(source.fetchedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`
  const text = source.state === 'not-configured' ? 'nicht eingerichtet' : source.state === 'idle' ? 'noch nicht geladen' : source.state === 'ready' ? `${source.events.length} Termine geladen${loadedAt}${stale ? ' · veraltet (voriger lokaler Tag)' : ''}` : `Fehler${loadedAt}: ${source.error ?? 'Quelle nicht erreichbar'}${stale ? ' · vom vorigen lokalen Tag' : ''}`
  return <p className={`workspace-source ${source.state === 'error' ? 'has-error' : ''}`}><strong>{label}:</strong> {text}</p>
}
function TasksWidget({ tasks, title, setTitle, add, setDone, remove, pending }: {
  tasks: WorkspaceTask[]; title: string; setTitle: (value: string) => void; add: (event: FormEvent) => Promise<void>
  setDone: (task: WorkspaceTask, done: boolean) => void; remove: (task: WorkspaceTask) => void; pending: boolean
}): JSX.Element {
  const open = tasks.filter((task) => !task.doneAt), done = tasks.filter((task) => task.doneAt)
  return <div className="workspace-tasks">
    <form className="workspace-task-form" onSubmit={(event) => void add(event)}><label htmlFor="workspace-task-title">Neue lokale Aufgabe</label><div><input id="workspace-task-title" maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Aufgabe notieren …" /><button type="submit" disabled={pending || !title.trim()}>Hinzufügen</button></div></form>
    {tasks.length === 0 ? <p className="workspace-empty">Noch keine lokalen Aufgaben.</p> : <>
      {open.length > 0 && <TaskList tasks={open.slice(0, 10)} done={false} setDone={setDone} remove={remove} pending={pending} />}
      {open.length > 10 && <details className="workspace-completed"><summary>Weitere offene Aufgaben ({open.length - 10})</summary><TaskList tasks={open.slice(10)} done={false} setDone={setDone} remove={remove} pending={pending} /></details>}
      {done.length > 0 && <details className="workspace-completed"><summary>Erledigt ({done.length})</summary><TaskList tasks={done.slice(0, 10)} done setDone={setDone} remove={remove} pending={pending} />{done.length > 10 && <details><summary>Weitere erledigte Aufgaben ({done.length - 10})</summary><TaskList tasks={done.slice(10)} done setDone={setDone} remove={remove} pending={pending} /></details>}</details>}
    </>}
    <p className="workspace-status">Nur lokal gespeichert · Aufgaben werden nicht an KI gesendet.</p>
  </div>
}
function TaskList({ tasks, done, setDone, remove, pending }: { tasks: WorkspaceTask[]; done: boolean; setDone: (task: WorkspaceTask, done: boolean) => void; remove: (task: WorkspaceTask) => void; pending: boolean }): JSX.Element {
  return <ul className="workspace-task-list">{tasks.map((task) => <li key={task.id} className={done ? 'is-done' : ''}><label><input type="checkbox" checked={done} disabled={pending} onChange={(event) => setDone(task, event.target.checked)} /><span>{task.title}</span></label><button type="button" disabled={pending} aria-label={`Aufgabe „${task.title}“ löschen`} onClick={() => remove(task)}>Löschen</button></li>)}</ul>
}
function NextStepsWidget({ goal, steps }: { goal: string; steps: string[] }): JSX.Element {
  return <div className="workspace-next"><p className="workspace-privacy">Aus dem Arbeitskontext · nur Anzeige. Diese Schritte lassen sich hier nicht abhaken oder verändern.</p>{goal && <p className="workspace-goal">{goal}</p>}{steps.length ? <ol>{steps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}</ol> : <p className="workspace-empty">Keine offenen nächsten Schritte im Arbeitskontext.</p>}</div>
}
