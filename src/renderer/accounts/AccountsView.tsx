import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import type { ChatGptStatus } from '@shared/chatgpt'
import type { ICloudCalendarEvent, ICloudDriveEntry, ICloudMailMessage, ICloudMailSummary, ICloudStatus } from '@shared/icloud'
import './accounts.css'

/**
 * Konten: alle Anmeldungen an einem Ort, und Apple Mail, Kalender, Drive und
 * Health direkt in James statt im Browser.
 *
 * Der Browser erscheint hier nur noch für den einen Schritt, den Apple oder
 * Google selbst sehen wollen: die Anmeldung. Alles danach zeigt James selbst.
 */

type Section = 'overview' | 'mail' | 'calendar' | 'drive' | 'health'
type MailDraft = { id: string; owner: string; to: string; subject: string; body: string; inReplyTo?: string }
const DRAFT_KEY = 'james:icloud-mail-draft'
const sendingMails = new Map<string, Promise<{ verschickt: true; an: string }>>()
function storedDraft(): MailDraft | null {
  try {
    const d = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? 'null')
    return d && ['id', 'owner', 'to', 'subject', 'body'].every(k => typeof d[k] === 'string') &&
      d.to.length <= 320 && d.subject.length <= 300 && d.body.length <= 50_000 &&
      (d.inReplyTo === undefined || typeof d.inReplyTo === 'string') ? d : null
  } catch { return null }
}
const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: 'overview', label: 'Übersicht' },
  { id: 'mail', label: 'iCloud Mail' },
  { id: 'calendar', label: 'Kalender' },
  { id: 'drive', label: 'iCloud Drive' },
  { id: 'health', label: 'Apple Health' }
]

function plain(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function useICloud(): [ICloudStatus | null, () => Promise<void>, string] {
  const [status, setStatus] = useState<ICloudStatus | null>(null)
  const [error, setError] = useState('')
  const request = useRef(0)
  const load = async (): Promise<void> => {
    const id = ++request.current
    try { const value = await window.jarvis.invoke('icloud:status'); if (id === request.current) { setStatus(value); setError('') } }
    catch (err) { if (id === request.current) { setStatus(null); setError(plain(err)) } }
  }
  useEffect(() => {
    void load()
    // Nach einer Anmeldung im Anmeldefenster den Stand neu holen — nur beim
    // Schließen oder bei erkannter Anmeldung, nicht bei jedem Ladevorgang.
    let wasOpen = false
    let wasDone = false
    const off = window.jarvis.on('browser:state', (state) => {
      if ((wasOpen && !state.open) || (state.done && !wasDone)) void load()
      wasOpen = state.open
      wasDone = state.done
    })
    return () => { ++request.current; off() }
  }, [])
  return [status, load, error]
}

export function AccountsView(): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState<Section>('overview')
  const container = useRef<HTMLElement>(null)
  const [icloud, reloadICloud, statusError] = useICloud()
  const [draft, setDraft] = useState<MailDraft | null>(storedDraft)
  useEffect(() => {
    try { if (draft) sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); else sessionStorage.removeItem(DRAFT_KEY) } catch { /* Window state still preserves navigation. */ }
  }, [draft])
  useEffect(() => { if (icloud && !icloud.mailConfigured) setDraft(null) }, [icloud?.mailConfigured])

  useEffect(() => {
    const show = (next?: string): void => {
      setOpen(true)
      if (next && SECTIONS.some((s) => s.id === next)) setSection(next as Section)
    }
    const onEvent = (event: Event): void => show((event as CustomEvent<string | undefined>).detail)
    window.addEventListener('jarvis:accounts', onEvent)
    const off = window.jarvis.on('accounts:open', (payload) => show(payload?.section))
    return () => { window.removeEventListener('jarvis:accounts', onEvent); off() }
  }, [])
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement
    container.current?.querySelector<HTMLButtonElement>('.accounts-close')?.focus()
    void reloadICloud()
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape' && !document.querySelector('.browser-panel')) setOpen(false) }
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('keydown', key); if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [open])

  if (!open) return null
  return (
    <section ref={container} className="accounts-view" aria-label="Konten">
      <header className="accounts-head">
        <div><span className="accounts-eyebrow">KONTEN</span><h2>Deine Konten und Apple-Dienste</h2></div>
        <button className="accounts-close" aria-label="Konten schließen" onClick={() => setOpen(false)}>×</button>
      </header>
      <div className="accounts-body">
        <nav className="accounts-nav" aria-label="Kontobereiche">
          {SECTIONS.map((s) => (
            <button key={s.id} aria-current={section === s.id ? 'page' : undefined} onClick={() => setSection(s.id)}>{s.label}</button>
          ))}
        </nav>
        <div className="accounts-content">
          {statusError && <div role="alert"><p>{statusError}</p><button onClick={() => void reloadICloud()}>Kontenstatus erneut prüfen</button></div>}
          {section === 'overview' && <Overview icloud={icloud} reload={reloadICloud} go={setSection} />}
          {!statusError && section === 'mail' && <MailSection key={icloud?.mailAddress ?? ''} icloud={icloud} reload={reloadICloud} draft={draft?.owner === icloud?.mailAddress ? draft : null} setDraft={next => setDraft(current => next === null && current?.id !== draft?.id ? current : next)} />}
          {!statusError && section === 'calendar' && <CalendarSection icloud={icloud} go={setSection} />}
          {!statusError && section === 'drive' && <DriveSection icloud={icloud} reload={reloadICloud} />}
          {section === 'health' && <HealthSection />}
        </div>
      </div>
    </section>
  )
}

function Card({ title, state, ok, children }: { title: string; state: string; ok: boolean | null; children?: ReactNode }): JSX.Element {
  return (
    <article className="account-card" aria-label={title}>
      <header><strong>{title}</strong><span className="account-state" data-ok={ok === null ? 'unknown' : ok}>{state}</span></header>
      {children}
    </article>
  )
}

function Note({ note }: { note: { ok: boolean; text: string } | null }): JSX.Element | null {
  return note ? <p className={note.ok ? 'accounts-note' : 'accounts-note warn'} role="status">{note.text}</p> : null
}

// ─────────────────────────────────────────────────────────────
// Übersicht
// ─────────────────────────────────────────────────────────────

function Overview({ icloud, reload, go }: { icloud: ICloudStatus | null; reload: () => Promise<void>; go: (s: Section) => void }): JSX.Element {
  const [google, setGoogle] = useState<{ connected: boolean; email?: string } | null>(null)
  const [chatgpt, setChatgpt] = useState<ChatGptStatus | null>(null)
  const [health, setHealth] = useState<{ takenAt: number | null } | null>(null)
  const [websites, setWebsites] = useState<number | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  const load = async (): Promise<void> => {
    const [g, c, h, w] = await Promise.allSettled([
      window.jarvis.invoke('google:status'), window.jarvis.invoke('chatgpt:status'),
      window.jarvis.invoke('health:status'), window.jarvis.invoke('accounts:list')
    ])
    if (g.status === 'fulfilled') setGoogle(g.value)
    if (c.status === 'fulfilled') setChatgpt(c.value)
    if (h.status === 'fulfilled') setHealth(h.value)
    if (w.status === 'fulfilled') setWebsites(w.value.length)
  }
  useEffect(() => { void load() }, [])

  const run = async (id: string, task: () => Promise<string | void>): Promise<void> => {
    setBusy(id); setNote(null)
    try { const text = await task(); if (text) setNote({ ok: true, text }) } catch (err) { setNote({ ok: false, text: plain(err) }) }
    finally { setBusy(null); void load(); void reload() }
  }

  return (
    <>
      <p className="accounts-lede">Hier verbindest du deine Konten. Mail und Kalender benötigen ein app-spezifisches Passwort, Drive die Windows-App und Health einen Export oder die native iPhone-App.</p>
      <div className="account-grid">
        <Card title="Apple Account" ok={icloud?.web ? null : false} state={icloud?.web ? 'Browsersitzung gefunden · Zugriff bei Apple prüfen' : 'keine Browsersitzung'}>
          <p>Für Fotos, Notizen, Erinnerungen und „Wo ist?“ auf iCloud.com.</p>
          <div className="account-actions">
            {icloud?.web
              ? <button disabled={busy !== null} onClick={() => void run('apple-out', async () => { await window.jarvis.invoke('icloud:signOutWeb'); return 'Bei Apple abgemeldet.' })}>Abmelden</button>
              : <button className="primary" disabled={busy !== null} onClick={() => void run('apple', async () => { const r = await window.jarvis.invoke('connect:login', { target: 'icloud' }); if (!r.ok) throw new Error(r.error ?? 'Anmeldefenster ließ sich nicht öffnen.') })}>Bei Apple anmelden</button>}
          </div>
        </Card>
        <Card title="iCloud Mail & Kalender" ok={icloud?.mailConfigured ? null : false} state={icloud?.mailConfigured ? `${icloud.mailAddress ?? 'iCloud'} · Zugang gespeichert` : 'nicht eingerichtet'}>
          <p>Mails lesen, suchen und schreiben, Termine sehen — direkt in James.</p>
          <div className="account-actions"><button className={icloud?.mailConfigured ? '' : 'primary'} onClick={() => go('mail')}>{icloud?.mailConfigured ? 'Mail öffnen' : 'Einrichten'}</button>{icloud?.mailConfigured && <button onClick={() => go('calendar')}>Kalender</button>}</div>
        </Card>
        <Card title="iCloud Drive" ok={icloud ? Boolean(icloud.drivePath) : null} state={icloud?.drivePath ? 'auf diesem PC' : 'iCloud für Windows fehlt'}>
          <p>Dateien aus iCloud Drive suchen und öffnen.</p>
          <div className="account-actions"><button onClick={() => go('drive')}>{icloud?.drivePath ? 'Drive öffnen' : 'Einrichten'}</button></div>
        </Card>
        <Card title="Apple Health" ok={health ? health.takenAt !== null : null} state={health?.takenAt ? `Stand ${new Date(health.takenAt).toLocaleDateString('de-DE')}` : 'keine Werte'}>
          <p>Schritte, Schlaf, Puls und Gewicht vom iPhone.</p>
          <div className="account-actions"><button onClick={() => go('health')}>{health?.takenAt ? 'Ansehen' : 'Einrichten'}</button></div>
        </Card>
        <Card title="Google" ok={google?.connected ?? null} state={google?.connected ? google.email ?? 'verbunden' : 'nicht verbunden'}>
          <p>Gmail, Google Kalender, Drive und Kontakte.</p>
          <div className="account-actions">
            {google?.connected
              ? <button disabled={busy !== null} onClick={() => void run('google-out', async () => { await window.jarvis.invoke('google:disconnect'); return 'Google getrennt.' })}>Trennen</button>
              : <button className="primary" disabled={busy !== null} onClick={() => void run('google', async () => { const r = await window.jarvis.invoke('google:connect'); if (!r.ok) throw new Error(r.error ?? 'Google-Anmeldung fehlgeschlagen.'); return `Mit Google verbunden${r.email ? ': ' + r.email : ''}.` })}>{busy === 'google' ? 'Im Browser anmelden …' : 'Mit Google anmelden'}</button>}
          </div>
        </Card>
        <Card title="ChatGPT" ok={chatgpt?.connected ?? null} state={chatgpt?.connected ? chatgpt.email ?? 'verbunden' : 'nicht verbunden'}>
          <p>Denken mit deinem ChatGPT-Abo.</p>
          <div className="account-actions">
            {chatgpt?.connected
              ? <button disabled={busy !== null} onClick={() => void run('chatgpt-out', async () => { await window.jarvis.invoke('chatgpt:disconnect'); return 'ChatGPT getrennt.' })}>Trennen</button>
              : <button className="primary" disabled={busy !== null} onClick={() => void run('chatgpt', async () => { const r = await window.jarvis.invoke('chatgpt:connect'); if (!r.ok) throw new Error(r.error ?? 'ChatGPT-Anmeldung fehlgeschlagen.'); return `Mit ChatGPT verbunden${r.email ? ': ' + r.email : ''}.` })}>{busy === 'chatgpt' ? 'Im Browser anmelden …' : 'Mit ChatGPT anmelden'}</button>}
          </div>
        </Card>
        <Card title="Weitere Konten" ok={null} state={websites === null ? '' : `${websites} Website-Konten`}>
          <p>Yahoo, Amazon, WhatsApp Web und gespeicherte Website-Zugänge.</p>
          <div className="account-actions">
            {(['yahoo', 'amazon', 'whatsapp'] as const).map((target) => (
              <button key={target} disabled={busy !== null} onClick={() => void run(target, async () => { const r = await window.jarvis.invoke('connect:login', { target }); if (!r.ok) throw new Error(r.error ?? 'Anmeldung ließ sich nicht öffnen.'); return 'Ein Chrome-Fenster mit James-Profil ist offen. Dort anmelden.' })}>
                {target === 'yahoo' ? 'Yahoo' : target === 'amazon' ? 'Amazon' : 'WhatsApp'}
              </button>
            ))}
            <button onClick={() => { void window.jarvis.invoke('app:openSettings', { section: 'connections' }) }}>Verwalten</button>
          </div>
        </Card>
      </div>
      <Note note={note} />
    </>
  )
}

// ─────────────────────────────────────────────────────────────
// Mail
// ─────────────────────────────────────────────────────────────

const FOLDERS = [
  { id: 'INBOX', label: 'Posteingang' },
  { id: 'Sent Messages', label: 'Gesendet' },
  { id: 'Drafts', label: 'Entwürfe' },
  { id: 'Junk', label: 'Werbung' },
  { id: 'Archive', label: 'Archiv' }
]

function addressOf(value: string): string {
  return /<([^>]+)>/.exec(value)?.[1] ?? value.split(',')[0].trim()
}

function MailSetup({ icloud, reload }: { icloud: ICloudStatus | null; reload: () => Promise<void> }): JSX.Element {
  const [address, setAddress] = useState(icloud?.mailAddress ?? '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const save = async (): Promise<void> => {
    setBusy(true); setNote(null)
    try {
      await window.jarvis.invoke('icloud:save', { address, password })
      setPassword('')
      const check = await window.jarvis.invoke('icloud:check')
      setNote(check.mail.ok ? { ok: true, text: `Verbunden. ${check.mail.detail}` } : { ok: false, text: check.mail.detail })
      await reload()
    } catch (err) { setNote({ ok: false, text: plain(err) }) } finally { setBusy(false) }
  }
  return (
    <div className="accounts-setup">
      <h3>iCloud Mail und Kalender verbinden</h3>
      <p>Apple erlaubt Programmen den Zugriff nur mit einem <strong>app-spezifischen Passwort</strong>. Du erstellst es einmal bei Apple und kannst es dort jederzeit widerrufen. Dein Apple-Passwort sieht James nie.</p>
      <ol className="accounts-steps">
        <li>
          <strong>Passwort bei Apple erstellen</strong>
          <span>Öffnet das Anmeldefenster bei Apple. Dort „App-spezifische Passwörter“ → „+“ → Name „James“ und das Passwort kopieren.</span>
          <button className="primary" onClick={() => { void window.jarvis.invoke('icloud:createAppPassword').then((r) => { if (!r.ok) setNote({ ok: false, text: r.error ?? 'Anmeldefenster ließ sich nicht öffnen.' }) }).catch(err => setNote({ ok: false, text: plain(err) })) }}>Bei Apple erstellen</button>
        </li>
        <li>
          <strong>Hier einfügen</strong>
          <label>iCloud-Mailadresse<input type="email" autoComplete="off" spellCheck={false} placeholder="name@icloud.com" value={address} onChange={(e) => setAddress(e.target.value)} /></label>
          <label>App-spezifisches Passwort<input type="password" autoComplete="off" spellCheck={false} placeholder="abcd-efgh-ijkl-mnop" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <button className="primary" disabled={busy || !address.trim() || !password.trim()} onClick={() => void save()}>{busy ? 'Prüfe bei Apple …' : 'Verbinden'}</button>
        </li>
      </ol>
      <Note note={note} />
    </div>
  )
}

function MailSection({ icloud, reload, draft, setDraft }: { icloud: ICloudStatus | null; reload: () => Promise<void>; draft: MailDraft | null; setDraft: (d: MailDraft | null) => void }): JSX.Element {
  const [folder, setFolder] = useState('INBOX')
  const [query, setQuery] = useState('')
  const [unread, setUnread] = useState(false)
  const [list, setList] = useState<ICloudMailSummary[] | null>(null)
  const [selected, setSelected] = useState<ICloudMailMessage | null>(null)
  const [loading, setLoading] = useState(false)
  const [composing, setComposing] = useState(Boolean(draft))
  const listRequest = useRef(0), readRequest = useRef(0)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  const load = async (): Promise<void> => {
    const id = ++listRequest.current
    setLoading(true); setNote(null)
    try { const rows = await window.jarvis.invoke('icloud:mailList', { folder, unreadOnly: unread, query: query.trim() || undefined, limit: 40 }); if (id === listRequest.current) setList(rows) }
    catch (err) { if (id === listRequest.current) { setList([]); setNote({ ok: false, text: plain(err) }) } }
    finally { if (id === listRequest.current) setLoading(false) }
  }
  useEffect(() => {
    setList(null); setSelected(null)
    if (icloud?.mailConfigured) void load()
    return () => { ++listRequest.current; ++readRequest.current }
  }, [icloud?.mailConfigured, folder, unread])

  if (!icloud) return <p className="accounts-lede">Lädt …</p>
  if (!icloud.mailConfigured) return <MailSetup icloud={icloud} reload={reload} />

  const openMail = async (uid: number): Promise<void> => {
    const id = ++readRequest.current
    setNote(null)
    try { const message = await window.jarvis.invoke('icloud:mailRead', { uid, folder }); if (id === readRequest.current) { setSelected(message); setComposing(false) } }
    catch (err) { if (id === readRequest.current) setNote({ ok: false, text: plain(err) }) }
  }
  const compose = (data: Omit<MailDraft, 'id' | 'owner'>): void => {
    if (!draft) setDraft({ ...data, id: crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint32Array(4)), x => x.toString(16).padStart(8, '0')).join(''), owner: icloud.mailAddress ?? '' })
    else setNote({ ok: true, text: 'Dein vorhandener Entwurf bleibt erhalten. Verwirf ihn ausdrücklich, bevor du eine andere Mail beginnst.' })
    setComposing(true)
  }

  return (
    <div className="mail-layout">
      <div className="mail-toolbar">
        <select aria-label="Ordner" value={folder} onChange={(e) => { ++listRequest.current; ++readRequest.current; setFolder(e.target.value); setList(null); setSelected(null) }}>
          {FOLDERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
        <form onSubmit={(e) => { e.preventDefault(); void load() }}><input aria-label="Mails durchsuchen" placeholder="Suchen …" value={query} onChange={(e) => setQuery(e.target.value)} /></form>
        <label className="mail-toggle"><input type="checkbox" checked={unread} onChange={(e) => setUnread(e.target.checked)} /> Nur ungelesene</label>
        <button onClick={() => void load()} disabled={loading}>{loading ? 'Lädt …' : 'Aktualisieren'}</button>
        <button className="primary" onClick={() => compose({ to: '', subject: '', body: '' })}>{draft ? 'Entwurf fortsetzen' : 'Neue Mail'}</button>
      </div>
      <Note note={note} />
      <div className="mail-panes">
        <ul className="mail-list" aria-label="Mails">
          {list === null && <li className="mail-empty">Lädt …</li>}
          {list?.length === 0 && note?.ok !== false && <li className="mail-empty">Keine Mails gefunden.</li>}
          {list?.map((m) => (
            <li key={m.uid}>
              <button aria-current={selected?.uid === m.uid ? 'true' : undefined} data-unread={!m.gelesen} onClick={() => void openMail(m.uid)}>
                <strong>{m.von.replace(/<[^>]+>/, '').trim() || m.von}</strong>
                <span>{m.betreff}</span>
                <small>{m.datum ? new Date(m.datum).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</small>
              </button>
            </li>
          ))}
        </ul>
        <article className="mail-reader" aria-label="Mail lesen">
          {composing && draft ? <Composer key={draft.id} draft={draft} onChange={setDraft} onClose={() => { setDraft(null); setComposing(false) }} onSent={(text) => { setDraft(null); setComposing(false); setNote({ ok: true, text }) }} />
            : selected ? (
              <>
                <header>
                  <h3>{selected.betreff}</h3>
                  <p>Von {selected.von}<br />An {selected.an}{selected.datum ? ` · ${new Date(selected.datum).toLocaleString('de-DE')}` : ''}</p>
                  {selected.anhaenge.length > 0 && <p className="mail-attachments">Anhänge: {selected.anhaenge.join(', ')}</p>}
                  <button onClick={() => compose({ to: addressOf(selected.von), subject: /^re:/i.test(selected.betreff) ? selected.betreff : `Re: ${selected.betreff}`, body: `\n\n— Am ${selected.datum ? new Date(selected.datum).toLocaleString('de-DE') : ''} schrieb ${selected.von}:\n> ${selected.text.slice(0, 2000).split('\n').join('\n> ')}`, inReplyTo: selected.messageId ?? undefined })}>Antworten</button>
                </header>
                <div className="mail-text">{selected.text || '(kein Textinhalt)'}{selected.gekuerzt ? '\n\n… gekürzt' : ''}</div>
              </>
            ) : <p className="mail-empty">Mail links auswählen.</p>}
        </article>
      </div>
    </div>
  )
}

function Composer({ draft, onChange, onClose, onSent }: { draft: MailDraft; onChange: (d: MailDraft) => void; onClose: () => void; onSent: (text: string) => void }): JSX.Element {
  const { to, subject, body } = draft
  const locked = useRef(sendingMails.has(draft.id))
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(sendingMails.has(draft.id))
  const [error, setError] = useState('')
  const send = async (): Promise<void> => {
    if (locked.current) return
    locked.current = true
    setBusy(true); setError('')
    const pending = window.jarvis.invoke('icloud:mailSend', { operationId: draft.id, to, subject, body, inReplyTo: draft.inReplyTo })
    sendingMails.set(draft.id, pending)
    try { const r = await pending; onSent(`Mail an ${r.an} verschickt.`) }
    catch (err) { setError(plain(err) + ' Der Versandstatus ist unklar. Prüfe „Gesendet“, bevor du erneut sendest.'); setConfirm(false) } finally { locked.current = false; setBusy(false) }
    sendingMails.delete(draft.id)
  }
  useEffect(() => {
    const pending = sendingMails.get(draft.id)
    if (!pending) return
    let active = true
    void pending.then(r => { if (active) onSent(`Mail an ${r.an} verschickt.`) }).catch(err => { if (active) setError(plain(err) + ' Prüfe „Gesendet“, bevor du erneut sendest.') }).finally(() => { if (active) { locked.current = false; setBusy(false) } })
    return () => { active = false }
  }, [draft.id])
  return (
    <form className="mail-compose" onSubmit={(e) => { e.preventDefault(); setConfirm(true) }}>
      <h3>{draft.inReplyTo ? 'Antworten' : 'Neue Mail'}</h3>
      <p className="accounts-lede">Der Entwurf bleibt beim Wechseln und Neuladen in diesem Fenster erhalten.</p>
      {busy && <p role="status">Der Versand läuft. Ein Fensterwechsel hält eine bereits übergebene Mail nicht an.</p>}
      <label>An<input aria-label="An" type="email" required maxLength={320} disabled={busy} value={to} onChange={(e) => { onChange({ ...draft, to: e.target.value }); setConfirm(false) }} /></label>
      <label>Betreff<input aria-label="Betreff" maxLength={300} disabled={busy} value={subject} onChange={(e) => { onChange({ ...draft, subject: e.target.value }); setConfirm(false) }} /></label>
      <label>Text<textarea aria-label="Text" rows={12} maxLength={50_000} disabled={busy} value={body} onChange={(e) => { onChange({ ...draft, body: e.target.value }); setConfirm(false) }} /></label>
      {error && <p className="accounts-note warn" role="alert">{error}</p>}
      {confirm
        ? <div className="mail-confirm" role="alertdialog" aria-label="Senden bestätigen"><span>Wirklich an <strong>{to}</strong> senden?</span><button className="primary" disabled={busy} type="button" onClick={() => void send()}>{busy ? 'Sendet …' : 'Ja, senden'}</button><button type="button" disabled={busy} onClick={() => setConfirm(false)}>Abbrechen</button></div>
        : <div className="account-actions"><button className="primary" type="submit" disabled={busy || !to.trim()}>Senden</button><button type="button" disabled={busy} onClick={onClose}>Verwerfen</button></div>}
    </form>
  )
}

// ─────────────────────────────────────────────────────────────
// Kalender
// ─────────────────────────────────────────────────────────────

function CalendarSection({ icloud, go }: { icloud: ICloudStatus | null; go: (s: Section) => void }): JSX.Element {
  const [events, setEvents] = useState<ICloudCalendarEvent[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!icloud?.mailConfigured) return
    let active = true
    setEvents(null); setError('')
    void window.jarvis.invoke('icloud:events', { days: 14 }).then(value => { if (active) setEvents(value) }).catch((err) => { if (active) { setEvents([]); setError(plain(err)) } })
    return () => { active = false }
  }, [icloud?.mailConfigured])
  if (!icloud) return <p className="accounts-lede">Lädt …</p>
  if (!icloud.mailConfigured) {
    return <div className="accounts-setup"><h3>iCloud-Kalender</h3><p>Der Kalender nutzt dieselbe Verbindung wie iCloud Mail.</p><button className="primary" onClick={() => go('mail')}>Mail und Kalender verbinden</button></div>
  }
  const days = new Map<string, ICloudCalendarEvent[]>()
  for (const event of events ?? []) {
    const key = new Date(event.start).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })
    days.set(key, [...(days.get(key) ?? []), event])
  }
  return (
    <div className="calendar-list">
      <h3>Die nächsten 14 Tage</h3>
      {error && <p className="accounts-note warn" role="alert">{error}</p>}
      {events === null && <p className="accounts-lede">Lädt …</p>}
      {events?.length === 0 && !error && <p className="accounts-lede">Keine Termine in den nächsten 14 Tagen.</p>}
      {[...days].map(([day, list]) => (
        <section key={day}>
          <h4>{day}</h4>
          {list.map((e, i) => (
            <div className="calendar-event" key={`${e.start}-${i}`}>
              <time>{e.allDay ? 'ganztägig' : `${new Date(e.start).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}–${new Date(e.end).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`}</time>
              <div><strong>{e.title}</strong><small>{[e.location, e.kalender].filter(Boolean).join(' · ')}</small></div>
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Drive
// ─────────────────────────────────────────────────────────────

function DriveSection({ icloud, reload }: { icloud: ICloudStatus | null; reload: () => Promise<void> }): JSX.Element {
  const [path, setPath] = useState('')
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<ICloudDriveEntry[] | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const request = useRef(0)
  const load = async (nextPath = path, search?: string): Promise<void> => {
    const id = ++request.current
    setNote(null); setEntries(null)
    try {
      const result = await window.jarvis.invoke('icloud:driveList', { path: nextPath, query: search })
      if (id !== request.current) return
      setEntries(result?.eintraege ?? [])
      if (result?.gekuerzt) setNote({ ok: true, text: 'Die Suche wurde begrenzt. Bitte einen genaueren Suchbegriff oder Unterordner wählen.' })
    } catch (err) { if (id === request.current) { setEntries([]); setNote({ ok: false, text: plain(err) }) } }
  }
  useEffect(() => { if (icloud?.drivePath) void load(path); return () => { ++request.current } }, [icloud?.drivePath, path])

  if (!icloud) return <p className="accounts-lede">Lädt …</p>
  if (!icloud.drivePath) {
    return (
      <div className="accounts-setup">
        <h3>iCloud Drive auf diesem PC</h3>
        <p>Apple bietet für iCloud Drive keine Schnittstelle an. Die App „iCloud für Windows“ legt Drive als normalen Ordner auf den PC — dann zeigt James deine Dateien hier.</p>
        <ol className="accounts-steps">
          <li><strong>iCloud für Windows installieren</strong><span>Kostenlos im Microsoft Store.</span><button className="primary" onClick={() => { void window.jarvis.invoke('icloud:installWindows').catch(err => setNote({ ok: false, text: plain(err) })) }}>Microsoft Store öffnen</button></li>
          <li><strong>Mit dem Apple Account anmelden</strong><span>In „iCloud für Windows“ den Haken bei „iCloud Drive“ setzen.</span></li>
          <li><strong>Hier prüfen</strong><span>Danach erscheint der Ordner automatisch.</span><button onClick={() => void reload()}>Erneut prüfen</button></li>
        </ol>
      </div>
    )
  }
  const parts = path ? path.split(/[\\/]/) : []
  return (
    <div className="drive-layout">
      <div className="mail-toolbar">
        <nav className="drive-crumbs" aria-label="Ordnerpfad">
          <button onClick={() => setPath('')}>iCloud Drive</button>
          {parts.map((part, i) => <span key={i}> › <button onClick={() => setPath(parts.slice(0, i + 1).join('\\'))}>{part}</button></span>)}
        </nav>
        <form onSubmit={(e) => { e.preventDefault(); void load(path, query.trim() || undefined) }}><input aria-label="Dateien suchen" placeholder="Dateien suchen …" value={query} onChange={(e) => setQuery(e.target.value)} /></form>
        <button onClick={() => { void window.jarvis.invoke('icloud:openDrive').then(r => { if (!r.ok) setNote({ ok: false, text: r.error ?? 'Drive ließ sich nicht öffnen.' }) }).catch(err => setNote({ ok: false, text: plain(err) })) }}>Im Explorer</button>
      </div>
      <Note note={note} />
      <ul className="drive-list" aria-label="Dateien">
        {entries === null && <li className="mail-empty">Lädt …</li>}
        {entries?.length === 0 && note?.ok !== false && <li className="mail-empty">Leer.</li>}
        {entries?.map((e) => (
          <li key={e.pfad}>
            <button onClick={() => { if (e.ordner) { setQuery(''); setPath(e.pfad) } else void window.jarvis.invoke('icloud:driveOpen', { path: e.pfad }).then((r) => { if (!r.ok) setNote({ ok: false, text: r.error ?? 'Ließ sich nicht öffnen.' }) }).catch(err => setNote({ ok: false, text: plain(err) })) }}>
              <i aria-hidden="true">{e.ordner ? '📁' : '📄'}</i>
              <strong>{query ? e.pfad : e.name}</strong>
              <small>{e.ordner ? 'Ordner' : e.groesse !== undefined ? `${Math.max(1, Math.round(e.groesse / 1024)).toLocaleString('de-DE')} KB` : ''}{e.geaendert ? ` · ${new Date(e.geaendert).toLocaleDateString('de-DE')}` : ''}</small>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────────────────────

function HealthSection(): JSX.Element {
  const [state, setState] = useState<{ takenAt: number | null; summary: string | null } | null>(null)
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const load = async (): Promise<void> => {
    try { setState(await window.jarvis.invoke('health:status')); setCheckedAt(Date.now()) } catch (err) { setNote({ ok: false, text: plain(err) }) }
  }
  useEffect(() => { void load() }, [])
  const importExport = async (): Promise<void> => {
    setBusy(true); setNote({ ok: true, text: 'Lese den Export … bei großen Exporten kann das eine Minute dauern.' })
    try { const r = await window.jarvis.invoke('health:import'); setNote({ ok: r.ok, text: r.detail }); await load() }
    catch (err) { setNote({ ok: false, text: plain(err) }) } finally { setBusy(false) }
  }
  useEffect(() => window.jarvis.on('health:importProgress', ({ records }) => {
    setNote({ ok: true, text: `${records.toLocaleString('de-DE')} Health-Einträge gelesen …` })
  }), [])
  return (
    <div className="health-view">
      <div className="health-status-line" role="status">
        <span className="account-state" data-ok={state ? state.takenAt !== null : 'unknown'}>{state?.takenAt ? `Werte vom ${new Date(state.takenAt).toLocaleString('de-DE')}` : state ? 'Noch keine Health-Werte am PC' : 'Health-Status noch nicht geladen'}</span>
        {checkedAt && <small>Geprüft um {new Date(checkedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</small>}
        <button onClick={() => void load()}>Neu prüfen</button>
      </div>
      {state?.summary && <pre className="health-summary">{state.summary}</pre>}
      <h3>So kommen die Werte zu James</h3>
      <ol className="accounts-steps">
        <li>
          <strong>Export aus der Health-App (geht sofort)</strong>
          <span>iPhone: Health-App → oben rechts dein Profilbild → „Alle Gesundheitsdaten exportieren“. Die Datei „Export.zip“ per AirDrop, Mail oder iCloud Drive auf den PC legen und hier einlesen.</span>
          <button className="primary" disabled={busy} onClick={() => void importExport()}>{busy ? 'Liest …' : 'Health-Export einlesen'}</button>
          {busy && <button onClick={() => void window.jarvis.invoke('health:cancelImport').catch(err => setNote({ ok: false, text: plain(err) }))}>Import abbrechen</button>}
        </li>
        <li>
          <strong>Automatisch mit der James-App fürs iPhone</strong>
          <span>Die native James-App schickt die Werte bei jedem Öffnen. Sie braucht einen signierten Build und die Kopplung unter iPhone &amp; Apple Watch. Die Web-App und iCloud.com können Health nicht lesen.</span>
          <button onClick={() => { void window.jarvis.invoke('app:openSettings', { section: 'companion' }).catch(err => setNote({ ok: false, text: plain(err) })) }}>iPhone koppeln</button>
        </li>
      </ol>
      {state?.takenAt && <button onClick={() => { void window.jarvis.invoke('health:clear').then(load).catch(err => setNote({ ok: false, text: plain(err) })) }}>Health-Werte am PC löschen</button>}
      <Note note={note} />
      <p className="accounts-lede">Gespeichert wird nur die Zusammenfassung der letzten sieben Tage, verschlüsselt auf diesem PC. Exportwerte sind Näherungen: Je Tag zählt die stärkste Quelle; überlappende Schlafintervalle derselben Quelle werden zusammengeführt.</p>
    </div>
  )
}
