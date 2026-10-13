import { useEffect, useState, type FormEvent } from 'react'
import type { WebsiteAccountInfo } from '@shared/websiteAccounts'

export function WebsiteAccounts() {
  const [accounts, setAccounts] = useState<WebsiteAccountInfo[]>([])
  const [loginUrl, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  useEffect(() => { let alive = true; void window.jarvis.invoke('accounts:list').then(a => { if (alive) setAccounts(a) }).catch(() => { if (alive) setNote('Konten konnten nicht geladen werden.') }); return () => { alive = false } }, [])
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setNote('')
    try {
      setAccounts(await window.jarvis.invoke('accounts:save', { loginUrl: loginUrl.trim(), username, password }))
      setPassword(''); setUsername(''); setUrl(''); setNote('Konto verschlüsselt gespeichert. Jarvis kann sich auf deinen Auftrag dort anmelden.')
    } catch (e) { setNote(e instanceof Error ? e.message : 'Speichern fehlgeschlagen.') }
    finally { setBusy(false) }
  }
  async function remove(origin: string) {
    setBusy(true); setNote('')
    try { setAccounts(await window.jarvis.invoke('accounts:remove', { origin })); setNote('Konto entfernt.') }
    catch (e) { setNote(e instanceof Error ? e.message : 'Entfernen fehlgeschlagen.') }
    finally { setBusy(false) }
  }
  return <section className="website-accounts" aria-label="Website-Konten">
    <h3>Website-Konten</h3>
    <p>Kontodaten hier eingeben, damit James sich auf deinen Auftrag anmelden kann. Sie werden lokal mit deinem Windows-Benutzerkonto verschlüsselt. Pro Website wird ein Konto gespeichert.</p>
    <p>CAPTCHA und Zwei-Faktor-Prüfungen erledigst du selbst. Standard-Anmeldeformulare werden unterstützt; besondere Anmeldewege brauchen deine Mithilfe.</p>
    <form onSubmit={e => void save(e)} autoComplete="off">
      <label>HTTPS-Anmeldeadresse<input type="url" required value={loginUrl} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/login" disabled={busy} maxLength={2048} /></label>
      <label>Benutzername oder E-Mail<input required value={username} onChange={e => setUsername(e.target.value)} disabled={busy} maxLength={320} autoComplete="off" /></label>
      <label>Passwort<input type="password" required value={password} onChange={e => setPassword(e.target.value)} disabled={busy} maxLength={4096} autoComplete="new-password" /></label>
      <button type="submit" disabled={busy || !loginUrl.trim() || !username.trim() || !password}>{busy ? 'Wird verarbeitet…' : 'Konto verschlüsselt speichern'}</button>
    </form>
    {note && <p role="status">{note}</p>}
    {accounts.map(a => <div className="website-account-row" key={a.origin}><div><strong>{new URL(a.origin).hostname}</strong><small>{a.loginUrl}</small></div><button disabled={busy} onClick={() => void remove(a.origin)}>Konto entfernen</button></div>)}
  </section>
}
