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
    args: ['-y', '@playwright/mcp@latest']
  },
  {
    id: 'higgsfield',
    name: 'Higgsfield',
    description: 'Bilder und Videos erzeugen über dein Higgsfield-Konto. Anmeldung im Browser.',
    command: '',
    args: [],
    url: 'https://mcp.higgsfield.ai/mcp'
  },
  {
    id: 'filesystem',
    name: 'Dateisystem',
    description: 'Liest und schreibt Dateien im Benutzerordner.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '%USERPROFILE%']
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Issues, Pull Requests und Code in deinen Repositories.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    secretEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    keyUrl: 'https://github.com/settings/tokens'
  },
  {
    id: 'brave',
    name: 'Brave Search',
    description: 'Websuche über die Brave-Search-API.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    secretEnv: ['BRAVE_API_KEY'],
    keyUrl: 'https://brave.com/search/api/'
  }
]

/** Erlaubte Namen für Umgebungsvariablen — alles andere wäre ein Tippfehler oder Absicht. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

/** Sieht der Name nach etwas aus, das nicht im Klartext liegen sollte? */
export function isSecretEnvName(name: string): boolean {
  return /KEY|TOKEN|SECRET|PASSWORD|PASSWD|PAT\b|CREDENTIAL|AUTH/i.test(name)
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string | number => typeof v === 'string' || typeof v === 'number').map(String)
}

function readServer(name: string, raw: unknown): ParsedMcpServer {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`„${name}" ist kein Server-Eintrag.`)
  }
  const entry = raw as Record<string, unknown>
  // Ferne Server: `{ "url": "https://…" }`, manchmal mit `"type": "http"`.
  // Alte SSE-Server (`"type": "sse"`) spricht der Client nicht.
  if (typeof entry.url === 'string' && entry.url.trim()) {
    if (entry.type === 'sse') {
      throw new Error(`„${name}" nutzt das alte SSE-Verfahren. James verbindet nur über Streamable HTTP.`)
    }
    let url: URL
    try {
      url = new URL(entry.url.trim())
    } catch {
      throw new Error(`„${name}": "${entry.url}" ist keine gültige Adresse.`)
    }
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      throw new Error(`„${name}": Ferne Server nur über https.`)
    }
    return { name, command: '', args: [], env: {}, secrets: {}, url: url.toString() }
  }
  if (typeof entry.command !== 'string' || !entry.command.trim()) {
    throw new Error(`Bei „${name}" fehlt "command" oder "url".`)
  }

  let command = entry.command.trim()
  let args = asStringArray(entry.args)
  // Manche Anleitungen schreiben alles in "command": "npx -y paket".
  if (args.length === 0 && /\s/.test(command)) {
    const parts = command.split(/\s+/)
    command = parts[0]
    args = parts.slice(1)
  }

  // Ohne `-y` fragt npx beim ersten Mal nach — an einer Konsole, die niemand sieht.
  if (/^npx(\.cmd)?$/i.test(command) && !args.some((a) => a === '-y' || a === '--yes')) {
    args = ['-y', ...args]
  }

  const env: Record<string, string> = {}
  const secrets: Record<string, string> = {}
  if (entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env)) {
    for (const [key, value] of Object.entries(entry.env as Record<string, unknown>)) {
      if (!ENV_NAME.test(key)) throw new Error(`„${key}" ist kein gültiger Variablenname.`)
      const text = value === null || value === undefined ? '' : String(value)
      // Anleitungen schreiben Platzhalter wie "<YOUR_TOKEN>" — die sind kein Wert.
      const real = /^<.*>$|^your[_-]|^\$\{.*\}$/i.test(text.trim()) ? '' : text
      if (isSecretEnvName(key)) secrets[key] = real
      else env[key] = real
    }
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
  if (typeof root.command === 'string') return [readServer('Server', root)]

  // VS Code nennt denselben Block "servers".
  const block = (root.mcpServers ?? root.servers ?? root) as unknown
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    throw new Error('"mcpServers" ist leer oder kein Objekt.')
  }
  const servers = Object.entries(block as Record<string, unknown>).map(([name, raw]) => readServer(name, raw))
  if (servers.length === 0) throw new Error('Im Block steht kein Server.')
  return servers
}

/** Eine freie Kennung aus dem Namen ableiten. */
export function uniqueServerId(name: string, existing: McpServerConfig[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'srv'
  let id = base
  for (let n = 2; existing.some((s) => s.id === id); n++) id = `${base}${n}`
  return id
}
