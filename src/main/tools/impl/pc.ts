import { app, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import {
  arrangeWindow,
  captureScreen,
  closeWindow,
  inputBackendStatus,
  listDisplays,
  lockScreen,
  systemStatus
} from '../../automation/desktop'

/**
 * Der Rechner selbst.
 *
 * Alles hier läuft ohne Modellaufruf und ohne Bildschirmfoto — es sind
 * Dinge, die Void im Spiel oder beim Schneiden nebenbei wissen oder
 * anordnen will, und dafür ist der Vision-Durchlauf viel zu langsam.
 */

const status = defineTool({
  name: 'system_status',
  group: 'system',
  description:
    'Sagt, wie es dem Rechner geht: Prozessorlast, Arbeitsspeicher, freier Plattenplatz, ' +
    'Laufzeit seit dem Start, Grafikkarte und Akku. Für "wie läuft der PC" oder "hab ich noch Platz".',
  schema: z.object({}),
  async execute() {
    const info = await systemStatus()
    return {
      prozessor: `${info.cpuLoad} Prozent Last`,
      arbeitsspeicher: `${info.memoryUsedGb} von ${info.memoryTotalGb} Gigabyte belegt`,
      grafikkarte: info.gpu ?? 'unbekannt',
      laufzeit: `${info.uptimeHours} Stunden seit dem letzten Start`,
      akku: info.batteryPercent === null ? 'kein Akku' : `${info.batteryPercent} Prozent`,
      platten: (info.disks ?? []).map((d) => ({
        laufwerk: d.drive,
        frei: `${d.freeGb} von ${d.totalGb} Gigabyte frei`
      })),
      hinweis: 'Nenne nur, wonach gefragt wurde. Zähl nicht alles auf.'
    }
  }
}) as ToolDefinition

const arrange = defineTool({
  name: 'arrange_window',
  group: 'system',
  description:
    'Ordnet ein Fenster an oder holt es auf einen anderen Bildschirm. ' +
    'Für "leg Chrome nach links", "mach Discord klein" und vor allem für ' +
    '"hol das Claude Fenster auf den rechten Bildschirm" — dann display auf "rechts" setzen. ' +
    'Ohne display bleibt das Fenster auf dem Bildschirm, auf dem es gerade steht.',
  schema: z.object({
    match: z.string().describe('Teil des Fenstertitels oder Programmnamens, etwa "Chrome" oder "Claude".'),
    how: z
      .enum(['left', 'right', 'maximize', 'minimize', 'restore'])
      .describe(
        'Wohin auf dem Bildschirm: linke Hälfte, rechte Hälfte, maximieren, minimieren oder ' +
          'auf eine mittlere Größe zurück. Wenn der Nutzer nur einen Bildschirm nennt und ' +
          'keine Lage, nimm "maximize" — er will das Fenster dort sehen, nicht halbiert.'
      ),
    display: z
      .string()
      .optional()
      .describe(
        'Auf welchen Bildschirm, wenn der Nutzer einen nennt: "links", "rechts", "haupt", ' +
          '"zwei". Weglassen, wenn er keinen genannt hat.'
      )
  }),
  async execute({ match, how, display }) {
    const result = await arrangeWindow(match, how, display)
    if (!result.ok) throw new Error(result.error ?? 'Kein passendes Fenster gefunden.')
    return {
      fenster: result.title,
      angeordnet: how,
      bildschirm: result.display,
      hinweis: 'Bestätige kurz, was du getan hast. Zähl nicht die Fensterliste auf.'
    }
  }
}) as ToolDefinition

/**
 * Welche Bildschirme es gibt.
 *
 * Klingt nach einer Auskunft, die niemand braucht, und ist die Voraussetzung
 * dafür, dass „auf den anderen Schirm" beantwortbar ist: Ohne sie muss das
 * Modell raten, ob überhaupt ein zweiter angeschlossen ist, und rät dann
 * gelegentlich falsch herum.
 */
const displays = defineTool({
  name: 'list_displays',
  group: 'system',
  description:
    'Zählt die angeschlossenen Bildschirme auf, mit Lage und Auflösung. ' +
    'Für "welche Bildschirme habe ich" oder wenn unklar ist, welcher gemeint ist.',
  schema: z.object({}),
  async execute() {
    const all = listDisplays()
    const sorted = [...all].sort((a, b) => a.bounds.x - b.bounds.x)
    return {
      anzahl: all.length,
      bildschirme: sorted.map((d, i) => ({
        name: d.label,
        lage: sorted.length === 1 ? 'einziger' : i === 0 ? 'links' : i === sorted.length - 1 ? 'rechts' : 'mitte',
        auflösung: `${d.bounds.width} mal ${d.bounds.height}`,
        haupt: d.primary
      }))
    }
  }
}) as ToolDefinition

const closeApp = defineTool({
  name: 'close_app',
  group: 'system',
  description:
    'Schließt ein Fenster oder Programm, so als hätte man auf das Kreuz geklickt. ' +
    'Für "mach das zu", "schließ Discord", "weg damit". Führ das direkt aus, ohne Rückfrage — ' +
    'ungesicherte Arbeit geht nicht verloren, das Programm fragt selbst nach, wenn etwas offen ist.',
  schema: z.object({
    match: z
      .string()
      .describe('Teil des Fenstertitels oder Programmnamens, so wie der Nutzer ihn gesagt hat.')
  }),
  async execute({ match }) {
    const result = await closeWindow(match)
    if (!result.ok) throw new Error(result.error ?? 'Kein passendes Fenster gefunden.')
    return { geschlossen: result.title }
  }
}) as ToolDefinition

const lock = defineTool({
  name: 'lock_screen',
  group: 'system',
  description: 'Sperrt den Bildschirm. Angemeldet bleibt alles, es läuft nur weiter im Hintergrund.',
  schema: z.object({}),
  async execute() {
    await lockScreen()
    return { gesperrt: true }
  }
}) as ToolDefinition

const saveShot = defineTool({
  name: 'screenshot_save',
  group: 'system',
  description:
    'Macht ein Bildschirmfoto und legt es in den Bilder-Ordner. Beschreibt es nicht — dafür ' +
    'ist screenshot da. Für "mach mal einen Screenshot davon".',
  schema: z.object({
    open: z.boolean().optional().describe('Ob der Ordner danach geöffnet wird.')
  }),
  async execute({ open }) {
    // Volle Auflösung und PNG: das Bild landet auf der Platte und soll
    // brauchbar sein, nicht bloß auswertbar. Kein Kachelbudget — das gilt für
    // Bilder, die ans Modell gehen, und dieses geht nirgendwohin.
    const shot = await captureScreen({ format: 'png' })
    const stamp = new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[:T]/g, '-')
    const target = join(app.getPath('pictures'), `jarvis-${stamp}.png`)

    await writeFile(target, Buffer.from(shot.base64, 'base64'))
    if (open) await shell.showItemInFolder(target)

    return {
      gespeichert: true,
      datei: `jarvis-${stamp}.png`,
      ordner: 'Bilder',
      hinweis: 'Nenne dem Nutzer nur den Dateinamen, nicht den ganzen Pfad.'
    }
  }
}) as ToolDefinition

const diagnose = defineTool({
  name: 'input_diagnose',
  group: 'system',
  description:
    'Prüft, ob James Maus und Tastatur überhaupt bewegen kann, und sagt über welchen Weg. ' +
    'Nutze das, wenn die Bildschirmsteuerung nicht tut, was sie soll.',
  schema: z.object({}),
  async execute() {
    const backend = await inputBackendStatus()
    return {
      weg: backend.name,
      einsatzbereit: !backend.grund,
      // Das Werkzeug ist ausdrücklich für den Fall gedacht, dass etwas nicht
      // tut. Dann ist der Grund das Einzige, was hier wirklich zählt.
      grund: backend.grund,
      hinweis: backend.grund
        ? 'Sag dem Nutzer, dass die Bildschirmsteuerung gerade nicht startet, und nenne den Grund.'
        : 'Sag nur kurz, dass es geht.'
    }
  }
}) as ToolDefinition

export const pcTools: ToolDefinition[] = [
  status,
  arrange,
  displays,
  closeApp,
  lock,
  saveShot,
  diagnose
]
