import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { shell } from 'electron'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { getMcpOAuth, setMcpOAuth } from '../secrets/keystore'

/**
 * Anmeldung bei fernen MCP-Servern (OAuth mit PKCE).
 *
 * Higgsfield, Notion, Linear und Verwandte bieten ihren MCP-Server nur über
 * eine Adresse an, und die verlangt eine Anmeldung. Der Ablauf ist der, den
 * auch Claude Desktop geht: James registriert sich beim Server als Client,
 * öffnet die Anmeldeseite im Systembrowser, und der Browser schickt den Code
 * an einen kurz offenen Port auf 127.0.0.1 zurück. Das Passwort sieht James
 * dabei nie.
 *
 * Der Port ist fest, weil er Teil der Registrierung ist — mit einem
 * wechselnden Port müsste sich James bei jeder Anmeldung neu registrieren.
 */

export const OAUTH_CALLBACK_PORT = 33418
const REDIRECT_URL = `http://127.0.0.1:${OAUTH_CALLBACK_PORT}/callback`
/** So lange wartet James, bis die Anmeldung im Browser abgeschlossen ist. */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

interface Stored {
  client?: OAuthClientInformationMixed
  tokens?: OAuthTokens
}

/** Wird geworfen, wenn ein Server eine Anmeldung braucht, aber niemand gefragt hat. */
export class LoginRequiredError extends Error {
  constructor(name: string) {
    super(`${name} braucht eine Anmeldung. In den Einstellungen unter MCP-Server auf „Anmelden" klicken.`)
    this.name = 'LoginRequiredError'
  }
}

export class JarvisOAuthProvider implements OAuthClientProvider {
  private verifier = ''
  private readonly expectedState = randomBytes(16).toString('hex')

  constructor(
    private readonly serverId: string,
    private readonly serverName: string,
    /** Nur bei ausdrücklicher Anmeldung darf ein Browserfenster aufgehen. */
    private readonly interactive: boolean
  ) {}

  get redirectUrl(): string {
    return REDIRECT_URL
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'James-Jarvis',
      redirect_uris: [REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    }
  }

  state(): string {
    return this.expectedState
  }

  get stateValue(): string {
    return this.expectedState
  }

  private read(): Stored {
    return getMcpOAuth<Stored>(this.serverId) ?? {}
  }

  private write(change: Partial<Stored>): void {
    setMcpOAuth(this.serverId, { ...this.read(), ...change })
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.read().client
  }

  saveClientInformation(client: OAuthClientInformationMixed): void {
    this.write({ client })
  }

  tokens(): OAuthTokens | undefined {
    return this.read().tokens
  }

  saveTokens(tokens: OAuthTokens): void {
    this.write({ tokens })
  }

  redirectToAuthorization(url: URL): void {
    // Beim Start oder Neuladen soll nicht ungefragt ein Browserfenster
    // aufspringen — nur wenn der Nutzer gerade auf „Anmelden" geklickt hat.
    if (!this.interactive) throw new LoginRequiredError(this.serverName)
    if (url.protocol !== 'https:') throw new Error('Die Anmeldeseite ist keine https-Adresse.')
    void shell.openExternal(url.toString())
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('Kein PKCE-Wert vorhanden — Anmeldung neu starten.')
    return this.verifier
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all') setMcpOAuth(this.serverId, null)
    else if (scope === 'client') this.write({ client: undefined })
    else if (scope === 'tokens') this.write({ tokens: undefined })
  }
}

export function hasMcpLogin(serverId: string): boolean {
  return Boolean(getMcpOAuth<Stored>(serverId)?.tokens?.access_token)
}

export function forgetMcpLogin(serverId: string): void {
  setMcpOAuth(serverId, null)
}

/**
 * Den Rückkanal öffnen und auf den Code warten.
 *
 * Nur 127.0.0.1, nur `/callback`, nur mit dem erwarteten `state` — sonst
 * könnte jede Webseite im Browser einen fremden Code unterschieben.
 */
export function waitForCallback(expectedState: string): { code: Promise<string>; close: () => void } {
  let server: Server | null = null
  let timer: NodeJS.Timeout | undefined
  const close = (): void => {
    clearTimeout(timer)
    server?.close()
    server = null
  }

  const code = new Promise<string>((resolve, reject) => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT_URL)
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const error = url.searchParams.get('error')
      const value = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const ok = !error && value && state === expectedState
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        `<!doctype html><meta charset="utf-8"><title>James-Jarvis</title>` +
          `<body style="font:16px system-ui;background:#070a12;color:#e7ecf6;display:grid;place-items:center;height:100vh;margin:0">` +
          `<p>${ok ? 'Angemeldet. Du kannst dieses Fenster schließen.' : 'Anmeldung fehlgeschlagen. Bitte in James erneut versuchen.'}</p>`
      )
      if (ok) resolve(value)
      else reject(new Error(error ? `Anmeldung abgelehnt: ${error}` : 'Die Rückmeldung passt nicht zu dieser Anmeldung.'))
      close()
    })
    server.on('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`Port ${OAUTH_CALLBACK_PORT} ist belegt — läuft eine zweite Anmeldung?`)
          : err
      )
      close()
    })
    server.listen(OAUTH_CALLBACK_PORT, '127.0.0.1')
    timer = setTimeout(() => {
      reject(new Error('Die Anmeldung wurde nicht innerhalb von fünf Minuten abgeschlossen.'))
      close()
    }, LOGIN_TIMEOUT_MS)
  })

  return { code, close }
}
