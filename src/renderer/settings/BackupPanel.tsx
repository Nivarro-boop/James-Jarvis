import { useEffect, useState, type JSX } from 'react'
import type { BackupInfo, Settings } from '@shared/types'
import type { RecoveryPreview, RecoveryProfileResult } from '@shared/recovery'

function localName(path: string): string { return path.split(/[\\/]/).pop() ?? '' }

export function BackupPanel({settings, patch}: {settings: Settings; patch: (p: Partial<Settings>) => Promise<Settings>}): JSX.Element {
  const [items, setItems] = useState<BackupInfo[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<RecoveryPreview | null>(null)
  const [profile, setProfile] = useState<RecoveryProfileResult | null>(null)
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
    <p className="hint">Sichert James’ Datenbank, Einstellungen und Fertigkeiten. Keystore, Anmeldetokens, MCP-Umgebungswerte und das separate Hermes-Profil sind ausgenommen. Die Sicherungsdateien können persönliche Gesprächsdaten enthalten.</p>
    <button disabled={busy} onClick={() => {
      setBusy(true); setError('')
      void window.jarvis.invoke('backup:create').then(load).catch(err => setError(String(err))).finally(() => setBusy(false))
    }}>{busy ? 'Sichert …' : 'Jetzt sichern'}</button>{' '}
    <button disabled={busy} onClick={() => { void window.jarvis.invoke('backup:openFolder').catch(err => setError(String(err))) }}>Sicherungsordner öffnen</button>
    {items.length > 0 && <div className="hint">
      <p>Letzte Sicherung: {new Date(items[0].createdAt).toLocaleString('de-DE')} · {Math.ceil(items[0].bytes / 1024)} KB</p>
      <h4>In ein getrenntes Recovery-Profil wiederherstellen</h4>
      <p>Die laufende Installation und ihr Profil werden nicht überschrieben. Wähle eine lokale Sicherung für eine Integritäts- und Schema-Prüfung.</p>
      <ul>{items.map(item => {
        const fileName = localName(item.file)
        return <li key={fileName}>
          {fileName} · {new Date(item.createdAt).toLocaleString('de-DE')} · {Math.ceil(item.bytes / 1024)} KB{' '}
          <button disabled={busy} onClick={() => {
            setBusy(true); setError(''); setPreview(null); setProfile(null)
            void window.jarvis.invoke('recovery:preview', {fileName}).then(setPreview).catch(err => setError(String(err))).finally(() => setBusy(false))
          }}>Vorschau und prüfen</button>
        </li>
      })}</ul>
    </div>}
    {preview && <div className="hint" role="region" aria-label="Wiederherstellungsvorschau">
      <h4>Prüfung bestanden – bitte sorgfältig lesen</h4>
      <p>Datei: {preview.fileName}<br />Format {preview.backupFormat} v{preview.backupVersion} · App {preview.appVersion}<br />Erstellt: {new Date(preview.createdAt).toLocaleString('de-DE')}<br />Komprimiert: {preview.compressedBytes.toLocaleString('de-DE')} Byte · Datenbank: {preview.databaseBytes.toLocaleString('de-DE')} Byte<br />SQLite: {preview.integrity} · Tabellen: {preview.tables.join(', ')}<br />SHA-256: <code>{preview.digest}</code></p>
      <p>Enthalten: {preview.included.join('; ')}.</p>
      <p>Ausgeschlossen: {preview.excluded.join('; ')}.</p>
      {preview.warnings.map(warning => <p key={warning}>{warning}</p>)}
      {!profile && <button disabled={busy} onClick={() => {
        const message = `Ein neues Recovery-Profil aus „${preview.fileName}“ anlegen?\n\nDatenbank: ${preview.databaseBytes} Byte\nSHA-256: ${preview.digest}\n\nDas aktive Profil bleibt unverändert. Die Profilaktivierung erfolgt anschließend separat.`
        if (!window.confirm(message)) return
        setBusy(true); setError('')
        void window.jarvis.invoke('recovery:createProfile', {fileName: preview.fileName, digest: preview.digest, confirmed: true})
          .then(setProfile).catch(err => setError(String(err))).finally(() => setBusy(false))
      }}>{busy ? 'Erstelle isoliertes Profil …' : 'Recovery-Profil anlegen'}</button>}
    </div>}
    {profile && <div className="hint" role="status">
      <h4>Isoliertes Profil angelegt</h4>
      <p>Profilkennung: <code>{profile.profileId}</code><br />Prüfsumme: <code>{profile.digest}</code><br />Profilordner: <code>{profile.directory}</code></p>
      <p>Das bisherige Profil bleibt erhalten. Das Recovery-Profil enthält keine Schlüssel; Autostart, Diagnosen, Alexa, Telefonie, Fernbedienung, MCP und gespeicherte Scheduler-/Preisüberwachungsaktivierungen sind ausgeschaltet.</p>
      <p>Zum Wechsel bitte ausdrücklich unten bestätigen. James wird beendet und mit dem getrennten Profil neu gestartet; im Recovery-Profil werden keine Dienste automatisch aktiviert.</p>
      <button disabled={busy} onClick={() => {
        if (!window.confirm('James jetzt beenden und mit dem angezeigten getrennten Recovery-Profil neu starten? Das bisherige Profil bleibt unverändert.')) return
        setBusy(true); setError('')
        void window.jarvis.invoke('recovery:activateProfile', {profileId: profile.profileId, confirmed: true})
          .catch(err => { setBusy(false); setError(String(err)) })
      }}>Getrenntes Recovery-Profil jetzt starten</button>
    </div>}
    {error && <p role="alert" className="hint err">{error}</p>}
  </section>
}
