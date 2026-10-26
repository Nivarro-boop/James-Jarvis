import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { browserHost, type BrowserPanelState } from '@shared/browser'
import { useCrystal } from '../store/crystalStore'
import './browser.css'

const EMPTY: BrowserPanelState = { open: false, activeId: null, tabs: [], purpose: null, done: false }
const KIND_LABEL = { login: 'Anmelden', approval: 'Freigeben', choice: 'Dein Schritt' } as const

/**
 * Das Anmeldefenster.
 *
 * Der eingebettete Browser ist kein allgemeiner Webbrowser mehr. Er erscheint
 * nur, wenn der Nutzer selbst etwas erledigen muss — anmelden, freigeben,
 * auswählen — und sagt oben, was zu tun ist. Mail, Kalender und Drive zeigt
 * James selbst in „Konten“. Die Webseite selbst ist eine native Fläche über
 * diesem Rahmen; ihre Größe meldet `browser:bounds`.
 */
export function BrowserWorkspace({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState(EMPTY)
  const [error, setError] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const viewport = useRef<HTMLDivElement>(null)
  const hasConfirmation = useCrystal(s => Boolean(s.confirmation))
  const active = state.tabs.find(tab => tab.id === state.activeId)
  const host = active ? browserHost(active.url) : ''
  const secure = active?.url.startsWith('https://') ?? false
  const purpose = state.purpose

  useEffect(() => {
    let disposed = false
    let received = false
    const off = window.jarvis.on('browser:state', next => { received = true; setState(next) })
    void window.jarvis.invoke('browser:status').then(next => { if (!disposed && !received) setState(next) }).catch(() => {})
    return () => { disposed = true; off() }
  }, [])
  useEffect(() => {
    const update = (): void => setDialogOpen(Boolean(document.querySelector('[role="dialog"]:not(.browser-panel)')))
    const observer = new MutationObserver(update)
    observer.observe(document.body, { childList: true, subtree: true })
    update()
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (hasConfirmation && state.open) void window.jarvis.invoke('browser:action', { action: 'hide' }).catch(() => {})
  }, [hasConfirmation, state.open])
  // Erkannte Anmeldung: kurz bestätigen, dann schließen.
  useEffect(() => {
    if (!state.open || !state.done) return
    const timer = window.setTimeout(() => { void window.jarvis.invoke('browser:action', { action: 'done' }).catch(() => {}) }, 2200)
    return () => window.clearTimeout(timer)
  }, [state.open, state.done])
  useEffect(() => {
    if (!state.open) return
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') void action('hide') }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [state.open])

  useEffect(() => {
    const element = viewport.current
    if (!state.open || !element || hasConfirmation || dialogOpen || state.done) {
      void window.jarvis.invoke('browser:bounds', null).catch(() => {})
      return
    }
    let frame = 0
    const update = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const box = element.getBoundingClientRect()
        void window.jarvis.invoke('browser:bounds', { x: box.x, y: box.y, width: box.width, height: box.height }).catch(() => {})
      })
    }
    const observer = new ResizeObserver(update)
    observer.observe(element)
    window.addEventListener('resize', update)
    update()
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('resize', update); void window.jarvis.invoke('browser:bounds', null).catch(() => {}) }
  }, [state.open, state.activeId, state.tabs.length > 1, Boolean(active?.error), Boolean(error), hasConfirmation, dialogOpen, state.done])

  const action = async (name: 'hide' | 'done' | 'select' | 'close' | 'back' | 'reload' | 'stop', id?: string): Promise<void> => {
    setError('')
    try { await window.jarvis.invoke('browser:action', { action: name, id }) }
    catch (err) { setError(err instanceof Error ? err.message : 'Die Browseraktion ist fehlgeschlagen.') }
  }

  return <div className={`james-workspace${state.open ? ' browser-is-open' : ''}`}>
    <div className="james-conversation">{children}</div>
    {state.open && <div className="browser-backdrop" aria-hidden="true" />}
    {state.open && <section className="browser-panel" role="dialog" aria-modal="true" aria-label="Anmeldefenster" data-kind={purpose?.kind ?? 'choice'}>
      <header className="browser-purpose">
        <div>
          <span className="browser-kind">{KIND_LABEL[purpose?.kind ?? 'choice']}</span>
          <h2>{purpose?.title ?? 'Dein Schritt im Browser'}</h2>
          <p>{purpose?.hint ?? 'Erledige den Schritt auf der Webseite und tippe danach auf „Fertig“.'}</p>
        </div>
        <div className="browser-purpose-actions">
          <button className="browser-done" onClick={() => void action('done')}>Fertig</button>
          <button className="browser-icon" aria-label="Fenster schließen" title="Schließen (Esc)" onClick={() => void action('hide')}>×</button>
        </div>
      </header>
      <div className="browser-site">
        <button type="button" className="browser-icon" aria-label="Zurück" disabled={!active?.canGoBack} onClick={() => void action('back')}>←</button>
        <button type="button" className="browser-icon" aria-label={active?.loading ? 'Laden stoppen' : 'Seite neu laden'} disabled={!active} onClick={() => void action(active?.loading ? 'stop' : 'reload')}>{active?.loading ? '×' : '↻'}</button>
        <span className="browser-address" data-secure={secure} title={active?.url}>
          <i aria-hidden="true">{secure ? '🔒' : '⚠'}</i>
          <strong>{host || 'Seite lädt …'}</strong>
          {!secure && host && <em>nicht verschlüsselt</em>}
        </span>
      </div>
      {state.tabs.length > 1 && <div className="browser-tabs" role="tablist" aria-label="Fenster dieser Anmeldung">
        {state.tabs.map(tab => <div className={`browser-tab${tab.id === state.activeId ? ' selected' : ''}`} key={tab.id}>
          <button role="tab" aria-selected={tab.id === state.activeId} onClick={() => void action('select', tab.id)} title={tab.title}>{tab.loading ? '◌' : '◉'} <span>{tab.title}</span></button>
          <button aria-label={`Tab schließen: ${tab.title}`} onClick={() => void action('close', tab.id)}>×</button>
        </div>)}
      </div>}
      {(error || active?.error) && <p className="browser-error" role="alert">{error || active?.error}</p>}
      <div className="browser-viewport" ref={viewport}>
        {state.done && <div className="browser-success" role="status"><span aria-hidden="true">✓</span><strong>Angemeldet</strong><p>Das Fenster schließt sich gleich.</p></div>}
        {hasConfirmation && <p className="browser-wait">Bestätige zuerst James’ Rückfrage.</p>}
      </div>
      <footer className="browser-status" role="status">
        {active?.loading ? 'Seite lädt …' : 'Passwörter gibst du nur auf der Webseite ein — James liest sie nicht.'}
        <span>Esc schließt das Fenster</span>
      </footer>
    </section>}
  </div>
}
