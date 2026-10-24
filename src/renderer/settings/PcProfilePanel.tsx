import { useEffect, useState, type JSX } from 'react'
import type { Settings } from '@shared/types'
import type { PcProfileStatus } from '@shared/ipc'

/** PC-Einlesen und Tagesbriefing: beides macht James persönlicher. */
export function PcProfilePanel({settings, patch}: {settings: Settings; patch: (p: Partial<Settings>) => Promise<Settings>}): JSX.Element {
  const [status, setStatus] = useState<PcProfileStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void window.jarvis.invoke('pc:status').then(s => { if (active) setStatus(s) }).catch(e => { if (active) setError(String(e)) })
    return () => { active = false }
  }, [])
  const run = (channel: 'pc:rescan' | 'pc:clear'): void => {
    setBusy(true); setError('')
    void window.jarvis.invoke(channel).then(setStatus).catch(err => setError(String(err))).finally(() => setBusy(false))
  }
  return <section className="field" aria-label="Persönlicher machen">
    <h3>Persönlicher machen</h3>
    <label><input type="checkbox" checked={settings.pcProfile} style={{width:'auto', marginRight:8}}
      onChange={e => { void patch({pcProfile:e.target.checked}).catch(err => setError(String(err))) }} />
      Computer kennenlernen, wenn James im Vordergrund ist</label>
    <p className="hint">Liest Programme, Ordner, zuletzt benutzte Dateien und kurze Ausschnitte aus Textdokumenten
      (.txt, .md, .docx und weitere Textformate). Gründlich einmal am Tag, die letzten Dateien alle 30 Minuten.
      Das Profil wird lokal gespeichert. Eine Kurzfassung und angefragte Suchtreffer können an den gewählten
      Modellanbieter übermittelt werden. Ein Dateinamenfilter überspringt erkennbar sensible Namen,
      erkennt aber keine vertraulichen Inhalte zuverlässig.</p>
    {status?.scannedAt
      ? <p className="hint">Zuletzt eingelesen: {new Date(status.scannedAt).toLocaleString('de-DE')} · {status.programs} Programme · {status.files} Dateien · {status.documents} Dokumente</p>
      : <p className="hint">Noch nichts eingelesen.</p>}
    <button disabled={busy || !settings.pcProfile} onClick={() => run('pc:rescan')}>{busy ? 'Liest ein …' : 'Jetzt einlesen'}</button>{' '}
    <button disabled={busy || !status?.scannedAt} onClick={() => run('pc:clear')}>Eingelesenes löschen</button>
    <label style={{marginTop:12}}><input type="checkbox" checked={settings.dailyBriefing} style={{width:'auto', marginRight:8}}
      onChange={e => { void patch({dailyBriefing:e.target.checked}).catch(err => setError(String(err))) }} />
      Tagesbriefing beim ersten Öffnen am Tag</label>
    <p className="hint">Termine, wichtige Mails, fällige Aufgaben und offene Projektschritte als Karte auf der Startseite.</p>
    {error && <p role="alert" className="hint err">{error}</p>}
  </section>
}
