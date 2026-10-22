import { hasSecret } from '../secrets/keystore'
import { hasCalendarAuth } from '../providers/googleAuth'
import { calendarTools } from '../tools/impl/calendar'
import { calendarLinkTools } from '../tools/impl/calendarLink'
import type { ToolContext, ToolDefinition } from '../tools/registry'
import { localTimeZone } from '../tools/impl/calendarTime'
import type { WorkspaceCalendarEvent, WorkspaceCalendarRead, WorkspaceCalendarSource } from '@shared/workspace'

interface AgendaEvent {
  title?: unknown
  start?: unknown
  end?: unknown
  allDay?: unknown
  calendar?: unknown
  location?: unknown
  id?: unknown
}
interface AgendaCard { kind?: string; events?: AgendaEvent[] }
type AgendaReader = (now: Date) => Promise<AgendaCard>

let consentEpoch = 0
/** Invalidate every in-flight read when the user opts out; re-enabling never revives an old response. */
export function invalidateWorkspaceCalendarReads(): void { consentEpoch++ }
/** Capture the current consent epoch; a prior read remains invalid after opt-out and later opt-in. */
export function workspaceCalendarReadIsCurrent(): () => boolean {
  const epoch = consentEpoch
  return () => epoch === consentEpoch
}

function source(state: WorkspaceCalendarSource['state'], events: WorkspaceCalendarEvent[] = [], error?: string, fetchedAt?: number): WorkspaceCalendarSource {
  return { state, events, ...(error ? { error } : {}), ...(fetchedAt === undefined ? {} : { fetchedAt }) }
}
function cleanError(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'Quelle konnte nicht geladen werden.'
  return raw.replace(/https?:\/\/\S+/gi, '[Kalenderadresse ausgeblendet]')
    .replace(/(access[_ -]?token|refresh[_ -]?token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[ausgeblendet]')
    .slice(0, 240)
}
function convertEvents(events: AgendaEvent[], provider: 'google' | 'ical', from: number, to: number): WorkspaceCalendarEvent[] {
  return events.flatMap((event, index) => {
    const start = Number(event.start)
    const end = Number(event.end)
    if (!Number.isFinite(start) || (Number.isFinite(end) && end <= start) || start >= to ||
        (Number.isFinite(end) ? end <= from : start < from)) return []
    const title = typeof event.title === 'string' && event.title.trim() ? event.title.slice(0, 240) : 'Termin'
    return [{
      id: typeof event.id === 'string' && event.id ? event.id.slice(0, 180) : `${provider}-${start}-${index}`,
      title,
      start,
      ...(Number.isFinite(end) ? { end } : {}),
      allDay: event.allDay === true,
      ...(typeof event.calendar === 'string' ? { calendar: event.calendar.slice(0, 120) } : {}),
      ...(typeof event.location === 'string' ? { location: event.location.slice(0, 200) } : {}),
      source: provider
    }]
  }).sort((a, b) => a.start - b.start)
}
function reader(tool: ToolDefinition, args: Record<string, unknown>): AgendaReader {
  return async (_now) => {
    let card: AgendaCard | null = null
    const context = { show: (value: unknown) => { card = value as AgendaCard; return false } } as ToolContext
    await tool.execute(args as never, context)
    return card ?? { events: [] }
  }
}
const googleAgenda = calendarTools.find((tool) => tool.name === 'calendar_agenda')
const icalAgenda = calendarLinkTools.find((tool) => tool.name === 'calendar_link_agenda')
if (!googleAgenda || !icalAgenda) throw new Error('Die vorhandenen Kalender-Leser sind nicht verfügbar.')
const existingGoogleReader = reader(googleAgenda, { zeitraum: 'heute', maximal: 50 })
const existingIcalReader = reader(icalAgenda, { zeitraum: 'heute', maximal: 50 })

/** Exact local civil-day bounds; setDate, not fixed milliseconds, handles DST days of 23/25 hours. */
export function localTodayBounds(now: Date = new Date()): { from: Date; to: Date } {
  const from = new Date(now)
  from.setHours(0, 0, 0, 0)
  const to = new Date(from)
  to.setDate(to.getDate() + 1)
  return { from, to }
}

/** Dependency-injected core makes source readiness, boundaries, provider errors, and stale-consent behavior testable. */
export async function readWorkspaceCalendar(input: {
  enabled: boolean
  now?: Date
  googleConfigured: boolean
  icalConfigured: boolean
  readGoogle?: AgendaReader
  readIcal?: AgendaReader
  timezone?: string
  isCurrent?: () => boolean
}): Promise<WorkspaceCalendarRead> {
  const now = input.now ?? new Date()
  const { from, to } = localTodayBounds(now)
  const timezone = input.timezone ?? localTimeZone()
  const blank = (ready: boolean): WorkspaceCalendarSource => source(ready ? 'idle' : 'not-configured')
  const result: WorkspaceCalendarRead = {
    enabled: input.enabled,
    from: from.getTime(),
    to: to.getTime(),
    timezone,
    sources: { google: blank(input.googleConfigured), ical: blank(input.icalConfigured) }
  }
  if (!input.enabled || (input.isCurrent && !input.isCurrent())) return { ...result, enabled: false }
  const fetchedAt = now.getTime()
  const load = async (configured: boolean, fn: AgendaReader | undefined, provider: 'google' | 'ical'): Promise<WorkspaceCalendarSource> => {
    if (!configured) return source('not-configured')
    try {
      const card = await fn!(now)
      return source('ready', convertEvents(Array.isArray(card.events) ? card.events : [], provider, result.from, result.to), undefined, fetchedAt)
    } catch (error) {
      return source('error', [], cleanError(error), fetchedAt)
    }
  }
  const [google, ical] = await Promise.all([
    load(input.googleConfigured, input.readGoogle ?? existingGoogleReader, 'google'),
    load(input.icalConfigured, input.readIcal ?? existingIcalReader, 'ical')
  ])
  if (input.isCurrent && !input.isCurrent()) {
    // Discard both successes and failures so no late private result reaches the caller.
    return { ...result, enabled: false, sources: { google: blank(input.googleConfigured), ical: blank(input.icalConfigured) } }
  }
  result.sources = { google, ical }
  return result
}

/** Called only by explicit calendar-read IPC; disabled state performs no credential lookup or provider read. */
export async function readConfiguredWorkspaceCalendar(enabled: boolean): Promise<WorkspaceCalendarRead> {
  if (!enabled) return readWorkspaceCalendar({ enabled: false, googleConfigured: false, icalConfigured: false })
  const googleConfigured = hasSecret('googleOAuthClientId') && hasCalendarAuth()
  const icalConfigured = hasSecret('calendarIcsUrl')
  return readWorkspaceCalendar({
    enabled, googleConfigured, icalConfigured,
    isCurrent: workspaceCalendarReadIsCurrent()
  })
}
