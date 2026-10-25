import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import type { BrowserPanelState } from '@shared/browser'
import { ICLOUD_SERVICES } from '@shared/icloud'
import { useCrystal } from '../store/crystalStore'
import './browser.css'

const EMPTY: BrowserPanelState = { open: false, activeId: null, tabs: [] }
const SHORTCUTS = [
  { label: 'iCloud Mail', icon: '✉', url: ICLOUD_SERVICES.mail, detail: 'Dein Postfach' },
  { label: 'Kalender', icon: '▦', url: ICLOUD_SERVICES.calendar, detail: 'Termine & Wochenplan' },
  { label: 'iCloud Drive', icon: '▱', url: ICLOUD_SERVICES.drive, detail: 'Dateien & Dokumente' },
  { label: 'Fotos', icon: '◈', url: ICLOUD_SERVICES.photos, detail: 'Deine Mediathek' }
]

export function BrowserWorkspace({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState(EMPTY)
  const [address, setAddress] = useState('')
  const [error, setError] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [position, setPosition] = useState({ x: 24, y: 72 })
  const [dragging, setDragging] = useState(false)
  const panel = useRef<HTMLElement>(null)
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const move = (x: number, y: number): void => {
    const box = panel.current?.getBoundingClientRect()
    setPosition({ x: Math.max(0, Math.min(x, window.innerWidth - (box?.width ?? 0))), y: Math.max(0, Math.min(y, window.innerHeight - (box?.height ?? 0))) })
  }
  useEffect(() => {
    const resize = (): void => {
      const box = panel.current?.getBoundingClientRect()
      if (box) setPosition(p => ({ x: Math.max(0, Math.min(p.x, window.innerWidth - box.width)), y: Math.max(0, Math.min(p.y, window.innerHeight - box.height)) }))
    }
    window.addEventListener('resize', resize)
    resize()
    return () => window.removeEventListener('resize', resize)
  }, [state.open])
  const viewport = useRef<HTMLDivElement>(null)
  const hasConfirmation = useCrystal(s => Boolean(s.confirmation))
  const active = state.tabs.find(tab => tab.id === state.activeId)
  const isBlank = !active?.url || active.url === 'about:blank'

  useEffect(() => {
    let disposed = false
    let received = false
    const off = window.jarvis.on('browser:state', next => { received = true; setState(next) })
    void window.jarvis.invoke('browser:status').then(next => { if (!disposed && !received) setState(next) }).catch(() => {})
    return () => { disposed = true; off() }
  }, [])
  useEffect(() => { setAddress(isBlank ? '' : active?.url ?? '') }, [active?.id, active?.url, isBlank])
  useEffect(() => {
    const update = (): void => setDialogOpen(Boolean(document.querySelector('[role="dialog"]')))
    const observer = new MutationObserver(update)
    observer.observe(document.body, { childList: true, subtree: true })
    update()
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (hasConfirmation && state.open) void window.jarvis.invoke('browser:action', { action: 'hide' }).catch(() => {})
  }, [hasConfirmation, state.open])

  useEffect(() => {
    const element = viewport.current
    if (!state.open || !element || hasConfirmation || dialogOpen || dragging) {
      void window.jarvis.invoke('browser:bounds', null).catch(() => {})
      return
    }
    let frame = 0
    const update = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const box = element.getBoundingClientRect()
        void window.jarvis.invoke('browser:bounds', {
          x: box.x, y: box.y, width: box.width, height: box.height
        }).catch(() => {})
      })
    }
    const observer = new ResizeObserver(update)
    observer.observe(element)
    window.addEventListener('resize', update)
    update()
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('resize', update); void window.jarvis.invoke('browser:bounds', null).catch(() => {}) }
  }, [state.open, state.activeId, Boolean(active?.error), Boolean(error), hasConfirmation, dialogOpen, dragging, position.x, position.y])

  const action = async (name: 'hide' | 'select' | 'close' | 'navigate' | 'back' | 'forward' | 'reload' | 'stop', id?: string, url?: string): Promise<void> => {
    setError('')
    try { await window.jarvis.invoke('browser:action', { action: name, id, url }) }
    catch (err) { setError(err instanceof Error ? err.message : 'Die Browseraktion ist fehlgeschlagen.') }
  }
  const open = async (url?: string): Promise<void> => {
    setError('')
    try { await window.jarvis.invoke('browser:open', { url }) }
    catch (err) { setError(err instanceof Error ? err.message : 'Die Seite konnte nicht geöffnet werden.') }
  }
  const navigate = (url: string): void => { if (active) void action('navigate', active.id, url); else void open(url) }

  return <div className={`james-workspace${state.open ? ' browser-is-open' : ''}`}>
    <div className="james-conversation">{children}</div>
    {state.open && <aside ref={panel} className="browser-panel" aria-label="Integrierter Browser" style={{ left: position.x, top: position.y }}>
      <button className="browser-drag-handle" aria-label="Browser verschieben" title="Ziehen zum Verschieben · Pfeiltasten zum Bewegen"
        onPointerDown={event => {
          if (event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { x: event.clientX, y: event.clientY, left: position.x, top: position.y }
          setDragging(true)
        }}
        onPointerMove={event => { const start = drag.current; if (start) move(start.left + event.clientX - start.x, start.top + event.clientY - start.y) }}
        onPointerUp={() => { drag.current = null; setDragging(false) }}
        onPointerCancel={() => { drag.current = null; setDragging(false) }}
        onLostPointerCapture={() => { drag.current = null; setDragging(false) }}
        onKeyDown={event => {
          const delta = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key]
          if (delta) { event.preventDefault(); move(position.x + delta[0], position.y + delta[1]) }
        }}>⠿ <span>Deine Auswahl</span><small>Ziehen zum Verschieben</small></button>
      <div className="browser-tabbar">
        <div className="browser-tabs" role="tablist" aria-label="Webseiten">
          {state.tabs.map(tab => <div className={`browser-tab${tab.id === state.activeId ? ' selected' : ''}`} key={tab.id}>
            <button role="tab" aria-selected={tab.id === state.activeId} onClick={() => void action('select', tab.id)} title={tab.title}>{tab.loading ? '◌' : '◉'} <span>{tab.title}</span></button>
            <button aria-label={`Tab schließen: ${tab.title}`} onClick={() => void action('close', tab.id)}>×</button>
          </div>)}
        </div>
        <button className="browser-icon" aria-label="Neuer Tab" title="Neuer Tab" onClick={() => void open()}>+</button>
        <button className="browser-icon" aria-label="Browser ausblenden" title="Zurück zu James" onClick={() => void action('hide')}>×</button>
      </div>
      <form className="browser-toolbar" onSubmit={event => { event.preventDefault(); navigate(address) }}>
        <button type="button" className="browser-icon" aria-label="Zurück" disabled={!active?.canGoBack} onClick={() => void action('back')}>←</button>
        <button type="button" className="browser-icon" aria-label="Vor" disabled={!active?.canGoForward} onClick={() => void action('forward')}>→</button>
        <button type="button" className="browser-icon" aria-label={active?.loading ? 'Laden stoppen' : 'Seite neu laden'} disabled={!active || isBlank} onClick={() => void action(active?.loading ? 'stop' : 'reload')}>{active?.loading ? '×' : '↻'}</button>
        <input aria-label="Webadresse" placeholder="Webadresse eingeben" spellCheck={false} value={address} onChange={e => setAddress(e.target.value)} />
        <button type="submit" className="browser-go" aria-label="Webseite öffnen">↵</button>
      </form>
      <nav className="browser-bookmarks" aria-label="Apple-Dienste">
        {SHORTCUTS.map(link => <button key={link.label} onClick={() => navigate(link.url)}>{link.label}</button>)}
      </nav>
      {(error || active?.error) && <p className="browser-error" role="alert">{error || active?.error}</p>}
      <div className="browser-viewport" ref={viewport}>
        {isBlank && <div className="browser-start">
          <span className="browser-eyebrow">DEIN WEB. DIREKT BEI JAMES.</span>
          <h2>Alles neben deinem Gespräch.</h2>
          <p>Öffne eine Webseite oder verbinde deinen Apple Account. Du meldest dich direkt auf der Webseite an.</p>
          <div className="browser-shortcuts">{SHORTCUTS.map(link => <button key={link.label} onClick={() => navigate(link.url)}>
            <span className="browser-service-icon">{link.icon}</span><strong>{link.label}</strong><small>{link.detail}</small>
          </button>)}</div>
          <p className="browser-footnote">Anmeldungen bleiben auf diesem Rechner gespeichert. Apple Health verbindest du in der nativen iPhone-App.</p>
        </div>}
        {hasConfirmation && <p className="browser-wait">Bestätige zuerst James’ Rückfrage.</p>}
      </div>
      <div className="browser-status" role="status">{active?.loading ? 'Seite lädt …' : 'Browser in James'}<span>Nach deiner Auswahl mit × ausblenden.</span></div>
    </aside>}
  </div>
}
