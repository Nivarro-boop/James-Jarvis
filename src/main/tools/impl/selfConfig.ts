import { z } from 'zod'
import type { Settings } from '@shared/types'
import { defineTool, type ToolDefinition } from '../registry'
import { getSettings, setSettings } from '../../store/settings'
import { runAutomaticRepair } from '../../selfheal/monitor'

/**
 * James stellt sich selbst ein und repariert, was zur Laufzeit geht.
 *
 * Einstellungen ändert er nur über einen Pfad, der schon existiert, und nur
 * mit einem Wert desselben Typs — so kann er nichts erfinden, was die App
 * beim nächsten Start nicht mehr lesen kann. Was Sicherheit oder fremde
 * Prozesse betrifft (Werkzeugrechte, MCP-Server, Fernzugriff), bleibt bei
 * den Einstellungen von Hand: Ein Satz am Telefon soll nicht reichen, um
 * eine Sperre aufzuheben.
 */

const LOCKED_ROOTS = new Set(['permissions', 'mcpServers', 'companion', 'dailyCostLimitUsd', 'alexa'])
/**
 * Unterhalb erlaubter Bereiche trotzdem gesperrt: Zugangsdaten, und alles,
 * was auf eine Datei, ein Programm oder eine Adresse zeigt. Über einen
 * umgebogenen Pfad startete die nächste Sprachausgabe ein beliebiges
 * Programm, über eine Adresse gingen Anrufe oder Anfragen an einen fremden
 * Rechner. Ebenso `capabilityGaps`: Das Senden von Gesprächsausschnitten
 * erlaubt nur der Nutzer selbst, mit der Erklärung in den Einstellungen vor
 * Augen — nicht ein „Ja“ auf die Rückfrage des Modells.
 */
const LOCKED_LEAVES = /(^|\.)(pin|token|secret|password|key|capabilitygaps|[a-z]*(path|dir|exe|url|host|command|args|skillid))$/i

function readPath(root: unknown, path: string[]): { found: boolean; value: unknown } {
  let node: unknown = root
  for (const key of path) {
    if (!node || typeof node !== 'object' || !(key in (node as object))) return { found: false, value: undefined }
    node = (node as Record<string, unknown>)[key]
  }
  return { found: true, value: node }
}

function kind(value: unknown): string {
  if (value === null) return 'null'
  return Array.isArray(value) ? 'array' : typeof value
}

/** Aus "speech.provider" und einem Wert ein Teilobjekt für `setSettings`. */
function patchFor(settings: Settings, path: string[], value: unknown): Partial<Settings> {
  const [head, ...rest] = path
  if (rest.length === 0) return { [head]: value } as Partial<Settings>
  const build = (node: Record<string, unknown>, keys: string[]): Record<string, unknown> => {
    const [k, ...more] = keys
    return { ...node, [k]: more.length === 0 ? value : build(node[k] as Record<string, unknown>, more) }
  }
  const section = (settings as unknown as Record<string, Record<string, unknown>>)[head]
  return { [head]: build(section, rest) } as Partial<Settings>
}

const read = defineTool({
  name: 'settings_read',
  group: 'system',
  description:
    'Liest James\' eigene Einstellungen (Stimme, Sprache, Modelle, Mikrofon, Weckwort, Telefon, Musik …). ' +
    'Ohne Bereich kommt die Liste der Bereiche. Vor settings_change benutzen, um den genauen Pfad zu kennen.',
  schema: z.object({
    section: z.string().optional().describe('Bereich, z. B. "speech", "audio", "wake", "telephony"')
  }),
  async execute({ section }) {
    const settings = getSettings() as unknown as Record<string, unknown>
    if (!section) {
      return { bereiche: Object.keys(settings).filter((k) => !LOCKED_ROOTS.has(k)) }
    }
    if (LOCKED_ROOTS.has(section)) return { fehler: `${section} ist nur in den Einstellungen von Hand änderbar.` }
    const { found, value } = readPath(settings, section.split('.'))
    return found ? { [section]: value } : { fehler: `Unbekannter Bereich: ${section}` }
  }
}) as ToolDefinition

const change = defineTool({
  name: 'settings_change',
  group: 'system',
  description:
    'Ändert eine eigene Einstellung, z. B. speech.provider auf "gemini" oder wake.threshold auf 0.6. ' +
    'Der Pfad muss existieren, der Wert denselben Typ haben. Werkzeugrechte, MCP-Server und Fernzugriff ' +
    'gehen nur von Hand.',
  alwaysAsk: true,
  schema: z.object({
    path: z.string().describe('Pfad mit Punkten, z. B. "speech.provider"'),
    value_json: z.string().describe('Neuer Wert als JSON, z. B. "\\"gemini\\"", "0.6" oder "true"')
  }),
  async execute({ path, value_json }) {
    const keys = path.split('.').filter(Boolean)
    if (keys.length === 0) throw new Error('Kein Pfad angegeben.')
    if (LOCKED_ROOTS.has(keys[0]) || LOCKED_LEAVES.test(path)) {
      throw new Error(`${path} ist gesperrt und nur in den Einstellungen von Hand änderbar.`)
    }
    const settings = getSettings()
    const before = readPath(settings, keys)
    if (!before.found) throw new Error(`Diese Einstellung gibt es nicht: ${path}. Erst mit settings_read nachsehen.`)

    let value: unknown
    try {
      value = JSON.parse(value_json)
    } catch {
      throw new Error('value_json ist kein gültiges JSON.')
    }
    const expected = kind(before.value)
    const got = kind(value)
    // null ↔ string ist bei Gerätekennungen üblich (null = Standardgerät).
    const nullable = (expected === 'null' && got === 'string') || (expected === 'string' && got === 'null')
    if (expected !== got && !nullable) {
      throw new Error(`${path} erwartet ${expected}, bekommen hat es ${got}.`)
    }
    if (expected === 'object') throw new Error('Bitte einen einzelnen Wert ändern, nicht einen ganzen Bereich.')

    setSettings(patchFor(settings, keys, value))
    return { geändert: path, vorher: before.value, jetzt: value }
  }
}) as ToolDefinition

const repair = defineTool({
  name: 'self_repair',
  group: 'system',
  description:
    'Prüft alle eingeschalteten Dienste (Stimme, Ohren, Telefon, Ollama …) und repariert sofort, was ' +
    'zur Laufzeit geht: Neustart, fehlende Downloads nachladen, anderer Port, Rückfall auf Gemini. ' +
    'Für "repariere dich" oder wenn etwas nicht geht.',
  schema: z.object({}),
  spokenHint: 'Ich prüfe mich kurz durch.',
  async execute() {
    const dashboard = await runAutomaticRepair(true)
    const open = dashboard.recent.filter((i) => !i.healed).slice(0, 5)
    return {
      offen: open.map((i) => `${i.area}: ${i.message.slice(0, 200)}`),
      behoben: dashboard.recent.filter((i) => i.healed).length,
      hinweis: open.length
        ? 'Nenne, was offen blieb, und ob es sich über settings_change lösen lässt.'
        : 'Alles in Ordnung — in einem Satz sagen.'
    }
  }
}) as ToolDefinition

export const selfConfigTools: ToolDefinition[] = [read, change, repair]
