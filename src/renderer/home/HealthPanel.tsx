import { useEffect, useState, type JSX } from 'react'
import type { SelfHealDashboard } from '@shared/types'
import { useCrystal } from '../store/crystalStore'

export function HealthPanel(): JSX.Element {
  const [health, setHealth] = useState<SelfHealDashboard | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const lastError = useCrystal(s => s.lastError)
  const state = useCrystal(s => s.state)
  const wake = useCrystal(s => s.wakeAvailable)
  const settings = useCrystal(s => s.settings)
  useEffect(() => {
    let disposed = false
    let pending = false
    const load = async (): Promise<void> => {
      if (pending) return
      pending = true
      try {
        const next = await window.jarvis.invoke('selfheal:status', { hours: 24 })
        if (!disposed) setHealth(next)
      } catch { if (!disposed) setNotice('Diagnose konnte nicht geladen werden.') }
      finally { pending = false }
    }
    void load()
    const timer = window.setInterval(() => void load(), 5000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [])
  const problems = health?.report.problems ?? []
  const runtimeError = state === 'error' ? lastError : null
  const wakeMissing = settings?.wake.enabled && wake === false
  const hasWakeProblem = problems.some(p => p.code === 'wake-modell-fehlt' || p.code === 'wakeword-fehler')
  const showWakeMissing = wakeMissing && !hasWakeProblem
  const count = problems.length + (runtimeError ? 1 : 0) + (showWakeMissing ? 1 : 0)
  const repair = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setNotice('Dienste werden geprüft und verfügbare Reparaturen ausgeführt …')
    try {
      const next = await window.jarvis.invoke('selfheal:repair')
      setHealth(next)
      const configurationBlocked = next.report.problems.some(p => /zugang-fehlt|anmeldung-fehlt/.test(p.code))
      if (!configurationBlocked) {
        setNotice('Sprachmotor wird neu aufgebaut und die Verbindung wird geprüft …')
        const detail = await new Promise<string>((resolve, reject) => {
          const timeout = window.setTimeout(() => reject(new Error('Der Sprachneustart hat zu lange gedauert.')), 35000)
          window.dispatchEvent(new CustomEvent('jarvis:repairVoice', { detail: {
            resolve: (result: string) => { window.clearTimeout(timeout); resolve(result) },
            reject: (error: unknown) => { window.clearTimeout(timeout); reject(error) }
          } }))
        })
        setNotice(`${detail} ${next.report.problems.length ? 'Weitere protokollierte Störungen stehen unten.' : ''}`)
        return
      }
      setNotice(next.report.problems.length
        ? `${next.report.problems.length} Störungen bleiben offen. Ein Zugang muss eingerichtet werden; ein Neustart kann fehlende Schlüssel nicht ersetzen.`
        : 'Prüfung abgeschlossen. Keine offenen protokollierten Störungen.')
    } catch (e) { setNotice(e instanceof Error ? e.message : 'Reparatur fehlgeschlagen.') }
    finally { setBusy(false) }
  }
  return <div className="health-control">
    <button className="home-chip health-toggle" data-error={count > 0} aria-expanded={open}
      onClick={() => setOpen(!open)}>{count ? `Fehler beheben · ${count}` : 'Fehler beheben'}</button>
    {open && <section className="health-popover" aria-label="Systemdiagnose">
      <div className="home-card-head"><span className="home-card-tag">Diagnose & Reparatur</span>
        <button className="home-nav-btn" onClick={() => setOpen(false)} aria-label="Diagnose schließen">×</button></div>
      <p>{count ? 'Fehler gefunden. Verfügbare Reparaturen jetzt ausführen?' : health ? 'Das Log wird überwacht. Prüfe die eingerichteten Dienste jederzeit.' : 'Diagnose wird geladen …'}</p>
      {runtimeError && <p role="alert">{runtimeError}</p>}
      {showWakeMissing && <p>Weckwort nicht bereit. Ein passender Klassifikator muss installiert werden. Klick und Hotkey funktionieren weiter.</p>}
      <div className="health-problems">{problems.map(p => <article key={`${p.area}:${p.code}`}>
        <strong>{p.area} · {p.count}×</strong><p>{p.message}</p>
        {p.attempted && <small>{p.attempted}</small>}
      </article>)}</div>
      <div className="health-buttons"><button className="home-btn-yes" disabled={busy} onClick={() => void repair()}>
        {busy ? 'Reparatur läuft …' : count ? 'Ja, reparieren' : 'Jetzt prüfen'}</button>
        <button className="home-nav-btn" onClick={() => {
          void window.jarvis.invoke('app:showLog').catch(() => setNotice('Log konnte nicht geöffnet werden.'))
        }}>Log öffnen</button></div>
      {count > 0 && <button className="home-nav-btn" onClick={() => {
        void window.jarvis.invoke('app:openSettings', { section: 'voice' }).catch(() => setNotice('Einstellungen konnten nicht geöffnet werden.'))
      }}>Zugänge und Stimme einrichten</button>}
      {notice && <p role="status" aria-live="polite">{notice}</p>}
      <SupportReport />
      <small>{health?.automatic ? 'Automatische Logüberwachung aktiv' : 'Logüberwachung wird gestartet'} · {health?.report.healed ?? 0} behoben / 24 h</small>
    </section>}
  </div>
}

/**
 * Support-Meldung: beschreiben, Vorschau ansehen, dann selbst senden.
 * Nichts geht von selbst raus — Mailprogramm, GitHub oder Zwischenablage.
 */
function SupportReport(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [diagnose, setDiagnose] = useState(true)
  const [preview, setPreview] = useState('')
  const [note, setNote] = useState('')
  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => {
      void window.jarvis.invoke('support:act', { action: 'preview', beschreibung: text, diagnose })
        .then(r => setPreview(`${r.subject}

${r.body}`)).catch(() => setPreview(''))
    }, 250)
    return () => window.clearTimeout(timer)
  }, [open, text, diagnose])
  const act = async (action: 'mail' | 'issue' | 'copy'): Promise<void> => {
    try {
      const r = await window.jarvis.invoke('support:act', { action, beschreibung: text, diagnose })
      setNote(r.tooLong ? 'Zu lang für das Mailprogramm. Nimm „Text kopieren“.'
        : action === 'copy' ? 'Kopiert. Füg den Text in eine Mail oder ein Issue ein.'
        : action === 'mail' ? 'Mailprogramm sollte offen sein. Empfänger eintragen, prüfen und selbst senden.'
        : 'GitHub ist offen. Prüfe den Text und sende das Issue selbst ab.')
    } catch { setNote('Das hat nicht geklappt. Markiere den Text in der Vorschau und kopiere ihn selbst.') }
  }
  if (!open) return <button className="home-nav-btn" onClick={() => setOpen(true)}>Hilfe und Support</button>
  return <section className="support-report" aria-label="Hilfe und Support">
    <strong>Was ist passiert?</strong>
    <textarea value={text} rows={3} maxLength={4000} onChange={e => setText(e.target.value)}
      placeholder="Zum Beispiel: Nach dem Weckwort antwortet James nicht." />
    <label><input type="checkbox" checked={diagnose} onChange={e => setDiagnose(e.target.checked)} />
      {' '}Technische Angaben anhängen (Version, System, offene Störungen; keine Logs oder Schlüssel)</label>
    <details><summary>Vorschau</summary><pre>{preview}</pre></details>
    <div className="health-buttons">
      <button className="home-btn-yes" onClick={() => void act('mail')}>Im Mailprogramm öffnen</button>
      <button className="home-nav-btn" onClick={() => void act('issue')}>Als GitHub-Issue</button>
      <button className="home-nav-btn" onClick={() => void act('copy')}>Text kopieren</button>
    </div>
    {note && <p role="status" aria-live="polite">{note}</p>}
  </section>
}
