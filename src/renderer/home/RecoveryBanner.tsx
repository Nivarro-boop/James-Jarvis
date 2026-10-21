import { useEffect, useState, type JSX } from 'react'

export function RecoveryBanner(): JSX.Element | null {
  const [active, setActive] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let mounted = true
    void window.jarvis.invoke('recovery:status').then(status => { if (mounted) setActive(status.active) })
      .catch(() => { if (mounted) setError('Der Recovery-Profilstatus konnte nicht gelesen werden.') })
    return () => { mounted = false }
  }, [])
  if (!active && !error) return null
  const leave = async (): Promise<void> => {
    setBusy(true); setError('')
    try { await window.jarvis.invoke('recovery:returnToDefault', { confirmed: true }) }
    catch { setBusy(false); setError('Der Neustart wurde nicht ausgeführt. Das Originalprofil bleibt unverändert.') }
  }
  return <section className="recovery-banner" aria-label="Recovery-Profil" role="status">
    {active && <>
      <strong>Isoliertes Recovery-Profil · Prüfmodus</strong>
      <p>Das Originalprofil ist unverändert. KI, Mikrofon, Kalenderzugriffe, Telefonie, Zeitpläne, Downloads und automatische Updates sind hier gesperrt. Importierte Fertigkeiten und Zusatzdaten können als passives Archiv vorliegen; sie werden nicht automatisch ausgeführt oder an eine KI gesendet.</p>
      <p>Aufgaben, Board und deklarative Pack-Widgets kannst du lokal prüfen. Dies ist noch kein automatischer Austausch des Originalprofils.</p>
      {!confirm ? <button type="button" onClick={() => setConfirm(true)}>Zurück zum Originalprofil …</button> : <div>
        <p>James wird neu gestartet und öffnet das bisherige Originalprofil. Das getrennte Recovery-Profil bleibt erhalten.</p>
        <button type="button" disabled={busy} onClick={() => void leave()}>{busy ? 'Startet neu …' : 'Neustart ins Originalprofil bestätigen'}</button>{' '}
        <button type="button" disabled={busy} onClick={() => setConfirm(false)}>Abbrechen</button>
      </div>}
    </>}
    {error && <p role="alert">{error}</p>}
  </section>
}
