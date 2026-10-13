import { useEffect, useState, type JSX } from 'react'
import type { ActivitySnapshot } from '@shared/types'
import { useCrystal } from '../store/crystalStore'

/**
 * Die Live-Bühne unter der Kugel.
 *
 * Wie bei ChatGPT Voice sieht man in der Mitte, was gerade passiert: was du
 * gesagt hast, was James antwortet, und als Spur die Schritte, die er dabei
 * ausführt — laufend pulsierend, erledigt mit Haken, gescheitert mit Kreuz.
 * Alte Zeilen verblassen von selbst, damit die Mitte ruhig bleibt.
 */

/** Nach so langer Ruhe verschwinden Untertitel und Spur. */
const FADE_MS = 25_000

export function LiveStage({ snapshot }: { snapshot: ActivitySnapshot }): JSX.Element | null {
  const captions = useCrystal((s) => s.captions)
  const state = useCrystal((s) => s.state)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const busy = ['thinking', 'speaking', 'confirm', 'research', 'tool'].includes(state) || snapshot.items.some(i => i.status === 'running' || i.status === 'waiting')
  const lines = captions.filter((c) => busy || now - c.at < FADE_MS).slice(-1)
  const steps = snapshot.items
    .filter((i) => i.source !== 'learning')
    .filter((i) => i.status === 'running' || i.status === 'waiting' || now - (i.startedAt + (i.durationMs ?? 0)) < FADE_MS)
    .slice(0, 4)
    .reverse()

  const current = steps.find(s => s.status === 'running' || s.status === 'waiting')
  const phase = current ? (current.thought || current.label)
    : state === 'thinking' ? 'Auftrag wird bearbeitet'
    : state === 'speaking' ? 'Antwort wird gesprochen'
    : state === 'connecting' ? 'Verbindung wird aufgebaut'
    : state === 'error' ? 'Fehler – Diagnose öffnen'
    : state === 'confirm' ? 'Wartet auf deine Freigabe'
    : state === 'paused' ? 'Pausiert – klicke auf die Kugel, wenn du mich brauchst'
    : state === 'offline' ? 'Verbindung fehlt – lokale Funktionen bleiben verfügbar'
    : state === 'listening' ? 'Ich höre dir zu' : 'Bereit, wenn du mich brauchst'

  return (
    <section className="live-stage" aria-label="Live-Ansicht" aria-live="polite">
      <header className="live-stage-head"><span className="live-status-dot" data-busy={busy} />
        <div className="live-status-copy"><small>{busy ? 'GERADE FÜR DICH' : 'JAMES'}</small><strong>{phase}</strong></div>
        {busy && <button className="home-nav-btn" onClick={() => window.dispatchEvent(new Event('jarvis:interrupt'))}>Stoppen</button>}
      </header>
      {lines.map((line) => (
        <p key={line.id} className={`live-line live-line-${line.who}`}>
          <span className="live-who">{line.who === 'user' ? 'Du' : 'James'}</span>
          <span className="live-text">{line.text}</span>
        </p>
      ))}

      {state === 'thinking' && steps.every((s) => s.status !== 'running') && (
        <p className="live-line live-line-thinking">
          <span className="live-who">James</span>
          <span className="live-dots" aria-label="denkt nach"><i /><i /><i /></span>
        </p>
      )}

    </section>
  )
}
