import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { WorkspaceBoard } from './WorkspaceBoard'
import { FeaturePacksPanel, FeaturePackWidgets } from './FeaturePacksPanel'
import { DataTransparencyPanel } from './DataTransparencyPanel'
import { ContextPanel } from './ContextPanel'
import { WidgetTiles } from './BrainMap'
import { WeatherCard } from './WeatherCard'
import './workspace-panel.css'

const sections = [
  { id: 'today', label: 'Heute' },
  { id: 'packs', label: 'Feature-Packs' },
  { id: 'data', label: 'Daten & KI' },
  { id: 'context', label: 'Arbeitsstand' },
  { id: 'widgets', label: 'Widgets' }
] as const

type Section = typeof sections[number]['id']

/** Only the selected section is mounted; closing returns to a clean home. */
export function WorkspacePanel({ onClose }: { onClose: () => void }): JSX.Element {
  const [section, setSection] = useState<Section>('today')
  const dialog = useRef<HTMLElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const tabs = useRef<Array<HTMLButtonElement | null>>([])
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeButton.current?.focus()
    const keydown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); closeRef.current(); return
      }
      if (event.key !== 'Tab' || !dialog.current) return
      const candidates = [...dialog.current.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, summary, [tabindex]')]
        .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0)
      const first = candidates[0], last = candidates.at(-1)
      if (!first) { event.preventDefault(); dialog.current.focus(); return }
      if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('keydown', keydown)
      if (previous?.isConnected && !document.querySelector('[aria-modal="true"]')) previous.focus()
    }
  }, [])
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % sections.length
    else if (event.key === 'ArrowLeft') next = (index + sections.length - 1) % sections.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = sections.length - 1
    else return
    event.preventDefault(); setSection(sections[next].id); tabs.current[next]?.focus()
  }
  return <div className="workspace-overlay" onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="workspace-panel" role="dialog" aria-modal="true" aria-labelledby="workspace-panel-title" ref={dialog} tabIndex={-1}>
      <header className="workspace-panel-header">
        <div><p className="workspace-panel-eyebrow">Dein Arbeitsbereich</p><h2 id="workspace-panel-title">Übersicht</h2></div>
        <button type="button" ref={closeButton} className="workspace-panel-close" aria-label="Übersicht schließen" onClick={onClose}>×</button>
      </header>
      <div className="workspace-panel-tabs" role="tablist" aria-label="Übersicht-Bereiche">
        {sections.map((entry, index) => <button type="button" key={entry.id} ref={element => { tabs.current[index] = element }} id={`overview-tab-${entry.id}`} role="tab" aria-selected={section === entry.id} aria-controls={`overview-panel-${entry.id}`} tabIndex={section === entry.id ? 0 : -1} onClick={() => setSection(entry.id)} onKeyDown={event => navigate(event, index)}>{entry.label}</button>)}
      </div>
      <div className="workspace-panel-content" role="tabpanel" id={`overview-panel-${section}`} aria-labelledby={`overview-tab-${section}`} tabIndex={0}>
        {section === 'today' && <WorkspaceBoard featurePackWidgets={<FeaturePackWidgets />} />}
        {section === 'packs' && <><FeaturePacksPanel /><FeaturePackWidgets /></>}
        {section === 'data' && <DataTransparencyPanel />}
        {section === 'context' && <ContextPanel />}
        {section === 'widgets' && <><h3>Eigene Widgets</h3><p className="workspace-panel-note">Deine gespeicherten Informationskarten. Das Heute-Board ordnest du im Register Heute an.</p><WeatherCard /><WidgetTiles /></>}
      </div>
    </section>
  </div>
}
