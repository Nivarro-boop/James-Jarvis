/** Fixed destinations: neither model output nor account data can change the host. */
export const ICLOUD_SERVICES = {
  mail: 'https://www.icloud.com/mail/',
  calendar: 'https://www.icloud.com/calendar/',
  drive: 'https://www.icloud.com/iclouddrive/',
  photos: 'https://www.icloud.com/photos/',
  contacts: 'https://www.icloud.com/contacts/',
  notes: 'https://www.icloud.com/notes/',
  reminders: 'https://www.icloud.com/reminders/',
  pages: 'https://www.icloud.com/pages/',
  numbers: 'https://www.icloud.com/numbers/',
  keynote: 'https://www.icloud.com/keynote/',
  find: 'https://www.icloud.com/find/'
} as const

export type ICloudService = keyof typeof ICLOUD_SERVICES
export const ICLOUD_SERVICE_IDS = Object.keys(ICLOUD_SERVICES) as [ICloudService, ...ICloudService[]]

/** Anzeigenamen für Kacheln und Antworten. */
export const ICLOUD_SERVICE_LABELS: Record<ICloudService, string> = {
  mail: 'Mail',
  calendar: 'Kalender',
  drive: 'iCloud Drive',
  photos: 'Fotos',
  contacts: 'Kontakte',
  notes: 'Notizen',
  reminders: 'Erinnerungen',
  pages: 'Pages',
  numbers: 'Numbers',
  keynote: 'Keynote',
  find: 'Wo ist?'
}

export function isICloudContentUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && (url.hostname === 'icloud.com' || url.hostname.endsWith('.icloud.com'))
  } catch { return false }
}

export function isICloudServiceUrl(value: string, service: ICloudService): boolean {
  try {
    const url = new URL(value)
    const expected = new URL(ICLOUD_SERVICES[service])
    return url.protocol === 'https:' && url.hostname === expected.hostname &&
      (url.pathname === expected.pathname.slice(0, -1) || url.pathname.startsWith(expected.pathname))
  } catch { return false }
}

/**
 * Apples feste Server für iCloud Mail und Kalender.
 *
 * Quelle: support.apple.com/102525 (IMAP/SMTP) und die CalDAV-Adresse, die
 * auch macOS und iOS verwenden. Fest eingetragen, damit weder Modell noch
 * Postfachinhalt die Zugangsdaten an einen anderen Rechner lenken können.
 */
export const ICLOUD_MAIL = {
  imapHost: 'imap.mail.me.com',
  imapPort: 993,
  smtpHost: 'smtp.mail.me.com',
  smtpPort: 587
} as const

export const ICLOUD_CALDAV = 'https://caldav.icloud.com/'

/** Nur Apples eigene CalDAV-Rechner (pXX-caldav.icloud.com) dürfen die Zugangsdaten sehen. */
export function isICloudDavUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && (url.hostname === 'caldav.icloud.com' || /^p\d+-caldav\.icloud\.com$/.test(url.hostname))
  } catch { return false }
}

/**
 * Ein app-spezifisches Passwort sieht aus wie `abcd-efgh-ijkl-mnop`.
 *
 * Das normale Apple-Account-Passwort funktioniert für IMAP gar nicht, und es
 * soll hier auch nicht landen. Gibt die bereinigte Form zurück oder `null`.
 */
export function normalizeAppPassword(raw: string): string | null {
  const letters = raw.toLowerCase().replace(/[\s-]/g, '')
  if (!/^[a-z]{16}$/.test(letters)) return null
  return letters.match(/.{4}/g)!.join('-')
}

/** Die Absenderadresse: iCloud-Adresse oder eigene Domain mit iCloud+. */
export function normalizeICloudAddress(raw: string): string | null {
  const value = raw.trim().toLowerCase()
  if (value.length > 254 || !/^[^\s@<>()",;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value)) return null
  return value
}

/** Ob eine Adresse eine Apple-eigene Mail-Domain hat. Eigene Domains gehen mit iCloud+ auch. */
export function isAppleMailDomain(address: string): boolean {
  return /@(icloud|me|mac)\.com$/i.test(address.trim())
}

/**
 * Wo „iCloud für Windows“ den Drive-Ordner ablegt.
 *
 * Die Store-Fassung legt `%USERPROFILE%\iCloudDrive` an, ältere Fassungen und
 * manche Sprachversionen `iCloud Drive`. Der Nutzer kann den Ort nicht frei
 * wählen; deshalb genügt diese kurze Liste.
 */
export function iCloudDriveCandidates(home: string): string[] {
  const base = home.replace(/[\\/]+$/, '')
  return [`${base}\\iCloudDrive`, `${base}\\iCloud Drive`]
}

/** Namen der Anmeldecookies von iCloud.com. Ihr Vorhandensein ist ein Hinweis, keine Bestätigung. */
export const ICLOUD_AUTH_COOKIES = ['X-APPLE-WEBAUTH-USER', 'X-APPLE-WEBAUTH-TOKEN', 'X-APPLE-DS-WEB-SESSION-TOKEN'] as const

export function hasICloudAuthCookie(cookies: Array<{ name: string; domain?: string; expirationDate?: number }>, nowSeconds = Date.now() / 1000): boolean {
  return cookies.some((cookie) => {
    const domain = (cookie.domain ?? '').replace(/^\./, '').toLowerCase()
    if (domain !== 'icloud.com' && !domain.endsWith('.icloud.com')) return false
    if (!(ICLOUD_AUTH_COOKIES as readonly string[]).includes(cookie.name)) return false
    return cookie.expirationDate === undefined || cookie.expirationDate > nowSeconds
  })
}

// ─────────────────────────────────────────────────────────────
// CalDAV-Antworten lesen
// ─────────────────────────────────────────────────────────────

/**
 * WebDAV-Antworten sind XML mit wechselnden Präfixen (`d:`, `D:`, ohne).
 * Ein vollständiger XML-Leser wäre für die drei Felder hier zu viel; diese
 * Helfer suchen Elemente unabhängig vom Präfix.
 */
function elements(xml: string, name: string): string[] {
  const pattern = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'gi')
  return [...xml.matchAll(pattern)].map((match) => match[1])
}

function first(xml: string, name: string): string | null {
  return elements(xml, name)[0] ?? null
}

function hasEmpty(xml: string, name: string): boolean {
  return new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?/>|<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>`, 'i').test(xml)
}

export function decodeXmlText(value: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/.exec(value)
  if (cdata) return cdata[1]
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Das `href` innerhalb eines Eigenschaftselements, z. B. `current-user-principal`. */
export function davHref(xml: string, property: string): string | null {
  const inner = first(xml, property)
  if (inner === null) return null
  const href = first(inner, 'href')
  return href ? decodeXmlText(href.trim()) : null
}

export interface DavCalendar { href: string; name: string }

/** Kalender aus einer PROPFIND-Antwort mit Depth 1 auf dem calendar-home-set. */
export function davCalendars(xml: string): DavCalendar[] {
  const out: DavCalendar[] = []
  for (const response of elements(xml, 'response')) {
    const href = first(response, 'href')
    const type = first(response, 'resourcetype') ?? ''
    if (!href || !hasEmpty(type, 'calendar')) continue
    const components = first(response, 'supported-calendar-component-set')
    // Erinnerungen liegen als VTODO-Kalender daneben; hier geht es um Termine.
    if (components !== null && !/name="VEVENT"/i.test(components)) continue
    const name = decodeXmlText((first(response, 'displayname') ?? '').trim())
    out.push({ href: decodeXmlText(href.trim()), name: name || 'Kalender' })
  }
  return out
}

/** Die einzelnen iCalendar-Texte aus einer REPORT-Antwort. */
export function davCalendarData(xml: string): string[] {
  return elements(xml, 'calendar-data').map((value) => decodeXmlText(value).trim()).filter((text) => /BEGIN:VCALENDAR/i.test(text))
}

/** Was die Einstellungen über iCloud anzeigen. Passwörter verlassen den Hauptprozess nie. */
export interface ICloudStatus {
  /** Anmeldecookie im James-Browser gefunden. Ein Hinweis, keine Bestätigung. */
  web: boolean
  mailAddress: string | null
  /** Adresse und app-spezifisches Passwort sind gespeichert. */
  mailConfigured: boolean
  /** Ordner von „iCloud für Windows“, falls vorhanden. */
  drivePath: string | null
}

export interface ICloudCheck {
  mail: { ok: boolean; detail: string }
  calendar: { ok: boolean; detail: string }
}

export interface ICloudMailSummary {
  uid: number
  von: string
  betreff: string
  datum: string | null
  gelesen: boolean
}

export interface ICloudMailMessage {
  uid: number
  von: string
  an: string
  betreff: string
  datum: string | null
  messageId: string | null
  anhaenge: string[]
  text: string
  gekuerzt: boolean
}

export interface ICloudCalendarEvent {
  title: string
  start: number
  end: number
  allDay: boolean
  location?: string
  kalender: string
}

export interface ICloudDriveEntry {
  /** Relativ zum Drive-Ordner, mit `\` unter Windows. */
  pfad: string
  name: string
  ordner: boolean
  groesse?: number
  geaendert?: string
}

/** Microsoft-Store-Seite von „iCloud für Windows“. */
export const ICLOUD_FOR_WINDOWS_STORE = 'ms-windows-store://pdp/?productid=9PKTQ5699M62'
export const APPLE_APP_PASSWORD_URL = 'https://account.apple.com/account/manage/section/security'
