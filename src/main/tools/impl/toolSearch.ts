import { z } from 'zod'
import { guidesForTools } from '@shared/prompts/system.de'
import { allTools, defineTool, toJsonSchema, type ToolDefinition } from '../registry'

/**
 * Werkzeuge nachladen statt alle vorab deklarieren.
 *
 * Über hundert Werkzeuge mit Schema kosteten bei jedem Verbindungsaufbau gut
 * zehntausend Token, und die Live-Sitzung trug sie in jeder Runde mit. Jetzt
 * bekommt das Modell nur den Kern fest (`CORE_TOOLS` in der Registry) und
 * findet den Rest über `tool_search`. Ausgeführt wird er über `tool_use`, das
 * der Runner auf das eigentliche Werkzeug umschreibt — Rechte, Rückfrage und
 * Protokoll laufen damit genau wie bei einem direkten Aufruf.
 */

const SEARCH_LIMIT = 5
const searchDocuments = new WeakMap<ToolDefinition, { name: string; group: string; description: string; lowerName: string; text: string }>()

function score(tool: ToolDefinition, words: string[]): number {
  let document = searchDocuments.get(tool)
  if (!document || document.name !== tool.name || document.group !== tool.group || document.description !== tool.description) {
    const lowerName = tool.name.toLowerCase()
    document = { name: tool.name, group: tool.group, description: tool.description, lowerName,
      text: `${lowerName} ${tool.group} ${tool.description}`.toLowerCase() }
    searchDocuments.set(tool, document)
  }
  let total = 0
  for (const w of words) {
    if (document.lowerName.includes(w)) total += 3
    else if (document.text.includes(w)) total += 1
  }
  return total
}

export function searchTools(query: string, exclude: ReadonlySet<string>): ToolDefinition[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length > 1)
  if (words.length === 0) return []
  return allTools()
    .filter((t) => !exclude.has(t.name))
    .map((t) => ({ t, s: score(t, words) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, SEARCH_LIMIT)
    .map((x) => x.t)
}

export const TOOL_SEARCH = 'tool_search'
export const TOOL_USE = 'tool_use'
const META = new Set([TOOL_SEARCH, TOOL_USE])

const search = defineTool({
  name: TOOL_SEARCH,
  group: 'agent',
  description:
    'Findet weitere Werkzeuge, die oben nicht stehen (Mail, Einkauf, Dateien, Office, Fenster, Chrome, ' +
    'WhatsApp, Minecraft, Kontakte, Termine, Orte, Routen, Skills …). Stichworte auf Deutsch oder Englisch. ' +
    'Danach mit tool_use aufrufen.',
  schema: z.object({ query: z.string().describe('Stichworte, z. B. "mail lesen" oder "datei suchen"') }),
  async execute({ query }) {
    const found = searchTools(query, META)
    if (found.length === 0) return { tools: [], hinweis: 'Nichts gefunden. Andere Stichworte versuchen.' }
    return {
      tools: found.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: toJsonSchema(t.schema).properties ?? {}
      })),
      anleitung: guidesForTools(found.map((t) => t.name)) || undefined,
      hinweis: 'Aufruf: tool_use mit name und args_json.'
    }
  }
}) as ToolDefinition

/**
 * Nur die Hülle für Schema und Beschreibung. Ausgeführt wird nie dieses
 * `execute`: Der Runner fängt `tool_use` vorher ab und ruft das genannte
 * Werkzeug selbst auf.
 */
const use = defineTool({
  name: TOOL_USE,
  group: 'agent',
  description:
    'Ruft ein Werkzeug auf, das du über tool_search gefunden hast. Für eine Bestätigung ' +
    '"confirmed": true in args_json mitgeben.',
  schema: z.object({
    name: z.string().describe('Name aus tool_search'),
    args_json: z.string().describe('Argumente als JSON-Objekt, z. B. {"query":"Rechnung"}')
  }),
  async execute() {
    throw new Error('tool_use läuft über den Runner.')
  }
}) as ToolDefinition

export const toolSearchTools: ToolDefinition[] = [search, use]
