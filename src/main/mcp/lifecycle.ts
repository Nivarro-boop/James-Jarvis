import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ToolListChangedNotificationSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import type { McpServerConfig, McpServerStatus } from '@shared/types'
import type { ToolDefinition } from '../tools/registry'

const START_CONCURRENCY = 3
const REQUEST_TIMEOUT_MS = 30_000
const CLOSE_TIMEOUT_MS = 5_000
const MAX_TOOL_PAGES = 100
const REFRESH_DEBOUNCE_MS = 150

interface Connection {
  config: McpServerConfig
  client: Client
  tools: ToolDefinition[]
  controller: AbortController
  disposed: boolean
  refresh?: Promise<void>
  refreshAgain: boolean
  timer?: NodeJS.Timeout
}

export interface McpLifecycleOptions {
  configs(): McpServerConfig[]
  /** Includes vault-backed credentials, hashed by the caller and never logged. */
  fingerprint(): string
  missingSecrets(config: McpServerConfig): string[]
  connect(config: McpServerConfig, signal: AbortSignal): Promise<Client>
  definitions(config: McpServerConfig, client: Client, tools: Tool[]): ToolDefinition[]
  register(tool: ToolDefinition): void
  unregister(tool: ToolDefinition): void
  /** Dynamic changes only; initial loading is deliberately quiet. */
  onToolsChanged?(): void
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300)
}

/** Independent connectors share scheduling, health and cleanup, not their credentials. */
export class McpLifecycle {
  private readonly active = new Map<string, Connection>()
  private readonly statuses = new Map<string, McpServerStatus>()
  private readonly stopping = new AbortController()
  private queue: Promise<void> = Promise.resolve()
  private pendingReload?: { fingerprint: string; work: Promise<void> }

  constructor(private readonly options: McpLifecycleOptions) {}

  get signal(): AbortSignal { return this.stopping.signal }

  status(): Record<string, McpServerStatus> {
    return Object.fromEntries([...this.statuses].map(([id, value]) => [id, { ...value }]))
  }

  /** Login shares the same queue as reload; neither can close the other's transport. */
  exclusive(work: () => Promise<void>): Promise<void> {
    const run = this.queue.then(async () => {
      if (this.stopping.signal.aborted) throw new Error('MCP wird bereits beendet.')
      await work()
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  reload(): Promise<void> {
    const fingerprint = this.options.fingerprint()
    if (this.pendingReload?.fingerprint === fingerprint) return this.pendingReload.work
    const work = this.exclusive(() => this.reloadNow())
    this.pendingReload = { fingerprint, work }
    const clear = (): void => { if (this.pendingReload?.work === work) this.pendingReload = undefined }
    void work.then(clear, clear)
    return work
  }

  /** Also used at the end of a queued OAuth login, without entering its own queue again. */
  async reloadNow(): Promise<void> {
    await Promise.all([...this.active.values()].map(connection => this.dispose(connection)))
    this.statuses.clear()
    const configs = this.options.configs()
    const seen = new Set<string>()
    const unique = configs.filter(config => {
      if (seen.has(config.id)) return false
      seen.add(config.id)
      return true
    })
    let next = 0
    await Promise.all(Array.from({ length: Math.min(START_CONCURRENCY, unique.length) }, async () => {
      while (next < unique.length && !this.stopping.signal.aborted) {
        const config = unique[next++]
        await this.start(config)
      }
    }))
  }

  private async start(config: McpServerConfig): Promise<void> {
    if (!config.enabled) {
      this.statuses.set(config.id, { state: 'off', tools: 0 })
      return
    }
    let connection: Connection | undefined
    try {
      const missing = this.options.missingSecrets(config)
      if (missing.length) {
        this.statuses.set(config.id, { state: 'key', tools: 0, error: `Schlüssel fehlt: ${missing.join(', ')}` })
        return
      }
      const client = await this.options.connect(config, this.stopping.signal)
      connection = { config, client, tools: [], controller: new AbortController(), disposed: false, refreshAgain: false }
      if (this.stopping.signal.aborted) { await this.dispose(connection); return }
      this.active.set(config.id, connection)
      const current = connection
      client.onclose = () => this.disconnected(current)
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.scheduleRefresh(current))
      current.refresh = this.refresh(current, false)
      try { await current.refresh } finally { current.refresh = undefined }
      if (current.refreshAgain) { current.refreshAgain = false; this.scheduleRefresh(current) }
      if (!current.disposed) console.log(`[mcp] ${config.name}: ${current.tools.length} Werkzeuge geladen`)
    } catch (error) {
      if (connection) await this.dispose(connection)
      if (this.stopping.signal.aborted) return
      const message = errorMessage(error)
      const login = Boolean(config.url) && !Object.keys(config.headers ?? {}).length && /unauthorized|401|LoginRequiredError/i.test(`${(error as Error)?.name} ${message}`)
      this.statuses.set(config.id, { state: login ? 'login' : 'error', tools: 0, error: message })
      if (login) console.warn(`[mcp] ${config.name}: Anmeldung nötig.`)
      else console.error(`[mcp] ${config.name} nicht erreichbar:`, message)
    }
  }

  private scheduleRefresh(connection: Connection): void {
    if (connection.disposed || this.stopping.signal.aborted) return
    clearTimeout(connection.timer)
    connection.timer = setTimeout(() => {
      connection.timer = undefined
      if (connection.refresh) { connection.refreshAgain = true; return }
      const work = this.refresh(connection, true)
      connection.refresh = work
      void work.catch(error => {
        if (!connection.disposed) {
          this.statuses.set(connection.config.id, { state: 'error', tools: connection.tools.length, error: errorMessage(error) })
        }
      }).finally(() => {
        connection.refresh = undefined
        if (connection.refreshAgain) {
          connection.refreshAgain = false
          this.scheduleRefresh(connection)
        }
      })
    }, REFRESH_DEBOUNCE_MS)
  }

  private async refresh(connection: Connection, notify: boolean): Promise<void> {
    const tools = new Map<string, Tool>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const result = await connection.client.listTools(cursor ? { cursor } : undefined, {
        timeout: REQUEST_TIMEOUT_MS,
        maxTotalTimeout: REQUEST_TIMEOUT_MS,
        signal: AbortSignal.any([connection.controller.signal, this.stopping.signal])
      })
      if (connection.disposed || this.stopping.signal.aborted) return
      for (const tool of result.tools) tools.set(tool.name, tool)
      cursor = result.nextCursor
      if (!cursor) break
      if (cursors.has(cursor) || page === MAX_TOOL_PAGES - 1) {
        throw new Error(`${connection.config.name} liefert eine ungültige oder zu lange Werkzeugliste.`)
      }
      cursors.add(cursor)
    }
    const definitions = this.options.definitions(connection.config, connection.client, [...tools.values()])
    const registered: ToolDefinition[] = []
    for (const tool of connection.tools) this.options.unregister(tool)
    try {
      for (const tool of definitions) {
        this.options.register(tool)
        registered.push(tool)
      }
    } catch (error) {
      for (const tool of registered) this.options.unregister(tool)
      for (const tool of connection.tools) this.options.register(tool)
      throw error
    }
    connection.tools = definitions
    this.statuses.set(connection.config.id, { state: 'ok', tools: definitions.length })
    if (notify) this.options.onToolsChanged?.()
  }

  private disconnected(connection: Connection): void {
    if (connection.disposed) return
    this.remove(connection)
    this.statuses.set(connection.config.id, { state: 'error', tools: 0, error: 'Verbindung zum MCP-Server wurde geschlossen. Bitte neu laden.' })
    this.options.onToolsChanged?.()
  }

  private remove(connection: Connection): void {
    connection.disposed = true
    clearTimeout(connection.timer)
    connection.controller.abort()
    for (const tool of connection.tools) this.options.unregister(tool)
    connection.tools = []
    if (this.active.get(connection.config.id) === connection) this.active.delete(connection.config.id)
  }

  private async dispose(connection: Connection): Promise<void> {
    this.remove(connection)
    let timeout: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        connection.client.close(),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Zeitlimit beim Schließen.')), CLOSE_TIMEOUT_MS) })
      ])
    } catch (error) {
      console.warn(`[mcp] ${connection.config.name} konnte nicht sauber schließen: ${errorMessage(error)}`)
    } finally { clearTimeout(timeout) }
  }

  async shutdown(): Promise<void> {
    this.stopping.abort()
    await Promise.all([...this.active.values()].map(connection => this.dispose(connection)))
    await this.queue
    this.statuses.clear()
  }
}
