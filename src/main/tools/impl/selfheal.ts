import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { codeReport, healthReport } from '../../selfheal'

/**
 * James über seinen eigenen Zustand.
 *
 * Der Grund, warum es das gibt: Auf "warum ging die Stimme gestern abend
 * nicht" konnte er bisher nichts antworten. Er hatte den Absturz zwar
 * überlebt und still auf Gemini zurückgestellt — aber wissen konnte er davon
 * nichts, und ein Assistent, der die eigene Störung nicht kennt, erfindet
 * stattdessen eine Erklärung.
 *
 * Bewusst kein Werkzeug zum Reparieren: Geheilt wird automatisch, in dem
 * Moment, in dem die Störung auftritt. Was hier abgefragt wird, ist die
 * Nachschau — und was offen blieb, ist offen, weil sich zur Laufzeit nichts
 * mehr daran machen lässt.
 */
/** Die Bereichskennungen so, wie man sie vorlesen kann. */
const AREA_NAMES: Record<string, string> = {
  system: 'das Grundsystem',
  stimme: 'die Sprachausgabe',
  telefonie: 'das Telefonieren',
  gemini: 'die Verbindung zu Gemini',
  werkzeug: 'ein Werkzeug',
  live: 'die Sprachschleife',
  fernbedienung: 'die Fernbedienung am Telefon'
}

const selfDiagnose = defineTool({
  name: 'self_diagnose',
  group: 'system',
  description:
    'Sagt, was an James selbst zuletzt nicht funktioniert hat, was davon automatisch behoben ' +
    'wurde und was offen ist. Nutze dies, wenn der Nutzer fragt, warum etwas nicht ging, ob ' +
    'alles läuft, oder sich über eine Fehlfunktion beschwert.',
  schema: z.object({
    hours: z
      .number()
      .optional()
      .describe('Wie weit zurück geschaut wird, in Stunden. Standard 24.')
  }),
  spokenHint: 'Ich sehe in meinem eigenen Protokoll nach.',
  async execute({ hours }) {
    const report = healthReport(Math.min(Math.max(hours ?? 24, 1), 24 * 14))

    if (report.problems.length === 0) {
      return { zusammenfassung: report.summary, offen: [] }
    }

    return {
      zusammenfassung: report.summary,
      offen: report.problems.map((p) => ({
        bereich: AREA_NAMES[p.area] ?? p.area,
        was: p.message,
        wie_oft: p.count,
        versucht: p.attempted ?? 'Dafür gibt es kein automatisches Gegenmittel.'
      }))
    }
  }
}) as ToolDefinition

/**
 * Der Übergabepunkt an einen Menschen.
 *
 * Was sich zur Laufzeit nicht heilen lässt, ist in der Regel ein Fehler im
 * Code oder in der Einrichtung. Statt daran selbst herumzuschrauben, trägt
 * James alles zusammen, was zur Behebung nötig ist — in einer Form, die sich
 * unverändert weiterreichen lässt.
 */
const selfReport = defineTool({
  name: 'self_report',
  group: 'system',
  description:
    'Stellt einen ausführlichen Fehlerbericht über James selbst zusammen, zum Weitergeben an ' +
    'einen Entwickler oder ein Programmierwerkzeug. Nutze dies, wenn der Nutzer den Fehler ' +
    'beheben lassen will statt nur zu wissen, dass er da ist.',
  schema: z.object({
    hours: z.number().optional().describe('Zeitraum in Stunden. Standard 24.')
  }),
  spokenHint: 'Ich stelle den Bericht zusammen.',
  async execute({ hours }) {
    const text = codeReport(Math.min(Math.max(hours ?? 24, 1), 24 * 14))
    return {
      bericht: text,
      hinweis:
        'Das ist der vollständige Bericht. Ich ändere meinen eigenen Quelltext nicht von selbst — ' +
        'wer ihn behebt, entscheidet der Nutzer.'
    }
  }
}) as ToolDefinition

export const selfHealTools: ToolDefinition[] = [selfDiagnose, selfReport]
