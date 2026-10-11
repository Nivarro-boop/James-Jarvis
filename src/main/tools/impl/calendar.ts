import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { friendlyGoogleError, googleClient, hasCalendarAuth, hasGoogleAuth } from '../../providers/googleAuth'
import {
  addDays,
  computeEnd,
  localTimeZone,
  parseWhen,
  RANGES,
  resolveRange,
  speakable,
  type When
} from './calendarTime'

/**
 * Google Kalender — alle Kalender, nicht nur der primäre.
 *
 * James sieht jetzt alle Kalender: primary, Arbeitskalender, Familienkalender,
 * Feiertagskalender — alles, was im Google-Konto eingebunden ist.
 *
 * Mit dem optionalen `kalender`-Parameter lässt sich ein bestimmter Kalender
 * ansprechen. Ohne Angabe liest `calendar_agenda` alle auf einmal.
 *
 * Lesen läuft ohne Rückfrage. Eintragen, Verschieben und Absagen fragen immer
 * nach — ein verschobener Zahnarzttermin, von dem der Nutzer nichts weiß, ist
 * schlimmer als gar kein Kalender.
 *
 * Endgültig gelöscht wird nichts. Google legt abgesagte Termine in seinen
 * Papierkorb, wo sie dreißig Tage lang wiederherstellbar bleiben.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function calendarApi(): Promise<any> {
  if (hasGoogleAuth() && !hasCalendarAuth()) {
    throw new Error(
      'Die Google-Anmeldung ist älter als der Kalender und deckt ihn nicht ab. Sag dem Nutzer, ' +
        'er soll sich unter Einstellungen, Verbindungen einmal neu verbinden — danach geht es.'
    )
  }
  const { google } = await import('googleapis')
  const auth = await googleClient(false)
  return google.calendar({ version: 'v3', auth })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function withCalendar<T>(fn: (calendar: any) => Promise<T>): Promise<T> {
  const calendar = await calendarApi()
  try {
    return await fn(calendar)
  } catch (err) {
    throw new Error(friendlyGoogleError(err))
  }
}

/**
 * Alle verfügbaren Kalender-IDs holen.
 *
 * Die Rückgabe enthält immer mindestens `primary`. Nicht-sichtbare Kalender
 * (z. B. automatische Geburtstagserinnerungen) werden übersprungen, weil sie
 * in der Agendaansicht nichts verloren haben.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function listCalendarIds(calendar: any): Promise<{ id: string; name: string }[]> {
  const res = await calendar.calendarList.list({ minAccessRole: 'reader' })
  const items: { id: string; name: string }[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const item of res.data.items ?? []) {
    if (item.deleted || item.hidden) continue
    items.push({ id: item.id, name: item.summary || item.id })
  }
  // primary zuerst
  items.sort((a, b) => (a.id === 'primary' ? -1 : b.id === 'primary' ? 1 : 0))
  return items
}

/**
 * Einen Kalender-Namen in eine ID auflösen.
 *
 * Wenn der Nutzer "Arbeit" sagt und es einen Kalender gibt, dessen Name
 * "Arbeit" enthält, soll der gemeint sein. Ohne Treffer: `null`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveCalendarId(calendar: any, nameOrId: string): Promise<string | null> {
  const lower = nameOrId.toLowerCase()
  const list = await listCalendarIds(calendar)
  // Exakter Treffer zuerst (ID oder Name)
  const exact = list.find((c) => c.id.toLowerCase() === lower || c.name.toLowerCase() === lower)
  if (exact) return exact.id
  // Teilstring
  const partial = list.find((c) => c.name.toLowerCase().includes(lower))
  return partial?.id ?? null
}

/**
 * Den Kalender finden, in dem ein Termin tatsächlich liegt.
 *
 * Seit die Agenda alle Kalender liest, kann eine Kennung aus jedem von ihnen
 * stammen. Verschieben und Absagen nahmen bisher `primary`, wenn das Modell
 * den Kalender nicht mitgab — und der Zahnarzttermin aus dem Familienkalender
 * ließ sich nicht absagen, mit einem 404 von Google als einziger Auskunft.
 *
 * Der genannte Kalender wird zuerst geprüft, und das ist mehr als eine
 * Abkürzung: Ein Termin, zu dem man eingeladen ist, trägt im eigenen und im
 * fremden Kalender dieselbe Kennung. Ohne Vorrang für den genannten träfe die
 * Änderung womöglich die andere Kopie.
 */
async function locateEvent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  calendar: any,
  eventId: string,
  hint?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ calId: string; calName: string; event: any }> {
  const list = await listCalendarIds(calendar)
  const nameOf = (id: string): string => list.find((c) => c.id === id)?.name ?? id

  const tryGet = async (calId: string): Promise<{ calId: string; calName: string; event: unknown } | null> => {
    try {
      const res = await calendar.events.get({ calendarId: calId, eventId })
      return { calId, calName: nameOf(calId), event: res.data }
    } catch {
      return null
    }
  }

  // Der Reihe nach: was genannt wurde, dann der primäre.
  const preferred: string[] = []
  if (hint) {
    const resolved = await resolveCalendarId(calendar, hint)
    if (resolved) preferred.push(resolved)
  }
  if (!preferred.includes('primary')) preferred.push('primary')

  for (const calId of preferred) {
    const hit = await tryGet(calId)
    if (hit) return hit
  }

  // Danach der Rest, alle auf einmal — bei einem halben Dutzend Kalendern
  // wäre nacheinander eine spürbare Pause mitten im Gespräch.
  const rest = list.map((c) => c.id).filter((id) => !preferred.includes(id))
  const hits = await Promise.all(rest.map(tryGet))
  const found = hits.find((h) => h !== null)
  if (found) return found

  throw new Error(
    `Diesen Termin gibt es in keinem deiner Kalender (mehr). Such ihn mit calendar_search noch ` +
      'einmal — die Kennung könnte veraltet sein.'
  )
}

/**
 * Anfang und Ende so, wie Googles API sie erwartet.
 */
function timing(start: When, end: When): Record<string, unknown> {
  const zone = localTimeZone()
  return {
    start: start.date ? { date: start.date } : { dateTime: start.dateTime, timeZone: zone },
    end: end.date ? { date: end.date } : { dateTime: end.dateTime, timeZone: zone }
  }
}

/**
 * Der Zeitpunkt eines Termins als Zahl — zum Sortieren.
 *
 * Gebraucht wird das erst, seit die Agenda mehrere Kalender auf einmal liest.
 * Innerhalb eines Kalenders sortiert Google selbst (`orderBy: 'startTime'`);
 * die Reihenfolge zwischen zwei Kalendern muss hier entstehen, und zwar bevor
 * gekürzt wird — sonst fallen nicht die spätesten Termine weg, sondern
 * beliebige.
 *
 * Ganztägige Termine kommen als `date` ohne Uhrzeit. Ihnen den Tagesanfang in
 * Ortszeit zu geben ist Absicht: `new Date('2026-08-15')` läse das Datum als
 * UTC und legte den Termin in Wien auf zwei Uhr früh — also hinter einen
 * Termin um 01:00, der eigentlich später am Tag stattfindet.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function startMillis(event: any): number {
  const start = event?.start
  if (start?.dateTime) return new Date(start.dateTime).getTime()
  if (start?.date) return new Date(`${start.date}T00:00:00`).getTime()
  // Ohne Zeitangabe ans Ende, statt mit NaN die Sortierung zu zerlegen.
  return Number.MAX_SAFE_INTEGER
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function summarize(event: any, calendarName?: string): Record<string, unknown> {
  return {
    id: event.id,
    titel: event.summary || '(ohne Titel)',
    wann: speakable(event),
    ort: event.location || undefined,
    notiz: event.description ? String(event.description).slice(0, 300) : undefined,
    teilnehmer:
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (event.attendees ?? []).map((a: any) => a.displayName || a.email).slice(0, 10) || undefined,
    kalender: calendarName || undefined,
    abgesagt: event.status === 'cancelled' || undefined
  }
}

// ─────────────────────────────────────────────────────────────
// Werkzeuge
// ─────────────────────────────────────────────────────────────

const listCalendars = defineTool({
  name: 'calendar_list_calendars',
  group: 'calendar',
  description:
    'Listet alle verfügbaren Google Kalender auf — primary, Arbeitskalender, Familienkalender, ' +
    'Feiertagskalender, etc. Nutze das, wenn der Nutzer wissen will, welche Kalender es gibt, ' +
    'oder bevor du einen Termin in einen bestimmten Kalender einträgst.',
  schema: z.object({}),
  requiresSecret: 'googleOAuthClientId',
  spokenHint: 'Ich schaue, welche Kalender du hast.',
  async execute() {
    return withCalendar(async (calendar) => {
      const list = await listCalendarIds(calendar)
      return {
        kalender: list.map((c) => ({ name: c.name, id: c.id })),
        hinweis: 'Nenne die Kalender beim Namen. Technische IDs nur auf Nachfrage.'
      }
    })
  }
}) as ToolDefinition

const agenda = defineTool({
  name: 'calendar_agenda',
  group: 'calendar',
  description:
    'Sagt, welche Termine anstehen — aus allen Kalendern oder einem bestimmten. ' +
    'Das richtige Werkzeug für "was habe ich heute", "was steht diese Woche an", ' +
    '"bin ich morgen früh frei". Nimmt einen Zeitraum als Wort — rechne selbst kein Datum aus. ' +
    'Ohne Kalenderangabe werden alle Kalender durchsucht.',
  schema: z.object({
    zeitraum: z
      .enum(RANGES)
      .optional()
      .describe('Welches Fenster. Standard ist heute.'),
    maximal: z.number().optional().describe('Höchstens so viele Termine, Standard fünfzehn.'),
    kalender: z
      .string()
      .optional()
      .describe(
        'Name oder ID eines bestimmten Kalenders, z.B. "Arbeit" oder "primary". ' +
          'Ohne Angabe werden alle Kalender abgefragt.'
      )
  }),
  requiresSecret: 'googleOAuthClientId',
  spokenHint: 'Ich sehe im Kalender nach.',
  async execute({ zeitraum, maximal, kalender }, ctx) {
    const { from, to, label } = resolveRange(zeitraum ?? 'heute')
    const showAgenda = (items: { event: any; name?: string }[]): void => {
      ctx?.show?.({ kind: 'agenda', id: `agenda:${label}:${kalender ?? 'alle'}`, range: label, events: items.map(({ event, name }) => ({
        title: event.summary || 'Termin', start: startMillis(event),
        ...(event.end?.dateTime || event.end?.date ? { end: new Date(event.end.dateTime || event.end.date).getTime() } : {}),
        allDay: Boolean(event.start?.date && !event.start?.dateTime), calendar: name, location: event.location || undefined
      })).filter(e => Number.isFinite(e.start)) })
    }
    return withCalendar(async (calendar) => {
      const max = Math.min(50, Math.max(1, maximal ?? 15))

      // Wenn ein bestimmter Kalender angegeben ist, nur den abfragen
      if (kalender) {
        const calId = await resolveCalendarId(calendar, kalender)
        if (!calId) {
          return {
            zeitraum: label,
            anzahl: 0,
            note: `Ich finde keinen Kalender namens "${kalender}". Nutze calendar_list_calendars um alle Kalender zu sehen.`
          }
        }
        const calList = await listCalendarIds(calendar)
        const calName = calList.find((c) => c.id === calId)?.name

        const res = await calendar.events.list({
          calendarId: calId,
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: max
        })
        const events = (res.data.items ?? []).filter(
          (e: { status?: string }) => e.status !== 'cancelled'
        )
        showAgenda(events.map((event: any) => ({ event, name: calName })))
        if (events.length === 0) {
          return { zeitraum: label, kalender: calName, anzahl: 0, note: `Für ${label} steht in "${calName}" nichts.` }
        }
        return { zeitraum: label, kalender: calName, anzahl: events.length, termine: events.map((e: unknown) => summarize(e)) }
      }

      // Alle Kalender abfragen
      const calList = await listCalendarIds(calendar)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const collected: { event: any; name: string; at: number }[] = []

      await Promise.all(
        calList.map(async ({ id, name }) => {
          try {
            const res = await calendar.events.list({
              calendarId: id,
              timeMin: from.toISOString(),
              timeMax: to.toISOString(),
              singleEvents: true,
              orderBy: 'startTime',
              maxResults: max
            })
            for (const e of res.data.items ?? []) {
              if (e.status !== 'cancelled') {
                collected.push({ event: e, name, at: startMillis(e) })
              }
            }
          } catch {
            // Einzelne Kalender können Leserechte fehlen — die überspringen wir.
          }
        })
      )

      // Nach der echten Startzeit sortieren, nicht nach dem vorgelesenen Satz:
      // Der fängt mit dem Wochentag an, und alphabetisch steht Dienstag vor
      // Montag. Erst danach kürzen, sonst fallen die falschen Termine weg.
      collected.sort((a, b) => a.at - b.at)
      showAgenda(collected.slice(0, max))

      const limited = collected.slice(0, max).map((c) => summarize(c.event, c.name))
      if (limited.length === 0) {
        return { zeitraum: label, anzahl: 0, note: `Für ${label} steht in keinem Kalender etwas.` }
      }
      return {
        zeitraum: label,
        kalender: 'alle',
        anzahl: limited.length,
        termine: limited,
        hinweis: 'Das Feld "kalender" sagt, aus welchem Kalender ein Termin kommt. Nenne es kurz.'
      }
    })
  }
}) as ToolDefinition

const search = defineTool({
  name: 'calendar_search',
  group: 'calendar',
  description:
    'Sucht einen Termin über einen Teil seines Titels, Orts oder Teilnehmers — etwa "Zahnarzt" ' +
    'oder "Elternabend". Durchsucht alle Kalender, oder nur einen bestimmten. ' +
    'Nutze das, bevor du einen Termin verschiebst oder absagst.',
  schema: z.object({
    suche: z.string().describe('Wonach gesucht wird.'),
    vergangenheit: z
      .boolean()
      .optional()
      .describe('Auch in bereits vergangenen Terminen suchen. Standard nein.'),
    kalender: z
      .string()
      .optional()
      .describe('Name oder ID eines bestimmten Kalenders. Ohne Angabe alle Kalender.')
  }),
  requiresSecret: 'googleOAuthClientId',
  spokenHint: 'Ich suche den Termin.',
  async execute({ suche, vergangenheit, kalender }) {
    return withCalendar(async (calendar) => {
      const now = new Date()
      const timeMin = (vergangenheit ? addDays(now, -365) : now).toISOString()
      const timeMax = addDays(now, 365).toISOString()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const searchInCalendar = async (calId: string, calName?: string): Promise<any[]> => {
        const res = await calendar.events.list({
          calendarId: calId,
          q: suche,
          timeMin,
          timeMax,
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 15
        })
        return (res.data.items ?? [])
          .filter((e: { status?: string }) => e.status !== 'cancelled')
          .map((e: unknown) => ({ event: e, name: calName, at: startMillis(e) }))
      }

      if (kalender) {
        const calId = await resolveCalendarId(calendar, kalender)
        if (!calId) {
          return { anzahl: 0, note: `Ich finde keinen Kalender namens "${kalender}".` }
        }
        const calList = await listCalendarIds(calendar)
        const calName = calList.find((c) => c.id === calId)?.name
        const found = await searchInCalendar(calId, calName)
        if (found.length === 0) return { anzahl: 0, note: `Zu "${suche}" steht in "${calName}" nichts.` }
        return { anzahl: found.length, termine: found.map((f) => summarize(f.event, f.name)) }
      }

      // Alle Kalender durchsuchen
      const calList = await listCalendarIds(calendar)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const collected: { event: any; name?: string; at: number }[] = []

      await Promise.all(
        calList.map(async ({ id, name }) => {
          try {
            collected.push(...(await searchInCalendar(id, name)))
          } catch {
            // Einzelne Kalender überspringen
          }
        })
      )

      if (collected.length === 0) {
        return { anzahl: 0, note: `Zu "${suche}" steht in keinem Kalender etwas.` }
      }
      // Der nächste Termin zuerst — sonst entscheidet darüber, welcher Kalender
      // zuerst geantwortet hat.
      collected.sort((a, b) => a.at - b.at)
      return {
        anzahl: collected.length,
        termine: collected.slice(0, 20).map((c) => summarize(c.event, c.name))
      }
    })
  }
}) as ToolDefinition

const create = defineTool({
  name: 'calendar_create',
  group: 'calendar',
  description:
    'Trägt einen Termin ein. Fragt vorher nach und liest dabei Titel und Zeit vor. ' +
    'Die Zeit muss konkret sein: 2026-08-15T14:30 mit Uhrzeit, 2026-08-15 für ganztägig. ' +
    'Rechne relative Angaben wie "morgen" vorher in ein Datum um. ' +
    'Mit dem optionalen Parameter "kalender" lässt sich ein bestimmter Kalender wählen.',
  schema: z.object({
    titel: z.string().describe('Worum es geht, kurz. Steht später im Kalender.'),
    beginn: z.string().describe('Startzeit als 2026-08-15T14:30 oder 2026-08-15 für ganztägig.'),
    dauerMinuten: z
      .number()
      .optional()
      .describe('Wie lange, in Minuten. Standard sechzig. Bei ganztägigen Terminen ohne Wirkung.'),
    ort: z.string().optional().describe('Wo, falls genannt.'),
    notiz: z.string().optional().describe('Zusätzlicher Text zum Termin.'),
    kalender: z
      .string()
      .optional()
      .describe(
        'In welchen Kalender eintragen. Name oder ID, z.B. "Arbeit" oder "primary". ' +
          'Standard ist der primäre Kalender.'
      )
  }),
  alwaysAsk: true,
  requiresSecret: 'googleOAuthClientId',
  async execute({ titel, beginn, dauerMinuten, ort, notiz, kalender }) {
    const start = parseWhen(beginn)
    const end = computeEnd(start, dauerMinuten ?? 60)

    return withCalendar(async (calendar) => {
      let calId = 'primary'
      let calName = 'primärer Kalender'

      if (kalender) {
        const resolved = await resolveCalendarId(calendar, kalender)
        if (!resolved) {
          throw new Error(
            `Ich finde keinen Kalender namens "${kalender}". Nutze calendar_list_calendars um alle Kalender zu sehen.`
          )
        }
        calId = resolved
        const calList = await listCalendarIds(calendar)
        calName = calList.find((c) => c.id === calId)?.name ?? calId
      }

      const res = await calendar.events.insert({
        calendarId: calId,
        requestBody: { summary: titel, location: ort, description: notiz, ...timing(start, end) }
      })
      return {
        eingetragen: true,
        id: res.data.id,
        titel,
        wann: speakable(res.data),
        kalender: calName
      }
    })
  }
}) as ToolDefinition

const reschedule = defineTool({
  name: 'calendar_reschedule',
  group: 'calendar',
  description:
    'Verschiebt einen bestehenden Termin auf eine neue Zeit. Braucht die Kennung aus ' +
    'calendar_search oder calendar_agenda. Fragt vorher nach.',
  schema: z.object({
    id: z.string().describe('Die Kennung des Termins.'),
    beginn: z.string().describe('Die neue Startzeit, 2026-08-15T14:30 oder 2026-08-15.'),
    dauerMinuten: z
      .number()
      .optional()
      .describe('Neue Dauer in Minuten. Ohne Angabe bleibt die bisherige erhalten.'),
    kalender: z
      .string()
      .optional()
      .describe(
        'Aus welchem Kalender der Termin stammt — das Feld "kalender" aus calendar_agenda oder ' +
          'calendar_search. Fehlt die Angabe, wird in allen Kalendern gesucht.'
      )
  }),
  alwaysAsk: true,
  requiresSecret: 'googleOAuthClientId',
  async execute({ id, beginn, dauerMinuten, kalender }) {
    const start = parseWhen(beginn)

    return withCalendar(async (calendar) => {
      const { calId, calName, event } = await locateEvent(calendar, id, kalender)

      let minutes = dauerMinuten
      if (!minutes && event.start?.dateTime && event.end?.dateTime) {
        minutes = Math.round(
          (new Date(event.end.dateTime).getTime() - new Date(event.start.dateTime).getTime()) / 60_000
        )
      }

      const res = await calendar.events.patch({
        calendarId: calId,
        eventId: id,
        requestBody: timing(start, computeEnd(start, minutes ?? 60))
      })
      return {
        verschoben: true,
        titel: res.data.summary || '(ohne Titel)',
        wann: speakable(res.data),
        kalender: calName
      }
    })
  }
}) as ToolDefinition

const cancel = defineTool({
  name: 'calendar_cancel',
  group: 'calendar',
  description:
    'Sagt einen Termin ab und nimmt ihn aus dem Kalender. Braucht die Kennung aus ' +
    'calendar_search. Fragt immer vorher nach und liest dabei den Titel vor.',
  schema: z.object({
    id: z.string().describe('Die Kennung des Termins.'),
    kalender: z
      .string()
      .optional()
      .describe(
        'Aus welchem Kalender der Termin stammt — das Feld "kalender" aus calendar_agenda oder ' +
          'calendar_search. Fehlt die Angabe, wird in allen Kalendern gesucht.'
      )
  }),
  alwaysAsk: true,
  requiresSecret: 'googleOAuthClientId',
  async execute({ id, kalender }) {
    return withCalendar(async (calendar) => {
      const { calId, calName, event } = await locateEvent(calendar, id, kalender)
      const titel = event.summary || '(ohne Titel)'
      const wann = speakable(event)

      await calendar.events.delete({ calendarId: calId, eventId: id })
      return {
        abgesagt: true,
        titel,
        wann,
        kalender: calName,
        note: 'Liegt dreißig Tage im Papierkorb von Google Kalender und ist bis dahin wiederherstellbar.'
      }
    })
  }
}) as ToolDefinition

export const calendarTools: ToolDefinition[] = [listCalendars, agenda, search, create, reschedule, cancel]

export const __internals = { resolveRange, parseWhen, speakable }
