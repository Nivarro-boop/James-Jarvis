import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { callUser, sipStatus } from '../../telephony/sip'

/**
 * James ruft den Nutzer an — über Linphone, kostenlos.
 *
 * Gedacht für den Moment, in dem James mit etwas fertig ist, das länger
 * gedauert hat, oder etwas schiefging, das der Nutzer wissen muss. Kein
 * Rückfragen vorher: Angerufen wird nur der Nutzer selbst, und ablehnen kann
 * er am iPhone.
 */
const callMe = defineTool({
  name: 'call_me',
  group: 'system',
  requiresSecret: 'sipPassword',
  description:
    'Ruft den Nutzer auf seinem iPhone an (Linphone, kostenlos). Nutze das, wenn eine längere Aufgabe ' +
    'fertig ist, etwas Wichtiges schiefging, oder er gesagt hat „ruf mich an, wenn …“. Nicht für ' +
    'Kleinigkeiten, und nicht, wenn er gerade mit dir am Rechner spricht.',
  schema: z.object({
    message: z
      .string()
      .describe('Der erste Satz, sobald er abnimmt, z. B. „Die Recherche zu den Flügen ist fertig.“')
  }),
  spokenHint: 'Okay.',
  async execute({ message }) {
    if (sipStatus().inCall) return { fehler: 'Es läuft schon ein Gespräch.' }
    await callUser(message)
    return { angenommen: true, hinweis: 'Er hat abgenommen; das Gespräch läuft am Telefon weiter.' }
  }
}) as ToolDefinition

export const linphoneTools: ToolDefinition[] = [callMe]
