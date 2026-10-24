import { useEffect, useState, type JSX } from 'react'
import type { BackupInfo, Settings } from '@shared/types'

export function BackupPanel({settings, patch}: {settings: Settings; patch: (p: Partial<Settings>) => Promise<Settings>}): JSX.Element {
  const [items, setItems] = useState<BackupInfo[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = async (): Promise<void> => { setItems(await window.jarvis.invoke('backup:list')) }
  useEffect(() => {
    let active = true
    void window.jarvis.invoke('backup:list').then(list => { if (active) setItems(list) })
      .catch(e => { if (active) setError(String(e)) })
    return () => { active = false }
  }, [])
  return <section className="field" aria-label="Datensicherung">
    <h3>Datensicherung</h3>
    <label><input type="checkbox" checked={settings.automaticBackups} style={{width:'auto', marginRight:8}}
      onChange={e => { void patch({automaticBackups:e.target.checked}).catch(err => setError(String(err))) }} />
      Täglich lokal sichern · sieben automatische Sicherungen behalten</label>
    <p className="hint">Sichert James’ Datenbank, Erinnerungen, Einstellungen, Fertigkeiten und Lernkarten mit Lernfortschritt.
      Keystore, Anmeldetokens, und MCP-Umgebungswerte sind ausgenommen.
      Die Dateien enthalten persönliche Gesprächsdaten. Wiederherstellung erfolgt derzeit manuell.</p>
    <button disabled={busy} onClick={() => {
      setBusy(true); setError('')
      void window.jarvis.invoke('backup:create').then(load).catch(err => setError(String(err))).finally(() => setBusy(false))
    }}>{busy ? 'Sichert …' : 'Jetzt sichern'}</button>{' '}
    <button onClick={() => { void window.jarvis.invoke('backup:openFolder').catch(err => setError(String(err))) }}>Sicherungsordner öffnen</button>
    {items.length > 0 && <p className="hint">Letzte Sicherung: {new Date(items[0].createdAt).toLocaleString('de-DE')} · {Math.ceil(items[0].bytes / 1024)} KB</p>}
    {error && <p role="alert" className="hint err">{error}</p>}
  </section>
}
