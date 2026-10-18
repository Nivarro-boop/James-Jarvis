import type { McpServerConfig } from './types'

/**
 * MCP-Server eintragen, ohne Befehle abzutippen.
 *
 * Fast jede MCP-Anleitung im Netz — Playwright, Notion, GitHub — liefert
 * denselben JSON-Block zum Kopieren: `{ "mcpServers": { "name": { command,
 * args, env } } }`. Den versteht Claude Desktop, Cursor und VS Code, und ab
 * jetzt auch James. Wer ihn einfügt, muss nicht wissen, was davon Befehl und
 * was Argument ist.
 *
 * Werte in `env`, deren Name nach Schlüssel aussieht, landen nicht in den
 * Einstellungen, sondern im verschlüsselten Keystore. Das entscheidet nicht der
 * Nutzer beim Einfügen — wer einen Block aus einer Anleitung kopiert, denkt
 * dabei nicht an Klartext auf der Platte.
 */

/** Ein Server aus dem eingefügten Block, bevor er eine Kennung bekommt. */
export interface ParsedMcpServer {
  name: string
  command: string
  args: string[]
  /** Gewöhnliche Umgebungsvariablen, landen in den Einstellungen. */
  env: Record<string, string>
  /** Schlüssel und Token, landen im Keystore. Leere Werte sind Platzhalter. */
  secrets: Record<string, string>
  /** Adresse eines fernen Servers; dann sind `command` und `args` leer. */
  url?: string
  headers?: Record<string, string>
}

export interface McpPreset {
  id: string
  name: string
  description: string
  command: string
  args: string[]
  /** Namen der Schlüssel, die der Server braucht — erscheinen als leere Felder. */
  secretEnv?: string[]
  /** Wo es den Schlüssel gibt. */
  keyUrl?: string
  /** Ferner Server: nur verbinden, nichts starten. Angemeldet wird im Browser. */
  url?: string
  headers?: Record<string, string>
  category?: 'Browser & Dateien' | 'Entwicklung' | 'Wissen & Planung' | 'Suche & Medien'
  docsUrl?: string
}

/**
 * Vorlagen für einen Klick.
 *
 * Playwright steht vorne: Er steuert einen echten Browser über die
 * Barrierefreiheitsstruktur der Seite statt über Bildschirmfotos — schneller
 * und genauer als die Bildschirmsteuerung, und ohne Schlüssel.
 *
 * `-y` steht bei allen dabei, weil npx sonst beim ersten Start fragt, ob es das
 * Paket holen darf. Die Frage geht an eine Konsole, die niemand sieht, und der
 * Server hängt, bis die Frist abläuft.
 */
export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'playwright',
    name: 'Playwright',
    description: 'Steuert einen Browser: Seiten öffnen, klicken, Formulare ausfüllen, Text lesen.',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    category: 'Browser & Dateien',
    docsUrl: 'https://github.com/microsoft/playwright-mcp'
  },
  {
    id: 'higgsfield',
    name: 'Higgsfield',
    description: 'Bilder und Videos erzeugen über dein Higgsfield-Konto. Anmeldung im Browser.',
    command: '',
    args: [],
    url: 'https://mcp.higgsfield.ai/mcp',
    category: 'Suche & Medien'
  },
  {
    id: 'filesystem',
    name: 'Dateisystem',
    description: 'Liest und schreibt Dateien im Dokumente-Ordner.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '%USERPROFILE%\\Documents'],
    category: 'Browser & Dateien',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem'
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Issues, Pull Requests und Code in deinen Repositories.',
    command: '',
    args: [],
    url: 'https://api.githubcopilot.com/mcp/',
    headers: { Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' },
    secretEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    keyUrl: 'https://github.com/settings/tokens',
    category: 'Entwicklung',
    docsUrl: 'https://github.com/github/github-mcp-server'
  },
  {
    id: 'notion', name: 'Notion', description: 'Wissen, Seiten und Datenbanken aus deinem Notion-Workspace.',
    command: '', args: [], url: 'https://mcp.notion.com/mcp', category: 'Wissen & Planung',
    docsUrl: 'https://developers.notion.com/guides/mcp/get-started-with-mcp'
  },
  {
    id: 'linear', name: 'Linear', description: 'Aufgaben, Projekte und Dokumente aus deinem Linear-Workspace.',
    command: '', args: [], url: 'https://mcp.linear.app/mcp', category: 'Wissen & Planung',
    docsUrl: 'https://linear.app/docs/mcp'
  },
  {
    id: 'brave',
    name: 'Brave Search',
    description: 'Websuche über die Brave-Search-API.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    secretEnv: ['BRAVE_API_KEY'],
    keyUrl: 'https://brave.com/search/api/',
    category: 'Suche & Medien'
  }
]

/** Erlaubte Namen für Umgebungsvariablen — alles andere wäre ein Tippfehler oder Absicht. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const SECRET_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}/g

export function validateMcpUrl(raw: string): URL {
  const url = new URL(raw.trim())
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('Ferne MCP-Server nur über https; http ist nur auf diesem Rechner erlaubt.')
  if (url.username || url.password) throw new Error('Zugangsdaten gehören in die geschützten Header-Felder, nicht in die Serveradresse.')
  if (url.hash) throw new Error('Eine MCP-Serveradresse darf keinen Fragment-Anker enthalten.')
  if ([...url.searchParams.keys()].some(isSecretEnvName)) throw new Error('Schlüssel und Token gehören in geschützte Header-Felder, nicht in die Serveradresse.')
  return url
}

/** Resolve header templates only at the connection boundary, using the vault. */
export function resolveMcpHeaders(config: Pick<McpServerConfig, 'headers' | 'secretEnv'>, secret: (name: string) => string | null | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  const seen = new Set<string>()
  for (const [name, template] of Object.entries(config.headers ?? {})) {
    if (!HEADER_NAME.test(name) || seen.has(name.toLowerCase()) || !/^(Bearer |Basic )?\$\{[A-Za-z_][A-Za-z0-9_]{0,127}\}$/i.test(template)) throw new Error('Ungültiger MCP-Header: Nur eindeutige geschützte Schlüsselreferenzen verwenden.')
    seen.add(name.toLowerCase())
    const refs = [...template.matchAll(SECRET_REFERENCE)]
    if (!refs.length || refs.some(match => !(config.secretEnv ?? []).includes(match[1]))) throw new Error(`Header ${name} muss einen geschützten Schlüssel verwenden.`)
    const value = template.replace(SECRET_REFERENCE, (_match, key: string) => {
      const value = secret(key)
      if (!value) throw new Error(`Schlüssel fehlt: ${key}`)
      if (/[\r\n]/.test(value)) throw new Error(`Ungültiger Schlüssel für Header ${name}.`)
      return value
    })
    headers[name] = value
  }
  return headers
}

/** Quoted Windows paths stay intact; no shell is involved. */
export function splitMcpArgs(raw: string): string[] {
  const tokens: string[] = []
  let quote = '', token = '', started = false
  for (const character of raw) {
    if (quote) { if (character === quote) quote = ''; else token += character }
    else if (character === '"' || character === "'") { quote = character; started = true }
    else if (/\s/.test(character)) { if (started) { tokens.push(token); token = ''; started = false } }
    else { token += character; started = true }
  }
  if (quote) throw new Error('Anführungszeichen im Befehl sind nicht geschlossen.')
  if (started) tokens.push(token)
  return tokens
}

/** Sieht der Name nach etwas aus, das nicht im Klartext liegen sollte? */
export function isSecretEnvName(name: string): boolean {
  return /KEY|TOKEN|SECRET|PASSWORD|PASSWD|PAT\b|CREDENTIAL|AUTH/i.test(name)
}

function asStringArray(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' && typeof v !== 'number')) throw new Error('args muss eine Liste von Zeichenketten oder Zahlen sein.')
  return value.filter((v): v is string | number => typeof v === 'string' || typeof v === 'number').map(String)
}

function readServer(name: string, raw: unknown): ParsedMcpServer {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`„${name}" ist kein Server-Eintrag.`)
  }
  const entry = raw as Record<string, unknown>
  const env: Record<string, string> = {}
  const secrets: Record<string, string> = {}
  if (entry.env !== undefined) {
    if (!entry.env || typeof entry.env !== 'object' || Array.isArray(entry.env)) throw new Error(`„${name}": env muss ein Objekt sein.`)
    for (const [key, value] of Object.entries(entry.env as Record<string, unknown>)) {
      if (!ENV_NAME.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error(`„${key}" ist kein gültiger Variablenname.`)
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new Error(`„${key}": Erwartet wird ein einfacher Wert.`)
      const text = value === null ? '' : String(value)
      const real = /^<.*>$|^your[_-]|^\$\{.*\}$/i.test(text.trim()) ? '' : text
      if (isSecretEnvName(key)) secrets[key] = real
      else env[key] = real
    }
  }
  // Ferne Server: `{ "url": "https://…" }`, manchmal mit `"type": "http"`.
  // Alte SSE-Server (`"type": "sse"`) spricht der Client nicht.
  if (typeof entry.url === 'string' && entry.url.trim()) {
    if (entry.type === 'sse') {
      throw new Error(`„${name}" nutzt das alte SSE-Verfahren. James verbindet nur über Streamable HTTP.`)
    }
    const url = validateMcpUrl(entry.url)
    const headers: Record<string, string> = {}
    if (entry.headers !== undefined) {
      if (!entry.headers || typeof entry.headers !== 'object' || Array.isArray(entry.headers)) throw new Error('headers muss ein Objekt sein.')
      const seen = new Set<string>()
      for (const [key, value] of Object.entries(entry.headers as Record<string, unknown>)) {
        if (!HEADER_NAME.test(key) || seen.has(key.toLowerCase()) || typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error(`Ungültiger oder doppelter Header: ${key}`)
        seen.add(key.toLowerCase())
        const reference = value.match(/^(Bearer |Basic )?\$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}$/i)
        if (reference) {
          const variable = reference[2]
          secrets[variable] ??= env[variable] ?? ''
          delete env[variable]
          headers[key] = value
        } else {
          const base = `MCP_HEADER_${key.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}`.slice(0, 120)
          let variable = base
          for (let n = 2; Object.hasOwn(secrets, variable) || Object.hasOwn(env, variable); n++) variable = `${base}_${n}`
          secrets[variable] = /^<.*>$|^your[_-]/i.test(value.trim()) ? '' : value
          headers[key] = '${' + variable + '}'
        }
      }
    }
    return { name, command: '', args: [], env, secrets, url: url.toString(), ...(Object.keys(headers).length ? { headers } : {}) }
  }
  if (typeof entry.command !== 'string' || !entry.command.trim()) {
    throw new Error(`Bei „${name}" fehlt "command" oder "url".`)
  }

  let command = entry.command.trim()
  let args = asStringArray(entry.args)
  // Manche Anleitungen schreiben alles in "command": "npx -y paket".
  if (command.startsWith('"') || command.startsWith("'")) {
    const parts = splitMcpArgs(command)
    command = parts[0]
    args = [...parts.slice(1), ...args]
  } else if (args.length === 0 && /\s/.test(command) && !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(command)) {
    const parts = splitMcpArgs(command)
    command = parts[0]
    args = parts.slice(1)
  }

  // Ohne `-y` fragt npx beim ersten Mal nach — an einer Konsole, die niemand sieht.
  if (/^npx(\.cmd)?$/i.test(command) && !args.some((a) => a === '-y' || a === '--yes')) {
    args = ['-y', ...args]
  }

  return { name, command, args, env, secrets }
}

/**
 * Den eingefügten Text lesen.
 *
 * Verstanden werden drei Formen, weil alle drei in Anleitungen vorkommen:
 * der ganze Block mit `mcpServers`, nur dessen Inhalt (`{ "playwright": {…} }`),
 * und ein einzelner Server (`{ "command": "npx", … }`). Auch ein Block, dem
 * beim Kopieren die äußeren Klammern fehlen, wird noch gelesen.
 */
export function parseMcpConfig(text: string): ParsedMcpServer[] {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('Da steht noch nichts.')

  let data: unknown
  try {
    data = JSON.parse(trimmed)
  } catch {
    try {
      data = JSON.parse(`{${trimmed.replace(/,\s*$/, '')}}`)
    } catch {
      throw new Error('Das ist kein gültiges JSON. Am besten den ganzen Block mit den geschweiften Klammern kopieren.')
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Erwartet wird ein Objekt mit "mcpServers".')
  }

  const root = data as Record<string, unknown>
  if (typeof root.command === 'string' || typeof root.url === 'string') return [readServer('Server', root)]

  // VS Code nennt denselben Block "servers".
  const block = (root.mcpServers ?? root.servers ?? root) as unknown
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    throw new Error('"mcpServers" ist leer oder kein Objekt.')
  }
  const servers = Object.entries(block as Record<string, unknown>).map(([name, raw]) => readServer(name, raw))
  if (servers.length === 0) throw new Error('Im Block steht kein Server.')
  return servers
}

/** Sharing a connector never exports vault values or clear-text credentials. */
export function exportMcpConfig(servers: McpServerConfig[]): string {
  const mcpServers: Record<string, unknown> = Object.create(null)
  for (const server of servers) {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(server.env ?? {})) env[key] = isSecretEnvName(key) ? '${' + key + '}' : value
    for (const name of server.secretEnv ?? []) env[name] = '${' + name + '}'
    const headers = Object.fromEntries(Object.entries(server.headers ?? {}).map(([name, template]) => [name,
      /^(Bearer |Basic )?\$\{[A-Za-z_][A-Za-z0-9_]{0,127}\}$/i.test(template) ? template : '${MCP_HEADER_' + name.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase() + '}'
    ]))
    const entry = server.url ? { url: validateMcpUrl(server.url).toString(), ...(Object.keys(headers).length ? { headers } : {}), ...(Object.keys(env).length ? { env } : {}) }
      : { command: server.command, args: server.args, ...(Object.keys(env).length ? { env } : {}) }
    mcpServers[server.id] = entry
  }
  return JSON.stringify({ mcpServers }, null, 2)
}

/** Eine freie Kennung aus dem Namen ableiten. */
export function uniqueServerId(name: string, existing: McpServerConfig[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'srv'
  let id = base
  for (let n = 2; existing.some((s) => s.id === id); n++) id = `${base}${n}`
  return id
}
