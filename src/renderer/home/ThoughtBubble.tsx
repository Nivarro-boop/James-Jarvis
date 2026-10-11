import { useEffect, useState, type JSX } from 'react'
import type { ActivityItem, ActivitySnapshot } from '@shared/types'

/**
 * Die Denkblase an der Kugel.
 *
 * Die Live-Anzeige rechts ist eine Liste für den, der genau hinschaut. Die
 * Blase ist für den Blick nebenbei: Sie sagt in einem Satz, was James gerade
 * vorhat — „Öffne NoRisk Client …" — und zeigt dabei das echte Programmsymbol,
 * wenn es eins gibt. Nach dem Schritt bleibt sie noch kurz stehen, damit man
 * sie auch bei schnellen Werkzeugen zu sehen bekommt.
 */

/** So lange bleibt die Blase nach dem Ende eines Schritts noch sichtbar. */
const AFTERGLOW_MS = 3500

function pick(items: ActivityItem[], now: number): ActivityItem | null {
  const visible = items.filter((i) => i.source !== 'learning')
  const running = visible.find((i) => i.status === 'running' || i.status === 'waiting')
  if (running) return running
  const last = visible[0]
  if (last && last.durationMs !== undefined && now - (last.startedAt + last.durationMs) < AFTERGLOW_MS) return last
  return null
}

export function ThoughtBubble({ snapshot }: { snapshot: ActivitySnapshot }): JSX.Element | null {
  const [now, setNow] = useState(Date.now())
  const item = pick(snapshot.items, now)

  // Nur ticken, solange eine Blase steht — sonst weckt sie React im Sekundentakt für nichts.
  useEffect(() => {
    if (!item) return
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [item?.id, item?.status])

  // Ein neuer Schritt soll sofort zählen, nicht erst beim nächsten Takt.
  useEffect(() => setNow(Date.now()), [snapshot])

  if (!item) return null
  const text = item.thought ?? item.label
  const done = item.status === 'ok'
  const failed = item.status === 'error'

  return (
    <div className="thought" data-status={item.status} key={item.id} role="status" aria-live="polite">
      <div className="thought-cloud">
        {item.icon ? (
          <img className="thought-icon" src={item.icon} alt="" />
        ) : (
          <span className="thought-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        )}
        <span className="thought-text">
          {failed ? `Hat nicht geklappt: ${item.detail ?? text}` : done ? text.replace(/\s*…$/, ' — erledigt') : text}
        </span>
      </div>
      <span className="thought-tail thought-tail-1" aria-hidden="true" />
      <span className="thought-tail thought-tail-2" aria-hidden="true" />
    </div>
  )
}
