import { app, shell } from 'electron'
import { createSign } from 'node:crypto'
import { getSecret } from '../secrets/keystore'
import { getSettings } from '../store/settings'

/**
 * Apple Music — der Dienst ohne Fernbedienung.
 *
 * Was hier möglich ist und was nicht, ist keine Frage des Aufwands, sondern
 * eine Entscheidung von Apple, und sie gehört an den Anfang dieser Datei,
 * damit niemand hier nach etwas sucht, das es nicht gibt:
 *
 * **Es gibt keine Schnittstelle, die die Wiedergabe auf ein anderes Gerät
 * schiebt.** Kein Gegenstück zu Spotify Connect, kein öffentliches AirPlay,
 * keine Möglichkeit, einem Echo Dot einen Titel zuzuweisen. Die Apple-Music-API
 * kann Katalog und Bibliothek lesen; steuern kann sie nur die eigene
 * Wiedergabe im Browser über MusicKit JS, und das setzt einen Browser mit
 * Widevine/FairPlay voraus, den Electron nicht mitbringt.
 *
 * **Was geht, ist der Weg über die App auf diesem Rechner.** Die Suche über
 * die Katalog-Schnittstelle liefert die genaue Kennung eines Titels, daraus
 * wird ein `music://`-Link, und den nimmt die Apple-Music-App von Windows
 * entgegen. Der Ton kommt danach aus diesem Rechner — und wenn er auf dem Echo
 * Dot landen soll, dann über das Ausgabegerät von Windows, siehe `output.ts`.
 *
 * **Und es geht auch ohne Entwicklerschlüssel.** Ohne ihn fehlt die genaue
 * Kennung, aber ein Suchlink tut es auch: Die App macht die Trefferliste auf.
 * Das ist ein Schritt mehr für den Nutzer und immer noch besser als „geht
 * nicht" für jeden, der keinen Apple-Entwicklerzugang hat — der kostet
 * neunundneunzig Euro im Jahr, und dafür macht niemand nur Musik an.
 */

const API_BASE = 'https://api.music.apple.com/v1'

// ─────────────────────────────────────────────────────────────
// Entwickler-Token
// ─────────────────────────────────────────────────────────────

/**
 * Wie lange ein selbst ausgestellter Token gilt.
 *
 * Apple lässt bis zu sechs Monate zu. Zwölf Stunden sind trotzdem richtig:
 * Der Token wird bei Bedarf in Millisekunden neu erzeugt, ein langlebiger
 * spart also nichts und liegt nur unnötig lange gültig im Speicher.
 */
const TOKEN_TTL_SEC = 12 * 60 * 60

interface CachedToken {
  jwt: string
  expiresAt: number
}

let cached: CachedToken | null = null

function base64url(value: string | Buffer): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** Ob alle drei Teile hinterlegt sind. Einer allein nützt nichts. */
export function hasDeveloperKey(): boolean {
  return Boolean(
    getSecret('appleMusicTeamId') && getSecret('appleMusicKeyId') && getSecret('appleMusicPrivateKey')
  )
}

/** Verwirft den gemerkten Token — nach einem Wechsel der Schlüssel. */
export function forgetDeveloperToken(): void {
  cached = null
}

/**
 * Der Entwickler-Token, den die Katalog-Schnittstelle verlangt.
 *
 * Ein JWT mit ES256. Node kann das ohne fremde Bibliothek, es steckt nur eine
 * Feinheit darin: JWS erwartet die Signatur als zwei aneinandergehängte
 * Zahlen (R und S), OpenSSL liefert sie standardmäßig als DER-Struktur.
 * `dsaEncoding: 'ieee-p1363'` ist genau der Schalter dafür — ohne ihn entsteht
 * ein Token, der überall gültig aussieht und den Apple mit 401 abweist.
 */
export function developerToken(): string {
  if (cached && Date.now() < cached.expiresAt) return cached.jwt

  const teamId = getSecret('appleMusicTeamId')
  const keyId = getSecret('appleMusicKeyId')
  const privateKey = getSecret('appleMusicPrivateKey')

  if (!teamId || !keyId || !privateKey) {
    throw new Error(
      'Für Apple Music fehlt der Entwicklerschlüssel. Sag dem Nutzer, dass die Suche ohne ihn ' +
        'nicht geht — Titel aufmachen geht trotzdem.'
    )
  }

  const issuedAt = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({ iss: teamId, iat: issuedAt, exp: issuedAt + TOKEN_TTL_SEC })
  )

  let signature: string
  try {
    signature = base64url(
      createSign('SHA256')
        .update(`${header}.${payload}`)
        // Der Schlüssel kommt aus einem Textfeld: Wer ihn aus dem Editor
        // kopiert, bringt oft Windows-Zeilenenden mit, und die machen das
        // PEM für OpenSSL unlesbar.
        .sign({ key: privateKey.replace(/\r\n/g, '\n').trim(), dsaEncoding: 'ieee-p1363' })
    )
  } catch (err) {
    throw new Error(
      'Der private Schlüssel von Apple ist nicht lesbar. Es muss der komplette Inhalt der ' +
        `.p8-Datei sein, mit BEGIN- und END-Zeile. (${err instanceof Error ? err.message : String(err)})`
    )
  }

  const jwt = `${header}.${payload}.${signature}`
  // Eine Minute vor Ablauf als abgelaufen behandeln, damit kein Aufruf mitten
  // im Flug ungültig wird.
  cached = { jwt, expiresAt: Date.now() + (TOKEN_TTL_SEC - 60) * 1000 }
  return jwt
}

// ─────────────────────────────────────────────────────────────
// Suchen
// ─────────────────────────────────────────────────────────────

export type AppleKind = 'songs' | 'albums' | 'playlists' | 'artists'

export interface AppleHit {
  id: string
  name: string
  by: string
  kind: AppleKind
  /** Die öffentliche Adresse — daraus wird der Link in die App. */
  url: string
}

interface RawResource {
  id?: string
  attributes?: {
    name?: string
    artistName?: string
    curatorName?: string
    url?: string
  }
}

function storefront(): string {
  const value = getSettings().music.appleStorefront.trim().toLowerCase()
  // Zwei Buchstaben, sonst antwortet Apple mit 404 auf eine Adresse, die
  // aussieht wie ein Programmfehler.
  return /^[a-z]{2}$/.test(value) ? value : 'at'
}

export async function search(term: string, kind: AppleKind, limit = 5): Promise<AppleHit[]> {
  const token = developerToken()
  const params = new URLSearchParams({ term, types: kind, limit: String(limit) })

  let response: Response
  try {
    response = await fetch(`${API_BASE}/catalog/${storefront()}/search?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000)
    })
  } catch (err) {
    if (/abort|timeout/i.test(String(err))) {
      throw new Error('Apple Music antwortet nicht. Steht die Internetverbindung?')
    }
    throw new Error('Ich erreiche Apple Music gerade nicht.')
  }

  if (response.status === 401 || response.status === 403) {
    // Der gemerkte Token ist ab hier wertlos — ohne dieses Wegwerfen liefe
    // jeder weitere Versuch bis zu zwölf Stunden lang in denselben Fehler.
    cached = null
    throw new Error(
      'Apple weist den Entwicklerschlüssel ab. Prüf Team-ID, Key-ID und die .p8-Datei in den ' +
        'Einstellungen unter Musik — und ob der Schlüssel für MusicKit ausgestellt ist.'
    )
  }
  if (!response.ok) {
    throw new Error(`Apple Music meldet einen Fehler (${response.status}).`)
  }

  const data = (await response.json()) as {
    results?: Record<string, { data?: RawResource[] }>
  }

  return (data.results?.[kind]?.data ?? [])
    .filter((item): item is RawResource => Boolean(item?.attributes?.url))
    .map((item) => ({
      id: item.id ?? '',
      name: item.attributes?.name ?? 'Ohne Titel',
      by: item.attributes?.artistName ?? item.attributes?.curatorName ?? '',
      kind,
      url: item.attributes?.url as string
    }))
}

// ─────────────────────────────────────────────────────────────
// Aufmachen
// ─────────────────────────────────────────────────────────────

/**
 * Ob überhaupt ein Programm auf `music://` hört.
 *
 * Electron beantwortet das aus der Registrierung von Windows heraus, ohne
 * einen Unterprozess und ohne die Paketliste zu durchsuchen. Ist dort nichts
 * eingetragen, ist weder die Apple-Music-App noch iTunes installiert — dann
 * verschluckt Windows den Aufruf kommentarlos, und ein Werkzeug, das „ich hab
 * es aufgemacht" meldet, während nichts passiert ist, ist schlimmer als eines,
 * das ehrlich sagt, dass die App fehlt.
 */
export function appInstalled(): boolean {
  try {
    return app.getApplicationNameForProtocol('music://').length > 0
  } catch {
    return false
  }
}

/** Der Name, unter dem Windows die App führt — für die Anzeige. */
export function appName(): string {
  try {
    return app.getApplicationNameForProtocol('music://')
  } catch {
    return ''
  }
}

/**
 * Aus einer Webadresse den Link machen, den die App entgegennimmt.
 *
 * Nur das Schema wird getauscht. Die Webadresse würde im Browser aufgehen und
 * dort den Web-Player starten — der spielt zwar auch, aber in einem
 * Browserfenster, das niemand angefordert hat, und er meldet sich bei den
 * Medientasten von Windows nicht immer an.
 */
export function toAppLink(url: string): string {
  return url.replace(/^https?:\/\//, 'music://')
}

/** Ein Suchergebnis in der App aufmachen. */
export async function open(url: string): Promise<void> {
  await shell.openExternal(toAppLink(url))
}

/**
 * Ohne Entwicklerschlüssel: die Suchseite in der App aufmachen.
 *
 * Das ist der ehrliche Rückfall. Es spielt nichts von selbst, aber der Nutzer
 * steht vor der Trefferliste statt vor einer Fehlermeldung, und ein Klick
 * später läuft es.
 */
export async function openSearch(term: string): Promise<void> {
  await shell.openExternal(
    `music://music.apple.com/${storefront()}/search?term=${encodeURIComponent(term)}`
  )
}
