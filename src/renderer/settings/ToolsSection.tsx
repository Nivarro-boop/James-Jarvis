import { useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import type { Settings } from '@shared/types'
import { HealthPanel } from '../home/HealthPanel'
import { BrainMap } from '../home/BrainMap'
import { SkillsPanel } from '../home/SkillsPanel'

/**
 * Was früher als Knopfleiste auf der Startseite stand: Diagnose, Gehirn und
 * Fertigkeiten. Die Startseite zeigt nur noch den Status-Punkt.
 */
export function ToolsSection({ settings, patch }: {
  settings: Settings
  patch: (p: Partial<Settings>) => Promise<Settings>
}): JSX.Element {
  const [brainOpen, setBrainOpen] = useState(false)
  const [sendNote, setSendNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [sending, setSending] = useState(false)
  const report = settings.diagnosticReporting

  const sendNow = async (): Promise<void> => {
    setSending(true)
    try {
      const r = await window.jarvis.invoke('diagnostics:send')
      setSendNote({ ok: r.ok, text: r.ok ? 'Fehlerbericht gesendet. Danke!' : r.detail })
    } catch {
      setSendNote({ ok: false, text: 'Senden fehlgeschlagen.' })
    } finally { setSending(false) }
  }

  return (
    <>
      <h2>Diagnose &amp; Werkzeuge</h2>
      <p className="lede">Prüfen, ob alles läuft, Fehler melden und sehen, was James weiß und kann.</p>

      <h3 className="settings-step">Fehlerberichte</h3>
      <div className="field">
        <label style={{ fontWeight: 400 }}>
          <input type="checkbox" checked={report.enabled && report.automatic} style={{ width: 'auto', marginRight: 8 }}
            onChange={e => void patch({ diagnosticReporting: { ...report, enabled: e.target.checked, automatic: e.target.checked } })} />
          Fehler automatisch an das James-Team senden
        </label>
        <p className="hint">Gesendet werden Version, System und Art der Störung. Keine Gespräche, keine Logs, keine Schlüssel.</p>
        <button className="primary" disabled={sending || !report.enabled} onClick={() => void sendNow()}>
          {sending ? 'Sendet …' : 'Fehlerbericht jetzt senden'}
        </button>
        {!report.enabled && <p className="hint">Zum Senden zuerst das Häkchen oben setzen.</p>}
        {sendNote && <p role="status" className={sendNote.ok ? 'hint ok' : 'hint err'}>{sendNote.text}</p>}
      </div>

      <hr className="section-divider" />
      <div className="settings-tiles">
        <button className="settings-tile" onClick={() => setBrainOpen(true)}>
          <strong>Gehirn</strong><p>Projekte, Notizen, Tagesplan und was James sich gemerkt hat.</p><span>Öffnen ↗</span>
        </button>
        <button className="settings-tile" onClick={() => window.dispatchEvent(new Event('jarvis:skills'))}>
          <strong>Fertigkeiten</strong><p>Gelernte Abläufe ansehen, prüfen und verwalten.</p><span>Öffnen ↗</span>
        </button>
      </div>

      <hr className="section-divider" />
      <h3 className="settings-step">Fehler beheben</h3>
      <HealthPanel inline />

      {/* Ins body: Der Inhaltsbereich legt sonst den Rahmen für position: fixed fest. */}
      {brainOpen && createPortal(<BrainMap onClose={() => setBrainOpen(false)} />, document.body)}
      {createPortal(<SkillsPanel />, document.body)}
    </>
  )
}
