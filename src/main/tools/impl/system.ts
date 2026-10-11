import { clipboard, shell } from 'electron'
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import {
  adjustVolume,
  appIcon,
  cachedAppIcon,
  focusWindow,
  knownApps,
  launch,
  listWindows,
  mediaKey,
  pressHotkey,
  resolveApp,
  typeText
} from '../../automation/desktop'
import { URL_SHORTCUTS } from '@shared/config/apps'
import type { ToolContext } from '../registry'
import type { ResolvedApp } from '../../automation/desktop'

/**
 * Denkblase mit echtem Programmsymbol.
 *
 * Gewartet wird auf das Symbol nie: Liegt es noch nicht vor, startet das
 * Programm sofort, und das Symbol wird nachgetragen, sobald es gelesen ist.
 */
export function showLaunch(ctx: ToolContext, resolved: ResolvedApp, thought: string): void {
  const icon = cachedAppIcon(resolved)
  ctx.annotate({ thought, icon })
  if (!icon) {
    void appIcon(resolved).then((found) => {
      if (found) ctx.annotate({ icon: found })
    })
  }
}

/**
 * Deterministische Desktopsteuerung.
 *
 * Das ist die erste von zwei Stufen: bekannte Aktionen laufen direkt, ohne
 * Bildschirmaufnahme und ohne Modellaufruf. Das ist um Größenordnungen
 * schneller und zuverlässiger als der Vision-Loop und kostet nichts.
 * Erst wenn es hier keinen passenden Weg gibt, übernimmt `computer_task`.
 */

const openApp = defineTool({
  name: 'open_app',
  group: 'system',
  description:
    'Startet ein Programm oder holt es nach vorn, wenn es schon läuft. ' +
    'Erkennt gesprochene Namen wie "norisk", "modrinth", "discord", "chrome", "capcut".',
  schema: z.object({
    name: z.string().describe('Der Name des Programms, so wie der Nutzer ihn gesagt hat.')
  }),
  async execute({ name }, ctx) {
    const resolved = await resolveApp(name)
    if (!resolved) {
      const available = knownApps()
        .map((a) => a.label)
        .slice(0, 12)
        .join(', ')
      throw new Error(
        `Ich finde kein Programm namens "${name}". Bekannt sind unter anderem: ${available}.`
      )
    }

    const label = resolved.entry.label
    showLaunch(ctx, resolved, `Öffne ${label} …`)

    // Läuft es schon, reicht der Fokuswechsel — ein zweiter Start würde bei
    // vielen Launchern eine Fehlermeldung erzeugen.
    if (resolved.entry.windowMatch) {
      const windows = await listWindows()
      const running = windows.find((w) =>
        w.title.toLowerCase().includes(resolved.entry.windowMatch!.toLowerCase())
      )
      if (running) {
        ctx.annotate({ thought: `${label} läuft schon, hole es nach vorn …` })
        await focusWindow(resolved.entry.windowMatch)
        return { action: 'nach vorn geholt', app: label }
      }
    }

    await launch(resolved)
    return { action: 'gestartet', app: label }
  }
}) as ToolDefinition

const openUrl = defineTool({
  name: 'open_url',
  group: 'system',
  description:
    'Öffnet eine Webseite im Standardbrowser. Kennt Kurznamen wie "twitch", "youtube", ' +
    '"amazon", "geizhals", "gmail".',
  schema: z.object({
    url: z.string().describe('Vollständige Adresse oder ein bekannter Kurzname.')
  }),
  async execute({ url }) {
    const key = url.toLowerCase().trim()
    let target = URL_SHORTCUTS[key] ?? url

    if (!/^https?:\/\//i.test(target)) {
      // Sieht es nach einer Domain aus, ergänzen wir das Schema; sonst ist es
      // eine Suchanfrage und landet bei Google.
      target = /^[\w-]+(\.[\w-]+)+/.test(target)
        ? `https://${target}`
        : `https://www.google.com/search?q=${encodeURIComponent(target)}`
    }

    await shell.openExternal(target)
    return { opened: new URL(target).hostname.replace(/^www\./, '') }
  }
}) as ToolDefinition

const focus = defineTool({
  name: 'focus_window',
  group: 'system',
  description: 'Holt ein bereits offenes Fenster in den Vordergrund.',
  schema: z.object({
    match: z.string().describe('Teil des Fenstertitels, etwa "Chrome" oder "Minecraft".')
  }),
  async execute({ match }) {
    const result = await focusWindow(match)
    if (!result.ok) throw new Error(result.error ?? 'Kein passendes Fenster gefunden.')
    return { focused: result.title }
  }
}) as ToolDefinition

const windows = defineTool({
  name: 'list_windows',
  group: 'system',
  description: 'Zählt auf, welche Programme gerade mit einem Fenster offen sind.',
  schema: z.object({}),
  async execute() {
    const list = await listWindows()
    return {
      // Titel kürzen: vollständige Browser-Titel sind vorgelesen unbrauchbar.
      fenster: list.slice(0, 25).map((w) => ({ programm: w.name, titel: w.title.slice(0, 70) }))
    }
  }
}) as ToolDefinition

const type = defineTool({
  name: 'type_text',
  group: 'system',
  description:
    'Tippt Text in das gerade aktive Fenster. Vorher mit focus_window das richtige Ziel wählen.',
  schema: z.object({
    text: z.string().describe('Der Text, der getippt werden soll.')
  }),
  async execute({ text }) {
    // Zugangs- und Zahlungsdaten tippt James grundsätzlich nicht — das gilt
    // unabhängig von den Rechte-Einstellungen.
    if (/passwor[dt]|kennwort|\bpin\b|cvv|cvc|iban|kartennummer|card number/i.test(text)) {
      throw new Error(
        'Das sieht nach Zugangs- oder Zahlungsdaten aus. So etwas tippe ich grundsätzlich nicht.'
      )
    }
    await typeText(text)
    return { getippt: text.length }
  }
}) as ToolDefinition

const hotkey = defineTool({
  name: 'hotkey',
  group: 'system',
  description:
    'Drückt eine Tastenkombination im aktiven Fenster, etwa "strg+t", "alt+tab" oder "f11".',
  schema: z.object({
    combo: z.string().describe('Die Kombination, Tasten mit Plus verbunden.')
  }),
  async execute({ combo }) {
    await pressHotkey(combo)
    return { gedrückt: combo }
  }
}) as ToolDefinition

const volume = defineTool({
  name: 'volume',
  group: 'system',
  description: 'Ändert die Systemlautstärke schrittweise. Ein Schritt sind zwei Prozent.',
  schema: z.object({
    direction: z.enum(['lauter', 'leiser']),
    steps: z.number().optional().describe('Anzahl der Schritte, Standard fünf.')
  }),
  async execute({ direction, steps }) {
    const count = Math.min(25, Math.max(1, steps ?? 5))
    await adjustVolume(direction === 'lauter' ? count : -count)
    return { richtung: direction, schritte: count }
  }
}) as ToolDefinition

const media = defineTool({
  name: 'media_control',
  group: 'system',
  description: 'Steuert die Medienwiedergabe: abspielen oder pausieren, weiter, zurück, stopp.',
  schema: z.object({
    action: z.enum(['play', 'next', 'previous', 'stop'])
  }),
  async execute({ action }) {
    await mediaKey(action)
    return { aktion: action }
  }
}) as ToolDefinition

const readClipboard = defineTool({
  name: 'clipboard_read',
  group: 'system',
  description: 'Liest, was gerade in der Zwischenablage steht.',
  schema: z.object({}),
  async execute() {
    const text = clipboard.readText()
    if (!text) return { leer: true }
    return { inhalt: text.slice(0, 4000), gekürzt: text.length > 4000 }
  }
}) as ToolDefinition

const writeClipboard = defineTool({
  name: 'clipboard_write',
  group: 'system',
  description: 'Legt Text in die Zwischenablage.',
  schema: z.object({
    text: z.string()
  }),
  async execute({ text }) {
    clipboard.writeText(text)
    return { kopiert: text.length }
  }
}) as ToolDefinition

export const systemTools: ToolDefinition[] = [
  openApp,
  openUrl,
  focus,
  windows,
  type,
  hotkey,
  volume,
  media,
  readClipboard,
  writeClipboard
]
