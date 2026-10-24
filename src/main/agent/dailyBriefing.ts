import { app, type BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BriefingCard } from '@shared/types'
import { findConflicts } from '@shared/brain'
import { getSettings } from '../store/settings'
import { sendToCrystal } from '../ipc/emit'
import { listProjects } from '../brain/store'
import { dayEvents } from '../tools/impl/brain'
import { getTool, type ToolContext } from '../tools/registry'

/**
 * Tagesbriefing: beim ersten Fokus des Tages eine Karte mit Terminen,
 * wichtigen Mails und offenen Projektschritten. Kein Sprachmodell nötig —
 * die Karte steht auch ohne Sprachzugang. Leere Bereiche entfallen; ist alles
 * leer, kommt keine Karte.
 */

const dayFile = (): string => join(app.getPath('userData'), 'briefing-day.txt')
const today = (): string => new Date().toLocaleDateString('sv-SE')

function shownToday(): boolean {
  try { return readFileSync(dayFile(), 'utf8').trim() === today() } catch { return false }
}

const clock = (ms: number): string => new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })

// Ohne Rückfragen: Das Briefing liest nur.
const quietContext: ToolContext = {
  confirm: async () => false,
  say: () => undefined,
  setState: () => undefined,
  showCard: () => false
} as unknown as ToolContext

export async function buildBriefing(): Promise<BriefingCard | null> {
  const hour = new Date().getHours()
  const greeting = hour < 11 ? 'Guten Morgen' : hour < 17 ? 'Guten Tag' : 'Guten Abend'
  const sections: BriefingCard['sections'] = []
  try {
    const events = await dayEvents(0)
    if (events?.length) {
      sections.push({ title: 'Termine heute', items: events.slice(0, 8).map(e => `${e.allDay ? 'Ganztägig' : clock(e.start)} · ${e.title}`) })
      const conflicts = findConflicts(events)
      if (conflicts.length) sections.push({ title: 'Überschneidungen', items: conflicts.map(c => `${c.a} und ${c.b} ab ${clock(c.from)}`) })
    }
  } catch (error) { console.warn('[briefing] Kalender:', error) }
  const inbox = getTool('gmail_summarize_inbox')
  if (inbox) {
    try {
      const result = await inbox.execute({ hours: 16 }, quietContext) as { mails?: { von: string; betreff: string }[] }
      if (result?.mails?.length) sections.push({ title: 'Wichtige Mails', items: result.mails.slice(0, 5).map(m => `${m.von}: ${m.betreff}`) })
    } catch { /* Gmail nicht verbunden */ }
  }
  const todo = getTool('tasks_list')
  if (todo) {
    try {
      const items = await todo.execute({}, quietContext) as { titel: string; faellig?: string }[]
      const end = new Date(); end.setHours(23, 59, 59, 999)
      const due = Array.isArray(items) ? items.filter(t => t.faellig && new Date(t.faellig) <= end).map(t => t.titel) : []
      if (due.length) sections.push({ title: 'Aufgaben fällig', items: due.slice(0, 6) })
    } catch { /* Aufgaben nicht verbunden */ }
  }
  const steps = listProjects().filter(p => p.status === 'aktiv').slice(0, 5)
    .map(p => ({ p, next: p.steps.find(s => !s.done)?.text })).filter(x => x.next)
    .map(x => `${x.p.title}: ${x.next}`)
  if (steps.length) sections.push({ title: 'Nächste Schritte', items: steps })
  if (!sections.length) return null
  return { kind: 'briefing', id: `briefing:${today()}`, at: Date.now(), source: 'briefing', greeting, sections } as BriefingCard
}

let pending = false

export async function maybeShowBriefing(): Promise<void> {
  if (pending || !getSettings().dailyBriefing || shownToday()) return
  pending = true
  try {
    const card = await buildBriefing()
    // Auch ohne Inhalt als erledigt merken, sonst fragt jeder Fokus erneut den Kalender.
    writeFileSync(dayFile(), today())
    if (card) sendToCrystal('display:card', card)
  } catch (error) {
    console.error('[briefing] fehlgeschlagen:', error)
  } finally { pending = false }
}

export function watchDailyBriefing(getWindow: () => BrowserWindow | null): void {
  app.on('browser-window-focus', (_event, win) => { if (win === getWindow()) void maybeShowBriefing() })
  // Erster Start: Fenster ist vielleicht schon fokussiert, bevor wir lauschen.
  setTimeout(() => { if (getWindow()?.isFocused()) void maybeShowBriefing() }, 4000).unref()
}
