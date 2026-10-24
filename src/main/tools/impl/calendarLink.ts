import { app, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { getSecret } from '../../secrets/keystore'
import {
  buildIcs,
  eventsInRange,
  googleCalendarLink,
  normalizeIcsUrl,
  outlookCalendarLink,
  type DraftEvent,
  type IcsEvent
} from '@shared/ics'
import { addDays, parseWhen, RANGES, resolveRange } from './calendarTime'

/**
 * Kalender per geheimem Link (ICS) und Termine zum Selbst-Speichern.
 *
 * Für alle, die Google nicht über OAuth anbinden wollen oder Outlook bzw.
 * iCloud nutzen. Lesen geht über die private iCal-Adresse, die der Nutzer in
 * den Einstellungen unter Konten & Standort ablegt. Eintragen geht hier nie direkt:
 * James baut den Termin vor, der Nutzer klickt im eigenen Kalender auf
 * Speichern. Damit gibt es keinen Schreibzugriff, den man absichern müsste.
 */

const CACHE_MS = 5 * 60 * 1000
const MAX_BYTES = 8 * 1024 * 1024
let cache: { url: string; at: number; text: string } | null = null

async function loadIcs(): Promise<string> {
  const raw = getSecret('calendarIcsUrl')
  const url = raw ? normalizeIcsUrl(raw) : null
  if (!url) {
    throw new Error(
      'Der Kalender-Link fehlt oder ist keine HTTPS-Adresse. Sag dem Nutzer, er soll unter ' +
        'Einstellungen, Zugänge den privaten iCal-Link seines Kalenders eintragen.'
    )
  }
  if (cache && cache.url === url && Date.now() - cache.at < CACHE_MS) return cache.text
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'follow' })
  if (!res.ok) {
    throw new Error(
      res.status === 404 || res.status === 401 || res.status === 403
        ? 'Der Kalender-Link gilt nicht mehr. Der Nutzer soll ihn beim Anbieter neu kopieren.'
        : `Der Kalender antwortet nicht (HTTP ${res.status}).`
    )
  }
  const text = await res.text()
  if (text.length > MAX_BYTES) throw new Error('Der Kalender ist zu groß zum Lesen.')
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('Unter dem Link liegt kein Kalender im iCal-Format.')
  cache = { url, at: Date.now(), text }
  return text
}

function describe(e: IcsEvent): Record<string, unknown> {
  const start = new Date(e.start)
  const zeit = e.allDay
    ? start.toLocaleDateString('de-AT', { weekday: 'long', day: 'numeric', month: 'long' }) + ', ganztägig'
    : start.toLocaleString('de-AT', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
  return { titel: e.title, wann: zeit, ...(e.location ? { ort: e.location } : {}) }
}

const linkAgenda = defineTool({
  name: 'calendar_link_agenda',
  group: 'calendar',
  description:
    'Liest Termine aus dem per iCal-Link verbundenen Kalender (Google, Outlook oder iCloud). ' +
    'Nur lesen. Für "was habe ich heute", "bin ich morgen frei", "was steht diese Woche an". ' +
    'Optional mit Suchwort im Titel oder Ort.',
  schema: z.object({
    zeitraum: z.enum(RANGES).optional().describe('Welches Fenster. Standard ist heute.'),
    suche: z.string().optional().describe('Nur Termine, deren Titel oder Ort das enthält.'),
    maximal: z.number().optional().describe('Höchstens so viele Termine, Standard fünfzehn.')
  }),
  readOnly: true,
  requiresSecret: 'calendarIcsUrl',
  spokenHint: 'Mhm.',
  async execute({ zeitraum, suche, maximal }, ctx) {
    const { from, to, label } = resolveRange(zeitraum ?? 'heute')
    const text = await loadIcs()
    const needle = suche?.trim().toLowerCase()
    const max = Math.min(50, Math.max(1, maximal ?? 15))
    const events = eventsInRange(text, from.getTime(), to.getTime())
      .filter((e) => !needle || `${e.title} ${e.location ?? ''}`.toLowerCase().includes(needle))
      .slice(0, max)
    ctx?.show?.({
      kind: 'agenda',
      id: `agenda-link:${label}:${needle ?? ''}`,
      range: label,
      events: events.map((e) => ({
        title: e.title,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
        ...(e.location ? { location: e.location } : {})
      }))
    } as never)
    if (events.length === 0) return { zeitraum: label, anzahl: 0, note: `Für ${label} steht nichts im Kalender.` }
    return { zeitraum: label, anzahl: events.length, termine: events.map(describe) }
  }
}) as ToolDefinition

function toDraft(beginn: string, ende: string | undefined, dauer: number | undefined, rest: Omit<DraftEvent, 'start' | 'end' | 'allDay'>): DraftEvent {
  const when = parseWhen(beginn)
  if (when.date) {
    const [y, m, d] = when.date.split('-').map(Number)
    const start = new Date(y, m - 1, d)
    let end = addDays(start, 1)
    if (ende) {
      const e = parseWhen(ende)
      if (!e.date) throw new Error('Ein ganztägiger Termin braucht auch ein Enddatum ohne Uhrzeit.')
      const [ey, em, ed] = e.date.split('-').map(Number)
      end = addDays(new Date(ey, em - 1, ed), 1)
    }
    return { ...rest, start, end, allDay: true }
  }
  const start = new Date(when.dateTime!)
  let end = new Date(start.getTime() + (dauer ?? 60) * 60000)
  if (ende) {
    const e = parseWhen(ende)
    if (!e.dateTime) throw new Error('Ende braucht eine Uhrzeit, wenn der Beginn eine hat.')
    end = new Date(e.dateTime)
  }
  if (end.getTime() <= start.getTime()) throw new Error('Das Ende liegt vor dem Beginn.')
  return { ...rest, start, end, allDay: false }
}

const saveDraft = defineTool({
  name: 'calendar_save_draft',
  group: 'calendar',
  description:
    'Bereitet einen Termin zum Selbst-Speichern vor, ohne Kalenderzugriff: Link für Google Kalender, ' +
    'für Outlook (privat oder Arbeit/Schule) und eine .ics-Datei für jede Kalender-App. Mit `oeffnen` ' +
    'geht der gewählte Weg sofort auf; der Nutzer klickt dort nur noch auf Speichern. ' +
    'Nimm das, wenn kein Google-Kalender verbunden ist oder der Nutzer Outlook/iCloud/Apple nutzt. ' +
    'Zeiten in Ortszeit: 2026-08-15T14:30 oder 2026-08-15 für ganztägig.',
  schema: z.object({
    titel: z.string().min(1),
    beginn: z.string().describe('2026-08-15T14:30 oder 2026-08-15 (ganztägig).'),
    ende: z.string().optional().describe('Gleiches Format wie beginn. Ohne Angabe gilt dauer_minuten.'),
    dauer_minuten: z.number().optional().describe('Standard 60.'),
    ort: z.string().optional(),
    notiz: z.string().optional(),
    oeffnen: z
      .enum(['google', 'outlook', 'outlook_arbeit', 'datei'])
      .optional()
      .describe('Welchen Weg sofort öffnen. Ohne Angabe nur vorbereiten.')
  }),
  spokenHint: 'Okay.',
  async execute({ titel, beginn, ende, dauer_minuten, ort, notiz, oeffnen }) {
    const draft = toDraft(beginn, ende, dauer_minuten, {
      title: titel.trim(),
      ...(ort ? { location: ort.trim() } : {}),
      ...(notiz ? { description: notiz.trim() } : {})
    })
    const uid = `${randomUUID()}@james-jarvis`
    const dir = join(app.getPath('userData'), 'termine')
    mkdirSync(dir, { recursive: true })
    const safe = titel.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 40) || 'Termin'
    const file = join(dir, `${safe}-${uid.slice(0, 8)}.ics`)
    writeFileSync(file, buildIcs(draft, uid), 'utf8')
    const links = {
      google: googleCalendarLink(draft),
      outlook: outlookCalendarLink(draft),
      outlook_arbeit: outlookCalendarLink(draft, true)
    }
    if (oeffnen === 'datei') {
      const err = await shell.openPath(file)
      if (err) throw new Error(`Die Kalender-App ging nicht auf: ${err}`)
    } else if (oeffnen) {
      await shell.openExternal(links[oeffnen])
    }
    return {
      vorbereitet: true,
      geoeffnet: oeffnen ?? null,
      datei: file,
      hinweis: oeffnen
        ? 'Sag dem Nutzer, er soll im geöffneten Kalender auf Speichern klicken. Eingetragen ist der Termin erst dann.'
        : 'Frag, wo der Termin hin soll (Google, Outlook oder Kalender-App), und ruf dann mit oeffnen erneut auf.'
    }
  }
}) as ToolDefinition

export const calendarLinkTools: ToolDefinition[] = [linkAgenda, saveDraft]
