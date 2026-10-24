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
  const paused = useCrystal((s) => s.paused)
  const engineLabel = useCrystal((s) => s.engineLabel)
  const [now, setNow] = useState(Date.now())
  const busy = ['thinking', 'speaking', 'confirm', 'research', 'tool'].includes(state) || snapshot.items.some(i => i.status === 'running' || i.status === 'waiting')
  const latest = captions.at(-1)
  useEffect(() => {
    setNow(Date.now())
    if (busy || !latest) return
    const remaining = latest.at + FADE_MS - Date.now()
    if (remaining <= 0) return
    const timer = window.setTimeout(() => setNow(Date.now()), remaining + 20)
    return () => window.clearTimeout(timer)
  }, [busy, latest?.at, latest?.id])
  const lines = latest && (busy || now - latest.at < FADE_MS) ? [latest] : []

  const current = snapshot.items.find(s => s.source !== 'learning' && (s.status === 'running' || s.status === 'waiting'))
  const phase = paused ? 'Pausiert – klicke auf die Kugel, wenn du mich brauchst'
    : current ? (current.thought || current.label)
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
        <div className="live-status-copy"><small>{busy ? 'GERADE FÜR DICH' : engineLabel || 'JAMES IST DA'}</small><strong>{phase}</strong></div>
        {busy && <button className="live-stop" onClick={() => window.dispatchEvent(new Event('jarvis:interrupt'))}>Stoppen <kbd>Esc</kbd></button>}
      </header>
      {lines.map((line) => (
        <p key={line.id} className={`live-line live-line-${line.who}`}>
          <span className="live-who">{line.who === 'user' ? 'Du' : 'James'}</span>
          <span className="live-text" title={line.text}>{line.text}</span>
        </p>
      ))}

      {state === 'thinking' && !current && (
        <p className="live-line live-line-thinking">
          <span className="live-who">James</span>
          <span className="live-dots" aria-label="denkt nach"><i /><i /><i /></span>
        </p>
      )}

    </section>
  )
}
