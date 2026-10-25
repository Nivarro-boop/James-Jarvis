import { app, shell } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { getSecret } from '../secrets/keystore'

/**
 * Google-OAuth für Gmail und Kalender.
 *
 * Der Anmeldeweg läuft bewusst über den Systembrowser mit einem lokalen
 * Rückkanal, nicht über ein eingebettetes Fenster: Google blockiert
 * eingebettete Anmeldefenster, und wichtiger noch — so tippt der Nutzer sein
 * Passwort in seinem eigenen Browser und nicht in unsere App. James bekommt
 * das Passwort nie zu sehen.
 *
 * Die Zugangsdaten liegen verschlüsselt über safeStorage, genau wie die
 * API-Schlüssel.
 */

/**
 * Was James bei Google darf.
 *
 * Bewusst nicht `auth/calendar`, obwohl das kürzer wäre: Der volle Umfang
 * schließt das Anlegen und Löschen ganzer Kalender ein, und dafür gibt es hier
 * keinen einzigen Anlass. `calendar.events` deckt Lesen, Eintragen, Verschieben
 * und Absagen von Terminen ab; `calendar.readonly` kommt dazu, weil ohne sie
 * die Liste der Kalender nicht abrufbar ist — und ohne die wüsste James nicht,
 * dass es neben „privat" noch „Arbeit" gibt.
 */
const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly'
]

/**
 * Der Rest von Google Workspace: Drive, Docs, Tabellen, Aufgaben, Kontakte.
 * Wer vor diesem Update verbunden war, hat diese Rechte nicht und sieht in den
 * Einstellungen den Hinweis, einmal neu zu verbinden.
 */
const WORKSPACE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/contacts.readonly'
]

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
  ...CALENDAR_SCOPES,
  ...WORKSPACE_SCOPES
]

/** Spiegelt googleapis' Credentials wider — dort sind die Felder nullbar. */
interface StoredTokens {
  access_token?: string | null
  refresh_token?: string | null
  expiry_date?: number | null
  scope?: string
  token_type?: string | null
  /** Nur zum Anzeigen „Angemeldet als …" — nicht von Google, sondern von uns nach dem Verbinden gemerkt. */
  account_email?: string
}

function tokenPath(): string {
  const dir = join(app.getPath('userData'), 'secure')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'google-tokens.bin')
}

function loadTokens(): StoredTokens | null {
  const file = tokenPath()
  if (!existsSync(file)) return null
  try {
    return JSON.parse(safeStorage.decryptString(readFileSync(file))) as StoredTokens
  } catch (err) {
    console.error('[google] Zugangsdaten nicht lesbar:', err)
    return null
  }
}

function saveTokens(tokens: StoredTokens): void {
  writeFileSync(tokenPath(), safeStorage.encryptString(JSON.stringify(tokens)), { mode: 0o600 })
}

/**
 * Neue Zugangsdaten über die alten legen, ohne dabei etwas zu verlieren.
 *
 * Ein schlichtes `{ ...alt, ...neu }` sieht richtig aus und ist es nicht:
 * Beim Erneuern schickt Google nur, was sich ändert — ein fehlendes Feld
 * kommt als `undefined` mit und überschreibt damit den gespeicherten Wert.
 * Betroffen sind `refresh_token` und `scope`, und beide fehlen still: Ohne
 * `scope` gilt der Kalender plötzlich als nicht erlaubt, obwohl der Nutzer
 * ihn erteilt hat, und die Abhilfe wäre eine Neuanmeldung für ein Problem,
 * das gar keins ist.
 */
function mergeTokens(current: StoredTokens, incoming: StoredTokens): StoredTokens {
  const merged: StoredTokens = { ...current }
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined && value !== null) {
      ;(merged as Record<string, unknown>)[key] = value
    }
  }
  return merged
}

export function hasGoogleAuth(): boolean {
  // Auf Wahrheit prüfen, nicht auf "nicht undefined": googleapis liefert das
  // Feld auch als null, und dann galt die Anmeldung fälschlich als bestehend.
  return Boolean(loadTokens()?.refresh_token)
}

/**
 * Deckt die bestehende Anmeldung auch den Kalender ab?
 *
 * Die Frage stellt sich, weil der Kalender nachträglich dazukam. Wer sich
 * vorher angemeldet hat, hat ein Token mit ausschließlich Gmail-Rechten — und
 * Google beantwortet einen Kalenderaufruf damit nicht mit "melde dich neu an",
 * sondern mit einem 403 und dem Wort "insufficient". Ohne diese Prüfung wäre
 * das Ergebnis ein James, der sagt, er habe keinen Zugriff, obwohl der Nutzer
 * sichtbar verbunden ist und nichts falsch gemacht hat.
 *
 * Google schickt die tatsächlich erteilten Rechte beim Tausch mit; verglichen
 * wird also mit dem, was gewährt wurde, nicht mit dem, was angefragt war —
 * der Nutzer kann im Zustimmungsdialog einzelne Häkchen wegnehmen.
 */
export function hasCalendarAuth(): boolean {
  const granted = loadTokens()?.scope?.split(/\s+/) ?? []
  return CALENDAR_SCOPES.every((needed) => granted.includes(needed))
}

/** Mit welchem Konto James verbunden ist, sofern beim Verbinden gemerkt. */
export function googleAccountEmail(): string | undefined {
  return hasGoogleAuth() ? loadTokens()?.account_email : undefined
}

/** Ob die Anmeldung Drive, Docs, Tabellen, Aufgaben und Kontakte abdeckt. */
export function hasWorkspaceAuth(): boolean {
  const granted = loadTokens()?.scope?.split(/\s+/) ?? []
  return WORKSPACE_SCOPES.every((needed) => granted.includes(needed))
}

/** Text, der in die Rückseite der Anmeldung eingesetzt wird — nie als HTML. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

/**
 * Wartet auf die Weiterleitung von Google.
 *
 * Port 0 lässt das Betriebssystem einen freien Port wählen — ein fester Port
 * kollidiert früher oder später mit etwas anderem, und der Nutzer sieht dann
 * nur eine kaputte Anmeldung.
 *
 * `state` und PKCE schließen zwei Lücken, die ein Rückkanal auf 127.0.0.1
 * sonst offen lässt: Jede Webseite im Browser kann diesen Port erreichen und
 * einen eigenen `code` unterschieben — dann wäre James still mit einem
 * fremden Konto verbunden und läse dessen Post. Ohne das passende `state`
 * wird hier nichts angenommen, und ohne den `code_verifier` taugt ein
 * abgefangener Code beim Token-Tausch nichts.
 */
function awaitCallback(): Promise<{ code: string; redirectUri: string; codeVerifier: string }> {
  const state = randomBytes(24).toString('base64url')
  const codeVerifier = randomBytes(48).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  return new Promise((resolve, reject) => {
    let settled = false
    let timeout: NodeJS.Timeout | null = null
    /**
     * Der Port wird beim Binden festgehalten.
     *
     * Genau hier lag der Fehler in der Anmeldung: `server.address()` liefert
     * nach `server.close()` null, der Port wurde zu 0 und damit ging als
     * redirect_uri "http://127.0.0.1:0" in den Token-Tausch — worauf Google
     * mit redirect_uri_mismatch antwortete und die Anmeldung jedes Mal
     * scheiterte.
     */
    let port = 0

    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      server.close()
      fn()
    }

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')

      // Der Browser holt sich nach der Weiterleitung noch das Favicon. Ohne
      // diese Prüfung gilt der zweite Aufruf als abgebrochene Anmeldung.
      if (url.pathname !== '/' && url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }

      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')
      // Eine Antwort ohne unser `state` gehört nicht zu dieser Anmeldung. Sie
      // beendet die Anmeldung nicht, sonst könnte jede Seite sie abbrechen.
      if (url.searchParams.get('state') !== state) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Diese Antwort gehört nicht zu der laufenden Anmeldung.')
        return
      }

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'"
      })
      res.end(
        `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#0b0710;color:#ece7f4;display:grid;place-items:center;height:100vh;margin:0">
         <div style="text-align:center"><h2>${code ? 'Verbunden' : 'Fehlgeschlagen'}</h2>
         <p style="color:#9b8fae">${code ? 'Du kannst dieses Fenster schließen.' : escapeHtml(error ?? 'Unbekannter Fehler')}</p></div></body>`
      )

      if (code) {
        done(() => resolve({ code, redirectUri: `http://127.0.0.1:${port}`, codeVerifier }))
      } else {
        done(() => reject(new Error(error ?? 'Die Anmeldung wurde abgebrochen.')))
      }
    })

    server.on('error', (err) => {
      done(() => reject(new Error(`Der Rückkanal ließ sich nicht öffnen: ${err.message}`)))
    })

    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      port = typeof address === 'object' && address ? address.port : 0
      if (!port) {
        done(() => reject(new Error('Der Rückkanal hat keinen Port bekommen.')))
        return
      }

      const clientId = getSecret('googleOAuthClientId')
      if (!clientId) {
        done(() => reject(new Error('Es fehlt die Google OAuth Client-ID in den Einstellungen.')))
        return
      }
      if (!getSecret('googleOAuthClientSecret')) {
        done(() => reject(new Error('Es fehlt das Google OAuth Geheimnis in den Einstellungen.')))
        return
      }

      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      authUrl.searchParams.set('client_id', clientId)
      authUrl.searchParams.set('redirect_uri', `http://127.0.0.1:${port}`)
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('scope', SCOPES.join(' '))
      // Ohne consent liefert Google beim zweiten Mal kein refresh_token mehr,
      // und die Anmeldung wäre nach einer Stunde wieder weg.
      authUrl.searchParams.set('access_type', 'offline')
      authUrl.searchParams.set('prompt', 'consent')
      authUrl.searchParams.set('state', state)
      authUrl.searchParams.set('code_challenge', codeChallenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')

      void shell.openExternal(authUrl.toString())
    })

    timeout = setTimeout(
      () => done(() => reject(new Error('Die Anmeldung hat zu lange gedauert.'))),
      5 * 60 * 1000
    )
  })
}

/**
 * Störungen mit zwei Lesern.
 *
 * Dieselbe Lage liest entweder das Sprachmodell — das braucht die Anweisung,
 * was es dem Nutzer ausrichten soll — oder der Nutzer selbst, im
 * Einstellungsfenster unter dem Knopf, den er gerade gedrückt hat. Dort war
 * „Sag dem Nutzer, er soll in den Einstellungen eine Google-Anmeldung
 * hinterlegen" zu lesen, und das ist an dieser Stelle Unsinn: Er steht schon
 * darin, und was er eintragen soll, steht nicht dabei.
 *
 * Deshalb steht jede Lage einmal hier, in beiden Fassungen, statt zweimal im
 * Code. Die Fassung für den Nutzer sagt, was zu tun ist; die für das Modell
 * sagt, was auszurichten ist.
 */
type GoogleFaultCode =
  | 'keine-einrichtung'
  | 'nicht-verbunden'
  | 'kein-dauerrecht'
  | 'abgelaufen'
  | 'rueckleitung'
  | 'client-falsch'
  | 'abgelehnt'
  | 'berechtigung'

const FAULTS: Record<GoogleFaultCode, { agent: string; user: string }> = {
  'keine-einrichtung': {
    agent:
      'Dafür fehlt die Google-Einrichtung. Sag dem Nutzer, er soll in den Einstellungen eine ' +
      'Google-Anmeldung hinterlegen.',
    user:
      'Es fehlt der OAuth-Client. Trag ihn weiter unten als Client-ID und Geheimnis ein — aus ' +
      'der Google Cloud Console, Anwendungstyp Desktop — und drück dann noch einmal hier.'
  },
  'nicht-verbunden': {
    agent:
      'Das Google-Konto ist noch nicht angemeldet. Mails gehen trotzdem über die mail_*-Werkzeuge im ' +
      'Browser. Für Kalender, Drive und Aufgaben: Sag dem Nutzer, er soll unter Einstellungen → Konten ' +
      'auf „Mit Google anmelden" drücken — ein Klick, die Anmeldung läuft im Browser.',
    user: 'Das Google-Konto ist noch nicht angemeldet.'
  },
  'kein-dauerrecht': {
    agent:
      'Google hat kein dauerhaftes Zugriffsrecht mitgeschickt. Sag dem Nutzer, er soll der App ' +
      'unter myaccount.google.com den Zugriff entziehen und sie danach neu verbinden.',
    user:
      'Google hat kein dauerhaftes Zugriffsrecht mitgeschickt. Entzieh der App unter ' +
      'myaccount.google.com den Zugriff und verbinde sie danach neu.'
  },
  abgelaufen: {
    agent:
      'Die Google-Anmeldung gilt nicht mehr. Sag dem Nutzer, er soll sich in den Einstellungen neu verbinden.',
    user: 'Die Anmeldung gilt nicht mehr. Einmal neu verbinden genügt.'
  },
  rueckleitung: {
    agent: 'Google akzeptiert die Rückleitung nicht. Der OAuth-Client muss vom Typ Desktop sein.',
    user:
      'Google akzeptiert die Rückleitung nicht. Der OAuth-Client muss vom Typ Desktop sein — ' +
      'ein Client für Web-Anwendungen führt genau zu diesem Fehler.'
  },
  'client-falsch': {
    agent: 'Client-ID oder Geheimnis stimmen nicht. Beides steht in den Einstellungen unter Konten & Standort.',
    user: 'Client-ID oder Geheimnis stimmen nicht. Beides steht weiter unten auf dieser Seite.'
  },
  abgelehnt: {
    agent: 'Die Anmeldung wurde im Browser abgelehnt.',
    user: 'Die Anmeldung wurde im Browser abgelehnt.'
  },
  berechtigung: {
    agent:
      'Für diese Aktion fehlt die Berechtigung. Sag dem Nutzer, er soll die Google-Anmeldung in ' +
      'den Einstellungen unter Verbindungen einmal erneuern — die alte Zustimmung deckt sie nicht ab.',
    user:
      'Für diese Aktion fehlt die Berechtigung. Verbinde einmal neu und lass im Zustimmungsdialog ' +
      'alle Häkchen stehen — die alte Zustimmung deckt sie nicht ab.'
  }
}

/** Fehler mit bekannter Lage — trägt den Code bis zur Formulierung durch. */
class GoogleFault extends Error {
  constructor(readonly code: GoogleFaultCode) {
    super(FAULTS[code].agent)
    this.name = 'GoogleFault'
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedClient: any = null

/** Liefert einen einsatzbereiten OAuth2-Client, meldet bei Bedarf an. */
export async function googleClient(interactive = false): Promise<any> {
  const { google } = await import('googleapis')
  const clientId = getSecret('googleOAuthClientId')
  const clientSecret = getSecret('googleOAuthClientSecret')

  if (!clientId || !clientSecret) {
    throw new GoogleFault('keine-einrichtung')
  }

  const existing = loadTokens()

  // `interactive` bedeutet ausdrücklich neu verbinden. Dafür darf der alte
  // Token beim Aufbau ignoriert werden, er wird aber noch nicht gelöscht:
  // Schließt der Nutzer den Browser oder lehnt Google ab, bleibt die bisherige
  // funktionierende Verbindung erhalten. Erst `saveTokens` ersetzt sie nach
  // einem vollständig erfolgreichen Token-Tausch.
  if (interactive || !existing?.refresh_token) {
    if (!interactive) {
      throw new GoogleFault('nicht-verbunden')
    }
    const { code, redirectUri, codeVerifier } = await awaitCallback()
    // Beim Token-Tausch muss dieselbe redirect_uri stehen wie in der
    // Anmeldeanfrage — inklusive Port. Deshalb reicht sie der Rückkanal durch.
    const oauth = new google.auth.OAuth2(clientId, clientSecret, redirectUri)
    const { tokens } = await oauth.getToken({ code, codeVerifier })
    if (!tokens.refresh_token) {
      throw new GoogleFault('kein-dauerrecht')
    }
    saveTokens(tokens as StoredTokens)
    oauth.setCredentials(tokens)
    cachedClient = oauth
    return oauth
  }

  if (cachedClient) return cachedClient

  const oauth = new google.auth.OAuth2(clientId, clientSecret, 'http://127.0.0.1')
  oauth.setCredentials(existing)

  // Erneuerte Zugangsdaten sofort sichern, sonst meldet sich die App nach
  // jedem Neustart wieder ab. Gegen den aktuellen Stand von der Platte
  // mischen statt gegen den beim Erzeugen gelesenen — sonst überschreibt ein
  // spätes Ereignis eine zwischenzeitlich neuere Anmeldung.
  oauth.on('tokens', (tokens: StoredTokens) => {
    saveTokens(mergeTokens(loadTokens() ?? existing, tokens))
  })

  cachedClient = oauth
  return oauth
}

/**
 * Ordnet einen Google-Fehler einer der bekannten Lagen zu.
 *
 * Erst am Code, den unsere eigenen Würfe mitbringen, dann an den Kürzeln, die
 * Google selbst schickt. `null` heißt: keine der bekannten Lagen — dann bleibt
 * nur der Originaltext.
 */
function classifyGoogleError(err: unknown): GoogleFaultCode | null {
  if (err instanceof GoogleFault) return err.code
  const lower = (err instanceof Error ? err.message : String(err)).toLowerCase()
  if (lower.includes('invalid_grant')) return 'abgelaufen'
  if (lower.includes('redirect_uri_mismatch')) return 'rueckleitung'
  if (lower.includes('invalid_client')) return 'client-falsch'
  if (lower.includes('access_denied')) return 'abgelehnt'
  if (lower.includes('insufficient') || lower.includes('insufficientpermissions')) {
    return 'berechtigung'
  }
  return null
}

function googleErrorText(err: unknown, leser: 'agent' | 'user'): string {
  const code = classifyGoogleError(err)
  // Eine abgelaufene Anmeldung überlebt sonst im Zwischenspeicher und macht
  // jeden folgenden Aufruf mit demselben Fehler kaputt.
  if (code === 'abgelaufen') cachedClient = null
  if (code) return FAULTS[code][leser]
  return (err instanceof Error ? err.message : String(err)).slice(0, 240)
}

/**
 * Google-Fehler sind zum Vorlesen ungeeignet und ihr häufigster Fall —
 * entzogenes Zugriffsrecht — sieht aus wie ein Programmfehler.
 *
 * Diese Fassung ist für das Sprachmodell. Was im Einstellungsfenster
 * erscheint, holt sich `googleErrorForUser`.
 */
export function friendlyGoogleError(err: unknown): string {
  return googleErrorText(err, 'agent')
}

/**
 * Dieselbe Lage, formuliert für das Einstellungsfenster.
 *
 * Der Unterschied ist nicht kosmetisch: Unter dem Knopf „Mit Google
 * verbinden" stand bis zuletzt die Anweisung an das Modell — „Sag dem Nutzer,
 * er soll in den Einstellungen eine Google-Anmeldung hinterlegen" —, gelesen
 * von jemandem, der genau dort schon steht.
 */
export function googleErrorForUser(err: unknown): string {
  return googleErrorText(err, 'user')
}

/** Startet die Anmeldung — wird aus dem Einstellungsfenster aufgerufen. */
export async function connectGoogle(): Promise<{ ok: boolean; email?: string; error?: string }> {
  cachedClient = null

  try {
    const client = await googleClient(true)
    const { google } = await import('googleapis')
    const gmail = google.gmail({ version: 'v1', auth: client })
    const profile = await gmail.users.getProfile({ userId: 'me' })
    const email = profile.data.emailAddress ?? undefined
    const stored = loadTokens()
    if (email && stored) saveTokens({ ...stored, account_email: email })
    return { ok: true, email }
  } catch (err) {
    cachedClient = null
    return { ok: false, error: googleErrorForUser(err) }
  }
}

function clearStoredTokens(): void {
  const file = tokenPath()
  if (existsSync(file)) writeFileSync(file, safeStorage.encryptString('{}'), { mode: 0o600 })
}

export function disconnectGoogle(): void {
  cachedClient = null
  clearStoredTokens()
}
