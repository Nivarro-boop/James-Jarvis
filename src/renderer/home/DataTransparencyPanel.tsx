import { useEffect, useRef, useState, type JSX } from 'react'
import type { Settings } from '@shared/types'
import { deriveTransparencyItems, type TransparencyGroup, type TransparencyItem, type TransparencyStatus } from '@shared/dataTransparency'
import './data-transparency.css'

const groups: { id: TransparencyGroup; title: string }[] = [
  { id: 'storage', title: 'Was auf diesem Rechner bleibt' },
  { id: 'models', title: 'KI- und Modellwege' },
  { id: 'voice', title: 'Sprache' },
  { id: 'channels', title: 'Kalender, Companion und Telefon' },
  { id: 'diagnostics', title: 'Diagnose und Meldungen' }
]
const statusText: Record<TransparencyStatus, string> = {
  active: 'Aktiv', optional: 'Bei Bedarf', off: 'Aus', unknown: 'Unbekannt'
}

export function DataTransparencyPanel(): JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const reloadSettings = useRef<() => void>(() => undefined)
  const items = deriveTransparencyItems(settings)

  useEffect(() => {
    let mounted = true
    let revision = 0
    const load = async (): Promise<void> => {
      const requestRevision = ++revision
      setLoading(true)
      try {
        const next = await window.jarvis.invoke('settings:get')
        if (mounted && requestRevision === revision) {
          setSettings(next)
          setError('')
        }
      } catch {
        if (mounted && requestRevision === revision) setError('Einstellungen konnten nicht geladen werden. Bitte erneut versuchen.')
      } finally {
        if (mounted && requestRevision === revision) setLoading(false)
      }
    }
    reloadSettings.current = () => { void load() }
    const off = window.jarvis.on('settings:changed', next => {
      revision++
      if (!mounted) return
      setSettings(next)
      setError('')
      setLoading(false)
    })
    void load()
    return () => { mounted = false; revision++; reloadSettings.current = () => undefined; off() }
  }, [])

  return <section className="data-transparency home-card" aria-label="Datentransparenz">
    <div className="home-card-head">
      <span className="home-card-tag">Datentransparenz</span>
      <button className="home-nav-btn" type="button" onClick={() => reloadSettings.current()} disabled={loading}>
        {loading ? 'Lädt …' : 'Einstellungen nachladen'}
      </button>
    </div>
    <p className="data-transparency-intro">Was lokal gespeichert wird und wann Inhalte einen Anbieter erreichen – anhand deiner aktuellen Einstellungen. Ein „lokaler“ Modellweg bedeutet nicht, dass alle Funktionen offline sind.</p>
    {error && <p className="data-transparency-error" role="alert">{error}</p>}
    {groups.map(group => {
      const rows = items.filter(entry => entry.group === group.id)
      return rows.length ? <section className="data-transparency-group" key={group.id} aria-label={group.title}>
        <h3>{group.title}</h3>
        <ul>
          {rows.map((entry: TransparencyItem) => <li key={entry.id}>
            <div className="data-transparency-row-head">
              <strong>{entry.title}</strong>
              <span className={`data-transparency-status is-${entry.status}`} aria-label={`Status: ${statusText[entry.status]}`}>{statusText[entry.status]}</span>
            </div>
            <p>{entry.detail}</p>
          </li>)}
        </ul>
      </section> : null
    })}
    <p className="data-transparency-caveat">Diese Übersicht beschreibt den Codepfad und gespeicherte Optionen, nicht jede gerade ausgeführte Anfrage. Die lokalen Ablagen werden nicht pauschal exportiert; Inhalte gehen erst mit einer passenden Anfrage/Funktion – einschließlich eingeschalteter Hintergrundfunktion – an deren Anbieter. Werkzeug-Ergebnisse können im Prompt landen; Fallbacks können den Anbieter wechseln. Keine rechtliche Datenschutzgarantie.</p>
  </section>
}
