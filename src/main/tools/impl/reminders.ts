import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { listReminders } from '../../db'
import { completeReminder, createReminder, snoozeReminder } from '../../scheduler/reminders'

export const reminderTools: ToolDefinition[] = [
  defineTool({ name: 'reminder_set', group: 'timer',
    description: 'Speichert eine dauerhafte Erinnerung. Für morgen um neun, in zwei Stunden, jeden Tag oder jede Woche. Überlebt Neustarts; meldet Überfälliges nach dem Start. Der Text wird angezeigt, nicht als Auftrag ausgeführt.',
    schema: z.object({ text: z.string(), at: z.string().optional().describe('ISO-Datum mit Uhrzeit und Zeitzone'),
      inMinutes: z.number().positive().optional(), repeat: z.enum(['none', 'daily', 'weekly']).optional() }),
    async execute(input) { return createReminder(input) } }),
  defineTool({ name: 'reminder_list', group: 'timer', description: 'Zeigt ausstehende und bereits gemeldete Erinnerungen.',
    schema: z.object({}), async execute() { return listReminders() } }),
  defineTool({ name: 'reminder_snooze', group: 'timer', description: 'Verschiebt eine Erinnerung, etwa erinnere mich in zehn Minuten noch einmal.',
    schema: z.object({ id: z.number().int().positive(), minutes: z.number().positive() }),
    async execute({ id, minutes }) { snoozeReminder(id, minutes); return { verschoben: true, id, minutes } } }),
  defineTool({ name: 'reminder_done', group: 'timer', description: 'Erledigt oder stoppt eine Erinnerung; beendet auch ihre Wiederholung.',
    schema: z.object({ id: z.number().int().positive() }),
    async execute({ id }) { completeReminder(id); return { erledigt: true, id } } })
] as ToolDefinition[]
