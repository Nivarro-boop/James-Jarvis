import { useEffect, useRef, useState, type JSX } from 'react'
import { HealthPanel } from './HealthPanel'

interface Props {
  onControl: () => void
  onBrain: () => void
  onSkills: () => void
  onActivity: () => void
  onSettings: () => void
  activityOpen: boolean
  activityBusy: boolean
}

/** Secondary destinations do not compete with the conversation on first launch. */
export function HomeMenu(props: Props): JSX.Element {
  const root = useRef<HTMLDetailsElement>(null)
  const [open, setOpen] = useState(false)
  const close = (restoreFocus = false): void => {
    if (root.current) root.current.open = false
    setOpen(false)
    if (restoreFocus) root.current?.querySelector('summary')?.focus()
  }
  useEffect(() => {
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close()
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !root.current?.open) return
      event.preventDefault(); event.stopPropagation(); close(true)
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [])
  const choose = (action: () => void): void => { close(true); action() }
  return <details ref={root} className="home-menu" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary aria-label="Weitere Bereiche" title="Weitere Bereiche"><span aria-hidden="true">···</span></summary>
    {open && <nav className="home-menu-content" aria-label="Weitere Bereiche">
      <span className="home-menu-label">Mehr mit James</span>
      <button type="button" onClick={() => choose(props.onControl)}>Steuerzentrale</button>
      <button type="button" onClick={() => choose(props.onBrain)}>Gehirn</button>
      <button type="button" onClick={() => choose(props.onSkills)}>Fertigkeiten</button>
      <button type="button" aria-label="Aktionslog" aria-pressed={props.activityOpen} onClick={() => choose(props.onActivity)}>{props.activityBusy ? 'Aktionslog · läuft' : 'Aktionslog'}</button>
      <HealthPanel />
      <button type="button" onClick={() => choose(props.onSettings)}>Einstellungen</button>
    </nav>}
  </details>
}
