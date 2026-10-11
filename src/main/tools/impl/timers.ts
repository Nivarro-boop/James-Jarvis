import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { deleteTimer, insertTimer, listTimers } from '../../db'

/**
 * Kurzzeitwecker.
 *
 * Das naheliegendste Sprachkommando überhaupt und bisher das einzige, für
 * das man den Zeitplaner mit einem Cron-Ausdruck bemühen musste — was für
 * "stell mir zehn Minuten" offensichtlich zu viel verlangt ist.
 */

function formatDue(dueAt: number): string {
  return new Date(dueAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
}

function humanRemaining(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000)
  if (totalMinutes < 1) return `${Math.max(1, Math.round(ms / 1000))} Sekunden`
  if (totalMinutes < 60) return `${totalMinutes} Minuten`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes === 0 ? `${hours} Stunden` : `${hours} Stunden und ${minutes} Minuten`
}

const setTimer = defineTool({
  name: 'timer_set',
  group: 'timer',
  description:
    'Stellt einen einmaligen Wecker. Wenn er abläuft, meldet sich James von selbst. ' +
    'Für "stell einen Timer auf zehn Minuten" oder "erinner mich in einer halben Stunde an die Pizza".',
  schema: z.object({
    minutes: z.number().describe('In wie vielen Minuten. Bruchteile sind erlaubt.'),
    label: z.string().optional().describe('Wofür der Wecker ist, in wenigen Worten.')
  }),
  async execute({ minutes, label }) {
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw new Error('Die Zeitangabe ergibt keinen Sinn.')
    }
    // Timer are durable too; longer calendar reminders belong to reminder_set.
    if (minutes > 48 * 60) throw new Error('Für mehr als zwei Tage reminder_set verwenden.')
    const capped = minutes
    const dueAt = Date.now() + capped * 60_000
    const entry = insertTimer(label ?? '', dueAt)

    return {
      gestellt: true,
      id: entry.id,
      bezeichnung: entry.label || 'Timer',
      dauer: humanRemaining(capped * 60_000),
      fälligUm: formatDue(dueAt)
    }
  }
}) as ToolDefinition

const listTimersTool = defineTool({
  name: 'timer_list',
  group: 'timer',
  description: 'Zählt auf, welche Wecker gerade laufen und wie lange noch.',
  schema: z.object({}),
  async execute() {
    const running = listTimers()
    if (running.length === 0) return { anzahl: 0, note: 'Es läuft gerade kein Timer.' }

    const now = Date.now()
    return {
      anzahl: running.length,
      timer: running.map((t) => ({
        id: t.id,
        bezeichnung: t.label || 'Timer',
        restzeit: humanRemaining(Math.max(0, t.dueAt - now)),
        fälligUm: formatDue(t.dueAt)
      }))
    }
  }
}) as ToolDefinition

const cancelTimer = defineTool({
  name: 'timer_cancel',
  group: 'timer',
  description:
    'Bricht einen laufenden Wecker ab. Ohne Kennung wird der zuletzt gestellte abgebrochen.',
  schema: z.object({
    id: z.number().optional().describe('Die Kennung aus timer_list.')
  }),
  async execute({ id }) {
    const running = listTimers()
    if (running.length === 0) throw new Error('Es läuft gerade kein Timer.')

    const target =
      id !== undefined
        ? running.find((t) => t.id === id)
        : // Ohne Angabe der zuletzt gestellte — das ist fast immer der gemeinte.
          [...running].sort((a, b) => b.createdAt - a.createdAt)[0]

    if (!target) throw new Error('Diesen Timer gibt es nicht.')
    deleteTimer(target.id)
    return { abgebrochen: target.label || 'Timer' }
  }
}) as ToolDefinition

export const timerTools: ToolDefinition[] = [setTimer, listTimersTool, cancelTimer]
