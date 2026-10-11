import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { tokenReport } from '../../agent/tokenSaver'
import { checkConnections } from '../../agent/connections'

/**
 * Auskunft über sich selbst.
 *
 * Beides Dinge, die man ohne Chatfenster sonst nirgends erfährt: was der
 * Sparmodus bringt und was gerade überhaupt verbunden ist.
 */

const KIND_LABELS: Record<string, string> = {
  result: 'gekürzte Werkzeugergebnisse',
  cache: 'wiederholte Aufrufe aus dem Zwischenspeicher',
  declarations: 'kürzere Werkzeugbeschreibungen',
  silence: 'nicht hochgeladene Stille'
}

const report = defineTool({
  name: 'token_report',
  group: 'system',
  description:
    'Sagt, wie viel der Sparmodus heute eingespart hat und woran es lag. ' +
    'Für "was hast du gespart" oder "wie teuer bist du gerade".',
  schema: z.object({}),
  async execute() {
    const data = tokenReport()
    if (data.todayTokens === 0) {
      return { note: 'Heute war noch nichts zu sparen.' }
    }

    return {
      heute: `${Math.round(data.todayTokens / 1000)} Tausend Token`,
      diesenMonat: `${Math.round(data.monthTokens / 1000)} Tausend Token`,
      ungefährInDollar: data.todayUsd.toFixed(2),
      stilleNichtHochgeladen: `${Math.round(data.silenceSecondsToday / 60)} Minuten`,
      wodurch: data.byKind.map((k) => ({
        was: KIND_LABELS[k.kind] ?? k.kind,
        token: k.tokens
      })),
      hinweis:
        'Nenne die Größenordnung in einem Satz und den größten Posten. Lies nicht die ganze ' +
        'Aufstellung vor.'
    }
  }
}) as ToolDefinition

const connections = defineTool({
  name: 'check_connections',
  group: 'system',
  description:
    'Prüft, was gerade verbunden ist: Chrome, Gmail, Amazon, Maus und Tastatur. ' +
    'Nutze das, wenn etwas nicht geht und du wissen musst, woran es liegt.',
  schema: z.object({}),
  spokenHint: 'Ich schaue kurz nach.',
  async execute() {
    const status = await checkConnections()
    const broken = status.filter((s) => !s.ok)

    return {
      alles: status.map((s) => ({ was: s.label, geht: s.ok, stand: s.detail })),
      problem:
        broken.length === 0
          ? null
          : broken.map((s) => ({ was: s.label, warum: s.detail, abhilfe: s.fix })),
      hinweis:
        broken.length === 0
          ? 'Sag in einem Satz, dass alles verbunden ist.'
          : 'Nenne nur, was nicht geht, und was der Nutzer dagegen tun kann.'
    }
  }
}) as ToolDefinition

export const introspectionTools: ToolDefinition[] = [report, connections]
