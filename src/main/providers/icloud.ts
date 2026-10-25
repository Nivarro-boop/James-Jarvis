import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { getSecret } from '../secrets/keystore'
import { eventsInRange, type IcsEvent } from '@shared/ics'
import {
  ICLOUD_CALDAV,
  ICLOUD_MAIL,
  davCalendarData,
  davCalendars,
  davHref,
  iCloudDriveCandidates,
  isICloudDavUrl,
  normalizeAppPassword,
  normalizeICloudAddress,
  type DavCalendar
} from '@shared/icloud'

/**
 * iCloud ohne Browser: Mail über IMAP/SMTP, Kalender über CalDAV und Drive
 * über den Ordner von „iCloud für Windows“.
 *
 * Apple bietet dafür keine OAuth-Anmeldung an. Der einzige offizielle Weg für
 * Programme ist ein app-spezifisches Passwort, das der Nutzer unter
 * account.apple.com anlegt und jederzeit widerrufen kann. Das eigentliche
 * Apple-Account-Passwort und die Zwei-Faktor-Codes kommen hier nie vorbei.
 *
 * Fotos, Notizen, Erinnerungen und Kontakte im Browser bleiben der Weg über
 * `icloud_open`; dafür gibt es keine öffentliche Schnittstelle.
 */

export interface ICloudCredentials { address: string; password: string }

export function iCloudCredentials(): ICloudCredentials | null {
  const address = normalizeICloudAddress(getSecret('icloudMailAddress') ?? '')
  const password = normalizeAppPassword(getSecret('icloudAppPassword') ?? '')
  return address && password ? { address, password } : null
}

function requireCredentials(): ICloudCredentials {
  const credentials = iCloudCredentials()
  if (!credentials) {
    throw new Error(
      'iCloud Mail und Kalender sind nicht eingerichtet. Sag dem Nutzer: Einstellungen, Verbindungen, ' +
        'Apple iCloud — dort iCloud-Adresse und ein app-spezifisches Passwort eintragen.'
    )
  }
  return credentials
}

/** Rohe Server- und Netzfehler sind zum Vorlesen ungeeignet. */
export function friendlyICloudError(err: unknown): string {
  const anyErr = err as { authenticationFailed?: boolean; responseText?: string; code?: string; responseCode?: number } | null
  const raw = err instanceof Error ? err.message : String(err)
  if (anyErr?.authenticationFailed || anyErr?.code === 'EAUTH' || anyErr?.responseCode === 535 || /auth|401|invalid credentials/i.test(raw)) {
    return 'Apple lehnt die Anmeldung ab. Bitte ein neues app-spezifisches Passwort unter account.apple.com anlegen und eintragen.'
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|timeout|network/i.test(raw) || anyErr?.code === 'ETIMEDOUT') {
    return 'iCloud ist gerade nicht erreichbar. Internetverbindung prüfen und gleich noch einmal versuchen.'
  }
  return `iCloud meldet einen Fehler: ${anyErr?.responseText || raw}`.slice(0, 300)
}

// ─────────────────────────────────────────────────────────────
// Mail
// ─────────────────────────────────────────────────────────────

async function withImap<T>(fn: (client: import('imapflow').ImapFlow) => Promise<T>): Promise<T> {
  const { address, password } = requireCredentials()
  const { ImapFlow } = await import('imapflow')
  const client = new ImapFlow({
    host: ICLOUD_MAIL.imapHost,
    port: ICLOUD_MAIL.imapPort,
    secure: true,
    auth: { user: address, pass: password },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000
  })
  // Ein abgerissener Socket meldet sich als Ereignis; ohne Zuhörer beendet er den Prozess.
  client.on('error', () => undefined)
  try {
    await client.connect()
    return await fn(client)
  } catch (err) {
    throw new Error(friendlyICloudError(err))
  } finally {
    await client.logout().catch(() => client.close())
  }
}

export interface ICloudMailSummary {
  uid: number
  von: string
  betreff: string
  datum: string | null
  gelesen: boolean
}

function addressText(list: Array<{ name?: string; address?: string }> | undefined): string {
  return (list ?? []).map((a) => (a.name ? `${a.name} <${a.address ?? ''}>` : a.address ?? '')).join(', ')
}

function folderName(folder: string | undefined): string {
  const value = (folder ?? 'INBOX').trim()
  // Nur Ordnernamen, keine IMAP-Befehle oder Steuerzeichen.
  if (!value || value.length > 200 || /[\r\n\0]/.test(value)) throw new Error('Ungültiger Ordnername.')
  return value
}

export async function iCloudMailList(options: { folder?: string; unreadOnly?: boolean; query?: string; limit?: number }): Promise<ICloudMailSummary[]> {
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50)
  return withImap(async (client) => {
    const lock = await client.getMailboxLock(folderName(options.folder), { readOnly: true })
    try {
      const query = options.query?.trim().slice(0, 200)
      const search: import('imapflow').SearchObject = query ? { or: [{ subject: query }, { from: query }, { body: query }] } : { all: true }
      if (options.unreadOnly) search.seen = false
      const uids = (await client.search(search, { uid: true })) || []
      const newest = uids.sort((a, b) => b - a).slice(0, limit)
      if (newest.length === 0) return []
      const out: ICloudMailSummary[] = []
      for await (const message of client.fetch(newest, { uid: true, envelope: true, flags: true }, { uid: true })) {
        const date = message.envelope?.date ? new Date(message.envelope.date) : null
        out.push({
          uid: message.uid,
          von: addressText(message.envelope?.from),
          betreff: message.envelope?.subject ?? '(ohne Betreff)',
          datum: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
          gelesen: message.flags?.has('\\Seen') ?? false
        })
      }
      return out.sort((a, b) => b.uid - a.uid)
    } finally {
      lock.release()
    }
  })
}

export async function iCloudMailRead(uid: number, folder: string | undefined, maxChars = 6000): Promise<Record<string, unknown>> {
  return withImap(async (client) => {
    const lock = await client.getMailboxLock(folderName(folder), { readOnly: true })
    try {
      const message = await client.fetchOne(String(uid), { uid: true, envelope: true, source: { maxLength: 2_000_000 } }, { uid: true })
      if (!message || !message.source) throw new Error('Diese Mail gibt es im Ordner nicht mehr.')
      const { simpleParser } = await import('mailparser')
      const parsed = await simpleParser(message.source)
      const text = (parsed.text || (typeof parsed.html === 'string' ? htmlToText(parsed.html) : '')).replace(/\n{3,}/g, '\n\n').trim()
      return {
        uid,
        von: addressText(message.envelope?.from),
        an: addressText(message.envelope?.to),
        betreff: message.envelope?.subject ?? '(ohne Betreff)',
        datum: parsed.date?.toISOString() ?? null,
        messageId: parsed.messageId ?? null,
        anhaenge: parsed.attachments.map((a) => a.filename ?? 'Anhang').slice(0, 20),
        text: text.slice(0, maxChars),
        gekuerzt: text.length > maxChars
      }
    } finally {
      lock.release()
    }
  })
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
}

export async function iCloudMailSend(input: { to: string; subject: string; body: string; inReplyTo?: string }): Promise<{ verschickt: true; an: string; messageId: string }> {
  const { address, password } = requireCredentials()
  const nodemailer = await import('nodemailer')
  const transport = nodemailer.createTransport({
    host: ICLOUD_MAIL.smtpHost,
    port: ICLOUD_MAIL.smtpPort,
    secure: false,
    requireTLS: true,
    auth: { user: address, pass: password },
    connectionTimeout: 15_000,
    socketTimeout: 60_000
  })
  try {
    const info = await transport.sendMail({
      from: address,
      to: input.to,
      subject: input.subject,
      text: input.body,
      ...(input.inReplyTo ? { inReplyTo: input.inReplyTo, references: input.inReplyTo } : {})
    })
    return { verschickt: true, an: input.to, messageId: info.messageId }
  } catch (err) {
    throw new Error(friendlyICloudError(err))
  } finally {
    transport.close()
  }
}

// ─────────────────────────────────────────────────────────────
// Kalender (CalDAV)
// ─────────────────────────────────────────────────────────────

async function dav(url: string, method: 'PROPFIND' | 'REPORT', depth: '0' | '1', body: string): Promise<{ url: string; text: string }> {
  if (!isICloudDavUrl(url)) throw new Error('Unerwartete Kalenderadresse; Anfrage abgebrochen.')
  const { address, password } = requireCredentials()
  const response = await fetch(url, {
    method,
    // Weiterleitungen selbst prüfen: Die Zugangsdaten dürfen nur an Apple gehen.
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${address}:${password}`).toString('base64'),
      Depth: depth,
      'Content-Type': 'application/xml; charset=utf-8'
    },
    body
  })
  if (response.status >= 300 && response.status < 400) {
    const next = response.headers.get('location')
    if (!next) throw new Error(`iCloud-Kalender leitet ohne Ziel weiter (HTTP ${response.status}).`)
    return dav(new URL(next, url).toString(), method, depth, body)
  }
  if (response.status === 401 || response.status === 403) throw Object.assign(new Error('401'), { authenticationFailed: true })
  if (!response.ok && response.status !== 207) throw new Error(`iCloud-Kalender antwortet mit HTTP ${response.status}.`)
  const text = await response.text()
  if (text.length > 16 * 1024 * 1024) throw new Error('Die Kalenderantwort ist zu groß.')
  return { url: response.url || url, text }
}

const PRINCIPAL = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>'
const HOME = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>'
const LIST = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/></d:prop></d:propfind>'

let discovered: { key: string; at: number; calendars: Array<DavCalendar & { url: string }> } | null = null

export async function iCloudCalendars(): Promise<Array<DavCalendar & { url: string }>> {
  const { address } = requireCredentials()
  if (discovered && discovered.key === address && Date.now() - discovered.at < 30 * 60_000) return discovered.calendars
  try {
    const root = await dav(ICLOUD_CALDAV, 'PROPFIND', '0', PRINCIPAL)
    const principal = davHref(root.text, 'current-user-principal')
    if (!principal) throw new Error('iCloud hat kein Kalenderkonto genannt.')
    const principalUrl = new URL(principal, root.url).toString()
    const home = await dav(principalUrl, 'PROPFIND', '0', HOME)
    const homeHref = davHref(home.text, 'calendar-home-set')
    if (!homeHref) throw new Error('iCloud hat keinen Kalenderordner genannt.')
    const homeUrl = new URL(homeHref, home.url).toString()
    const list = await dav(homeUrl, 'PROPFIND', '1', LIST)
    const calendars = davCalendars(list.text)
      .map((c) => ({ ...c, url: new URL(c.href, homeUrl).toString() }))
      .filter((c) => isICloudDavUrl(c.url) && c.url !== homeUrl)
    discovered = { key: address, at: Date.now(), calendars }
    return calendars
  } catch (err) {
    throw new Error(friendlyICloudError(err))
  }
}

function icsStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

export async function iCloudEvents(from: number, to: number): Promise<Array<IcsEvent & { kalender: string }>> {
  const calendars = await iCloudCalendars()
  const query =
    '<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
    '<d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">' +
    `<c:time-range start="${icsStamp(from)}" end="${icsStamp(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`
  const results = await Promise.allSettled(calendars.map(async (calendar) => {
    const { text } = await dav(calendar.url, 'REPORT', '1', query)
    return davCalendarData(text).flatMap((ics) => eventsInRange(ics, from, to).map((event) => ({ ...event, kalender: calendar.name })))
  }))
  const events = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
  if (events.length === 0) {
    const failed = results.find((r) => r.status === 'rejected')
    if (failed && failed.status === 'rejected') throw new Error(friendlyICloudError(failed.reason))
  }
  return events.sort((a, b) => a.start - b.start)
}

// ─────────────────────────────────────────────────────────────
// Drive
// ─────────────────────────────────────────────────────────────

/** Der lokale Drive-Ordner, wenn „iCloud für Windows“ installiert und angemeldet ist. */
export function iCloudDrivePath(home = homedir()): string | null {
  for (const candidate of iCloudDriveCandidates(home)) {
    try { if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate } catch { /* weiter */ }
  }
  return null
}

/** Verbindung prüfen, ohne Inhalte zu lesen. */
export async function iCloudCheck(): Promise<{ mail: { ok: boolean; detail: string }; calendar: { ok: boolean; detail: string } }> {
  if (!iCloudCredentials()) {
    const missing = { ok: false, detail: 'iCloud-Adresse und app-spezifisches Passwort fehlen.' }
    return { mail: missing, calendar: missing }
  }
  discovered = null
  const [mail, calendar] = await Promise.allSettled([
    withImap(async (client) => {
      const status = await client.status('INBOX', { messages: true, unseen: true })
      if (!status) return 'Angemeldet, der Posteingang meldet aber keinen Stand.'
      return `Posteingang erreichbar: ${status.messages ?? 0} Mails, ${status.unseen ?? 0} ungelesen.`
    }),
    iCloudCalendars().then((list) => `${list.length} Kalender gefunden${list.length ? ': ' + list.slice(0, 5).map((c) => c.name).join(', ') : ''}.`)
  ])
  return {
    mail: mail.status === 'fulfilled' ? { ok: true, detail: mail.value } : { ok: false, detail: String((mail.reason as Error)?.message ?? mail.reason) },
    calendar: calendar.status === 'fulfilled' ? { ok: true, detail: calendar.value } : { ok: false, detail: String((calendar.reason as Error)?.message ?? calendar.reason) }
  }
}

export function forgetICloudCache(): void {
  discovered = null
}
