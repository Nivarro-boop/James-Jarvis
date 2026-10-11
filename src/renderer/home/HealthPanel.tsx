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
      <small>{health?.automatic ? 'Automatische Logüberwachung aktiv' : 'Logüberwachung wird gestartet'} · {health?.report.healed ?? 0} behoben / 24 h</small>
    </section>}
  </div>
}
