import { z } from 'zod'
import { accessSync, constants } from 'node:fs'
import { defineTool, type ToolDefinition } from '../registry'
import { findConflicts, freeSlots, planTasks, searchNotes, tidyFindings } from '@shared/brain'
import {
  brainDir,
  createProject,
  findProject,
  listProjects,
  listWidgets,
  readNotes,
  removeWidget,
  saveNote,
  saveProject,
  setWidget
} from '../../brain/store'
import { eventsBetween } from './calendar'
import { getTool } from '../registry'
import { hasCalendarAuth, hasGoogleAuth } from '../../providers/googleAuth'
import { healthReport } from '../../selfheal'
import { listMemories } from '../../db'
import { getSettings } from '../../store/settings'
import { broadcast } from '../../ipc/emit'

/**
 * Das Gehirn als Werkzeuge: Projekte, Notizen, Tag, Briefing, Kacheln.
 *
 * Gemeinsam ist allem, dass gerechnet statt geschätzt wird. Ob zwei Termine
 * sich überschneiden, steht nicht im Ermessen des Modells, und ob eine Notiz
 * etwas sagt, auch nicht — deshalb kommt jede Fundstelle mit Datei und Zeile,
 * und eine leere Suche heißt „steht nicht drin".
 */

const clock = (ms: number): string => new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })

function dayBounds(offsetDays = 0): { from: Date; to: Date } {
  const from = new Date()
  from.setHours(0, 0, 0, 0)
  from.setDate(from.getDate() + offsetDays)
  const to = new Date(from)
  to.setDate(to.getDate() + 1)
  return { from, to }
}

async function dayEvents(offsetDays = 0): Promise<Awaited<ReturnType<typeof eventsBetween>> | null> {
  if (!hasGoogleAuth() || !hasCalendarAuth()) return null
  const { from, to } = dayBounds(offsetDays)
  return eventsBetween(from, to)
}

// ─── Projekte ──────────────────────────────────────────────────────────

const projectSchema = z.string().describe('Name des Projekts, auch ein Teil davon.')

function mustFind(name: string): ReturnType<typeof listProjects>[number] {
  const project = findProject(name)
  if (!project) throw new Error(`Kein Projekt „${name}“. Mit project_list nachsehen oder mit project_create anlegen.`)
  return project
}

const projectCreate = defineTool({
  name: 'project_create',
  group: 'memory',
  description: 'Legt ein Projekt-Gedächtnis an, damit spätere Gespräche den Stand kennen. Für „leg ein Projekt X an“.',
  schema: z.object({ titel: z.string(), stand: z.string().optional().describe('Wo das Projekt gerade steht.') }),
  async execute({ titel, stand }) {
    const p = createProject(titel, stand ?? '')
    return { angelegt: p.title, datei: `projekte/${p.slug}.md` }
  }
}) as ToolDefinition

const projectList = defineTool({
  name: 'project_list',
  group: 'memory',
  description: 'Listet die Projekte mit Status und nächstem offenen Schritt.',
  schema: z.object({ auchAbgeschlossene: z.boolean().optional() }),
  async execute({ auchAbgeschlossene }) {
    const all = listProjects().filter((p) => auchAbgeschlossene || p.status === 'aktiv')
    if (!all.length) return { anzahl: 0, note: 'Es gibt noch keine Projekte.' }
    return { anzahl: all.length, projekte: all.map((p) => ({ titel: p.title, status: p.status, naechster: p.steps.find((s) => !s.done)?.text ?? '—' })) }
  }
}) as ToolDefinition

const projectStatus = defineTool({
  name: 'project_status',
  group: 'memory',
  description: 'Holt den vollen Stand eines Projekts: Stand, Entscheidungen mit Grund, nächste Schritte. Vor jeder Arbeit an einem Projekt aufrufen.',
  schema: z.object({ projekt: projectSchema }),
  async execute({ projekt }) {
    const p = mustFind(projekt)
    return { titel: p.title, status: p.status, aktualisiert: p.updated, stand: p.stand || '—', entscheidungen: p.decisions, schritte: p.steps }
  }
}) as ToolDefinition

const projectUpdate = defineTool({
  name: 'project_update',
  group: 'memory',
  description:
    'Ändert ein Projekt: neuen Stand setzen, Entscheidung mit Grund festhalten, Schritt hinzufügen, ' +
    'Schritt abhaken oder Projekt abschließen. Nur Angaben machen, die sich ändern.',
  schema: z.object({
    projekt: projectSchema,
    stand: z.string().optional(),
    entscheidung: z.object({ was: z.string(), grund: z.string() }).optional(),
    neuerSchritt: z.string().optional(),
    erledigt: z.string().optional().describe('Text oder Teil des Schritts, der erledigt ist.'),
    abschliessen: z.boolean().optional()
  }),
  async execute({ projekt, stand, entscheidung, neuerSchritt, erledigt, abschliessen }) {
    const p = mustFind(projekt)
    const changes: string[] = []
    if (stand !== undefined) { p.stand = stand; changes.push('Stand') }
    if (entscheidung) {
      p.decisions.push({ date: new Date().toISOString().slice(0, 10), text: entscheidung.was, reason: entscheidung.grund })
      changes.push('Entscheidung')
    }
    if (neuerSchritt) { p.steps.push({ done: false, text: neuerSchritt }); changes.push('Schritt') }
    if (erledigt) {
      const step = p.steps.find((s) => !s.done && s.text.toLowerCase().includes(erledigt.toLowerCase()))
      if (!step) throw new Error(`Kein offener Schritt passt zu „${erledigt}“.`)
      step.done = true
      changes.push('abgehakt')
    }
    if (abschliessen) { p.status = 'abgeschlossen'; changes.push('abgeschlossen') }
    if (!changes.length) return { geaendert: false, note: 'Es war nichts zu ändern.' }
    saveProject(p)
    return { geaendert: changes, projekt: p.title }
  }
}) as ToolDefinition

// ─── Notizen ────────────────────────────────────────────────────────────

const notesSearch = defineTool({
  name: 'notes_search',
  group: 'memory',
  description:
    'Second Brain: sucht in den eigenen Notizen und Projekten und liefert Fundstellen mit Datei und Zeile. ' +
    'Antworte nur aus den Fundstellen und nenne sie. Ist die Liste leer, sag „finde ich nicht in deinen Notizen“ und rate nicht.',
  schema: z.object({ frage: z.string() }),
  async execute({ frage }) {
    const hits = searchNotes(readNotes(), frage)
    if (!hits.length) return { gefunden: 0, note: 'Dazu steht nichts in den Notizen.' }
    return { gefunden: hits.length, fundstellen: hits.map((h) => ({ datei: h.file, zeile: h.line, text: h.text })) }
  }
}) as ToolDefinition

const noteSave = defineTool({
  name: 'note_save',
  group: 'memory',
  description: 'Legt eine neue Notiz im Gehirn-Ordner an. Verweise auf andere Notizen als [[Titel]], Schlagworte als #wort.',
  schema: z.object({ titel: z.string(), text: z.string() }),
  async execute({ titel, text }) {
    return { gespeichert: saveNote(titel, text) }
  }
}) as ToolDefinition

const brainTidy = defineTool({
  name: 'brain_tidy',
  group: 'memory',
  description:
    'Aufräumer: findet veraltete Projekte, fehlende nächste Schritte, doppelte Schritte und doppelte Projekte. ' +
    'Schlägt nur vor; ändere erst, wenn der Nutzer zustimmt.',
  schema: z.object({ tageBisVeraltet: z.number().optional() }),
  async execute({ tageBisVeraltet }) {
    const findings = tidyFindings(listProjects(), Date.now(), Math.max(1, tageBisVeraltet ?? 30))
    return findings.length ? { vorschlaege: findings } : { vorschlaege: [], note: 'Alles aufgeräumt.' }
  }
}) as ToolDefinition

// ─── Tag ────────────────────────────────────────────────────────────────

const dayPlan = defineTool({
  name: 'day_plan',
  group: 'memory',
  description:
    'Tagesplaner: rechnet freie Zeiten aus dem Kalender und verteilt Aufgaben darauf. Liefert einen Vorschlag, ' +
    'trägt nichts ein. Was nicht passt, wird verschoben genannt, nicht gestrichen. Für „plan mir den Tag“.',
  schema: z.object({
    morgen: z.boolean().optional().describe('Den morgigen Tag statt heute planen.'),
    aufgaben: z.array(z.object({ titel: z.string(), minuten: z.number() })).optional(),
    von: z.number().optional().describe('Tagesbeginn als Stunde, Standard 8.'),
    bis: z.number().optional().describe('Tagesende als Stunde, Standard 20.')
  }),
  async execute({ morgen, aufgaben, von, bis }) {
    const offset = morgen ? 1 : 0
    const events = await dayEvents(offset) ?? []
    const { from } = dayBounds(offset)
    const start = new Date(from); start.setHours(Math.min(23, Math.max(0, von ?? 8)))
    const end = new Date(from); end.setHours(Math.min(24, Math.max(1, bis ?? 20)))
    const earliest = Math.max(start.getTime(), offset ? 0 : Date.now())
    const slots = freeSlots(events, earliest, end.getTime())
    const plan = planTasks(slots, (aufgaben ?? []).map((a) => ({ title: a.titel, minutes: a.minuten })))
    return {
      kalenderVerbunden: hasCalendarAuth(),
      termine: events.map((e) => `${e.allDay ? 'ganztägig' : `${clock(e.start)}–${clock(e.end)}`} ${e.title}`),
      ueberschneidungen: findConflicts(events).map((c) => `${c.a} und ${c.b} ab ${clock(c.from)}`),
      frei: slots.map((s) => `${clock(s.start)}–${clock(s.end)}`),
      vorschlag: plan.placed.map((p) => `${clock(p.start)}–${clock(p.end)} ${p.title}`),
      verschieben: plan.leftover,
      hinweis: 'Nur ein Vorschlag. Eintragen erst nach Zustimmung mit calendar_create.'
    }
  }
}) as ToolDefinition

const morningBriefing = defineTool({
  name: 'morning_briefing',
  group: 'memory',
  description:
    'Morgenbriefing, nur lesend: Uhrzeit, heutige Termine mit gerechneten Überschneidungen, wichtige ungelesene Mails, ' +
    'offene Projektschritte und Erinnerungen an den Nutzer. Für „guten Morgen“, „was steht heute an“, „Briefing“.',
  schema: z.object({}),
  async execute(_args, ctx) {
    const now = Date.now()
    const out: Record<string, unknown> = {
      uhrzeit: new Date(now).toLocaleString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
    }
    try {
      const events = await dayEvents(0)
      if (events) {
        out.termine = events.map((e) => `${e.allDay ? 'ganztägig' : clock(e.start)} ${e.title}`)
        out.ueberschneidungen = findConflicts(events).map((c) => `${c.a} und ${c.b} ab ${clock(c.from)}`)
      } else out.termine = 'Kalender nicht verbunden.'
    } catch (err) {
      out.termine = `Kalender nicht lesbar: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`
    }
    const inbox = getTool('gmail_summarize_inbox')
    if (inbox) {
      try { out.mails = await inbox.execute({ hours: 16 }, ctx) } catch { out.mails = 'Postfach nicht lesbar.' }
    }
    out.projekte = listProjects().filter((p) => p.status === 'aktiv').slice(0, 5)
      .map((p) => `${p.title}: ${p.steps.find((s) => !s.done)?.text ?? 'kein nächster Schritt'}`)
    out.hinweis = 'Fasse in vier bis sechs gesprochenen Sätzen zusammen: Termine und Überschneidungen zuerst, dann Mails, dann Projekte.'
    return out
  }
}) as ToolDefinition

// ─── Kacheln ────────────────────────────────────────────────────────────

const widgetSet = defineTool({
  name: 'widget_set',
  group: 'memory',
  description:
    'Baut oder aktualisiert eine Kachel auf der Startseite: Titel, ein Wert und optional eine kurze Liste. ' +
    'Für „mach mir ein Widget für X“. Gleiche id ersetzt die Kachel. Nur Text, kein HTML.',
  schema: z.object({
    id: z.string().describe('Kurze Kennung, etwa "wasser" oder "einkauf".'),
    titel: z.string(),
    wert: z.string().describe('Die Hauptangabe, etwa "3 von 8 Gläsern".'),
    liste: z.array(z.string()).optional()
  }),
  async execute({ id, titel, wert, liste }) {
    const clean = (s: string, n: number): string => s.replace(/[<>]/g, '').trim().slice(0, n)
    const widgets = setWidget({ id: clean(id, 40).toLowerCase(), title: clean(titel, 60), value: clean(wert, 120), items: liste?.slice(0, 8).map((i) => clean(i, 80)) })
    broadcast('brain:widgets', widgets)
    return { kacheln: widgets.length }
  }
}) as ToolDefinition

const widgetRemove = defineTool({
  name: 'widget_remove',
  group: 'memory',
  description: 'Entfernt eine Kachel von der Startseite.',
  schema: z.object({ id: z.string() }),
  async execute({ id }) {
    const before = listWidgets().length
    const widgets = removeWidget(id.toLowerCase())
    broadcast('brain:widgets', widgets)
    return { entfernt: before !== widgets.length }
  }
}) as ToolDefinition

// ─── Selbsttest ─────────────────────────────────────────────────────────

const selfTest = defineTool({
  name: 'self_test',
  group: 'system',
  description: 'Prüft James Punkt für Punkt: Datenordner, Gedächtnis, Gehirn, Google-Zugang, Stimme, offene Störungen. Für „läuft alles?“, „mach einen Selbsttest“.',
  schema: z.object({}),
  async execute() {
    const checks: { punkt: string; ok: boolean; info: string }[] = []
    const check = (punkt: string, fn: () => string): void => {
      try { checks.push({ punkt, ok: true, info: fn() }) } catch (err) { checks.push({ punkt, ok: false, info: String(err instanceof Error ? err.message : err).slice(0, 160) }) }
    }
    check('Gehirn-Ordner beschreibbar', () => { const dir = brainDir(); accessSync(dir, constants.W_OK); return `${readNotes().length} Notizen und Projekte` })
    check('Gedächtnis', () => `${listMemories(1000).length} Einträge`)
    check('Google-Konto', () => { if (!hasGoogleAuth()) throw new Error('nicht verbunden'); return hasCalendarAuth() ? 'Mail und Kalender' : 'nur Mail, Kalender neu verbinden' })
    check('Stimme', () => `Ausgabe über ${getSettings().speech.provider}`)
    check('Störungen in 24 Stunden', () => { const r = healthReport(24); if (r.problems.length) throw new Error(r.summary); return 'keine' })
    return { bestanden: checks.filter((c) => c.ok).length, von: checks.length, punkte: checks }
  }
}) as ToolDefinition

export const brainTools: ToolDefinition[] = [
  projectCreate, projectList, projectStatus, projectUpdate,
  notesSearch, noteSave, brainTidy, dayPlan, morningBriefing,
  widgetSet, widgetRemove, selfTest
]
