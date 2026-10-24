import { app, safeStorage, shell } from 'electron'
import { createHash, createPublicKey, randomBytes, randomUUID, verify, type JsonWebKeyInput } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatGptStatus } from '@shared/chatgpt'

/** Official local Sign in with ChatGPT flow. Packaged commercial builds need
 * their own approved client registration. Local installations register the
 * user's agent dynamically; packaging alone is not a commercial deployment.
 * Never borrow Codex/browser tokens.
 * https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 */
const ISSUER = 'https://auth.openai.com'
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1'
const DYNAMIC_CLIENT_ID = 'dynamic_agent_client'
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const PLAN_SCOPE = 'chatgpt.tokens.use.direct'

function approvedClientId(): string {
  const id = process.env.JARVIS_CHATGPT_CLIENT_ID?.trim() ?? ''
  return id.startsWith('oaiapp_') ? id : ''
}

export function chatGptSignInEnabled(): boolean {
  if (process.env.JARVIS_CHATGPT_SIGNIN === '0') return false
  return Boolean(approvedClientId()) || process.env.JARVIS_CHATGPT_DISTRIBUTION !== 'commercial'
}

interface Registration { clientId: string; subject: string; email?: string }
interface StoredLogin extends Registration {
  hostId: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  idToken: string
  scope: string
}

function securePath(name: string): string {
  const dir = join(app.getPath('userData'), 'secure')
  mkdirSync(dir, { recursive: true })
  return join(dir, name)
}

function atomicWrite(file: string, data: string | Buffer): void {
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, data, { mode: 0o600 })
    renameSync(temp, file)
  } finally { rmSync(temp, { force: true }) }
}

function readProtected<T>(name: string): T | null {
  const file = securePath(name)
  if (!safeStorage.isEncryptionAvailable() || !existsSync(file)) return null
  try { return JSON.parse(safeStorage.decryptString(readFileSync(file))) as T }
  catch {
    console.warn('[chatgpt] Gespeicherte Anmeldung ist nicht lesbar; erneut anmelden.')
    return null
  }
}

function writeProtected(name: string, value: unknown): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Verschlüsselter Speicher ist nicht verfügbar. Die Anmeldung wird nicht abgelegt.')
  atomicWrite(securePath(name), safeStorage.encryptString(JSON.stringify(value)))
}

function hasPlanScope(scope: string): boolean {
  const scopes = typeof scope === 'string' ? scope.split(/\s+/) : []
  return scopes.includes(PLAN_SCOPE) && scopes.includes('resource.invoke')
}

function loadLogin(): StoredLogin | null {
  const login = readProtected<StoredLogin>('chatgpt-login.bin')
  if (!login || !login.clientId?.startsWith('oaiapp_') || !login.accessToken ||
      !login.refreshToken || !Number.isFinite(login.expiresAt) || !hasPlanScope(login.scope)) return null
  return login
}

/** Installation identity survives sign-out, failed consent and account changes. */
export function chatGptHostId(): string {
  const file = securePath('chatgpt-host.json')
  if (existsSync(file)) {
    const value = JSON.parse(readFileSync(file, 'utf8')) as { hostId?: string }
    if (typeof value.hostId !== 'string' || !/^urn:uuid:[0-9a-f-]{36}$/i.test(value.hostId)) throw new Error('Die ChatGPT-Installationskennung ist beschädigt.')
    return value.hostId
  }
  const hostId = readProtected<StoredLogin>('chatgpt-login.bin')?.hostId ?? `urn:uuid:${randomUUID()}`
  atomicWrite(file, JSON.stringify({ hostId }))
  return hostId
}

export function hasChatGptLogin(): boolean { return chatGptSignInEnabled() && loadLogin() !== null }
export function chatGptStatus(): ChatGptStatus {
  const enabled = chatGptSignInEnabled()
  const login = enabled ? loadLogin() : null
  return { enabled, connected: login !== null, email: login?.email,
    reason: enabled
      ? undefined
      : 'Die Abo-Anmeldung ist in dieser Ausgabe deaktiviert. Für einen kommerziellen Vertrieb muss der Herausgeber einen von OpenAI freigegebenen Client konfigurieren.' }
}

let sessionGeneration = 0
let connecting: Promise<{ email?: string }> | null = null
let pendingSignIn: AbortController | null = null
let refreshing: Promise<string> | null = null

/** Cancel a browser attempt without signing out an existing account. */
export function cancelChatGptSignIn(): void {
  if (!pendingSignIn) return
  sessionGeneration++
  pendingSignIn.abort()
}

interface Discovery { issuer: string; jwks_uri: string; revocation_endpoint?: string }
async function discovery(): Promise<Discovery> {
  const res = await fetch(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error('OpenAIs Anmeldedaten sind gerade nicht erreichbar.')
  const data = await res.json() as Discovery
  if (data.issuer !== ISSUER) throw new Error('Unerwarteter OpenAI-Aussteller.')
  return data
}
function trustedAuthEndpoint(value: string): string {
  const url = new URL(value)
  if (url.origin !== ISSUER || url.username || url.password) throw new Error('Unerwarteter OpenAI-Anmeldeendpunkt.')
  return url.toString()
}

/** Stop locally immediately; preserve host and account/client mapping for reauthorization. */
export async function disconnectChatGpt(): Promise<{ revoked: boolean }> {
  sessionGeneration++
  pendingSignIn?.abort()
  const login = loadLogin()
  if (login?.subject) writeProtected('chatgpt-registration.bin', {
    clientId: login.clientId, subject: login.subject, email: login.email
  } satisfies Registration)
  rmSync(securePath('chatgpt-login.bin'), { force: true })
  if (!login) return { revoked: true }
  try {
    const endpoint = (await discovery()).revocation_endpoint
    if (!endpoint) return { revoked: false }
    const response = await fetch(trustedAuthEndpoint(endpoint), {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: login.refreshToken, token_type_hint: 'refresh_token', client_id: login.clientId }),
      signal: AbortSignal.timeout(15_000)
    })
    return { revoked: response.status === 200 }
  } catch { return { revoked: false } }
}

function decodePart<T>(part: string): T { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T }
type Jwks = { keys: (JsonWebKeyInput['key'] & { kid?: string })[] }
let jwksCache: { value: Jwks; expires: number } | null = null
async function jwks(): Promise<Jwks> {
  if (jwksCache && jwksCache.expires > Date.now()) return jwksCache.value
  const info = await discovery()
  const response = await fetch(trustedAuthEndpoint(info.jwks_uri), { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error('OpenAIs Signaturschlüssel sind nicht erreichbar.')
  const value = await response.json() as Jwks
  if (!Array.isArray(value.keys)) throw new Error('OpenAIs Signaturschlüssel sind unlesbar.')
  jwksCache = { value, expires: Date.now() + 60 * 60_000 }
  return value
}

export async function verifyIdToken(idToken: string, clientId: string, nonce: string): Promise<{ email?: string; subject: string }> {
  const parts = idToken.split('.')
  if (parts.length !== 3 || parts.some((p) => !p)) throw new Error('OpenAI hat ein unlesbares ID-Token geschickt.')
  const [h, p, s] = parts
  const header = decodePart<{ alg: string; kid?: string }>(h)
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Unerwartetes ID-Token-Signaturverfahren.')
  let jwk = (await jwks()).keys.find((k) => k.kid === header.kid)
  if (!jwk) { jwksCache = null; jwk = (await jwks()).keys.find((k) => k.kid === header.kid) }
  if (!jwk || !verify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url'))) throw new Error('Die Signatur des ID-Tokens stimmt nicht.')
  const claims = decodePart<{ iss: string; aud: string | string[]; azp?: string; exp: number; nonce?: string; email?: string; sub: string }>(p)
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (claims.iss !== ISSUER) throw new Error('Das ID-Token stammt nicht von OpenAI.')
  if (!audiences.includes(clientId) || (audiences.length > 1 && claims.azp !== clientId)) throw new Error('Das ID-Token gilt nicht für James.')
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now() - 60_000) throw new Error('Das ID-Token ist abgelaufen.')
  if (claims.nonce !== nonce) throw new Error('Das ID-Token gehört nicht zu dieser Anmeldung.')
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('Im ID-Token fehlt die Kontoidentität.')
  return { email: typeof claims.email === 'string' ? claims.email : undefined, subject: claims.sub }
}

export function issuedClientId(requested: string, issued: string | null): string {
  if (requested === DYNAMIC_CLIENT_ID) {
    if (!issued?.startsWith('oaiapp_')) throw new Error('OpenAI hat keine Client-ID ausgestellt. Bitte erneut anmelden.')
    return issued
  }
  if (issued && issued !== requested) throw new Error('Die Rückleitung gehört zu einer anderen ChatGPT-Registrierung.')
  return requested
}
interface Callback { code: string; issuedClientId: string | null; redirectUri: string }
interface PendingBrowser { url: string; expiresAt: number; browserError?: string }
let pendingBrowser: PendingBrowser | null = null
let submitCallback: ((value: string) => void) | null = null

/** No ID-token hints or credentials cross into the remote sign-in controls. */
export function chatGptPendingSignIn(): PendingBrowser | null {
  return pendingBrowser ? { ...pendingBrowser } : null
}
export function submitChatGptCallback(value: unknown): void {
  if (typeof value !== 'string' || value.length > 12000) throw new Error('Bitte die vollständige Rückleitungsadresse einfügen.')
  if (!submitCallback) throw new Error('Keine Anmeldung offen. Bitte zuerst Continue with ChatGPT wählen.')
  submitCallback(value.trim())
}
function awaitCallback(authUrl: (redirectUri: string) => URL, state: string, signal: AbortSignal): Promise<Callback> {
  return new Promise((resolve, reject) => {
    let settled = false
    let redirectUri = ''
    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      if (submitCallback === manual) { submitCallback = null; pendingBrowser = null }
      server.close()
      server.closeIdleConnections()
      fn()
    }
    const accept = (url: URL): void => {
      if (settled) throw new Error('Diese Anmeldung ist bereits abgeschlossen.')
      const expected = new URL(redirectUri)
      if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash || url.searchParams.get('state') !== state) {
        throw new Error('Die Rückleitung gehört nicht zu dieser Anmeldung. Kopiere die vollständige Adresse aus dem Anmeldebrowser.')
      }
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      if (!code && !error) throw new Error('In der Adresse fehlt der Anmeldecode.')
      if (error) done(() => reject(new Error(error === 'access_denied'
        ? 'Die Nutzung deines ChatGPT-Plans wurde nicht erlaubt. Du kannst sie später erneut verbinden.'
        : 'Die ChatGPT-Anmeldung wurde vom Anmeldedienst abgebrochen. Bitte erneut versuchen.')))
      else done(() => resolve({ code: code!, issuedClientId: url.searchParams.get('client_id'), redirectUri }))
    }
    const manual = (value: string): void => {
      let url: URL
      try { url = new URL(value) } catch { throw new Error('Bitte die vollständige http://127.0.0.1:…/auth/callback-Adresse einfügen.') }
      accept(url)
    }
    const abort = (): void => done(() => reject(new Error('Die ChatGPT-Anmeldung wurde abgebrochen.')))
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', redirectUri || 'http://127.0.0.1')
      if (req.method !== 'GET' || url.pathname !== '/auth/callback') { res.writeHead(404).end(); return }
      if (url.searchParams.get('state') !== state) { res.writeHead(400).end('Ungültige Anmeldung.'); return }
      try {
        accept(url)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" })
        res.end('<!doctype html><meta charset="utf-8"><title>James-Jarvis</title><p>Zurück zu James wechseln. Dort wird die Anmeldung geprüft.</p>')
      } catch { res.writeHead(400).end('Ungültige Rückleitung. Bitte erneut kopieren.') }
    })
    const timeout = setTimeout(() => done(() => reject(new Error('Die ChatGPT-Anmeldung hat zu lange gedauert.'))), 5 * 60_000)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    server.on('error', () => done(() => reject(new Error('Der lokale Anmelderückkanal konnte nicht geöffnet werden.'))))
    server.listen(0, '127.0.0.1', () => {
      if (settled) { server.close(); return }
      const address = server.address()
      if (!address || typeof address !== 'object') { abort(); return }
      redirectUri = `http://127.0.0.1:${address.port}/auth/callback`
      const url = authUrl(redirectUri)
      const portable = new URL(url)
      portable.searchParams.delete('id_token_hint')
      pendingBrowser = { url: portable.toString(), expiresAt: Date.now() + 5 * 60_000 }
      submitCallback = manual
      // Browser forwarding during Remote Play may target another machine.
      // Keep the validated manual callback available even if opening fails.
      Promise.resolve().then(() => shell.openExternal(url.toString())).catch(() => {
        if (!settled && pendingBrowser) pendingBrowser.browserError = 'Browser konnte nicht geöffnet werden. Anmeldelink kopieren und selbst öffnen.'
      })
    })
  })
}

interface TokenResponse { access_token: string; refresh_token?: string; id_token?: string; expires_in: number; scope?: string }
class TokenExchangeError extends Error {
  constructor(message: string, readonly code?: string) { super(message) }
}
async function tokenRequest(body: Record<string, string>, signal?: AbortSignal): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...body, resource: CHATGPT_RESOURCE }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
  })
  if (!response.ok) {
    let code: string | undefined
    try {
      const error = (await response.json() as { error?: string | { code?: string } }).error
      code = typeof error === 'string' ? error : error?.code
    } catch { /* Never display or log a raw token response. */ }
    throw new TokenExchangeError(code === 'invalid_grant'
      ? 'Der Anmeldecode ist abgelaufen oder wurde bereits verwendet. Bitte erneut anmelden.'
      : code === 'invalid_client'
        ? 'OpenAI erkennt diese App-Registrierung nicht mehr. Bitte die Anmeldung erneut einrichten.'
        : code === 'invalid_scope'
          ? 'OpenAI erlaubt die angeforderte ChatGPT-Plan-Freigabe nicht.'
          : `OpenAI konnte die Anmeldung nicht bestätigen (HTTP ${response.status}). Bitte erneut versuchen.`, code)
  }
  const value = await response.json() as TokenResponse
  if (!value.access_token || !Number.isFinite(value.expires_in) || value.expires_in <= 0) throw new Error('OpenAI hat unvollständige Zugangsdaten geliefert.')
  return value
}

export function connectChatGpt(): Promise<{ email?: string }> {
  connecting ??= signIn().finally(() => { connecting = null })
  return connecting
}
async function signIn(): Promise<{ email?: string }> {
  if (!chatGptSignInEnabled()) throw new Error(chatGptStatus().reason)
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Der verschlüsselte Anmeldespeicher ist nicht verfügbar.')
  if (refreshing) await refreshing.catch(() => undefined)
  const generation = ++sessionGeneration
  const previous = loadLogin()
  const registration = previous ?? readProtected<Registration>('chatgpt-registration.bin')
  const hostId = chatGptHostId()
  let clientId = approvedClientId() || registration?.clientId || DYNAMIC_CLIENT_ID
  const controller = new AbortController()
  pendingSignIn = controller
  try {
    // An expired code needs fresh PKCE/state/nonce, reusing the issued client.
    // Retry once; repeatedly opening the browser would hide a lasting error.
    for (let attempt = 0; attempt < 2; attempt++) {
      controller.signal.throwIfAborted()
      const state = randomBytes(24).toString('base64url')
      const nonce = randomBytes(24).toString('base64url')
      const verifier = randomBytes(48).toString('base64url')
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      const callback = await awaitCallback((redirectUri) => {
        const url = new URL(`${ISSUER}/api/accounts/authorize`)
        const params: Record<string, string> = {
          client_id: clientId, ext_agent_host_id: hostId, response_type: 'code', redirect_uri: redirectUri,
          scope: SCOPE, resource: CHATGPT_RESOURCE, state, nonce, code_challenge: challenge, code_challenge_method: 'S256'
        }
        if (clientId === DYNAMIC_CLIENT_ID) params.agent_name_hint = 'James-Jarvis'
        if (previous?.idToken && previous.clientId === clientId) params.id_token_hint = previous.idToken
        if (registration?.email && registration.clientId === clientId) params.login_hint = registration.email
        url.search = new URLSearchParams(params).toString()
        return url
      }, state, controller.signal)
      const finalClientId = issuedClientId(clientId, callback.issuedClientId)
      let tokens: TokenResponse
      try {
        tokens = await tokenRequest({ grant_type: 'authorization_code', client_id: finalClientId,
          code: callback.code, code_verifier: verifier, redirect_uri: callback.redirectUri }, controller.signal)
      } catch (error) {
        if (error instanceof TokenExchangeError && error.code === 'invalid_grant' && attempt === 0) {
          clientId = finalClientId
          continue
        }
        throw error
      }
      if (!tokens.refresh_token || !tokens.id_token) throw new Error('OpenAI hat keine dauerhafte Anmeldung mitgeschickt.')
      if (!hasPlanScope(tokens.scope ?? '')) throw new Error('Die Nutzung deines ChatGPT-Plans wurde nicht erlaubt.')
      const identity = await verifyIdToken(tokens.id_token, finalClientId, nonce)
      if (registration?.subject && registration.clientId === finalClientId && registration.subject !== identity.subject) throw new Error('Die Anmeldung gehört zu einem anderen ChatGPT-Konto.')
      if (generation !== sessionGeneration) throw new Error('Die Anmeldung wurde inzwischen abgebrochen.')
      const login: StoredLogin = { clientId: finalClientId, hostId, accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000,
        idToken: tokens.id_token, scope: tokens.scope!, ...identity }
      writeProtected('chatgpt-login.bin', login)
      return { email: identity.email }
    }
    throw new Error('Bitte erneut mit ChatGPT anmelden.')
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Die ChatGPT-Anmeldung wurde abgebrochen.')
    throw error
  } finally { if (pendingSignIn === controller) pendingSignIn = null }
}

export async function chatGptAccessToken(forceRefresh = false): Promise<string> {
  const login = chatGptSignInEnabled() ? loadLogin() : null
  if (!login) throw new Error('Es ist keine ChatGPT-Anmeldung hinterlegt. In Zugänge mit ChatGPT anmelden.')
  if (refreshing) return refreshing
  if (!forceRefresh && login.expiresAt - Date.now() > 2 * 60_000) return login.accessToken
  const generation = sessionGeneration
  refreshing = (async () => {
    const tokens = await tokenRequest({ grant_type: 'refresh_token', client_id: login.clientId, refresh_token: login.refreshToken })
    const scope = tokens.scope ?? login.scope
    if (!hasPlanScope(scope)) throw new Error('Die Erlaubnis zur ChatGPT-Plan-Nutzung gilt nicht mehr. Bitte erneut anmelden.')
    if (generation !== sessionGeneration) throw new Error('Die ChatGPT-Anmeldung wurde inzwischen geändert.')
    writeProtected('chatgpt-login.bin', { ...login, accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? login.refreshToken, expiresAt: Date.now() + tokens.expires_in * 1000, scope })
    return tokens.access_token
  })().finally(() => { refreshing = null })
  return refreshing
}
