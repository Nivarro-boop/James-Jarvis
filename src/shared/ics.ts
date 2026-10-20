/**
 * Kalender über einen geheimen iCal-Link (ICS), ohne Anmeldung beim Anbieter.
 *
 * Google, Outlook und iCloud bieten für jeden Kalender eine private Adresse an,
 * unter der der Kalender als Textdatei im iCalendar-Format liegt. Wer diese
 * Adresse hat, kann den Kalender lesen — mehr nicht. Damit sieht James die
 * Termine auch ohne Google-OAuth und auch bei Outlook oder iCloud.
 *
 * Der Leser hier ist bewusst klein und eigen: Er versteht, was diese drei
 * Anbieter tatsächlich ausliefern (VEVENT mit DTSTART/DTEND, TZID oder UTC,
 * ganztägige Termine, einfache RRULE mit INTERVAL/COUNT/UNTIL/BYDAY, EXDATE
 * und verschobene Einzeltermine über RECURRENCE-ID). Exotische Regeln
 * (BYSETPOS, BYWEEKNO, „jeden zweiten Montag im Monat") werden auf ihre
 * Grundfrequenz zurückgeführt statt geraten.
 *
 * Außerdem baut die Datei Termine zum Selbst-Speichern: einen Google- und einen
 * Outlook-Link und eine .ics-Datei. James trägt damit nichts ein — der Nutzer
 * klickt im eigenen Kalender auf Speichern.
 */

export interface IcsEvent {
  uid: string
  title: string
  start: number
  end: number
  allDay: boolean
  location?: string
  description?: string
}

interface RawEvent {
  uid: string
  summary: string
  location?: string
  description?: string
  start: number
  end: number | null
  durationMs: number | null
  allDay: boolean
  startTimeZone: string | null
  startUtc: boolean
  rrule: string | null
  exdates: number[]
  recurrenceId: number | null
  cancelled: boolean
}

const MAX_OCCURRENCES = 5000

/** Zeilen entfalten: Fortsetzungszeilen beginnen mit Leerzeichen oder Tab. */
function unfold(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n')
}

function unescapeText(value: string): string {
  return value.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim()
}

interface Prop {
  name: string
  params: Record<string, string>
  value: string
}

function parseLine(line: string): Prop | null {
  // Der Doppelpunkt kann in Parameterwerten in Anführungszeichen stehen.
  let inQuote = false
  let colon = -1
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') inQuote = !inQuote
    else if (c === ':' && !inQuote) {
      colon = i
      break
    }
  }
  if (colon < 0) return null
  const head = line.slice(0, colon).split(';')
  const params: Record<string, string> = {}
  for (const p of head.slice(1)) {
    const eq = p.indexOf('=')
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '')
  }
  return { name: head[0].toUpperCase(), params, value: line.slice(colon + 1) }
}

/** Versatz einer Zeitzone zu UTC in Minuten, zum gegebenen Zeitpunkt. */
function tzOffsetMinutes(utcMs: number, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).formatToParts(new Date(utcMs))
    const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value)
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
    return Math.round((asUtc - utcMs) / 60000)
  } catch {
    return NaN
  }
}

/** Windows-Namen, wie Outlook sie gern statt IANA schreibt. */
const WINDOWS_ZONES: Record<string, string> = {
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'GMT Standard Time': 'Europe/London',
  'UTC': 'UTC',
  'Eastern Standard Time': 'America/New_York',
  'Pacific Standard Time': 'America/Los_Angeles'
}

function wallToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const zone = WINDOWS_ZONES[tz] ?? tz
  const guess = Date.UTC(y, mo - 1, d, h, mi, s)
  const off1 = tzOffsetMinutes(guess, zone)
  if (!Number.isFinite(off1)) return new Date(y, mo - 1, d, h, mi, s).getTime()
  const first = guess - off1 * 60000
  const off2 = tzOffsetMinutes(first, zone)
  return off2 === off1 ? first : guess - off2 * 60000
}

/** Lokale Kalenderfelder einer TZID-Zeit als UTC-basierte Rechendatei. */
function zonedWallDate(utcMs: number, timeZone: string): Date {
  const zone = WINDOWS_ZONES[timeZone] ?? timeZone
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(new Date(utcMs))
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value)
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')))
}

/** Ein DATE oder DATE-TIME lesen. Ganztägig heißt: lokale Mitternacht. */
export function parseIcsDate(value: string, params: Record<string, string> = {}): { ms: number; allDay: boolean } | null {
  const v = value.trim()
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v)
  if (!m) return null
  const [, ys, mos, ds, hs, mis, ss, z] = m
  const y = Number(ys)
  const mo = Number(mos)
  const d = Number(ds)
  if (hs === undefined || params.VALUE === 'DATE') {
    return { ms: new Date(y, mo - 1, d).getTime(), allDay: true }
  }
  const h = Number(hs)
  const mi = Number(mis)
  const s = Number(ss ?? '0')
  if (z) return { ms: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false }
  if (params.TZID) return { ms: wallToUtc(y, mo, d, h, mi, s, params.TZID), allDay: false }
  return { ms: new Date(y, mo - 1, d, h, mi, s).getTime(), allDay: false }
}

function parseDuration(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim())
  if (!m) return null
  const [, sign, w, d, h, mi, s] = m
  const ms = ((Number(w ?? 0) * 7 + Number(d ?? 0)) * 86400 + Number(h ?? 0) * 3600 + Number(mi ?? 0) * 60 + Number(s ?? 0)) * 1000
  return sign === '-' ? -ms : ms
}

function parseEvents(text: string): RawEvent[] {
  const out: RawEvent[] = []
  let cur: Partial<RawEvent> & { exdates?: number[] } | null = null
  let depth = 0
  for (const line of unfold(text)) {
    if (!line) continue
    const upper = line.toUpperCase()
    if (upper === 'BEGIN:VEVENT') {
      cur = { exdates: [], allDay: false, rrule: null, recurrenceId: null, end: null, durationMs: null, cancelled: false }
      depth = 0
      continue
    }
    if (!cur) continue
    // Eingebettete Blöcke (VALARM) gehören nicht zum Termin selbst.
    if (upper.startsWith('BEGIN:')) { depth++; continue }
    if (upper.startsWith('END:') && depth > 0) { depth--; continue }
    if (depth > 0) continue
    if (upper === 'END:VEVENT') {
      if (cur.start !== undefined && Number.isFinite(cur.start)) {
        out.push({
          uid: cur.uid ?? `ics-${out.length}`,
          summary: cur.summary || 'Termin',
          location: cur.location,
          description: cur.description,
          start: cur.start,
          end: cur.end ?? null,
          durationMs: cur.durationMs ?? null,
          allDay: cur.allDay ?? false,
          startTimeZone: cur.startTimeZone ?? null,
          startUtc: cur.startUtc ?? false,
          rrule: cur.rrule ?? null,
          exdates: cur.exdates ?? [],
          recurrenceId: cur.recurrenceId ?? null,
          cancelled: cur.cancelled ?? false
        })
      }
      cur = null
      continue
    }
    const prop = parseLine(line)
    if (!prop) continue
    switch (prop.name) {
      case 'UID': cur.uid = prop.value.trim(); break
      case 'SUMMARY': cur.summary = unescapeText(prop.value); break
      case 'LOCATION': cur.location = unescapeText(prop.value) || undefined; break
      case 'DESCRIPTION': cur.description = unescapeText(prop.value).slice(0, 500) || undefined; break
      case 'STATUS': cur.cancelled = prop.value.trim().toUpperCase() === 'CANCELLED'; break
      case 'RRULE': cur.rrule = prop.value.trim(); break
      case 'DURATION': cur.durationMs = parseDuration(prop.value); break
      case 'DTSTART': {
        const d = parseIcsDate(prop.value, prop.params)
        if (d) {
          cur.start = d.ms
          cur.allDay = d.allDay
          cur.startUtc = !d.allDay && /Z$/i.test(prop.value.trim())
          const zone = prop.params.TZID
          // Ungültige Anbieter-Zonennamen behalten den lokalen Fallback des
          // Datumslesers. DATE-Werte haben grundsätzlich keine Zeitzone.
          cur.startTimeZone = !d.allDay && !cur.startUtc && zone &&
            Number.isFinite(tzOffsetMinutes(d.ms, WINDOWS_ZONES[zone] ?? zone)) ? zone : null
        }
        break
      }
      case 'DTEND': {
        const d = parseIcsDate(prop.value, prop.params)
        if (d) cur.end = d.ms
        break
      }
      case 'EXDATE':
        for (const part of prop.value.split(',')) {
          const d = parseIcsDate(part, prop.params)
          if (d) cur.exdates!.push(d.ms)
        }
        break
      case 'RECURRENCE-ID': {
        const d = parseIcsDate(prop.value, prop.params)
        if (d) cur.recurrenceId = d.ms
        break
      }
    }
  }
  return out
}

const WEEKDAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }

function parseRule(rule: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of rule.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0) out[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).toUpperCase()
  }
  return out
}

/** Alle Beginnzeitpunkte einer Serie bis `until` (inklusive DTSTART selbst). */
function expandStarts(ev: RawEvent, until: number): number[] {
  if (!ev.rrule) return [ev.start]
  const r = parseRule(ev.rrule)
  const freq = r.FREQ
  const interval = Math.max(1, Number(r.INTERVAL) || 1)
  const count = r.COUNT ? Number(r.COUNT) : Infinity
  const ruleUntil = r.UNTIL ? parseIcsDate(r.UNTIL)?.ms ?? Infinity : Infinity
  const limit = Math.min(until, ruleUntil)
  const calendarIsUtc = ev.startUtc || ev.startTimeZone !== null
  const base = ev.startTimeZone ? zonedWallDate(ev.start, ev.startTimeZone) : new Date(ev.start)
  const occurrenceTime = (d: Date): number => ev.startTimeZone
    ? wallToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), ev.startTimeZone)
    : d.getTime()
  const getDay = (d: Date): number => calendarIsUtc ? d.getUTCDay() : d.getDay()
  const getDate = (d: Date): number => calendarIsUtc ? d.getUTCDate() : d.getDate()
  const getMonth = (d: Date): number => calendarIsUtc ? d.getUTCMonth() : d.getMonth()
  const getFullYear = (d: Date): number => calendarIsUtc ? d.getUTCFullYear() : d.getFullYear()
  const setDate = (d: Date, value: number): void => { if (calendarIsUtc) d.setUTCDate(value); else d.setDate(value) }
  const setMonth = (d: Date, value: number): void => { if (calendarIsUtc) d.setUTCMonth(value); else d.setMonth(value) }
  const setFullYear = (d: Date, value: number): void => { if (calendarIsUtc) d.setUTCFullYear(value); else d.setFullYear(value) }
  const out: number[] = []
  const push = (d: Date): boolean => {
    const ms = occurrenceTime(d)
    if (ms < ev.start) return true
    if (ms > limit || out.length >= count || out.length >= MAX_OCCURRENCES) return false
    out.push(ms)
    return true
  }
  const byDay = (r.BYDAY ?? '')
    .split(',')
    .map((x) => WEEKDAYS[x.replace(/^[+-]?\d+/, '')])
    .filter((x) => x !== undefined)

  if (freq === 'WEEKLY' && byDay.length > 0) {
    // Woche ab Montag, wie WKST=MO bei allen drei Anbietern.
    const weekStart = new Date(base)
    setDate(weekStart, getDate(weekStart) - ((getDay(weekStart) + 6) % 7))
    const days = [...byDay].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
    for (let w = 0; w < 5000; w += interval) {
      for (const wd of days) {
        const d = new Date(weekStart)
        setDate(d, getDate(d) + w * 7 + ((wd + 6) % 7))
        if (!push(d)) return out
      }
    }
    return out
  }

  for (let i = 0; i < MAX_OCCURRENCES * interval; i += interval) {
    const d = new Date(base)
    if (freq === 'DAILY') setDate(d, getDate(d) + i)
    else if (freq === 'WEEKLY') setDate(d, getDate(d) + i * 7)
    else if (freq === 'MONTHLY') {
      setMonth(d, getMonth(d) + i)
      // 31. im Februar gibt es nicht — solche Monate überspringt die Regel.
      if (getDate(d) !== getDate(base)) continue
    } else if (freq === 'YEARLY') {
      setFullYear(d, getFullYear(d) + i)
      if (getMonth(d) !== getMonth(base)) continue
    } else return [ev.start]
    if (!push(d)) return out
  }
  return out
}

/** Termine, die das Fenster [from, to) berühren, sortiert nach Beginn. */
export function eventsInRange(text: string, from: number, to: number): IcsEvent[] {
  const raw = parseEvents(text)
  const overrides = new Map<string, RawEvent[]>()
  for (const ev of raw) {
    if (ev.recurrenceId !== null) {
      const list = overrides.get(ev.uid) ?? []
      list.push(ev)
      overrides.set(ev.uid, list)
    }
  }
  const out: IcsEvent[] = []
  const add = (ev: RawEvent, start: number): void => {
    let end: number
    if (ev.allDay) {
      const dayNumber = (ms: number): number => {
        const d = new Date(ms)
        return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000
      }
      const days = ev.end !== null
        ? dayNumber(ev.end) - dayNumber(ev.start)
        : Math.floor((ev.durationMs ?? 86400000) / 86400000)
      const endDate = new Date(start)
      endDate.setDate(endDate.getDate() + Math.max(0, days))
      end = endDate.getTime()
    } else {
      const dur = ev.end !== null ? ev.end - ev.start : ev.durationMs ?? 0
      end = start + Math.max(0, dur)
    }
    if (ev.cancelled) return
    if (end <= from && !(end === start && start >= from)) return
    if (start >= to) return
    out.push({
      uid: ev.uid,
      title: ev.summary,
      start,
      end,
      allDay: ev.allDay,
      ...(ev.location ? { location: ev.location } : {}),
      ...(ev.description ? { description: ev.description } : {})
    })
  }
  for (const ev of raw) {
    if (ev.recurrenceId !== null) {
      add(ev, ev.start)
      continue
    }
    const moved = new Set((overrides.get(ev.uid) ?? []).map((o) => o.recurrenceId))
    const ex = new Set(ev.exdates)
    for (const start of expandStarts(ev, to)) {
      if (ex.has(start) || moved.has(start)) continue
      add(ev, start)
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

/** webcal:// ist dieselbe Adresse über HTTPS. Alles andere als HTTPS wird abgelehnt. */
export function normalizeIcsUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/^webcals?:\/\//i, 'https://')
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// Termin zum Selbst-Speichern
// ─────────────────────────────────────────────────────────────

export interface DraftEvent {
  title: string
  start: Date
  end: Date
  allDay?: boolean
  location?: string
  description?: string
}

const pad = (n: number): string => String(n).padStart(2, '0')

function utcStamp(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
}

function dateStamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

const utf8Len = (s: string): number => new TextEncoder().encode(s).length

/** Zeilen über 75 Oktette falten, wie RFC 5545 es verlangt. */
function fold(line: string): string {
  const out: string[] = []
  let rest = line
  while (utf8Len(rest) > 75) {
    let cut = 74
    while (utf8Len(rest.slice(0, cut)) > 74) cut--
    out.push(rest.slice(0, cut))
    rest = ' ' + rest.slice(cut)
  }
  out.push(rest)
  return out.join('\r\n')
}

export function buildIcs(ev: DraftEvent, uid: string, now: Date = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//James-Jarvis//Termin//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${utcStamp(now)}`,
    ev.allDay ? `DTSTART;VALUE=DATE:${dateStamp(ev.start)}` : `DTSTART:${utcStamp(ev.start)}`,
    ev.allDay ? `DTEND;VALUE=DATE:${dateStamp(ev.end)}` : `DTEND:${utcStamp(ev.end)}`,
    `SUMMARY:${escapeText(ev.title)}`,
    ...(ev.location ? [`LOCATION:${escapeText(ev.location)}`] : []),
    ...(ev.description ? [`DESCRIPTION:${escapeText(ev.description)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR'
  ]
  return lines.map(fold).join('\r\n') + '\r\n'
}

export function googleCalendarLink(ev: DraftEvent): string {
  const dates = ev.allDay ? `${dateStamp(ev.start)}/${dateStamp(ev.end)}` : `${utcStamp(ev.start)}/${utcStamp(ev.end)}`
  const p = new URLSearchParams({ action: 'TEMPLATE', text: ev.title, dates })
  if (ev.location) p.set('location', ev.location)
  if (ev.description) p.set('details', ev.description)
  return `https://calendar.google.com/calendar/render?${p.toString()}`
}

export function outlookCalendarLink(ev: DraftEvent, work = false): string {
  const iso = (d: Date): string => (ev.allDay ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : d.toISOString())
  const p = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: ev.title,
    startdt: iso(ev.start),
    enddt: iso(ev.end)
  })
  if (ev.allDay) p.set('allday', 'true')
  if (ev.location) p.set('location', ev.location)
  if (ev.description) p.set('body', ev.description)
  const host = work ? 'outlook.office.com' : 'outlook.live.com'
  return `https://${host}/calendar/0/deeplink/compose?${p.toString()}`
}
