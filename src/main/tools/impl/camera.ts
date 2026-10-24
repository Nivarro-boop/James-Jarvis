import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { captureCameraFrame } from '../../automation/camera'
import { friendlyGeminiError, generateWithFallback } from '../../providers/gemini'
import { getSettings } from '../../store/settings'

/**
 * Die Kamera als Auge.
 *
 * Der Unterschied zu `screenshot` ist nicht die Technik, sondern die Frage:
 * „Was siehst du?" meint den Bildschirm, „Was ist das hier?" meint das, was
 * der Nutzer in die Hand nimmt. Zwei Werkzeuge statt eines mit Schalter, weil
 * das Modell sonst bei jedem Bild raten müsste, welches gemeint ist — und weil
 * die Beschreibung eines Werkzeugs die einzige Stelle ist, an der sich diese
 * Unterscheidung erklären lässt.
 *
 * Was hier nicht passiert: Gesichter erkennen oder Personen zuordnen. Nicht
 * aus technischen Gründen — das Modell könnte es —, sondern weil ein
 * Assistent, der auf Zuruf sagt, wer im Bild ist, etwas grundlegend anderes
 * ist als einer, der einen Gegenstand benennt. Die Systemanweisung unten
 * schließt es aus.
 */

const cameraLook = defineTool({
  name: 'camera_look',
  group: 'system',
  description:
    'Macht ein Bild mit der Kamera und beschreibt, was darauf zu sehen ist. Für "was halte ich ' +
    'hier in der Hand", "lies mir vor was auf der Packung steht", "welche Farbe hat das". ' +
    'Für alles auf dem Bildschirm nimm stattdessen screenshot.',
  schema: z.object({
    question: z
      .string()
      .optional()
      .describe('Was konkret interessiert. Ohne Angabe eine allgemeine Beschreibung.')
  }),
  // Die Kamera geht an, und das dauert einen Moment. Ohne ein gesprochenes
  // Zeichen wirkt die Pause wie ein Aussetzer.
  spokenHint: 'Mhm.',
  async execute({ question }, ctx) {
    ctx.setState('tool')

    const frame = await captureCameraFrame()
    const settings = getSettings()

    try {
      const response = await generateWithFallback({
        model: settings.visionModel,
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: frame.mimeType, data: frame.base64 } },
              {
                text:
                  question ??
                  'Was ist auf dem Bild zu sehen? Beschreib den Gegenstand oder die Szene.'
              }
            ]
          }
        ],
        config: {
          systemInstruction:
            'Du siehst ein Bild aus der Webcam eines Rechners. Antworte in zwei bis drei Sätzen ' +
            'auf Deutsch, ohne Aufzählungen und ohne Markdown — die Antwort wird vorgelesen. ' +
            'Benenne Gegenstände, Text und Farben so genau, wie das Bild es hergibt, und sag ' +
            'dazu, wenn etwas unscharf oder angeschnitten ist, statt zu raten. ' +
            'Beschreibe Menschen im Bild nur so weit, wie es die Frage verlangt: keine Namen, ' +
            'keine Vermutungen über Alter, Herkunft, Gesundheit oder Stimmung.'
        }
      })

      return {
        beschreibung: response.text,
        kamera: frame.label,
        auflösung: `${frame.width} mal ${frame.height}`,
        hinweis: 'Gib die Beschreibung wieder. Nenne die Auflösung nur, wenn danach gefragt wird.'
      }
    } catch (err) {
      throw new Error(friendlyGeminiError(err))
    }
  }
}) as ToolDefinition

export const cameraTools: ToolDefinition[] = [cameraLook]
