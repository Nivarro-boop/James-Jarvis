import { useEffect, useState, type JSX } from 'react'
import type { CrystalState, SipStatus, UpdateStatus } from '@shared/types'

/**
 * Update-Leiste und Telefonanzeige auf der Startseite.
 *
 * Update: Gefunden wird beim Start. Während des Ladens steht der Fortschritt
 * da, danach zählt die Leiste fünfzehn Sekunden herunter und spielt das
 * Update ein — aber nur, solange James gerade nichts tut. Redet er, wartet
 * die Uhr. „Später" heißt: beim Beenden.
 */

const COUNTDOWN_S = 15

export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    void window.jarvis.invoke('update:get').then(setStatus).catch(() => undefined)
    return window.jarvis.on('update:status', setStatus)
  }, [])
  return status
}

export function UpdateBar({ status, state }: { status: UpdateStatus | null; state: CrystalState }): JSX.Element | null {
  const [left, setLeft] = useState(COUNTDOWN_S)
  const idle = state === 'idle' || state === 'paused'
  const counting = status?.state === 'ready' && !status.postponed

  useEffect(() => {
    if (!counting) {
      setLeft(COUNTDOWN_S)
      return
    }
    const timer = window.setInterval(() => {
      // Nur in der Ruhe zählen: Mitten in einer Antwort neu zu starten wäre
      // genau die Überraschung, die ein Update nicht sein soll.
      if (!idle) return
      setLeft((n) => Math.max(0, n - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [counting, idle])

  useEffect(() => {
    if (counting && left === 0) void window.jarvis.invoke('update:installNow')
  }, [counting, left])

  if (!status) return null
  if (status.state === 'downloading') {
    return (
      <div className="update-bar" role="status">
        <span className="update-tag">Update</span>
        <span>
          Version {status.version} wird automatisch geladen … {status.percent ?? 0} %
        </span>
        <div className="update-progress" aria-hidden="true">
          <span style={{ width: `${status.percent ?? 0}%` }} />
        </div>
      </div>
    )
  }
  if (status.state === 'installing') {
    return (
      <div className="update-bar" role="status">
        <span className="update-tag">Update</span>
        <span>Version {status.version} wird eingespielt — James startet gleich neu.</span>
      </div>
    )
  }
  if (status.state === 'ready') {
    return (
      <div className="update-bar update-ready" role="status">
        <span className="update-tag">Update</span>
        <span>
          {status.postponed
            ? `Version ${status.version} wird beim Beenden eingespielt.`
            : idle
              ? `Version ${status.version} ist geladen und wird in ${left} s eingespielt.`
              : `Version ${status.version} ist geladen — eingespielt wird, sobald James fertig ist.`}
        </span>
        <span className="update-actions">
          <button className="home-btn-pop" onClick={() => void window.jarvis.invoke('update:installNow')}>
            Jetzt
          </button>
          {!status.postponed && (
            <button className="update-later" onClick={() => void window.jarvis.invoke('update:postpone')}>
              Später
            </button>
          )}
        </span>
      </div>
    )
  }
  return null
}

/**
 * Linphone auf einen Blick: angemeldet, und ob gerade telefoniert wird.
 *
 * Ein Telefonat läuft im Hauptprozess, die Kugel merkt davon nichts — ohne
 * diese Anzeige sah es am Rechner so aus, als täte James gar nichts.
 */
export function useSipStatus(): SipStatus | null {
  const [status, setStatus] = useState<SipStatus | null>(null)
  useEffect(() => {
    let disposed = false
    const load = (): void => {
      void window.jarvis
        .invoke('sip:status')
        .then((s) => !disposed && setStatus(s))
        .catch(() => undefined)
    }
    load()
    const timer = window.setInterval(load, 3000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [])
  return status
}

export function SipChip({ status }: { status: SipStatus | null }): JSX.Element | null {
  if (!status?.enabled) return null
  if (status.inCall) {
    return (
      <span className="home-chip home-chip-live" title="James telefoniert gerade über Linphone">
        Telefonat läuft
      </span>
    )
  }
  return (
    <span
      className={`home-chip${status.registered ? '' : ' home-chip-off'}`}
      title={status.lastCall ? `${status.detail} Letzter Anruf: ${status.lastCall}` : status.detail}
    >
      {status.registered ? 'Linphone' : 'Linphone getrennt'}
    </span>
  )
}
