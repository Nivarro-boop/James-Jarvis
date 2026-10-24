import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { runTool } from '../runner'
import { forgetRoutines, runDesktopTask, type DesktopResult } from '../../agent/desktopAgent'

/**
 * Die schnelle Bildschirmsteuerung als Werkzeug — Erklärung in `agent/desktopAgent`.
 */

const desktopTask = defineTool({
  name: 'desktop_task',
  group: 'system',
  description:
    'Erste Wahl, um eine Aufgabe in einem Windows-Programm zu erledigen (Einstellungen ändern, ' +
    'Menüs bedienen, Formulare in Programmen ausfüllen). Liest das Fenster als Bedienbaum statt als ' +
    'Bild — schnell und billig — und merkt sich erfolgreiche Abläufe, die beim nächsten Mal ohne ' +
    'Nachdenken abgespielt werden. Fällt bei Spielen und Zeichenflächen selbst auf computer_task zurück. ' +
    'Für Programme starten nimm open_app, für Webseiten die Browser-Werkzeuge.',
  schema: z.object({
    goal: z.string().describe('Was erreicht werden soll, konkret in einem Satz'),
    app: z.string().optional().describe('Fenstertitel oder Programmname; leer = aktives Fenster')
  }),
  spokenHint: 'Mhm.',
  async execute({ goal, app }, ctx) {
    const vision = async (): Promise<DesktopResult> => {
      const result = await runTool({
        id: randomUUID(),
        name: 'computer_task',
        args: { goal, ...(app ? { startApp: app } : {}) }
      }, ctx.signal)
      const outcome = result.result as { fertig?: boolean; abgebrochen?: boolean; grund?: string; ergebnis?: string } | undefined
      const ok = result.ok && outcome?.fertig === true && !outcome.abgebrochen
      return {
        ok,
        summary: result.ok ? (outcome?.ergebnis || outcome?.grund || 'Die Bildschirmaufgabe wurde nicht abgeschlossen.') : (result.error ?? 'fehlgeschlagen'),
        mode: 'vision',
        steps: 0,
        modelCalls: 0
      }
    }
    const result = await runDesktopTask(goal, app, ctx.signal, vision)
    if (!result.ok && result.mode !== 'vision') throw new Error(result.summary)
    return {
      erledigt: result.ok,
      zusammenfassung: result.summary,
      weg:
        result.mode === 'replay'
          ? 'gespeicherter Ablauf, ohne Modellaufruf'
          : result.mode === 'vision'
            ? 'Bildschirmfoto-Weg'
            : `Bedienbaum, ${result.modelCalls} Modellaufrufe`,
      schritte: result.steps
    }
  }
})

const desktopForget = defineTool({
  name: 'desktop_forget_routines',
  group: 'system',
  description: 'Vergisst alle gespeicherten Bedienabläufe der schnellen Bildschirmsteuerung.',
  schema: z.object({}),
  alwaysAsk: true,
  async execute() {
    return `${forgetRoutines()} gespeicherte Abläufe vergessen.`
  }
})

export const desktopTools: ToolDefinition[] = [desktopTask, desktopForget] as ToolDefinition[]
