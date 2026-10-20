import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { register, unregisterTool, type ToolDefinition } from '../tools/registry'
import { getSettings } from '../store/settings'
import { getMcpSecret } from '../secrets/keystore'
import type { McpServerConfig, McpServerStatus } from '@shared/types'
import { resolveMcpHeaders, validateMcpUrl } from '@shared/mcp'
import { abortable } from '@shared/async'
import { JarvisOAuthProvider, waitForCallback } from './oauth'
import { expandMcpEnvironment, mcpEnvironment, mcpToolName } from './configuration'
import { McpLifecycle } from './lifecycle'
import { sendToCrystal } from '../ipc/emit'

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

export function mcpStatus(): Record<string, McpServerStatus> {
  return lifecycle.status()
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

/** JSON-Schema erlaubt Vereinigungen mit null, etwa `["string", "null"]`. */
function primaryType(type: unknown): unknown {
  if (!Array.isArray(type)) return type
  return type.find((t) => t !== 'null') ?? type[0]
}

/** Aus MCP-JSON-Schema wird ein Zod-Schema, damit der Runner validieren kann. */
function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object') return z.object({}).passthrough()
  const s = schema as Record<string, unknown>
  const nullable = Array.isArray(s.type) && s.type.includes('null')
  const type = primaryType(s.type)
  let result: z.ZodTypeAny

  switch (type) {
    case 'string':
      result = Array.isArray(s.enum) && s.enum.length > 0
        ? z.enum(s.enum as [string, ...string[]])
        : z.string()
      break
    case 'number':
      result = z.number()
      break
    case 'integer':
      result = z.number().int()
      break
    case 'boolean':
      result = z.boolean()
      break
    case 'array':
      result = z.array(jsonSchemaToZod(s.items))
      break
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
      result = z.object(shape)
      break
    }
    default:
      if (type === 'null') return z.null()
      result = z.object({}).passthrough()
  }
  return nullable ? result.nullable() : result
}

export function reloadMcpServers(): Promise<void> {
  return lifecycle.reload()
}

type SdkClient = InstanceType<typeof import('@modelcontextprotocol/sdk/client/index.js').Client>

/** Verbindung aufbauen, über die Kommandozeile oder über eine Adresse. */
async function connect(config: McpServerConfig, signal: AbortSignal): Promise<SdkClient> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const client = new Client({ name: 'void-jarvis', version: '0.1.0' }, { capabilities: {} })

  try {
    if (config.url) {
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
      const hasHeaders = Object.keys(config.headers ?? {}).length > 0
      const transport = new StreamableHTTPClientTransport(validateMcpUrl(config.url), {
        ...(hasHeaders ? {} : { authProvider: new JarvisOAuthProvider(config.id, config.name, false) }),
        requestInit: { headers: resolveMcpHeaders(config, name => getMcpSecret(config.id, name)) }
      })
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS, signal })
      return client
    }

    const { StdioClientTransport, getDefaultEnvironment } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    const env = mcpEnvironment(config, getDefaultEnvironment(), name => getMcpSecret(config.id, name))
    const transport = new StdioClientTransport({
      command: expandMcpEnvironment(config.command, env),
      args: config.args.map((arg) => expandMcpEnvironment(arg, env)),
      env
    })
    await client.connect(transport, { timeout: FIRST_CONNECT_TIMEOUT_MS, signal })
    return client
  } catch (err) {
    // Sein Prozess läuft womöglich schon — ohne Schließen bliebe er verwaist.
    void client.close().catch(() => undefined)
    throw err
  }
}

/** Definitionen zuerst vollständig aufbauen; die Lifecycle ersetzt sie danach atomar. */
export function serverToolDefinitions(config: McpServerConfig, connected: SdkClient, tools: Tool[]): ToolDefinition[] {
  return tools.map(tool => {
    const readOnly = tool.annotations?.readOnlyHint === true && !ALWAYS_ASK.test(tool.name)
    const localName = mcpToolName(config.id, tool.name)
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
      async execute(args, context) {
        context.signal.throwIfAborted()
        const res = await connected.callTool({ name: tool.name, arguments: args as Record<string, unknown> }, undefined, {
          signal: context.signal,
          timeout: 60_000,
          maxTotalTimeout: 60_000
        })
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
    return def
  })
}

const lifecycle = new McpLifecycle({
  configs: () => getSettings().mcpServers,
  fingerprint: () => {
    const configs = getSettings().mcpServers
    const secrets = configs.map(config => (config.secretEnv ?? []).map(name => getMcpSecret(config.id, name)))
    return createHash('sha256').update(JSON.stringify({ configs, secrets })).digest('hex')
  },
  missingSecrets: config => (config.secretEnv ?? []).filter(name => !getMcpSecret(config.id, name)),
  connect,
  definitions: serverToolDefinitions,
  register,
  unregister: tool => unregisterTool(tool.name, tool),
  onToolsChanged: () => { sendToCrystal('session:forceReconnect', undefined) }
})

/**
 * Bei einem fernen Server anmelden.
 *
 * Öffnet die Anmeldeseite im Systembrowser, wartet auf den Rückkanal und lädt
 * danach neu. Läuft in derselben Warteschlange wie das Neuladen, damit sich
 * die beiden nicht in die Quere kommen.
 */
export function loginMcpServer(id: string): Promise<void> {
  return lifecycle.exclusive(async () => {
    const config = getSettings().mcpServers.find((s) => s.id === id)
    if (!config?.url) throw new Error('Diesen fernen MCP-Server gibt es nicht.')
    if (Object.keys(config.headers ?? {}).length) {
      resolveMcpHeaders(config, name => getMcpSecret(config.id, name))
      await lifecycle.reloadNow()
      return
    }
    const provider = new JarvisOAuthProvider(config.id, config.name, true)
    const callback = waitForCallback(provider.stateValue)
    // Der Rückkanal kann scheitern, bevor jemand auf ihn wartet — etwa wenn
    // der Port belegt ist. Ohne diesen Fänger wäre das ein unbehandelter Fehler.
    callback.code.catch(() => undefined)
    let probe: SdkClient | undefined
    try {
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
      const transport = new StreamableHTTPClientTransport(validateMcpUrl(config.url), {
        authProvider: provider,
        requestInit: { headers: resolveMcpHeaders(config, name => getMcpSecret(config.id, name)) }
      })
      probe = new Client({ name: 'void-jarvis', version: '0.1.0' }, { capabilities: {} })
      let needsCode = true
      try {
        // Mit gültigem Token klappt das sofort, dann ist nichts weiter zu tun.
        await withTimeout(probe.connect(transport, { signal: lifecycle.signal }), CONNECT_TIMEOUT_MS, config.name)
        needsCode = false
      } catch (err) {
        if (!/unauthorized|401/i.test(String(err))) throw err
      }
      if (needsCode) {
        const code = await abortable(callback.code, lifecycle.signal)
        await transport.finishAuth(code)
      }
    } finally {
      if (probe) await withTimeout(probe.close(), 5_000, config.name).catch(() => undefined)
      callback.close()
    }
    await lifecycle.reloadNow()
  })
}

export async function shutdownMcp(): Promise<void> {
  await lifecycle.shutdown()
}
