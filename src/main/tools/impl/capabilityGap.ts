import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { capabilityGaps, gapUserText } from '../../agent/capabilityGaps'

/**
 * James meldet selbst, was ihm fehlt.
 *
 * Die Ablehnung in der Antwort erkennt der Sammler auch ohne dieses Werkzeug.
 * Was er daraus nicht erfährt, ist der Grund und was man bauen müsste — das
 * weiß nur das Modell, das gerade nach einem Werkzeug gesucht und keins
 * gefunden hat. Deshalb soll es das sagen, bevor es dem Nutzer absagt.
 *
 * Ohne Zustimmung des Nutzers wird nichts gesendet. Das Werkzeug gelingt
 * trotzdem: Ein Fehler hier würde das Modell nur dazu bringen, dem Nutzer von
 * einem Meldeweg zu erzählen, der ihn nicht interessiert.
 */

export const CAPABILITY_GAP_TOOL = 'report_capability_gap'

const reportGap = defineTool({
  name: CAPABILITY_GAP_TOOL,
  group: 'agent',
  description:
    'Meldet dem Entwickler eine fehlende Fähigkeit, damit sie ins nächste Update kommt. Immer aufrufen, ' +
    'wenn du eine Bitte nicht erfüllen kannst, weil dir ein Werkzeug, ein Zugang oder eine Funktion fehlt — ' +
    'bevor du es dem Nutzer sagst. Beschreib, was gebaut werden müsste. Keine Namen, Adressen oder Nummern.',
  schema: z.object({
    anfrage: z.string().describe('Was der Nutzer wollte, in einem Satz'),
    grund: z.string().describe('Woran es scheitert: welches Werkzeug, welcher Zugang oder welche Funktion fehlt'),
    loesungsvorschlag: z.string().describe('Was man bauen oder ändern müsste, damit es künftig geht')
  }),
  async execute({ anfrage, grund, loesungsvorschlag }) {
    const gemeldet =
      capabilityGaps()?.explicit({ request: anfrage, reason: grund, suggestion: loesungsvorschlag, userText: gapUserText() }) ??
      false
    return {
      gemeldet,
      hinweis: gemeldet
        ? 'Für den Entwickler vorgemerkt. Sag dem Nutzer jetzt kurz, dass du das nicht kannst.'
        : 'Nicht gesendet, Meldungen sind ausgeschaltet. Sag dem Nutzer kurz, dass du das nicht kannst.'
    }
  }
}) as ToolDefinition

export const capabilityGapTools: ToolDefinition[] = [reportGap]
