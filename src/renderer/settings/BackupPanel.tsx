import { useEffect, useState, type JSX } from 'react'
import type { BackupInfo, Settings } from '@shared/types'

export function BackupPanel({settings, patch}: {settings: Settings; patch: (p: Partial<Settings>) => Promise<Settings>}): JSX.Element {
  const [items, setItems] = useState<BackupInfo[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [pendingRestore, setPendingRestore] = useState(false)
  const load = async (): Promise<void> => { setItems(await window.jarvis.invoke('backup:list')) }
  useEffect(() => {
    let active = true
    void window.jarvis.invoke('backup:list').then(list => { if (active) setItems(list) })
      .catch(e => { if (active) setError(String(e)) })
    void window.jarvis.invoke('backup:restoreStatus').then(value => { if (active) setPendingRestore(value.pending) }).catch(e => { if (active) setError(String(e)) })
    return () => { active = false }
  }, [])
  return <section className="field" aria-label="Datensicherung">
    <h3>Datensicherung</h3>
    <label><input type="checkbox" checked={settings.automaticBackups} style={{width:'auto', marginRight:8}}
      onChange={e => { void patch({automaticBackups:e.target.checked}).catch(err => setError(String(err))) }} />
      Täglich lokal sichern · sieben automatische Sicherungen behalten</label>
    <p className="hint">Sichert Datenbank, Erinnerungen, Einstellungen, Fertigkeiten, Lernkarten, Projekte, Notizen, Arbeitsstand und PC-Profil.
      Zugangsdaten, Browser-Sitzungen, Health-Werte und MCP-Umgebungswerte sind ausgenommen.
      Sicherungen enthalten persönliche Daten. Wiederherstellung prüft den Bestand und wird beim nächsten Start mit Rückfallsicherung ausgeführt.</p>
    <button disabled={busy} onClick={() => {
      setBusy(true); setError('')
      void window.jarvis.invoke('backup:create').then(load).catch(err => setError(String(err))).finally(() => setBusy(false))
    }}>{busy ? 'Sichert …' : 'Jetzt sichern'}</button>{' '}
    <button onClick={() => { void window.jarvis.invoke('backup:openFolder').catch(err => setError(String(err))) }}>Sicherungsordner öffnen</button>
    {' '}<button disabled={busy || pendingRestore} onClick={() => {
      setBusy(true); setError(''); setNote('')
      void window.jarvis.invoke('backup:restore').then(async result => { setNote(result.detail); setPendingRestore((await window.jarvis.invoke('backup:restoreStatus')).pending) }).catch(err => setError(String(err))).finally(() => setBusy(false))
    }}>Sicherung wiederherstellen …</button>
    {pendingRestore && <p className="hint" role="status">Wiederherstellung für den nächsten Start vorgemerkt. <button onClick={() => void window.jarvis.invoke('backup:cancelRestore').then(() => { setPendingRestore(false); setNote('Wiederherstellung abgebrochen.') }).catch(err => setError(String(err)))}>Vorgemerkte Wiederherstellung abbrechen</button></p>}
    {note && <p className="hint" role="status">{note}</p>}
    {items.length > 0 && <p className="hint">Letzte Sicherung: {new Date(items[0].createdAt).toLocaleString('de-DE')} · {Math.ceil(items[0].bytes / 1024)} KB</p>}
    {error && <p role="alert" className="hint err">{error}</p>}
  </section>
}
