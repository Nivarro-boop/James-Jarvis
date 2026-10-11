import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { setPaused } from '../../store/pause'

/**
 * James stilllegen — auf Zuruf.
 *
 * Stilllegen konnte man ihn schon immer: langer Druck auf den Kristall, das
 * Häkchen im Tray, der Hotkey. Was fehlte, war der naheliegendste Weg — ihn
 * einfach darum bitten. Und die Frist: Ohne sie konnte man ihn nur abschalten
 * und musste selbst daran denken, ihn zurückzuholen. Nach einem Filmabend
 * fällt einem das drei Tage später wieder ein.
 *
 * Stillgelegt heißt vollständig: kein Mikrofon, kein Weckwort, keine offene
 * Verbindung, keine Timer und keine Preisalarme. Er kann sich also nicht
 * selbst zurückholen — das ist der Punkt. Zurück kommt er über den Kristall,
 * den Hotkey, das Tray oder die abgelaufene Frist.
 *
 * Das Werkzeug fragt nicht nach. Eine Rückfrage vor dem Stillwerden wäre die
 * eine, die sich selbst im Weg steht: Wer "sei mal still" sagt, will keine
 * Gegenfrage. Zurücknehmen lässt es sich mit einem Klick.
 */

/**
 * Wie lange das letzte Wort noch Zeit bekommt.
 *
 * Ohne diese Verzögerung schneidet die Pause den Abschiedssatz mitten im Wort
 * ab: Das Werkzeug antwortet, das Modell setzt zum Sprechen an — und die
 * Sitzung ist schon zu. Drei Sekunden reichen für "Bis später", und länger
 * redet er an dieser Stelle ohnehin nicht.
 */
const GOODBYE_MS = 3200

/** Zwölf Stunden. Darüber hinaus ist es keine Pause mehr, sondern Ausschalten. */
const MAX_MINUTES = 720

const quiet = defineTool({
  name: 'jarvis_quiet',
  group: 'system',
  description:
    'Legt James still: kein Mikrofon, kein Weckwort, keine Verbindung. ' +
    'Für "sei mal still", "lass mich in Ruhe", "leg dich schlafen" oder ' +
    '"sei die nächste Stunde ruhig". Ohne Zeitangabe bleibt er still, bis ihn ' +
    'jemand zurückholt.',
  schema: z.object({
    minutes: z
      .number()
      .optional()
      .describe('Nach so vielen Minuten kommt er von selbst zurück. Ohne Angabe unbefristet.'),
    reason: z
      .string()
      .optional()
      .describe('Was der Nutzer gesagt hat, in wenigen Worten. Landet nur im Aktionslog.')
  }),
  async execute({ minutes }) {
    const span =
      minutes !== undefined && Number.isFinite(minutes)
        ? Math.min(MAX_MINUTES, Math.max(1, Math.round(minutes)))
        : null
    const until = span === null ? null : Date.now() + span * 60_000

    // Erst antworten, dann still werden. Die Reihenfolge ist der ganze Trick:
    // Das Modell bekommt sein Ergebnis, spricht den letzten Satz, und danach
    // erst geht das Mikrofon aus. Wer den Kristall in diesen drei Sekunden
    // anklickt, legt ihn ohnehin selbst stumm — der Wecker unten setzt dann
    // nur denselben Zustand noch einmal.
    setTimeout(() => setPaused(true, until), GOODBYE_MS)

    return {
      stillgelegt: true,
      fürMinuten: span ?? undefined,
      hinweis:
        span === null
          ? 'Verabschiede dich in einem kurzen Satz. Sag dazu, dass ein Klick auf die Kugel ' +
            'dich zurückholt. Danach bist du still.'
          : `Verabschiede dich in einem kurzen Satz und sag, dass du in ${span} Minuten von ` +
            'selbst wieder da bist. Danach bist du still.'
    }
  }
}) as ToolDefinition

export const quietTools: ToolDefinition[] = [quiet]
