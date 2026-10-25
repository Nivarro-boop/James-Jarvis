import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { LocalAsset, LocalAssetId, LocalInstallProgress } from '@shared/types'
import { useCrystal } from '../store/crystalStore'

/**
 * Der erste Start: James lädt Stimme und Gehör im Hintergrund, und in der
 * Zwischenzeit lassen sich ChatGPT und WhatsApp verbinden. Verschwindet von
 * selbst, sobald alles Nötige auf dem Rechner liegt.
 */
const DISMISSED = 'james.firstRun.dismissed'

export function FirstRun({ ready }: { ready: boolean }): JSX.Element | null {
  const settings = useCrystal(s => s.settings)
  const [assets, setAssets] = useState<LocalAsset[] | null>(null)
  const [progress, setProgress] = useState<Partial<Record<LocalAssetId, LocalInstallProgress>>>({})
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [, tick] = useState(0)
  const [chatgpt, setChatgpt] = useState<'unknown' | 'connected' | 'missing' | 'busy'>('unknown')
  const [whatsapp, setWhatsapp] = useState<'unknown' | 'connected' | 'missing' | 'busy'>('unknown')
  /** `hidden`: dieser Build hat keinen eingebauten Google-Zugang, dann gehört die Zeile nicht hierher. */
  const [google, setGoogle] = useState<'unknown' | 'connected' | 'missing' | 'busy' | 'hidden'>('unknown')
  const [error, setError] = useState('')
  // „Später einrichten“ gilt auch beim nächsten Start; die Konten bleiben unter Einstellungen erreichbar.
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISSED) === '1' } catch { return false }
  })
  const alive = useRef(true)
  const loginRun = useRef(0)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const deadlineTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const downloadBatch = useRef<LocalAsset[] | null>(null)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false; ++loginRun.current
      if (pollTimer.current) clearTimeout(pollTimer.current)
      if (deadlineTimer.current) clearTimeout(deadlineTimer.current)
    }
  }, [])

  useEffect(() => {
    let alive = true
    const load = (): void => { void window.jarvis.invoke('local:assets').then(a => {
      if (alive) { downloadBatch.current ??= a.filter(asset => !asset.present); setAssets(a) }
    }).catch(() => { if (alive) setError('Downloads konnten nicht geprüft werden. Öffne die Einstellungen und versuche es erneut.') }) }
    load()
    const off = window.jarvis.on('local:progress', p => {
      setStartedAt(s => s ?? Date.now())
      setProgress(prev => ({ ...prev, [p.id]: p }))
      if (p.done || p.error) load()
    })
    void window.jarvis.invoke('chatgpt:status').then(s => { if (alive) setChatgpt(s.connected ? 'connected' : 'missing') }).catch(() => setChatgpt('missing'))
    void window.jarvis.invoke('google:status').then(s => {
      if (alive) setGoogle(s.connected ? 'connected' : s.clientReady ? 'missing' : 'hidden')
    }).catch(() => setGoogle('hidden'))
    void window.jarvis.invoke('connect:status').then(list => {
      if (alive) setWhatsapp(list.find(c => c.id === 'whatsapp')?.ok ? 'connected' : 'missing')
    }).catch(() => setWhatsapp('missing'))
    return () => { alive = false; off() }
  }, [])

  const missing = useMemo(() => (assets ?? []).filter(a => !a.present), [assets])
  useEffect(() => {
    if (!missing.length || !startedAt) return
    const timer = window.setInterval(() => tick(n => n + 1), 1000)
    return () => window.clearInterval(timer)
  }, [missing.length, startedAt])

  // Mit ChatGPT verbunden, Stimme und Gehör da, aber noch kein anderer Zugang:
  // dann denkt James über das Abo.
  useEffect(() => {
    if (!settings || ready || chatgpt !== 'connected' || missing.length || !assets) return
    void window.jarvis.invoke('settings:set', { brainProvider: 'chatgpt', speech: { ...settings.speech,
      provider: 'piper', thinkProvider: 'chatgpt', hearProvider: 'whisper' } }).catch(() => undefined)
  }, [settings, ready, chatgpt, missing.length, assets])

  // Downloads können vor der Anmeldung fertig sein. Die Kontoknöpfe müssen
  // dann erreichbar bleiben, bis der Nutzer fertig ist oder überspringt.
  if (!assets || (!missing.length && (ready || dismissed))) return null

  const batch = downloadBatch.current ?? missing
  const total = batch.reduce((n, a) => n + (progress[a.id]?.total || a.bytes), 0)
  const received = batch.reduce((n, a) => n + (assets.find(asset => asset.id === a.id)?.present ? (progress[a.id]?.total || a.bytes) : progress[a.id]?.received ?? 0), 0)
  const percent = total ? Math.min(100, Math.round(received / total * 100)) : 0
  const failed = missing.map(a => progress[a.id]?.error).find(Boolean)
  const running = Boolean(startedAt) && !failed
  const seconds = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0
  const size = (bytes: number): string => bytes > 1e9 ? `${(bytes / 1e9).toFixed(1).replace('.', ',')} GB` : `${Math.round(bytes / 1e6)} MB`

  const retry = (): void => {
    setError('')
    void (async () => {
      for (const asset of missing) await window.jarvis.invoke('local:install', { id: asset.id })
    })().catch(e => setError(e instanceof Error ? e.message : String(e)))
  }
  const connectChatgpt = (): void => {
    setChatgpt('busy'); setError('')
    void window.jarvis.invoke('chatgpt:connect').then(r => {
      setChatgpt(r.ok ? 'connected' : 'missing')
      if (!r.ok && r.error) setError(r.error)
    }).catch(e => { setChatgpt('missing'); setError(String(e)) })
  }
  const connectGoogle = (): void => {
    setGoogle('busy'); setError('')
    void window.jarvis.invoke('google:connect').then(r => {
      setGoogle(r.ok ? 'connected' : 'missing')
      if (!r.ok && r.error) setError(r.error)
    }).catch(e => { setGoogle('missing'); setError(String(e)) })
  }
  const connectWhatsapp = (): void => {
    const run = ++loginRun.current
    if (pollTimer.current) clearTimeout(pollTimer.current)
    if (deadlineTimer.current) clearTimeout(deadlineTimer.current)
    const current = (): boolean => alive.current && run === loginRun.current
    const finish = (connected: boolean): void => {
      if (!current()) return
      ++loginRun.current
      if (pollTimer.current) clearTimeout(pollTimer.current)
      if (deadlineTimer.current) clearTimeout(deadlineTimer.current)
      setWhatsapp(connected ? 'connected' : 'missing')
      if (!connected) setError('Verbindung nicht bestätigt. Du kannst den QR-Code erneut öffnen.')
    }
    setWhatsapp('busy'); setError('')
    deadlineTimer.current = setTimeout(() => finish(false), 120_000)
    void window.jarvis.invoke('connect:login', { target: 'whatsapp' }).then(r => {
      if (!current()) return
      if (!r.ok) { finish(false); if (r.error) setError(r.error); return }
      const poll = async (): Promise<void> => {
        if (!current()) return
        try {
          const list = await window.jarvis.invoke('connect:status')
          if (!current()) return
          if (list.find(c => c.id === 'whatsapp')?.ok) { finish(true); return }
        } catch { /* retry until the absolute deadline, also on errors */ }
        if (current()) pollTimer.current = setTimeout(() => { void poll() }, 5000)
      }
      void poll()
    }).catch(e => { if (current()) { finish(false); setError(String(e)) } })
  }

  return <section className="first-run" aria-label="James richtet sich ein">
    <header className="first-run-head">
      <span className="first-run-spinner" aria-hidden="true" />
      <div>
        <small>JAMES</small>
        <h2>{missing.length ? 'James richtet sich ein' : 'Bei deinem Konto anmelden'}</h2>
        <p>{missing.length ? 'Stimme und Gehör vorbereiten. Deine Konten kannst du daneben verbinden.' : 'Mit ChatGPT anmelden und James über dein Abo nutzen. Weitere Konten sind optional.'}</p>
      </div>
    </header>

    {missing.length > 0 && <div className="first-run-row" data-active="true">
      <div className="first-run-line">
        <span>Stimme und Gehör laden</span>
        <em>{failed ? 'unterbrochen' : running ? `läuft seit ${seconds} s` : 'startet gleich'}</em>
      </div>
      <div className="first-run-bar" role="progressbar" aria-label="Stimme und Gehör herunterladen" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <i style={{ width: `${Math.max(percent, running ? 3 : 0)}%` }} />
      </div>
      <p>{failed ? failed : `Zusammen etwa ${size(total)}, im Hintergrund. ${percent ? `${percent} % geladen.` : ''}`}</p>
      {failed && <button className="first-run-btn" onClick={retry}>Erneut versuchen</button>}
    </div>}

    <div className="first-run-row">
      <div className="first-run-line">
        <span>Mit ChatGPT verbinden</span>
        <em>{chatgpt === 'connected' ? 'verbunden · Abo' : chatgpt === 'busy' ? 'im Browser anmelden …' : 'optional'}</em>
      </div>
      <p>James denkt dann über dein ChatGPT-Abo. Kein API-Schlüssel nötig.</p>
      {chatgpt === 'missing' && <button className="first-run-btn" onClick={connectChatgpt}>Mit ChatGPT verbinden</button>}
    </div>

    {google !== 'hidden' && google !== 'unknown' && <div className="first-run-row">
      <div className="first-run-line">
        <span>Mit Google anmelden</span>
        <em>{google === 'connected' ? 'angemeldet' : google === 'busy' ? 'im Browser anmelden …' : 'optional'}</em>
      </div>
      <p>Für Gmail, Kalender, Drive und Aufgaben. Dein Passwort gibst du nur bei Google ein.</p>
      {google === 'missing' && <button className="first-run-btn" onClick={connectGoogle}>Mit Google anmelden</button>}
    </div>}

    <div className="first-run-row">
      <div className="first-run-line">
        <span>WhatsApp verbinden</span>
        <em>{whatsapp === 'connected' ? 'verbunden' : whatsapp === 'busy' ? 'QR-Code scannen …' : 'optional'}</em>
      </div>
      <p>Einmal den QR-Code mit dem Handy scannen. Danach liest und schreibt James Nachrichten auf deinen Auftrag.</p>
      {whatsapp === 'missing' && <button className="first-run-btn" onClick={connectWhatsapp}>WhatsApp verbinden</button>}
    </div>

    {error && <p className="first-run-error" role="alert">{error}</p>}
    {!missing.length && <button className="first-run-btn" onClick={() => {
      try { localStorage.setItem(DISMISSED, '1') } catch { /* nur für diese Sitzung */ }
      setDismissed(true)
    }}>Später einrichten</button>}
    <footer>Stimme und Gehör laufen lokal. Verbundene Onlinedienste erhalten die Daten, die sie für deine Aufträge benötigen.</footer>
  </section>
}
