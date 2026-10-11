import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { recall, remember } from '../../agent/memory'
import { deleteMemory, listMemories, listSchedules, upsertSchedule, deleteSchedule } from '../../db'
import { isValidCron, reloadSchedules } from '../../scheduler/cron'

/**
 * Langzeitgedächtnis und Zeitplan.
 *
 * Beides gehört zusammen, weil es dieselbe Rolle spielt: Dinge, die über das
 * aktuelle Gespräch hinaus bestehen bleiben sollen.
 */

const rememberTool = defineTool({
  name: 'remember',
  group: 'memory',
  description:
    'Merkt sich dauerhaft eine Information über den Nutzer. Nutze das ungefragt, wenn er etwas ' +
    'über sich erzählt, das später relevant sein könnte: Vorlieben, Namen, Geräte, laufende Projekte, ' +
    'Gewohnheiten. Nicht für Dinge, die nur im aktuellen Gespräch zählen.',
  schema: z.object({
    fact: z
      .string()
      .describe('Die Information als vollständiger Satz, aus deiner Sicht formuliert.'),
    kind: z
      .enum(['fact', 'preference', 'person', 'project'])
      .optional()
      .describe('Art der Information.')
  }),
  async execute({ fact, kind }) {
    const id = await remember(fact, kind ?? 'fact')
    return { gemerkt: true, id }
  }
}) as ToolDefinition

const recallTool = defineTool({
  name: 'recall',
  group: 'memory',
  description:
    'Sucht in deinen Erinnerungen an den Nutzer. Nutze das, wenn er sich auf etwas Früheres ' +
    'bezieht oder du wissen musst, was er bevorzugt.',
  schema: z.object({
    query: z.string().describe('Wonach gesucht wird.')
  }),
  async execute({ query }) {
    const hits = await recall(query)
    if (hits.length === 0) return { gefunden: 0, note: 'Dazu weiß ich nichts.' }
    return { gefunden: hits.length, erinnerungen: hits.map((h) => h.text) }
  }
}) as ToolDefinition

/**
 * Sucht die eine Erinnerung heraus, die gelöscht werden soll.
 *
 * Dieselbe Dreiteilung wie beim Auflösen eines Empfängers, und aus demselben
 * Grund: Es wird gefragt, bevor etwas passiert, und die Frage muss benennen,
 * was passiert. Der Suchbegriff taugt dafür nicht — er ist ein Bruchstück, das
 * auf mehreres passen kann, und vorgelesen wurde bisher nur er. Der Nutzer hat
 * also "Ich führe forget aus mit text: Kaffee. Soll ich?" gehört und damit dem
 * Löschen einer Erinnerung zugestimmt, deren Wortlaut er nie erfahren hat.
 *
 * Ein zu kurzer Begriff ist der schlimmste Fall: `includes` trifft mit einem
 * einzelnen Buchstaben fast jede Erinnerung, `find` nimmt die erste — und die
 * Liste kommt nach Alter sortiert, es erwischt also die zuletzt angelegte.
 */
export type MemoryMatch =
  | { kind: 'one'; entry: { id: number; text: string } }
  | { kind: 'many'; matches: { id: number; text: string }[] }
  | { kind: 'none' }

export function resolveMemory(text: string): MemoryMatch {
  const needle = text.trim().toLowerCase()
  if (needle.length < 4) return { kind: 'none' }

  const hits = listMemories(500).filter((m) => m.text.toLowerCase().includes(needle.slice(0, 60)))
  if (hits.length === 0) return { kind: 'none' }
  if (hits.length === 1) return { kind: 'one', entry: hits[0] }

  // Ein wörtlicher Treffer schlägt jede Teilübereinstimmung — sonst bliebe
  // selbst die genaue Angabe des Wortlauts mehrdeutig, sobald eine zweite
  // Erinnerung ihn zufällig enthält.
  const exact = hits.filter((m) => m.text.trim().toLowerCase() === needle)
  if (exact.length === 1) return { kind: 'one', entry: exact[0] }

  return { kind: 'many', matches: hits.slice(0, 5) }
}

const forgetTool = defineTool({
  name: 'forget',
  group: 'memory',
  description: 'Löscht eine gespeicherte Erinnerung. Vorher mit recall die richtige heraussuchen.',
  schema: z.object({
    text: z.string().describe('Der Wortlaut der Erinnerung, die weg soll.')
  }),
  alwaysAsk: true,
  async execute({ text }) {
    const found = resolveMemory(text)
    if (found.kind === 'none') {
      throw new Error(
        'Ich finde keine passende Erinnerung. Such sie mit recall heraus und nenne mir ihren ' +
          'Wortlaut, nicht nur ein Stichwort.'
      )
    }
    if (found.kind === 'many') {
      throw new Error(
        `Darauf passen mehrere Erinnerungen: ${found.matches.map((m) => m.text).join(' — ')}. ` +
          'Frag den Nutzer, welche davon weg soll, und nenne dann ihren vollen Wortlaut.'
      )
    }
    deleteMemory(found.entry.id)
    return { gelöscht: found.entry.text }
  }
}) as ToolDefinition

// ─────────────────────────────────────────────────────────────
// Zeitplan
// ─────────────────────────────────────────────────────────────

const scheduleTool = defineTool({
  name: 'schedule_task',
  group: 'schedule',
  description:
    'Richtet einen wiederkehrenden Auftrag ein. Zur angegebenen Zeit meldet sich James von ' +
    'selbst und führt den Auftrag aus. Beispiel: jeden Morgen um acht die Mails zusammenfassen.',
  schema: z.object({
    cron: z
      .string()
      .describe(
        'Zeitplan im Cron-Format, fünf Felder: Minute Stunde Tag Monat Wochentag. ' +
          'Jeden Tag um acht ist "0 8 * * *", jeden Montag um neun ist "0 9 * * 1".'
      ),
    prompt: z
      .string()
      .describe('Was du zu diesem Zeitpunkt tun sollst, als Anweisung an dich selbst formuliert.'),
    label: z.string().optional().describe('Kurze Bezeichnung für die Übersicht.')
  }),
  async execute({ cron, prompt, label }) {
    // Vor dem Speichern prüfen. Ein unplanbarer Ausdruck landete sonst in der
    // Datenbank, stünde in der Übersicht und feuerte nie — während James dem
    // Nutzer "eingerichtet" gemeldet hätte.
    if (!isValidCron(cron)) {
      throw new Error(
        `"${cron}" ist kein gültiger Cron-Ausdruck. Erwartet werden fünf Felder: ` +
          'Minute Stunde Tag Monat Wochentag. Jeden Tag um acht ist "0 8 * * *".'
      )
    }
    const entry = upsertSchedule({ cron, prompt, label: label ?? prompt.slice(0, 40), active: true })
    reloadSchedules()
    return { eingerichtet: true, id: entry.id, zeitplan: cron }
  }
}) as ToolDefinition

const listSchedulesTool = defineTool({
  name: 'list_schedules',
  group: 'schedule',
  description: 'Zählt die eingerichteten wiederkehrenden Aufträge auf.',
  schema: z.object({}),
  async execute() {
    const list = listSchedules()
    if (list.length === 0) return { anzahl: 0, note: 'Es ist nichts eingeplant.' }
    return {
      anzahl: list.length,
      aufträge: list.map((s) => ({
        id: s.id,
        bezeichnung: s.label,
        zeitplan: s.cron,
        aktiv: s.active
      }))
    }
  }
}) as ToolDefinition

const cancelScheduleTool = defineTool({
  name: 'cancel_schedule',
  group: 'schedule',
  description: 'Löscht einen wiederkehrenden Auftrag.',
  schema: z.object({
    id: z.number().describe('Die Kennung aus list_schedules.')
  }),
  alwaysAsk: true,
  async execute({ id }) {
    const entry = listSchedules().find((s) => s.id === id)
    if (!entry) throw new Error('Diesen Auftrag gibt es nicht.')
    deleteSchedule(id)
    reloadSchedules()
    return { gelöscht: entry.label }
  }
}) as ToolDefinition

export const memoryTools: ToolDefinition[] = [
  rememberTool,
  recallTool,
  forgetTool,
  scheduleTool,
  listSchedulesTool,
  cancelScheduleTool
]
