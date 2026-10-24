import { useEffect, useRef, useState, type JSX } from 'react'
import { useCrystal } from '../store/crystalStore'

/**
 * Die rechte Seite der Kopfzeile: womit James denkt, die Uhr und das Menü.
 * Alles, was früher als eigener Knopf auf der Startseite stand, liegt jetzt
 * im Menü — die Startseite selbst bleibt leer bis auf James.
 */

function openSettings(section?: string): void {
  void window.jarvis.invoke('app:openSettings', section ? { section } : undefined)
}

/** Womit James gerade verbunden ist, in einem Wort. */
export function useConnectionLabel(ready: boolean): { label: string; ok: boolean } {
  const settings = useCrystal(s => s.settings)
  const speech = settings?.speech
  if (!speech) return { label: 'Verbindet …', ok: true }
  if (!ready) return { label: 'Nicht verbunden', ok: false }
  if (speech.provider === 'gemini') return { label: 'Verbunden mit Gemini', ok: true }
  if (speech.provider === 'openai') return { label: 'Verbunden mit OpenAI', ok: true }
  if (speech.thinkProvider === 'chatgpt') return { label: 'Verbunden mit ChatGPT · Abo', ok: true }
  if (speech.thinkProvider === 'ollama') return { label: 'Läuft lokal', ok: true }
  return { label: 'Verbunden mit Gemini', ok: true }
}

export function ConnectionPill({ ready }: { ready: boolean }): JSX.Element {
  const { label, ok } = useConnectionLabel(ready)
  return <button className="top-pill" data-ok={ok} title={ok ? label : 'Sprachzugang einrichten'}
    onClick={() => openSettings('voice')}><i aria-hidden="true" />{label}</button>
}

export function Clock(): JSX.Element {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const two = (n: number): string => String(n).padStart(2, '0')
  const day = now.toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '').toUpperCase()
  const date = now.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' }).replace('.', '').toUpperCase()
  return <div className="top-clock" role="timer" aria-label={now.toLocaleString('de-DE', { weekday: 'long', hour: '2-digit', minute: '2-digit' })}>
    <span className="top-clock-time">{two(now.getHours())}:{two(now.getMinutes())}<small>:{two(now.getSeconds())}</small></span>
    <span className="top-clock-date">{day} · {date}</span>
  </div>
}

interface MenuItem { label: string; run: () => void }

export function MainMenu({ onBrain }: { onBrain: () => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); setOpen(false); trigger.current?.focus() }
      if (e.key === 'Tab') setOpen(false)
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault()
        const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus()
      }
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc, true)
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc, true) }
  }, [open])
  useEffect(() => {
    if (!note) return
    const timer = window.setTimeout(() => setNote(''), 4000)
    return () => window.clearTimeout(timer)
  }, [note])

  const items: MenuItem[] = [
    { label: 'Neues Gespräch', run: () => {
      void window.jarvis.invoke('context:clear').then(() => {
        useCrystal.getState().clearCaptions()
        setNote('Neues Gespräch begonnen.')
      }).catch(() => setNote('Gespräch konnte nicht zurückgesetzt werden.'))
    } },
    { label: 'Mit James einrichten', run: () => openSettings('setup') },
    { label: 'Lernen & Quiz', run: () => window.dispatchEvent(new Event('jarvis:learn')) },
    { label: 'Deine Fähigkeiten', run: () => window.dispatchEvent(new Event('jarvis:skills')) },
    { label: 'Gehirn & Projekte', run: onBrain },
    { label: 'Verbindungen', run: () => openSettings('connections') },
    { label: 'Einstellungen', run: () => openSettings() },
    { label: 'Nach Updates suchen', run: () => {
      void window.jarvis.invoke('update:check').then(s => setNote(
        s.state === 'checking' ? 'Suche nach Updates …'
          : s.state === 'downloading' ? `Version ${s.version ?? ''} wird geladen …`
          : s.state === 'ready' ? `Version ${s.version ?? ''} ist bereit.`
          : s.state === 'error' ? 'Update-Prüfung fehlgeschlagen.'
          : `Du hast die neueste Version (${s.current}).`
      )).catch(() => setNote('Update-Prüfung fehlgeschlagen.'))
    } },
    { label: 'Einführung ansehen', run: () => { void window.jarvis.invoke('app:openGuide') } },
    { label: 'Rechner prüfen', run: () => openSettings('diagnose') },
    { label: 'Hilfe und Support', run: () => openSettings('diagnose') },
    { label: 'Lizenzen', run: () => openSettings('about') }
  ]

  return <div className="top-menu" ref={root}>
    <button ref={trigger} className="top-menu-btn" aria-label="Menü" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span aria-hidden="true" /><span aria-hidden="true" />
    </button>
    {open && <div className="top-menu-list" role="menu" aria-label="Menü">
      {items.map(item => <button key={item.label} role="menuitem" onClick={() => { setOpen(false); trigger.current?.focus(); item.run() }}>{item.label}</button>)}
    </div>}
    {note && <div className="top-menu-note" role="status">{note}</div>}
  </div>
}
