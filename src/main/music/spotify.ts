import { app, safeStorage, shell } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MusicDevice, NowPlaying } from '@shared/types'
import { getSecret } from '../secrets/keystore'
import { getSettings } from '../store/settings'

/**
 * Spotify — der Dienst, der eine Fernbedienung hat.
 *
 * Spotify Connect ist der ganze Grund, warum „spiel das auf dem Echo Dot"
 * hier ohne Home Assistant und ohne sonst eine Brücke funktioniert. Die
 * Schnittstelle kann zwei Dinge, die kein anderer Musikdienst öffentlich
 * anbietet: die Geräte auflisten, auf denen dasselbe Konto angemeldet ist,
 * und die Wiedergabe auf eines davon schieben.
 *
 * Wichtig ist, was dabei *nicht* passiert: Der Ton geht nie über diesen
 * Rechner. James sagt Spotifys Wolke, welches Gerät welchen Titel spielen
 * soll, und der Lautsprecher holt sich den Strom selbst. Deshalb spielt es
 * auch weiter, wenn dieser Rechner in den Ruhezustand geht, und deshalb ist
 * die Tonqualität nicht die einer Bluetooth-Strecke, sondern die des
 * Lautsprechers. Ein Echo Dot steht in der Liste, sobald in der Alexa-App
 * einmal ein Spotify-Konto verknüpft und dort einmal etwas abgespielt wurde.
 *
 * ── Warum die Anmeldung über PKCE läuft ──
 *
 * Der klassische Weg tauscht den Code gegen ein Geheimnis der Anwendung ein.
 * Ein solches Geheimnis, das in einem Programm auf dem Rechner des Nutzers
 * liegt, ist keines — jeder kann es herauslesen. PKCE ersetzt es durch eine
 * Zufallszahl, die pro Anmeldung neu entsteht und den Rechner nie verlässt;
 * über die Leitung geht nur ihr Hash. Spotify unterstützt das ausdrücklich
 * für genau diesen Fall, und es spart dem Nutzer ein Feld beim Einrichten.
 */

const AUTH_URL = 'https://accounts.spotify.com/authorize'
const TOKEN_URL = 'https://accounts.spotify.com/api/token'
const API_BASE = 'https://api.spotify.com/v1'

/**
 * Was James bei Spotify darf.
 *
 * Bewusst knapp gehalten und ohne `user-read-email`: Die Mailadresse wird für
 * nichts gebraucht, und ein Recht, das nicht gebraucht wird, steht trotzdem
 * im Zustimmungsdialog und muss dort erklärt werden.
 *
 * `user-read-private` sieht nach mehr aus, als es ist — es liefert den
 * Kontotyp und das Land. Beides wird gebraucht: Ohne den Kontotyp kann die
 * Oberfläche nicht sagen, dass Steuerbefehle Premium verlangen, und ohne das
 * Land liefert die Suche Titel, die im eigenen Abo gar nicht abspielbar sind.
 */
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-private',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read'
]

interface StoredTokens {
  accessToken: string
  refreshToken: string
  /** Millisekunden seit der Epoche, ab wann der Zugriffstoken nicht mehr gilt. */
  expiresAt: number
  scope: string
}

// ─────────────────────────────────────────────────────────────
// Token-Ablage
// ─────────────────────────────────────────────────────────────

function tokenPath(): string {
  const dir = join(app.getPath('userData'), 'secure')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'spotify-tokens.bin')
}

function loadTokens(): StoredTokens | null {
  const file = tokenPath()
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(safeStorage.decryptString(readFileSync(file))) as StoredTokens
    return parsed.refreshToken ? parsed : null
  } catch (err) {
    console.error('[spotify] Zugangsdaten nicht lesbar:', err)
    return null
  }
}

function saveTokens(tokens: StoredTokens): void {
  writeFileSync(tokenPath(), safeStorage.encryptString(JSON.stringify(tokens)), { mode: 0o600 })
}

export function spotifyConnected(): boolean {
  return loadTokens() !== null
}

export function disconnectSpotify(): void {
  refreshInFlight = null
  const file = tokenPath()
  if (existsSync(file)) writeFileSync(file, safeStorage.encryptString('{}'), { mode: 0o600 })
}

// ─────────────────────────────────────────────────────────────
// Anmeldung
// ─────────────────────────────────────────────────────────────

function clientId(): string {
  const id = getSecret('spotifyClientId')
  if (!id) {
    throw new Error(
      'Für Spotify ist keine Client-ID hinterlegt. Sag dem Nutzer, er soll sie in den ' +
        'Einstellungen unter Musik eintragen — sie steht im Spotify-Entwicklerbereich.'
    )
  }
  return id
}

/** Die Adresse, die im Entwicklerbereich als Rückleitung stehen muss. */
export function redirectUri(): string {
  return `http://127.0.0.1:${getSettings().music.spotifyRedirectPort}/callback`
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Text, der in die Rückseite der Anmeldung eingesetzt wird — nie als HTML. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

/**
 * Wartet auf die Weiterleitung von Spotify.
 *
 * Anders als bei Google kann der Port hier nicht vom Betriebssystem gewählt
 * werden: Spotify vergleicht die Rückleitung Zeichen für Zeichen mit der
 * hinterlegten, Port inklusive. Ein gewürfelter Port passte nie, und die
 * Anmeldung schlüge jedes Mal mit `INVALID_CLIENT: Invalid redirect URI` fehl.
 *
 * Ist der Port belegt, ist das deshalb kein Grund weiterzumachen, sondern eine
 * Auskunft: In den Einstellungen steht ein anderer, und der muss dann auch im
 * Entwicklerbereich nachgetragen werden.
 */
function awaitCallback(state: string): Promise<string> {
  const port = getSettings().music.spotifyRedirectPort

  return new Promise((resolve, reject) => {
    let settled = false
    let timeout: NodeJS.Timeout | null = null

    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      server.close()
      fn()
    }

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      // Nach der Weiterleitung holt der Browser noch das Favicon. Ohne diese
      // Prüfung gälte der zweite Aufruf als abgebrochene Anmeldung.
      if (url.pathname !== '/callback' && url.pathname !== '/') {
        res.writeHead(404).end()
        return
      }

      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')
      // Ein fremder Code aus einem anderen Fenster darf hier nicht ankommen.
      // Er beendet die Anmeldung aber auch nicht, sonst könnte jede Webseite
      // sie mit einem Aufruf dieses Ports abbrechen.
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
         <div style="text-align:center"><h2>${code ? 'Spotify verbunden' : 'Fehlgeschlagen'}</h2>
         <p style="color:#9b8fae">${code ? 'Du kannst dieses Fenster schließen.' : escapeHtml(error ?? 'Unbekannter Fehler')}</p></div></body>`
      )

      if (code) done(() => resolve(code))
      else done(() => reject(new Error(error ?? 'Die Anmeldung wurde abgebrochen.')))
    })

    server.on('error', (err: NodeJS.ErrnoException) => {
      done(() =>
        reject(
          new Error(
            err.code === 'EADDRINUSE'
              ? `Port ${port} ist belegt. Stell in den Einstellungen unter Musik einen anderen ein ` +
                'und trag ihn auch im Spotify-Entwicklerbereich als Rückleitung nach.'
              : `Der Rückkanal ließ sich nicht öffnen: ${err.message}`
          )
        )
      )
    })

    server.listen(port, '127.0.0.1')

    timeout = setTimeout(
      () => done(() => reject(new Error('Die Anmeldung hat zu lange gedauert.'))),
      5 * 60 * 1000
    )
  })
}

async function exchange(body: Record<string, string>): Promise<StoredTokens> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(15_000)
  })

  const text = await response.text()
  if (!response.ok) {
    const detail = (() => {
      try {
        const parsed = JSON.parse(text) as { error?: string; error_description?: string }
        return parsed.error_description ?? parsed.error ?? text
      } catch {
        return text
      }
    })()
    if (/redirect uri/i.test(detail)) {
      throw new Error(
        `Spotify nimmt die Rückleitung nicht an. Im Entwicklerbereich muss exakt ${redirectUri()} ` +
          'als Redirect URI stehen — mit Port und mit /callback am Ende.'
      )
    }
    if (/invalid client/i.test(detail)) {
      throw new Error('Spotify kennt diese Client-ID nicht. Prüf sie in den Einstellungen unter Musik.')
    }
    throw new Error(`Spotify lehnt die Anmeldung ab: ${detail.slice(0, 200)}`)
  }

  const data = JSON.parse(text) as {
    access_token: string
    refresh_token?: string
    expires_in: number
    scope?: string
  }

  const previous = loadTokens()
  return {
    accessToken: data.access_token,
    /*
     * Beim Erneuern schickt Spotify nicht immer einen neuen Auffrischtoken
     * mit. Fehlt er, gilt der alte weiter — ihn hier mit `undefined` zu
     * überschreiben hieße, dass die Anmeldung nach genau einer Stunde weg ist
     * und der Nutzer sich täglich neu verbindet, ohne den Grund zu sehen.
     */
    refreshToken: data.refresh_token ?? previous?.refreshToken ?? '',
    // Eine Minute Sicherheitsabstand: Ein Token, der während des Aufrufs
    // abläuft, kostet einen 401 und einen zweiten Versuch.
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    scope: data.scope ?? previous?.scope ?? SCOPES.join(' ')
  }
}

/** Startet die Anmeldung — wird aus dem Einstellungsfenster aufgerufen. */
export async function connectSpotify(): Promise<{ ok: boolean; name?: string; error?: string }> {
  try {
    const id = clientId()
    const verifier = base64url(randomBytes(64))
    const challenge = base64url(createHash('sha256').update(verifier).digest())
    const state = base64url(randomBytes(16))

    const url = new URL(AUTH_URL)
    url.searchParams.set('client_id', id)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('redirect_uri', redirectUri())
    url.searchParams.set('scope', SCOPES.join(' '))
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('state', state)

    // Erst lauschen, dann den Browser aufmachen: andersherum kann die
    // Weiterleitung auf einen Port treffen, auf dem noch niemand horcht.
    const waiting = awaitCallback(state)
    await shell.openExternal(url.toString())

    const tokens = await exchange({
      grant_type: 'authorization_code',
      code: await waiting,
      redirect_uri: redirectUri(),
      client_id: id,
      code_verifier: verifier
    })
    saveTokens(tokens)

    const me = await profile()
    return { ok: true, name: me.displayName ?? undefined }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ─────────────────────────────────────────────────────────────
// Aufrufe
// ─────────────────────────────────────────────────────────────

/**
 * Ein laufendes Erneuern, damit es nicht zweimal gleichzeitig passiert.
 *
 * `music_devices` und `music_now_playing` laufen im Gespräch dicht
 * hintereinander. Ohne diese Sperre schicken beide ihren eigenen
 * Auffrischversuch los, der zweite überschreibt das Ergebnis des ersten, und
 * einer der beiden Zugriffstoken ist ab da ungültig.
 */
let refreshInFlight: Promise<StoredTokens> | null = null

async function accessToken(): Promise<string> {
  const stored = loadTokens()
  if (!stored) {
    throw new Error(
      'Spotify ist nicht verbunden. Sag dem Nutzer, er soll sich in den Einstellungen unter ' +
        'Musik einmal bei Spotify anmelden.'
    )
  }
  if (Date.now() < stored.expiresAt) return stored.accessToken

  if (!refreshInFlight) {
    refreshInFlight = exchange({
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken,
      client_id: clientId()
    })
      .then((next) => {
        saveTokens(next)
        return next
      })
      .catch((err: unknown) => {
        // Ein zurückgezogenes Recht heilt kein zweiter Versuch. Die
        // Zugangsdaten wegzuräumen ist hier die richtige Antwort: Danach sagt
        // die Oberfläche „nicht verbunden" statt bei jedem Aufruf zu scheitern.
        if (/invalid_grant|revoked/i.test(String(err))) disconnectSpotify()
        throw err
      })
      .finally(() => {
        refreshInFlight = null
      })
  }

  return (await refreshInFlight).accessToken
}

interface SpotifyError {
  error?: { status?: number; message?: string; reason?: string }
}

/**
 * Spotifys Fehler in Sätze übersetzen, die vorgelesen etwas taugen.
 *
 * Die drei, die im Alltag wirklich vorkommen, sehen als Statuscode gleich
 * belanglos aus und verlangen völlig verschiedene Dinge: kein Gerät wach,
 * kein Premium, Recht fehlt. „HTTP 404" beantwortet keine davon.
 */
function friendlyError(status: number, body: SpotifyError): string {
  const reason = body.error?.reason ?? ''
  const message = body.error?.message ?? ''

  if (reason === 'NO_ACTIVE_DEVICE' || (status === 404 && /device/i.test(message))) {
    return (
      'Spotify hat gerade kein aktives Gerät. Sag dem Nutzer, er soll die Musik einmal auf dem ' +
      'gewünschten Gerät starten — danach steht es in der Liste und du kannst es fernsteuern.'
    )
  }
  /*
   * Nicht jeder 403 ist eine Premium-Frage.
   *
   * „Zurück" am Anfang einer Playlist und „weiter" am Ende beantwortet Spotify
   * ebenfalls mit 403, aber mit einer Einschränkung im Text. Das als „du
   * brauchst Premium" vorzulesen wäre falsch und ausgerechnet dem Nutzer
   * gegenüber, der Premium hat.
   */
  if (/restriction/i.test(message)) {
    return 'Das geht hier gerade nicht — am Anfang gibt es kein Zurück und am Ende kein Weiter.'
  }
  if (reason === 'PREMIUM_REQUIRED' || status === 403) {
    return (
      'Spotify erlaubt Fernsteuerung nur mit Premium. Suchen und nachsehen geht auch ohne, ' +
      'Abspielen und Umschalten nicht.'
    )
  }
  if (status === 401) {
    return 'Die Spotify-Anmeldung gilt nicht mehr. Sag dem Nutzer, er soll sie in den Einstellungen erneuern.'
  }
  if (status === 429) {
    return 'Spotify bremst gerade zu viele Anfragen aus. In einer Minute geht es wieder.'
  }
  return `Spotify meldet einen Fehler (${status})${message ? `: ${message}` : ''}.`
}

/** Nur zum Testen. */
export const __internals = { friendlyError }

async function call<T>(path: string, init: RequestInit = {}): Promise<T | null> {
  const token = await accessToken()

  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {})
      },
      signal: AbortSignal.timeout(10_000)
    })
  } catch (err) {
    if (/abort|timeout/i.test(String(err))) {
      throw new Error('Spotify antwortet nicht. Steht die Internetverbindung?')
    }
    throw new Error('Ich erreiche Spotify gerade nicht.')
  }

  // 204 ist der Normalfall bei allen Steuerbefehlen: erledigt, kein Rumpf.
  // 202 heißt „angenommen, das Gerät wacht gerade auf" — für den Nutzer
  // dasselbe, nur eine Sekunde später hörbar.
  if (response.status === 204 || response.status === 202) return null

  const text = await response.text()
  const body = (() => {
    try {
      return text ? (JSON.parse(text) as T & SpotifyError) : null
    } catch {
      return null
    }
  })()

  if (!response.ok) throw new Error(friendlyError(response.status, (body ?? {}) as SpotifyError))
  return body as T | null
}

// ─────────────────────────────────────────────────────────────
// Konto
// ─────────────────────────────────────────────────────────────

export interface SpotifyProfile {
  displayName: string | null
  premium: boolean
  /** Zweibuchstabiges Land — die Suche braucht es, sonst kommen Titel ohne Rechte. */
  market: string | null
}

let cachedProfile: SpotifyProfile | null = null

export async function profile(): Promise<SpotifyProfile> {
  if (cachedProfile) return cachedProfile
  const me = await call<{ display_name?: string; product?: string; country?: string }>('/me')
  cachedProfile = {
    displayName: me?.display_name ?? null,
    premium: me?.product === 'premium',
    market: me?.country ?? null
  }
  return cachedProfile
}

/** Nach Abmelden oder Neuanmelden gilt das gemerkte Konto nicht mehr. */
export function forgetProfile(): void {
  cachedProfile = null
}

// ─────────────────────────────────────────────────────────────
// Geräte
// ─────────────────────────────────────────────────────────────

interface RawDevice {
  id: string | null
  name: string
  type: string
  is_active: boolean
  volume_percent: number | null
}

/**
 * Die Geräte, auf denen dieses Konto angemeldet ist.
 *
 * Ein Gerät ohne `id` ist eine eingeschränkte Wiedergabe — manche Autoradios
 * und Fernseher melden sich so. Es lässt sich nicht ansteuern, und es in der
 * Liste zu führen hieße, dem Modell ein Ziel anzubieten, an dem jeder Versuch
 * scheitert.
 */
export async function devices(): Promise<MusicDevice[]> {
  const data = await call<{ devices?: RawDevice[] }>('/me/player/devices')
  return (data?.devices ?? [])
    .filter((d) => Boolean(d.id))
    .map((d) => ({
      id: d.id as string,
      name: d.name,
      kind: 'connect' as const,
      type: deviceType(d.type),
      active: d.is_active,
      volumePercent: d.volume_percent
    }))
}

/** Spotifys Gerätearten auf Deutsch — sie werden vorgelesen. */
function deviceType(raw: string): string {
  switch (raw.toLowerCase()) {
    case 'computer':
      return 'Rechner'
    case 'smartphone':
      return 'Telefon'
    case 'speaker':
      return 'Lautsprecher'
    case 'tv':
      return 'Fernseher'
    case 'avr':
    case 'stb':
      return 'Receiver'
    case 'castaudio':
    case 'castvideo':
      return 'Cast-Gerät'
    case 'automobile':
      return 'Auto'
    default:
      return raw
  }
}

/**
 * Die Wiedergabe auf ein anderes Gerät schieben.
 *
 * Das ist der Kern der ganzen Sache und zugleich der Grund, warum es ohne
 * Home Assistant geht: `PUT /me/player` ist genau das, was der Knopf unten
 * links in der Spotify-App macht. Danach spielt der Echo Dot, und dieser
 * Rechner ist aus dem Spiel.
 */
export async function transfer(deviceId: string, play = true): Promise<void> {
  await call('/me/player', {
    method: 'PUT',
    body: JSON.stringify({ device_ids: [deviceId], play })
  })
}

// ─────────────────────────────────────────────────────────────
// Suchen
// ─────────────────────────────────────────────────────────────

export type SearchKind = 'track' | 'album' | 'artist' | 'playlist'

export interface SpotifyHit {
  /** `spotify:track:…` — das, was zum Abspielen gebraucht wird. */
  uri: string
  name: string
  /** Bei Titeln und Alben die Interpreten, bei Playlists der Ersteller. */
  by: string
  kind: SearchKind
}

interface RawItem {
  uri?: string
  name?: string
  artists?: { name?: string }[]
  owner?: { display_name?: string }
}

/**
 * Die eigenen Playlists.
 *
 * ── Warum die Suche dafür nicht reicht ──
 *
 * `/search` durchsucht ausschließlich den öffentlichen Katalog. Die eigenen
 * Playlists stehen dort nicht — private schon gar nicht, aber auch die
 * öffentlichen nur, wenn sie jemand anderes gefunden hätte. „Spiel meine
 * Playlist Chill" traf damit im besten Fall nichts und im schlechteren die
 * gleichnamige Playlist eines Fremden, was von außen nicht zu unterscheiden
 * ist: Es läuft ja Musik.
 *
 * Das Recht dafür wird ohnehin schon angefragt (`playlist-read-private`), es
 * wurde nur nie benutzt. Ein angefordertes und ungenutztes Recht ist die
 * schlechteste Kombination — es steht im Zustimmungsdialog und bringt nichts.
 *
 * Fünfzig Einträge, eine Seite. Wer mehr hat, findet die restlichen über die
 * gewöhnliche Suche; durch mehrere Seiten zu blättern kostet Zeit in einem
 * Gespräch, in dem gerade jemand auf Musik wartet.
 */
export async function myPlaylists(): Promise<SpotifyHit[]> {
  const data = await call<{ items?: (RawItem | null)[] }>('/me/playlists?limit=50')
  return (data?.items ?? [])
    .filter((item): item is RawItem => Boolean(item?.uri))
    .map((item) => ({
      uri: item.uri as string,
      name: item.name ?? 'Ohne Titel',
      by: item.owner?.display_name ?? '',
      kind: 'playlist' as const
    }))
}

/**
 * Unter den eigenen Playlists nach dem gesprochenen Namen suchen.
 *
 * Dieselbe Stufenfolge wie bei den Geräten: erst genau, dann enthalten. Wer
 * „Chill" sagt, meint seine „Chill Abends"-Playlist und nicht eine fremde, die
 * zufällig genauso heißt.
 */
export function matchPlaylist(playlists: SpotifyHit[], query: string): SpotifyHit | null {
  const needle = query.toLowerCase().trim()
  if (!needle) return null

  const exact = playlists.find((p) => p.name.toLowerCase() === needle)
  if (exact) return exact

  const contains = playlists.filter((p) => p.name.toLowerCase().includes(needle))
  if (contains.length === 1) return contains[0]

  // Mehrdeutig: Statt zu raten den Katalog entscheiden lassen — dort gewinnt
  // die Relevanzsortierung von Spotify, und die ist besser als ein Münzwurf.
  if (contains.length > 1) {
    // Die kürzeste passt am ehesten: "Chill" trifft eher "Chill" als
    // "Chill Abends Winter 2024".
    return [...contains].sort((a, b) => a.name.length - b.name.length)[0]
  }

  const words = needle.split(/\s+/).filter((w) => w.length > 2)
  if (words.length === 0) return null
  return (
    playlists.find((p) => {
      const haystack = p.name.toLowerCase()
      return words.every((word) => haystack.includes(word))
    }) ?? null
  )
}

export async function search(query: string, kind: SearchKind, limit = 5): Promise<SpotifyHit[]> {
  const market = (await profile().catch(() => null))?.market
  const params = new URLSearchParams({ q: query, type: kind, limit: String(limit) })
  if (market) params.set('market', market)

  const data = await call<Record<string, { items?: (RawItem | null)[] }>>(`/search?${params}`)
  /*
   * Spotify schickt in den Trefferlisten gelegentlich `null` mit — bei
   * Playlists, die während der Anfrage gelöscht wurden, ist das der Regelfall.
   * Ohne diesen Filter wirft die Zuordnung darunter auf `item.uri`, und aus
   * einer Suche mit vier brauchbaren Treffern wird eine Fehlermeldung.
   */
  const items = (data?.[`${kind}s`]?.items ?? []).filter((i): i is RawItem => Boolean(i?.uri))

  return items.map((item) => ({
    uri: item.uri as string,
    name: item.name ?? 'Ohne Titel',
    by:
      item.artists?.map((a) => a.name).filter(Boolean).join(', ') ??
      item.owner?.display_name ??
      '',
    kind
  }))
}

// ─────────────────────────────────────────────────────────────
// Abspielen und steuern
// ─────────────────────────────────────────────────────────────

/**
 * Etwas abspielen, wahlweise auf einem bestimmten Gerät.
 *
 * Ein einzelner Titel geht als `uris`, alles andere als `context_uri` — ein
 * Album als `uris` spielte nur dessen ersten Titel, und bei einem Interpreten
 * gäbe es gar nichts abzuspielen. Der Unterschied steckt in der URI selbst,
 * deshalb entscheidet er sich hier und nicht beim Aufrufer.
 */
export async function play(uri: string, deviceId?: string): Promise<void> {
  const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : ''
  const body = uri.startsWith('spotify:track:') ? { uris: [uri] } : { context_uri: uri }
  await call(`/me/player/play${query}`, { method: 'PUT', body: JSON.stringify(body) })
}

export type Control =
  | 'weiter'
  | 'pause'
  | 'nächster'
  | 'vorheriger'
  | 'shuffle_an'
  | 'shuffle_aus'
  | 'wiederholen_an'
  | 'wiederholen_aus'

export async function control(action: Control, deviceId?: string): Promise<void> {
  const device = deviceId ? `device_id=${encodeURIComponent(deviceId)}` : ''
  const q = (extra = ''): string => {
    const parts = [device, extra].filter(Boolean)
    return parts.length > 0 ? `?${parts.join('&')}` : ''
  }

  switch (action) {
    case 'weiter':
      await call(`/me/player/play${q()}`, { method: 'PUT' })
      return
    case 'pause':
      await call(`/me/player/pause${q()}`, { method: 'PUT' })
      return
    case 'nächster':
      await call(`/me/player/next${q()}`, { method: 'POST' })
      return
    case 'vorheriger':
      await call(`/me/player/previous${q()}`, { method: 'POST' })
      return
    case 'shuffle_an':
    case 'shuffle_aus':
      await call(`/me/player/shuffle${q(`state=${action === 'shuffle_an'}`)}`, { method: 'PUT' })
      return
    case 'wiederholen_an':
    case 'wiederholen_aus':
      await call(
        `/me/player/repeat${q(`state=${action === 'wiederholen_an' ? 'context' : 'off'}`)}`,
        { method: 'PUT' }
      )
  }
}

export async function setVolume(percent: number, deviceId?: string): Promise<void> {
  const value = Math.min(100, Math.max(0, Math.round(percent)))
  const device = deviceId ? `&device_id=${encodeURIComponent(deviceId)}` : ''
  await call(`/me/player/volume?volume_percent=${value}${device}`, { method: 'PUT' })
}

interface RawPlayback {
  is_playing?: boolean
  progress_ms?: number | null
  device?: { name?: string }
  item?: {
    name?: string
    duration_ms?: number
    artists?: { name?: string }[]
    album?: { name?: string }
  } | null
}

/**
 * Was gerade läuft — oder `null`, wenn nichts läuft.
 *
 * Spotify antwortet auf diese Frage mit 204 und leerem Rumpf, wenn nichts
 * spielt. Das ist kein Fehler, sondern die Antwort, und `call` gibt dafür
 * `null` zurück.
 */
export async function nowPlaying(): Promise<NowPlaying | null> {
  const data = await call<RawPlayback>('/me/player')
  if (!data?.item) return null

  return {
    playing: data.is_playing ?? false,
    title: data.item.name ?? '',
    artist: data.item.artists?.map((a) => a.name).filter(Boolean).join(', ') ?? '',
    album: data.item.album?.name ?? '',
    source: 'spotify',
    device: data.device?.name ?? null,
    progressMs: data.progress_ms ?? null,
    durationMs: data.item.duration_ms ?? null
  }
}
