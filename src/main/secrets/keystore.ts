import { app, safeStorage } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { SecretKey, SecretStatus } from '@shared/types'
import { websiteLoginUrl, type WebsiteAccountInfo, type WebsiteAccountInput } from '@shared/websiteAccounts'

/**
 * API-Keys landen nie im Klartext auf der Platte.
 *
 * `safeStorage` verschlüsselt unter Windows über DPAPI gegen das Benutzerkonto —
 * die Datei ist auf einem anderen Rechner oder unter einem anderen Benutzer
 * wertlos. Ist die Verschlüsselung nicht verfügbar (seltener Sonderfall bei
 * frisch angelegten Profilen), verweigern wir das Speichern, statt still
 * auf Klartext zurückzufallen.
 */

const ALL_KEYS: SecretKey[] = [
  'diagnosticReportToken',
  'gemini',
  'elevenlabs',
  'openrouter',
  'openai',
  'hermes',
  'anthropic',
  'higgsfield',
  'googleOAuthClientId',
  'googleOAuthClientSecret',
  'twilioAccountSid',
  'twilioAuthToken',
  'twilioPhoneNumber',
  'twilioApiKeySid',
  'twilioApiSecret',
  'sipPassword',
  'phonePin',
  'homeAssistant',
  'spotifyClientId',
  'appleMusicTeamId',
  'appleMusicKeyId',
  'appleMusicPrivateKey',
  'alexaSkillId',
  'calendarIcsUrl'
]

/**
 * Die Schlüssel der MCP-Server liegen in derselben Datei, aber unter einem
 * eigenen Fach. Ihre Namen bestimmt der jeweilige Server (`BRAVE_API_KEY`,
 * `GITHUB_PERSONAL_ACCESS_TOKEN` …), deshalb passen sie nicht in die feste
 * Liste oben.
 */
const MCP_FIELD = '__mcp'

/** Anmeldungen bei fernen MCP-Servern: Client-Registrierung und Token. */
const MCP_OAUTH_FIELD = '__mcpOAuth'

type Store = Partial<Record<SecretKey, string>> & {
  __websiteAccounts?: Record<string, WebsiteAccountInput>
  [MCP_FIELD]?: Record<string, string>
  [MCP_OAUTH_FIELD]?: Record<string, unknown>
}

let cache: Store | null = null
let unreadable = false

function secretsPath(): string {
  const dir = join(app.getPath('userData'), 'secure')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'secrets.bin')
}

export function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

function load(): Store {
  if (cache) return cache
  const file = secretsPath()
  if (!existsSync(file)) {
    cache = {}
    return cache
  }
  try {
    const blob = readFileSync(file)
    const json = safeStorage.decryptString(blob)
    const parsed: unknown = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Ungültiger Schlüsselspeicher.')
    const record = parsed as Record<string, unknown>
    for (const key of ALL_KEYS) {
      if (record[key] !== undefined && typeof record[key] !== 'string') throw new Error('Ungültiger Schlüsseleintrag.')
    }
    cache = parsed as Store
  } catch (err) {
    // Häufigster Grund: Datei stammt aus einem anderen Windows-Benutzerprofil.
    // Wir werfen sie nicht weg, sondern starten leer — der Nutzer trägt neu ein.
    console.error('[keystore] Entschlüsselung fehlgeschlagen:', err)
    unreadable = true
    cache = {}
  }

  return cache!
}

function persist(next: Store): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'Verschlüsselter Speicher ist auf diesem System nicht verfügbar. ' +
        'API-Keys werden aus Sicherheitsgründen nicht im Klartext abgelegt.'
    )
  }
  const blob = safeStorage.encryptString(JSON.stringify(next))
  const file = secretsPath()
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, blob, { mode: 0o600 })
    // Preserve a damaged or foreign-profile store before accepting new keys.
    if (unreadable && existsSync(file)) copyFileSync(file, `${file}.defekt-${randomUUID()}`)
    renameSync(temp, file)
    cache = next
    unreadable = false
  } finally {
    rmSync(temp, { force: true })
  }
}

export function getSecret(key: SecretKey): string | null {
  // Auch beim Lesen getrimmt: Ältere Einträge stammen aus der Zeit vor dem Trimmen beim Speichern.
  const value = load()[key]?.trim()
  return value ? value : null
}

export function setSecret(key: SecretKey, value: string): void {
  const store = { ...load() }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    delete store[key]
  } else {
    store[key] = trimmed
  }
  persist(store)
}

export function clearSecret(key: SecretKey): void {
  const store = { ...load() }
  delete store[key]
  persist(store)
}

/** Nur Vorhandensein melden — der Wert verlässt den Main-Prozess nicht. */
export function secretStatus(): SecretStatus[] {
  const store = load()
  return ALL_KEYS.map((key) => ({ key, present: Boolean(store[key]) }))
}

export function hasSecret(key: SecretKey): boolean {
  return getSecret(key) !== null
}

/** Values are encrypted with the existing DPAPI store; only origins are exposed to the model. */
export function websiteAccounts(): WebsiteAccountInfo[] {
  const accounts = load().__websiteAccounts ?? {}
  return Object.entries(accounts).flatMap(([origin, account]) => {
    try { return websiteLoginUrl(account.loginUrl).origin === origin ? [{ origin, loginUrl: account.loginUrl }] : [] }
    catch { return [] }
  })
}
export function saveWebsiteAccount(input: WebsiteAccountInput): void {
  const url = websiteLoginUrl(input.loginUrl)
  if (typeof input.username !== 'string' || !input.username.trim() || input.username.length > 320 ||
      typeof input.password !== 'string' || !input.password || input.password.length > 4096) throw new Error('Bitte Benutzername und Passwort vollständig eingeben.')
  const store = load()
  const accounts = { ...(store.__websiteAccounts ?? {}) }
  if (!accounts[url.origin] && Object.keys(accounts).length >= 100) throw new Error('Höchstens 100 Website-Konten speichern.')
  accounts[url.origin] = { loginUrl: url.toString(), username: input.username.trim(), password: input.password }
  persist({ ...store, __websiteAccounts: accounts })
}
export function removeWebsiteAccount(raw: string): void {
  const origin = websiteLoginUrl(raw).origin
  const store = load()
  const accounts = { ...(store.__websiteAccounts ?? {}) }
  delete accounts[origin]
  persist({ ...store, __websiteAccounts: accounts })
}
/** Main process only. Never expose this function over IPC or place its output in a tool result. */
export function websiteAccount(raw: string): WebsiteAccountInput | null {
  const origin = websiteLoginUrl(raw).origin
  const account = load().__websiteAccounts?.[origin]
  if (!account || typeof account.username !== 'string' || typeof account.password !== 'string') return null
  return websiteLoginUrl(account.loginUrl).origin === origin ? { ...account } : null
}

// ── Schlüssel der MCP-Server ─────────────────────────────────

function mcpSlot(serverId: string, name: string): string {
  return `${serverId}\u0000${name}`
}

export function getMcpSecret(serverId: string, name: string): string | null {
  const value = load()[MCP_FIELD]?.[mcpSlot(serverId, name)]
  return value && value.length > 0 ? value : null
}

export function setMcpSecret(serverId: string, name: string, value: string): void {
  const store = { ...load() }
  const bucket = { ...(store[MCP_FIELD] ?? {}) }
  const trimmed = value.trim()
  if (trimmed.length === 0) delete bucket[mcpSlot(serverId, name)]
  else bucket[mcpSlot(serverId, name)] = trimmed
  store[MCP_FIELD] = bucket
  persist(store)
}

/** Alle Schlüssel eines Servers wegwerfen — beim Löschen des Servers. */
export function clearMcpSecrets(serverId: string): void {
  const store = { ...load() }
  if (!store[MCP_FIELD]) return
  const bucket = { ...store[MCP_FIELD] }
  const prefix = `${serverId}\u0000`
  for (const slot of Object.keys(bucket)) if (slot.startsWith(prefix)) delete bucket[slot]
  store[MCP_FIELD] = bucket
  persist(store)
}

/** Wieder nur Vorhandensein, nie den Wert. */
export function mcpSecretStatus(serverId: string, names: string[]): Record<string, boolean> {
  return Object.fromEntries(names.map((name) => [name, getMcpSecret(serverId, name) !== null]))
}

// ── Anmeldungen bei fernen MCP-Servern ───────────────────────

/**
 * Was ein ferner Server nach der Anmeldung hinterlässt: die Registrierung von
 * James als Client und die Token. Beides ist so viel wert wie ein Passwort —
 * mit dem Token kann jeder im Namen des Nutzers Guthaben ausgeben.
 */
export function getMcpOAuth<T>(serverId: string): T | null {
  const value = load()[MCP_OAUTH_FIELD]?.[serverId]
  return (value as T | undefined) ?? null
}

export function setMcpOAuth(serverId: string, value: unknown | null): void {
  const store = { ...load() }
  const bucket = { ...(store[MCP_OAUTH_FIELD] ?? {}) }
  if (value === null) delete bucket[serverId]
  else bucket[serverId] = value
  store[MCP_OAUTH_FIELD] = bucket
  persist(store)
}
