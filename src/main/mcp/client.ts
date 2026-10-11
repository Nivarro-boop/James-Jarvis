import { z } from 'zod'
import { register, unregisterGroup, type ToolDefinition } from '../tools/registry'
import { getSettings } from '../store/settings'
import { getMcpSecret } from '../secrets/keystore'
import type { McpServerConfig, McpServerStatus } from '@shared/types'
import { JarvisOAuthProvider, LoginRequiredError, waitForCallback } from './oauth'

/**
 * MCP-Client.
 *
 * Jeder eingetragene MCP-Server wird gestartet, seine Tools werden abgefragt
 * und in die Registry gemergt. Damit wird jeder MCP-Server (Spotify, Notion,
 * Home Assistant, Dateisystem …) zu einem James-Werkzeug, ohne dass dafür
 * Code geschrieben werden muss.
 *
 * Namenskollisionen werden mit dem Server-Präfix aufgelöst, sonst würden zwei
 * Server mit einem `search`-Tool sich gegenseitig überschreiben.
 */

interface ActiveServer {
  id: string
  name: string
  close: () => Promise<void>
}

const active: ActiveServer[] = []

/**
 * Wie es jedem eingetragenen Server beim letzten Laden ergangen ist.
 *
 * Die Einstellungen zeigen das an der Karte des Servers. Vorher musste man
 * die Werkzeugliste nach dem Präfix durchsuchen und raten, warum einer fehlt.
 */
const status = new Map<string, McpServerStatus>()

export function mcpStatus(): Record<string, McpServerStatus> {
  return Object.fromEntries(status)
}

/**
 * Wie lange ein Server zum Starten und Auflisten seiner Werkzeuge braucht.
 *
 * Ohne Frist hing ein Server, der nie antwortet, das ganze Neuladen auf —
 * und jedes weitere wartete dahinter.
 */
const CONNECT_TIMEOUT_MS = 30_000

/**
 * Das Verbinden selbst darf länger dauern.
 *
 * Beim ersten Start holt `npx` das Paket erst aus dem Netz — bei Playwright
 * sind das einige Megabyte. Mit dreißig Sekunden scheiterte genau der erste
 * Versuch, und beim zweiten lag das Paket dann im Cache.
 */
const FIRST_CONNECT_TIMEOUT_MS = 120_000

/**
 * `%USERPROFILE%` und Verwandte auflösen.
 *
 * Der Server wird ohne Shell gestartet, also ersetzt niemand sonst die
 * Platzhalter — die Vorlage fürs Dateisystem bekäme sonst wörtlich
 * „%USERPROFILE%" als Ordner.
 */
function expandEnv(value: string, env: Record<string, string>): string {
  return value.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name: string) => {
    const hit = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
    return hit ? env[hit] : whole
  })
}

/** Umgebung für den Serverprozess: System, eigene Variablen, Schlüssel aus dem Keystore. */
function serverEnv(config: McpServerConfig): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...(config.env ?? {}) }
  for (const name of config.secretEnv ?? []) {
    const value = getMcpSecret(config.id, name)
    if (value) env[name] = value
  }
  return env
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} hat nach ${ms / 1000} Sekunden nicht geantwortet.`)), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

/**
 * MCP-Werkzeuge, die immer nachfragen, egal was unter „Rechte" steht.
 *
 * Beliebiger Code im Browser oder auf dem Rechner, Dateien hochladen,
 * löschen, verschicken: Hier lässt sich aus einer präparierten Webseite
 * heraus am meisten Schaden anrichten.
 */
const ALWAYS_ASK = /unsafe|evaluate|run_code|exec|shell|command|upload|delete|remove|send|write/i

/** JSON-Schema erlaubt `"type": ["string", "null"]` — gemeint ist dann der erste echte Typ. */
function primaryType(type: unknown): unknown {
  if (!Array.isArray(type)) return type
  return type.find((t) => t !== 'null') ?? type[0]
}

/** Aus MCP-JSON-Schema wird ein Zod-Schema, damit der Runner validieren kann. */
function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object') return z.object({}).passthrough()
  const s = schema as Record<string, unknown>

  switch (primaryType(s.type)) {
    case 'string':
      return Array.isArray(s.enum) && s.enum.length > 0
        ? z.enum(s.enum as [string, ...string[]])
        : z.string()
    case 'number':
    case 'integer':
      return z.number()
    case 'boolean':
      return z.boolean()
    case 'array':
      return z.array(jsonSchemaToZod(s.items))
    case 'object': {
      const props = (s.properties ?? {}) as Record<string, unknown>
      const required = new Set((s.required as string[]) ?? [])
      const shape: Record<string, z.ZodTypeAny> = {}
      for (const [key, value] of Object.entries(props)) {
        const inner = jsonSchemaToZod(value)
        const described =
          typeof (value as Record<string, unknown>).description === 'string'
            ? inner.describe((value as Record<string, unknown>).description as string)
            : inner
        shape[key] = required.has(key) ? described : described.optional()
      }
      return z.object(shape)
    }
    default:
      return z.object({}).passthrough()
  }
}

/**
 * Neuladen, eins nach dem anderen.
 *
 * Beim Start lädt die App, und wer gleich danach in den Einstellungen auf
 * „neu laden" drückt, startet einen zweiten Lauf. Gleichzeitig räumten beide
 * die Liste ab und trugen dieselben Werkzeuge ein — der zweite scheiterte an
 * „doppelt registriert", und dessen Serverprozesse liefen ohne Verwaltung weiter.
 */
let reloadQueue: Promise<void> = Promise.resolve()

export function reloadMcpServers(): Promise<void> {
  const run = reloadQueue.then(() => reloadMcpServersNow())
  reloadQueue = run.catch(() => undefined)
  return run
}

type SdkClient = InstanceType<typeof import('@modelcontextprotocol/sdk/client/index.js').Client>

/** Ferne Server nur über https — außer zum Ausprobieren auf diesem Rechner. */
function remoteUrl(raw: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error('Ferne MCP-Server nur über https.')
  }
  return url
}

/** Verbindung aufbauen, über die Kommandozeile oder über eine Adresse. */
async function connect(config: McpServerConfig): Promise<SdkClient> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const client = new Client({ name: 'void-jarvis', version: '0.1.0' }, { capabilities: {} })

  try {
    if (config.url) {
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
      const transport = new StreamableHTTPClientTransport(remoteUrl(config.url), {
        authProvider: new JarvisOAuthProvider(config.id, config.name, false)
      })
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, config.name)
      return client
    }

    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    const env = serverEnv(config)
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args.map((arg) => expandEnv(arg, env)),
      env
    })
    await withTimeout(client.connect(transport), FIRST_CONNECT_TIMEOUT_MS, config.name)
    return client
  } catch (err) {
    // Sein Prozess läuft womöglich schon — ohne Schließen bliebe er verwaist.
    void client.close().catch(() => undefined)
    throw err
  }
}

/** Die Werkzeuge eines verbundenen Servers in die Registry eintragen. */
async function registerServerTools(config: McpServerConfig, connected: SdkClient): Promise<number> {
  const { tools } = await withTimeout(connected.listTools(), CONNECT_TIMEOUT_MS, config.name)
  for (const tool of tools) {
    const readOnly = tool.annotations?.readOnlyHint === true
    const localName = `mcp_${config.id}_${tool.name}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 63)
    const def: ToolDefinition = {
      name: localName,
      group: 'mcp',
      description: `[${config.name}] ${tool.description ?? tool.name}`,
      schema: jsonSchemaToZod(tool.inputSchema),
      // Was nur liest — Seitenstruktur, Bildschirmfoto, Konsole —, läuft
      // ohne Rückfrage. Vorher fragte Playwright vor jedem Blick auf die
      // Seite nach, und eine Aufgabe mit zehn Schritten hieß zehnmal „ja".
      // Alles andere fragt nach und lässt sich unter „Rechte" freigeben;
      // nur Code ausführen, Dateien hochladen und Ähnliches bleibt fest.
      readOnly,
      alwaysAsk: !readOnly && ALWAYS_ASK.test(tool.name),
      async execute(args) {
        const res = await connected.callTool({ name: tool.name, arguments: args as Record<string, unknown> })
        // Ein Werkzeugfehler kommt bei MCP als gewöhnliche Antwort mit
        // `isError`. Durchgereicht als Ergebnis stand im Aktionslog
        // „erfolgreich", und James meldete den Fehlertext als Erfolg.
        if (res.isError) {
          const text = Array.isArray(res.content)
            ? res.content
                .map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : ''))
                .filter(Boolean)
                .join(' ')
            : ''
          throw new Error(text || `${config.name} meldet einen Fehler bei ${tool.name}.`)
        }
        return res.content
      }
    }
    try {
      register(def)
    } catch (err) {
      console.error(`[mcp] Tool ${localName} konnte nicht registriert werden:`, err)
    }
  }
  return tools.length
}

async function reloadMcpServersNow(): Promise<void> {
  for (const server of active) {
    try {
      await server.close()
    } catch (err) {
      console.error(`[mcp] Konnte ${server.name} nicht sauber schließen:`, err)
    }
  }
  active.length = 0
  unregisterGroup('mcp')
  status.clear()

  for (const config of getSettings().mcpServers) {
    if (!config.enabled) {
      status.set(config.id, { state: 'off', tools: 0 })
      continue
    }
    const missing = (config.secretEnv ?? []).filter((name) => !getMcpSecret(config.id, name))
    if (missing.length > 0) {
      // Ohne Schlüssel startet der Server meist trotzdem und scheitert erst
      // beim ersten Aufruf — mit einer Meldung, die niemand zuordnen kann.
      status.set(config.id, { state: 'key', tools: 0, error: `Schlüssel fehlt: ${missing.join(', ')}` })
      continue
    }
    try {
      const connected = await connect(config)
      const count = await registerServerTools(config, connected)
      active.push({ id: config.id, name: config.name, close: () => connected.close() })
      status.set(config.id, { state: 'ok', tools: count })
      console.log(`[mcp] ${config.name}: ${count} Werkzeuge geladen`)
    } catch (err) {
      // Ein kaputter MCP-Server darf den Start nicht blockieren.
      const message = err instanceof Error ? err.message : String(err)
      const login = Boolean(config.url) && (err instanceof LoginRequiredError || /unauthorized|401/i.test(message))
      status.set(config.id, { state: login ? 'login' : 'error', tools: 0, error: message.slice(0, 300) })
      // Eine fehlende Anmeldung ist kein Fehler, sondern ein ausstehender
      // Schritt des Nutzers — als Fehler geloggt zählte die Selbstheilung sie
      // als kaputtes Werkzeug.
      if (login) console.warn(`[mcp] ${config.name}: Anmeldung nötig.`)
      else console.error(`[mcp] ${config.name} nicht erreichbar:`, message)
    }
  }
}

/**
 * Bei einem fernen Server anmelden.
 *
 * Öffnet die Anmeldeseite im Systembrowser, wartet auf den Rückkanal und lädt
 * danach neu. Läuft in derselben Warteschlange wie das Neuladen, damit sich
 * die beiden nicht in die Quere kommen.
 */
export function loginMcpServer(id: string): Promise<void> {
  const run = reloadQueue.then(async () => {
    const config = getSettings().mcpServers.find((s) => s.id === id)
    if (!config?.url) throw new Error('Diesen fernen MCP-Server gibt es nicht.')
    const provider = new JarvisOAuthProvider(config.id, config.name, true)
    const callback = waitForCallback(provider.stateValue)
    // Der Rückkanal kann scheitern, bevor jemand auf ihn wartet — etwa wenn
    // der Port belegt ist. Ohne diesen Fänger wäre das ein unbehandelter Fehler.
    callback.code.catch(() => undefined)
    try {
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
      const transport = new StreamableHTTPClientTransport(remoteUrl(config.url), { authProvider: provider })
      const probe = new Client({ name: 'void-jarvis', version: '0.1.0' }, { capabilities: {} })
      let needsCode = true
      try {
        // Mit gültigem Token klappt das sofort, dann ist nichts weiter zu tun.
        await withTimeout(probe.connect(transport), CONNECT_TIMEOUT_MS, config.name)
        needsCode = false
        await probe.close()
      } catch (err) {
        if (!/unauthorized|401/i.test(String(err))) throw err
      }
      if (needsCode) {
        const code = await callback.code
        await transport.finishAuth(code)
      }
    } finally {
      callback.close()
    }
    await reloadMcpServersNow()
  })
  reloadQueue = run.catch(() => undefined)
  return run
}

export async function shutdownMcp(): Promise<void> {
  await Promise.allSettled(active.map((s) => s.close()))
  active.length = 0
}
