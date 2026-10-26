import { app, type BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BriefingCard } from '@shared/types'
import { findConflicts } from '@shared/brain'
import { abortable } from '@shared/async'
import { getSettings } from '../store/settings'
import { sendToCrystal } from '../ipc/emit'
import { listProjects } from '../brain/store'
import { dayEvents } from '../tools/impl/brain'
import { getTool, type ToolContext } from '../tools/registry'
import { permissionFor } from '../tools/permissions'

const dayFile = (): string => join(app.getPath('userData'), 'briefing-day.txt')
const today = (): string => new Date().toLocaleDateString('sv-SE')
function shownToday(): boolean {
  try { return readFileSync(dayFile(), 'utf8').trim() === today() } catch { return false }
}
const clock = (ms: number): string => new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })

export async function loadBriefing(): Promise<{ card: BriefingCard | null; complete: boolean }> {
  const now = new Date(), day = today()
  const greeting = now.getHours() < 11 ? 'Guten Morgen' : now.getHours() < 17 ? 'Guten Tag' : 'Guten Abend'
  const sections: BriefingCard['sections'] = []
  const signal = AbortSignal.timeout(10_000)
  const context: ToolContext = { confirm: async () => false, say() {}, setState() {}, show: () => false, annotate() {}, signal }
  const readTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const tool = getTool(name)
    if (!tool || permissionFor(name) !== 'allow') return undefined
    return tool.execute(tool.schema.parse(args), context)
  }
  // Each independent reader is bounded, and a failed reader cannot hide others.
  const results = await Promise.allSettled([
    abortable(permissionFor('calendar_agenda') === 'allow' ? dayEvents(0) : Promise.resolve(null), signal),
    abortable(readTool('gmail_summarize_inbox', { hours: 16 }), signal),
    abortable(readTool('tasks_list', {}), signal),
    Promise.resolve().then(() => listProjects())
  ])
  const [calendar, mail, tasks, projects] = results
  if (calendar.status === 'fulfilled' && calendar.value?.length) {
    const events = calendar.value
    sections.push({ title: 'Termine heute', items: events.slice(0, 8).map(e => `${e.allDay ? 'Ganztägig' : clock(e.start)} · ${e.title}`) })
    const conflicts = findConflicts(events)
    if (conflicts.length) sections.push({ title: 'Überschneidungen', items: conflicts.map(c => `${c.a} und ${c.b} ab ${clock(c.from)}`) })
  }
  if (mail.status === 'fulfilled') {
    const data = mail.value as { mails?: Array<{ von?: string; betreff?: string }> } | undefined
    if (Array.isArray(data?.mails) && data.mails.length) sections.push({ title: 'Wichtige Mails', items: data.mails.slice(0, 5).map(m => `${m.von ?? ''}: ${m.betreff ?? ''}`) })
  }
  if (tasks.status === 'fulfilled' && Array.isArray(tasks.value)) {
    const end = new Date(now); end.setHours(23, 59, 59, 999)
    const due = tasks.value.filter(t => typeof t?.titel === 'string' && t.faellig && new Date(t.faellig) <= end).map(t => t.titel as string)
    if (due.length) sections.push({ title: 'Aufgaben fällig', items: due.slice(0, 6) })
  }
  if (projects.status === 'fulfilled') {
    const steps = projects.value.filter(p => p.status === 'aktiv').slice(0, 5).flatMap(p => {
      const next = p.steps.find(s => !s.done)?.text
      return next ? [`${p.title}: ${next}`] : []
    })
    if (steps.length) sections.push({ title: 'Nächste Schritte', items: steps })
  }
  const missing = results.flatMap((r, i) => r.status === 'rejected' ? [['Kalender', 'Mail', 'Aufgaben', 'Projekte'][i]] : [])
  if (missing.length) sections.push({ title: 'Noch nicht geladen', items: missing.map(name => `${name}: momentan nicht erreichbar. Das Briefing kann erneut geladen werden.`) })
  return { complete: !missing.length, card: sections.length ? { kind: 'briefing', id: `briefing:${day}`, at: now.getTime(), source: 'briefing', greeting, sections } : null }
}
export async function buildBriefing(): Promise<BriefingCard | null> { return (await loadBriefing()).card }
let pending = false, nextAttemptAt = 0
export async function maybeShowBriefing(force = false): Promise<void> {
  if (pending || (!force && (!getSettings().dailyBriefing || shownToday() || Date.now() < nextAttemptAt))) return
  pending = true
  const day = today()
  try {
    const { card, complete } = await loadBriefing()
    if ((!force && !getSettings().dailyBriefing) || day !== today()) return
    if (complete) writeFileSync(dayFile(), day)
    else nextAttemptAt = Date.now() + 5 * 60_000
    if (card) sendToCrystal('display:card', card)
    else if (force) sendToCrystal('display:card', { kind: 'briefing', id: `briefing:${day}`, at: Date.now(), source: 'briefing', greeting: 'Dein Tagesüberblick', sections: [{ title: 'Aktuell', items: ['Keine Termine, fälligen Aufgaben oder offenen Projektschritte gefunden.'] }] })
  } finally { pending = false }
}
export function watchDailyBriefing(getWindow: () => BrowserWindow | null): void {
  const run = (): void => { void maybeShowBriefing().catch(error => console.warn('[briefing] Laden fehlgeschlagen:', error instanceof Error ? error.name : 'Fehler')) }
  app.on('browser-window-focus', (_event, win) => { if (win === getWindow()) run() })
  setTimeout(() => { if (getWindow()?.isFocused()) run() }, 4000).unref()
}
