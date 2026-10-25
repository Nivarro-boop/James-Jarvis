import { useEffect, useState, type JSX } from 'react'
import { ICLOUD_SERVICE_IDS, ICLOUD_SERVICE_LABELS, isAppleMailDomain, type ICloudCheck, type ICloudService, type ICloudStatus } from '@shared/icloud'

/**
 * Apple iCloud an einem Ort: Anmeldung im James-Browser für alle Web-Apps,
 * dazu der direkte Zugang für Mail und Kalender per app-spezifischem Passwort
 * und der Drive-Ordner von „iCloud für Windows“.
 */
export function ICloudPanel(): JSX.Element {
  const [status, setStatus] = useState<ICloudStatus | null>(null)
  const [address, setAddress] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [check, setCheck] = useState<ICloudCheck | null>(null)

  const run = async (task: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setNote(null)
    try { await task() } catch (err) { setNote({ ok: false, text: plain(err) }) } finally { setBusy(false) }
  }

  useEffect(() => {
    void window.jarvis.invoke('icloud:status').then((next) => { setStatus(next); setAddress(next.mailAddress ?? '') }).catch(() => undefined)
  }, [])

  const signIn = (): Promise<void> => run(async () => {
    const result = await window.jarvis.invoke('connect:login', { target: 'icloud' })
    setNote(result.ok
      ? { ok: true, text: 'iCloud ist rechts im James-Hauptfenster geöffnet. Dort mit dem Apple Account anmelden und auf dem iPhone bestätigen. Danach hier „Status aktualisieren“.' }
      : { ok: false, text: `Der Browser ließ sich nicht öffnen: ${result.error ?? 'unbekannter Fehler'}` })
  })

  const refresh = (): Promise<void> => run(async () => { setStatus(await window.jarvis.invoke('icloud:status')) })

  const open = (service: ICloudService): Promise<void> => run(async () => {
    const result = await window.jarvis.invoke('icloud:open', { service })
    if (!result.ok) setNote({ ok: false, text: result.error ?? 'Ließ sich nicht öffnen.' })
  })

  const save = (): Promise<void> => run(async () => {
    const next = await window.jarvis.invoke('icloud:save', { address, password })
    setPassword('')
    setStatus(next)
    const result = await window.jarvis.invoke('icloud:check')
    setCheck(result)
    setNote(result.mail.ok
      ? { ok: true, text: 'Gespeichert und mit Apple bestätigt. James liest jetzt Mail und Kalender direkt.' }
      : { ok: false, text: `Gespeichert, aber Apple hat nicht bestätigt: ${result.mail.detail}` })
  })

  const test = (): Promise<void> => run(async () => { setCheck(await window.jarvis.invoke('icloud:check')) })

  const forget = (): Promise<void> => run(async () => {
    setStatus(await window.jarvis.invoke('icloud:forget'))
    setCheck(null)
    setNote({ ok: true, text: 'App-spezifisches Passwort entfernt. Widerrufe es zusätzlich unter account.apple.com, wenn du es nicht mehr brauchst.' })
  })

  const signOut = (): Promise<void> => run(async () => {
    setStatus(await window.jarvis.invoke('icloud:signOutWeb'))
    setNote({ ok: true, text: 'Im James-Browser von iCloud abgemeldet.' })
  })

  const drive = (): Promise<void> => run(async () => {
    const result = await window.jarvis.invoke('icloud:openDrive')
    if (!result.ok) setNote({ ok: false, text: result.error ?? 'Ordner ließ sich nicht öffnen.' })
  })

  return (
    <section className="icloud-panel" aria-label="Apple iCloud">
      <h3>Apple iCloud</h3>

      <div className="icloud-status" role="status">
        <span className={status?.web ? 'badge ok' : 'badge missing'}>{status?.web ? 'Browser angemeldet' : 'Browser nicht angemeldet'}</span>
        <span className={status?.mailConfigured ? 'badge ok' : 'badge missing'}>{status?.mailConfigured ? 'Mail & Kalender direkt' : 'Mail & Kalender nur im Browser'}</span>
        <span className={status?.drivePath ? 'badge ok' : 'badge missing'}>{status?.drivePath ? 'iCloud Drive auf diesem PC' : 'Drive nur im Browser'}</span>
      </div>

      <h4>1 · Mit Apple Account anmelden</h4>
      <p className="hint">
        Öffnet iCloud rechts in James. Passwort und Bestätigungscode gibst du nur dort bei Apple ein — James sieht sie nicht.
        Danach sind alle iCloud-Apps offen: Mail, Kalender, Drive, Fotos, Kontakte, Notizen, Erinnerungen, Pages, Numbers, Keynote und „Wo ist?“.
      </p>
      <div className="row">
        <button className="primary" onClick={() => void signIn()} disabled={busy}>{status?.web ? 'iCloud öffnen' : 'Mit Apple Account anmelden'}</button>
        <button className="ghost" onClick={() => void refresh()} disabled={busy}>Status aktualisieren</button>
        {status?.web && <button className="ghost" onClick={() => void signOut()} disabled={busy}>Im Browser abmelden</button>}
      </div>
      <div className="icloud-services" role="group" aria-label="iCloud-Apps öffnen">
        {ICLOUD_SERVICE_IDS.map((service) => (
          <button key={service} type="button" onClick={() => void open(service)} disabled={busy}>{ICLOUD_SERVICE_LABELS[service]}</button>
        ))}
      </div>

      <h4>2 · Mail und Kalender direkt (empfohlen)</h4>
      <p className="hint">
        Damit liest James iCloud Mail und alle iCloud-Kalender ohne offenen Browser und kann Mails schicken — immer erst nach deiner Bestätigung.
        Apple verlangt dafür ein <strong>app-spezifisches Passwort</strong>: account.apple.com → Anmeldung und Sicherheit →
        App-spezifische Passwörter → „James“. Dein Apple-Account-Passwort gehört hier nicht hinein.
      </p>
      <div className="field">
        <label htmlFor="icloud-address">iCloud-Mailadresse</label>
        <input id="icloud-address" type="email" autoComplete="off" spellCheck={false} placeholder="name@icloud.com"
          value={address} onChange={(e) => setAddress(e.target.value)} />
        {address && !isAppleMailDomain(address) && (
          <div className="hint">Keine @icloud.com-, @me.com- oder @mac.com-Adresse. Das geht nur mit eigener Domain über iCloud+.</div>
        )}
        <label htmlFor="icloud-password">App-spezifisches Passwort</label>
        <input id="icloud-password" type="password" autoComplete="off" spellCheck={false}
          placeholder={status?.mailConfigured ? 'gespeichert — zum Ändern neu eintragen' : 'abcd-efgh-ijkl-mnop'}
          value={password} onChange={(e) => setPassword(e.target.value)} />
        <div className="row">
          <button className="primary" onClick={() => void save()} disabled={busy || !address.trim() || !password.trim()}>Speichern und prüfen</button>
          {status?.mailConfigured && <button className="ghost" onClick={() => void test()} disabled={busy}>Verbindung prüfen</button>}
          {status?.mailConfigured && <button className="ghost" onClick={() => void forget()} disabled={busy}>Passwort entfernen</button>}
        </div>
        {check && (
          <ul className="icloud-check">
            <li className={check.mail.ok ? 'ok' : 'err'}>Mail: {check.mail.detail}</li>
            <li className={check.calendar.ok ? 'ok' : 'err'}>Kalender: {check.calendar.detail}</li>
          </ul>
        )}
      </div>

      <h4>3 · iCloud Drive</h4>
      <p className="hint">
        {status?.drivePath
          ? 'Gefunden: Der iCloud-Drive-Ordner von „iCloud für Windows“. James kann darin suchen und Textdateien lesen.'
          : 'Für Dateizugriff ohne Browser „iCloud für Windows“ aus dem Microsoft Store installieren und iCloud Drive einschalten. Bis dahin öffnet James Drive im Browser.'}
      </p>
      <div className="row">
        {status?.drivePath && <button onClick={() => void drive()} disabled={busy}>Drive-Ordner öffnen</button>}
        <button className="ghost" onClick={() => void open('drive')} disabled={busy}>Drive im Browser</button>
      </div>

      {note && <p className={note.ok ? 'hint' : 'hint warn'} role="status">{note.text}</p>}
      <p className="hint">
        Zum Beispiel: „Habe ich neue Mails in iCloud?“, „Was steht morgen in meinem iCloud-Kalender?“, „Such in iCloud Drive nach der Einkaufsliste.“
        Apple Health teilst du in der nativen James-App auf dem iPhone; über iCloud.com ist Health nicht verfügbar.
      </p>
    </section>
  )
}

/** Electron setzt „Error invoking remote method …“ vor jede Meldung aus dem Hauptprozess. */
function plain(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
