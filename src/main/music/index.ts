import { hostname } from 'node:os'
import type { MusicDevice, MusicService, MusicStatus, NowPlaying } from '@shared/types'
import { getSettings } from '../store/settings'
import { hasSecret } from '../secrets/keystore'
import { adjustVolume, mediaKey } from '../automation/desktop'
import * as apple from './appleMusic'
import * as output from './output'
import * as spotify from './spotify'

/**
 * Die eine Stelle, an der „mach Musik an" zu etwas Konkretem wird.
 *
 * Darunter liegen drei sehr verschiedene Dinge, und die Aufgabe hier ist,
 * dass der Nutzer davon nichts merken muss:
 *
 * - `spotify.ts` kann alles fern: suchen, abspielen, auf ein anderes Gerät
 *   schieben. Der Ton geht nie über diesen Rechner.
 * - `appleMusic.ts` kann suchen und einen Titel in der App auf *diesem*
 *   Rechner aufmachen. Weiter reicht Apples Schnittstelle nicht.
 * - `output.ts` verschiebt, wo der Ton dieses Rechners herauskommt. Das ist
 *   der Weg, mit dem auch Apple Music auf einem Echo Dot landet — über
 *   Bluetooth, gröber als Connect, aber es geht ohne jede Brücke im Heimnetz.
 *
 * Was hier *nicht* passiert: raten. Passt ein Gerätename auf zwei Geräte,
 * kommt die Frage zurück statt einer Vermutung — zwei Lautsprecher mit
 * ähnlichem Namen sind der Normalfall, und im falschen Zimmer Musik anzumachen
 * fällt frühestens auf, wenn sich jemand beschwert.
 */

// ─────────────────────────────────────────────────────────────
// Was eingerichtet ist
// ─────────────────────────────────────────────────────────────

export async function musicStatus(): Promise<MusicStatus> {
  const settings = getSettings().music
  const hasClientId = hasSecret('spotifyClientId')
  const connected = spotify.spotifyConnected()

  const status: MusicStatus = {
    spotify: {
      hasClientId,
      connected,
      premium: false,
      displayName: null,
      redirectUri: spotify.redirectUri()
    },
    apple: {
      hasDeveloperKey: apple.hasDeveloperKey(),
      appInstalled: apple.appInstalled(),
      storefront: settings.appleStorefront
    },
    devices: []
  }

  if (connected) {
    try {
      const me = await spotify.profile()
      status.spotify.premium = me.premium
      status.spotify.displayName = me.displayName
    } catch (err) {
      status.spotify.error = err instanceof Error ? err.message : String(err)
    }
  }

  try {
    status.devices = await allDevices()
  } catch (err) {
    status.devicesError = err instanceof Error ? err.message : String(err)
  }

  return status
}

// ─────────────────────────────────────────────────────────────
// Geräte
// ─────────────────────────────────────────────────────────────

/**
 * Alle Ziele, auf denen Musik landen kann.
 *
 * Beide Listen zusammen, aber nicht vermischt: `kind` sagt, welcher der beiden
 * Wege gemeint ist, und daran hängt, was beim Umschalten wirklich passiert.
 *
 * Ein Fehler auf einer Seite lässt die andere stehen. Wer nicht bei Spotify
 * angemeldet ist, soll trotzdem seine Kopfhörer in der Liste finden.
 */
export async function allDevices(): Promise<MusicDevice[]> {
  const [connect, local] = await Promise.all([
    spotify.spotifyConnected()
      ? spotify.devices().catch(() => [] as MusicDevice[])
      : Promise.resolve([] as MusicDevice[]),
    output.outputs().catch(() => [] as MusicDevice[])
  ])
  return [...connect, ...local]
}

export type DeviceMatch =
  | { found: true; device: MusicDevice }
  | { found: false; ambiguous: MusicDevice[] }

/**
 * Ein Gerät über den gesprochenen Namen finden.
 *
 * Dieselbe Stufenfolge wie beim Licht: erst genau, dann enthalten, dann jedes
 * Wort irgendwo. „Echo" findet den „Echo Dot Wohnzimmer", ohne dass jemand den
 * vollen Namen sagen muss.
 *
 * Spotify-Connect-Geräte gewinnen bei Gleichstand, und das ist Absicht: Steht
 * derselbe Lautsprecher in beiden Listen — als Connect-Gerät und als
 * Bluetooth-Ausgang —, ist Connect der bessere Weg. Er lässt James' Stimme
 * dort, wo sie ist, und braucht diesen Rechner nicht.
 */
export function matchDevice(devices: MusicDevice[], spoken: string): DeviceMatch {
  const needle = spoken.toLowerCase().trim()
  if (!needle) return { found: false, ambiguous: [] }

  const byPreference = (list: MusicDevice[]): MusicDevice[] =>
    [...list].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'connect' ? -1 : 1))

  const stages: MusicDevice[][] = [
    devices.filter((d) => d.name.toLowerCase() === needle),
    devices.filter((d) => d.name.toLowerCase().includes(needle)),
    (() => {
      const words = needle.split(/\s+/).filter((w) => w.length > 2)
      if (words.length === 0) return []
      return devices.filter((d) => {
        const haystack = `${d.name} ${d.type}`.toLowerCase()
        return words.every((word) => haystack.includes(word))
      })
    })()
  ]

  for (const stage of stages) {
    if (stage.length === 0) continue
    const sorted = byPreference(stage)
    /*
     * Zwei Treffer sind nur dann mehrdeutig, wenn sie verschiedene Geräte
     * sind. Derselbe Lautsprecher einmal über Connect und einmal als
     * Bluetooth-Ausgang ist keine offene Frage, sondern zwei Wege zum selben
     * Ziel — und der erste ist der bessere.
     */
    const distinct = sorted.filter(
      (d, i) => sorted.findIndex((o) => o.name.toLowerCase() === d.name.toLowerCase()) === i
    )
    if (distinct.length > 1) return { found: false, ambiguous: distinct }
    return { found: true, device: sorted[0] }
  }

  return { found: false, ambiguous: [] }
}

// ─────────────────────────────────────────────────────────────
// Abspielen
// ─────────────────────────────────────────────────────────────

export type PlayKind = 'titel' | 'album' | 'interpret' | 'playlist'

export interface PlayRequest {
  query: string
  kind: PlayKind
  service?: MusicService
  /** Gesprochener Gerätename. Leer heißt: das eingestellte Standardgerät. */
  device?: string
  /**
   * Der Not-Aus des Werkzeuglaufs.
   *
   * Gebraucht wird er für genau eine Stelle: das Warten darauf, dass die
   * Apple-Music-App hochkommt. Das dauert kalt bis zu zwölf Sekunden, und
   * dreimal Escape muss auch dort greifen — sonst drückt James noch die
   * Wiedergabetaste, nachdem der Nutzer längst abgebrochen hat.
   */
  signal?: AbortSignal
}

export interface PlayOutcome {
  service: MusicService
  /** Was tatsächlich läuft, so wie es vorgelesen werden soll. */
  what: string
  device: string | null
  /** Gesetzt, wenn nicht der gewünschte Dienst genommen wurde. */
  switchedFrom?: MusicService
  /** Was der Nutzer wissen sollte — etwa, dass jetzt auch James dort spricht. */
  note?: string
}

const SPOTIFY_KIND: Record<PlayKind, spotify.SearchKind> = {
  titel: 'track',
  album: 'album',
  interpret: 'artist',
  playlist: 'playlist'
}

const APPLE_KIND: Record<PlayKind, apple.AppleKind> = {
  titel: 'songs',
  album: 'albums',
  interpret: 'artists',
  playlist: 'playlists'
}

/**
 * Welcher Dienst es wird.
 *
 * Der gewünschte, wenn er kann. Sonst der andere — aber nur, wenn der
 * überhaupt eingerichtet ist, und mit Vermerk, damit James es sagen kann.
 * Stillschweigend auf Apple Music auszuweichen, während der Nutzer Spotify
 * gesagt hat, ist die Sorte Hilfsbereitschaft, die niemand haben will.
 */
function pickService(wanted: MusicService | undefined): {
  service: MusicService
  switchedFrom?: MusicService
} {
  const chosen = wanted ?? getSettings().music.preferred
  const spotifyReady = spotify.spotifyConnected()
  // Apple Music braucht keinen Schlüssel, nur die App: Ohne Entwicklerzugang
  // geht die Suchseite auf, und das ist immer noch eine Wiedergabe.
  const appleReady = apple.appInstalled()

  if (chosen === 'spotify' && spotifyReady) return { service: 'spotify' }
  if (chosen === 'apple' && appleReady) return { service: 'apple' }

  if (chosen === 'spotify' && appleReady) return { service: 'apple', switchedFrom: 'spotify' }
  if (chosen === 'apple' && spotifyReady) return { service: 'spotify', switchedFrom: 'apple' }

  // Keiner von beiden ist einsatzbereit. Der gewünschte bleibt stehen, damit
  // die Fehlermeldung darunter von dem redet, den der Nutzer gemeint hat.
  return { service: chosen }
}

/**
 * Das Gerät auflösen, auf dem gespielt werden soll.
 *
 * Ohne Angabe wird das eingestellte Standardgerät genommen; steht dort auch
 * nichts, bleibt es bei dem, wo zuletzt gespielt wurde. Ein *genannter* Name,
 * der auf nichts passt, ist dagegen ein Fehler und keine stille Rückkehr zum
 * Standard: „spiel das im Wohnzimmer" darf nicht in der Küche landen.
 */
async function resolveTarget(
  spoken: string | undefined
): Promise<{ device: MusicDevice | null; ambiguous?: MusicDevice[]; missing?: string }> {
  const wanted = (spoken ?? '').trim() || getSettings().music.defaultDevice.trim()
  if (!wanted) return { device: null }

  const devices = await allDevices()
  const match = matchDevice(devices, wanted)

  if (match.found) return { device: match.device }
  if (match.ambiguous.length > 0) return { device: null, ambiguous: match.ambiguous }

  // Ein leeres Standardgerät aus den Einstellungen soll nicht bei jedem
  // Abspielen scheitern — es ist eine Voreinstellung, keine Ansage.
  if (!spoken?.trim()) return { device: null }
  return { device: null, missing: wanted }
}

export async function playMusic(request: PlayRequest): Promise<PlayOutcome> {
  const { service, switchedFrom } = pickService(request.service)
  const target = await resolveTarget(request.device)

  if (target.ambiguous) {
    throw new Error(
      `Darauf passen mehrere Geräte: ${target.ambiguous.map((d) => d.name).join(', ')}. ` +
        'Frag den Nutzer, welches gemeint ist, und ruf danach mit dem genauen Namen erneut auf.'
    )
  }
  if (target.missing) {
    const devices = await allDevices()
    throw new Error(
      `Ein Gerät namens "${target.missing}" gibt es nicht. Verfügbar sind: ` +
        `${devices.map((d) => d.name).join(', ') || 'gar keines'}. Sag das dem Nutzer.`
    )
  }

  return service === 'spotify'
    ? playViaSpotify(request, target.device, switchedFrom)
    : playViaApple(request, target.device, switchedFrom)
}

/**
 * Welches Spotify-Gerät dieser Rechner ist.
 *
 * Gebraucht, wenn der Ton über den Windows-Ausgang gehen soll: Dann muss
 * Spotify hier abspielen und nicht auf dem Fernseher, sonst hat der eben
 * umgestellte Ausgang nichts wiederzugeben.
 *
 * „Irgendein Rechner" reicht dafür nicht. In der Liste steht das Notebook aus
 * dem Nebenzimmer genauso, und Musik dorthin zu schicken macht hier nur
 * Stille. Deshalb zuerst der Rechnername, den Spotify als Gerätenamen führt,
 * dann das gerade aktive Gerät, und erst zuletzt der erste beste Rechner.
 */
async function localSpotifyDevice(): Promise<string | undefined> {
  const computers = (await spotify.devices()).filter((d) => d.type === 'Rechner')
  if (computers.length === 0) return undefined

  const host = hostname().toLowerCase()
  const byName = computers.find((d) => d.name.toLowerCase() === host)
  return (byName ?? computers.find((d) => d.active) ?? computers[0]).id
}

async function playViaSpotify(
  request: PlayRequest,
  device: MusicDevice | null,
  switchedFrom?: MusicService
): Promise<PlayOutcome> {
  if (!spotify.spotifyConnected()) {
    throw new Error(
      'Spotify ist nicht verbunden. Sag dem Nutzer, er soll sich in den Einstellungen unter ' +
        'Musik einmal anmelden — danach kannst du auch auf dem Echo Dot abspielen.'
    )
  }

  /*
   * Bei Playlists zuerst in den eigenen nachsehen.
   *
   * „Spiel meine Playlist Chill" meint die eigene, und die steht nicht im
   * Katalog — `/search` kennt nur, was öffentlich ist. Ohne diesen Vorrang lief
   * im besten Fall nichts und im schlechteren die gleichnamige Playlist eines
   * Fremden, was von außen nicht auffällt: Es spielt ja Musik.
   */
  let hit: spotify.SpotifyHit | null = null

  if (request.kind === 'playlist') {
    const own = await spotify.myPlaylists().catch(() => [])
    hit = spotify.matchPlaylist(own, request.query)
  }

  if (!hit) {
    const hits = await spotify.search(request.query, SPOTIFY_KIND[request.kind], 5)
    if (hits.length === 0) {
      throw new Error(`Bei Spotify finde ich nichts zu "${request.query}".`)
    }
    hit = hits[0]
  }

  /*
   * Ein Windows-Ausgabegerät ist bei Spotify kein Ziel, sondern zwei
   * Handgriffe: Der Ton muss auf diesem Rechner laufen (sonst hätte der
   * Ausgang nichts abzuspielen), und der Ausgang wird umgestellt. Ohne diese
   * Unterscheidung schickte „spiel das auf den Lautsprechern" die Musik an
   * Spotify Connect — und dort gibt es diesen Lautsprecher gar nicht.
   */
  let note: string | undefined
  let deviceId: string | undefined

  if (device?.kind === 'output') {
    deviceId = await localSpotifyDevice()
    /*
     * Ohne laufende Spotify-App auf diesem Rechner geht das nicht.
     *
     * Den Ausgang trotzdem umzustellen und irgendwo abzuspielen wäre die
     * schlechteste aller Antworten: Spotify spielte dann auf dem zuletzt
     * benutzten Gerät — dem Telefon, dem Fernseher —, der eben umgestellte
     * Lautsprecher bliebe still, und James meldete Erfolg. Lieber gar nichts
     * anfassen und sagen, was fehlt.
     */
    if (!deviceId) {
      throw new Error(
        `Damit der Ton über ${device.name} läuft, muss Spotify auf diesem Rechner offen sein — ` +
          'es ist aber kein Spotify hier wach. Sag dem Nutzer, dass es zwei Wege gibt: die ' +
          'Spotify-App hier aufmachen, oder direkt auf einem Connect-Gerät abspielen, dann ' +
          'braucht es diesen Rechner gar nicht.'
      )
    }
    await output.setOutput(device.id)
    note =
      'Der Ausgang dieses Rechners steht jetzt auf ' +
      `${device.name} — dort kommt ab sofort auch meine Stimme heraus.`
  } else if (device) {
    deviceId = device.id
  }

  await spotify.play(hit.uri, deviceId)

  return {
    service: 'spotify',
    what: hit.by ? `${hit.name} von ${hit.by}` : hit.name,
    device: device?.name ?? null,
    switchedFrom,
    note
  }
}

/**
 * Wie lange auf die Apple-Music-App gewartet wird.
 *
 * Kalt gestartet braucht sie auf diesem Rechner mehrere Sekunden, bis sie sich
 * bei den Medientasten anmeldet. Vorher ist nicht zu erkennen, ob sie den Titel
 * schon hat — und die Wiedergabetaste ins Leere zu drücken macht nichts an,
 * sondern pausiert im Zweifel das, was vorher lief.
 */
const APPLE_STARTUP_MS = 12_000
const APPLE_POLL_MS = 700

async function playViaApple(
  request: PlayRequest,
  device: MusicDevice | null,
  switchedFrom?: MusicService
): Promise<PlayOutcome> {
  if (!apple.appInstalled()) {
    throw new Error(
      'Auf diesem Rechner ist keine Apple-Music-App installiert. Sag dem Nutzer, dass er sie aus ' +
        'dem Microsoft Store holen kann — ohne sie gibt es für Apple Music keinen Weg, weil Apple ' +
        'keine Schnittstelle zum Fernsteuern anbietet.'
    )
  }

  let note: string | undefined

  // Bei Apple Music spielt immer dieser Rechner. Ein Connect-Gerät ist deshalb
  // kein mögliches Ziel — das gehört gesagt, nicht ignoriert.
  if (device?.kind === 'connect') {
    throw new Error(
      `${device.name} ist ein Spotify-Connect-Gerät, und Apple Music kann dorthin nicht senden — ` +
        'Apple bietet dafür keine Schnittstelle an. Sag dem Nutzer, dass es zwei Wege gibt: ' +
        'denselben Titel über Spotify abspielen, oder den Lautsprecher über Bluetooth koppeln und ' +
        'ihn dann als Ausgabegerät wählen.'
    )
  }
  if (device?.kind === 'output') {
    await output.setOutput(device.id)
    note =
      'Der Ausgang dieses Rechners steht jetzt auf ' +
      `${device.name} — dort kommt ab sofort auch meine Stimme heraus.`
  }

  let what = request.query

  if (apple.hasDeveloperKey()) {
    const hits = await apple.search(request.query, APPLE_KIND[request.kind], 5)
    if (hits.length === 0) throw new Error(`Bei Apple Music finde ich nichts zu "${request.query}".`)
    const hit = hits[0]
    what = hit.by ? `${hit.name} von ${hit.by}` : hit.name
    await apple.open(hit.url)
  } else {
    // Ohne Entwicklerschlüssel gibt es keine genaue Kennung. Die Suchseite in
    // der App ist der ehrliche Rückfall — ein Klick statt gar nichts.
    await apple.openSearch(request.query)
    return {
      service: 'apple',
      what: request.query,
      device: device?.name ?? null,
      switchedFrom,
      note:
        (note ? `${note} ` : '') +
        'Apple Music zeigt jetzt die Trefferliste. Von selbst startet nichts, weil ohne ' +
        'Entwicklerschlüssel die genaue Kennung des Titels fehlt — der steht in den Einstellungen ' +
        'unter Musik.'
    }
  }

  await nudgeApplePlay(request.signal)

  return { service: 'apple', what, device: device?.name ?? null, switchedFrom, note }
}

/**
 * Nachhelfen, falls die App den Titel geladen, aber nicht gestartet hat.
 *
 * Ein `music://`-Link bringt die App in den Vordergrund und wählt den Titel
 * aus; ob sie ihn abspielt, hängt davon ab, was vorher lief. Deshalb wird
 * gewartet, bis Windows überhaupt eine Sitzung meldet, und die Wiedergabetaste
 * nur dann gedrückt, wenn dort „pausiert" steht. Andersherum wäre die Taste
 * genau das, was die eben gestartete Musik wieder anhält.
 */
async function nudgeApplePlay(signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + APPLE_STARTUP_MS

  while (Date.now() < deadline) {
    // Dreimal Escape muss auch hier greifen. Ohne diese Zeile drückt James
    // die Wiedergabetaste, nachdem der Nutzer längst abgebrochen hat.
    if (signal?.aborted) return
    const playing = await output.windowsNowPlaying()
    if (playing?.playing) return
    if (playing) {
      await mediaKey('play')
      return
    }
    await new Promise((resolve) => setTimeout(resolve, APPLE_POLL_MS))
  }
  // Keine Sitzung in Sicht. Nichts drücken: Die App ist offen, der Titel ist
  // gewählt, und ein Tastendruck ins Leere trifft das, was sonst gerade läuft.
}

// ─────────────────────────────────────────────────────────────
// Steuern
// ─────────────────────────────────────────────────────────────

export type ControlAction =
  | 'weiter'
  | 'pause'
  | 'nächster'
  | 'vorheriger'
  | 'stopp'
  | 'shuffle_an'
  | 'shuffle_aus'
  | 'wiederholen_an'
  | 'wiederholen_aus'

/**
 * Wer die Steuerbefehle bekommt.
 *
 * Spotify, wenn dort tatsächlich gerade etwas läuft — nur dann greift die
 * Fernsteuerung auch auf einem Gerät, das gar nicht dieser Rechner ist. Sonst
 * die Medientasten von Windows: Die treffen das, was hier spielt, und das ist
 * bei Apple Music der einzige Weg.
 */
async function spotifyIsPlaying(): Promise<boolean> {
  if (!spotify.spotifyConnected()) return false
  try {
    return (await spotify.nowPlaying()) !== null
  } catch {
    return false
  }
}

export interface ControlOutcome {
  action: ControlAction
  via: 'spotify' | 'windows'
}

export async function controlMusic(action: ControlAction): Promise<ControlOutcome> {
  if (await spotifyIsPlaying()) {
    if (action === 'stopp') {
      await spotify.control('pause')
      return { action, via: 'spotify' }
    }
    await spotify.control(action)
    return { action, via: 'spotify' }
  }

  // Windows kennt kein Umschalten für Zufall und Wiederholung — das sitzt in
  // der App und ist von außen nicht erreichbar.
  if (action.startsWith('shuffle') || action.startsWith('wiederholen')) {
    throw new Error(
      'Zufallswiedergabe und Wiederholung lassen sich nur bei Spotify umschalten. Bei Apple Music ' +
        'sitzt der Schalter in der App selbst — sag das dem Nutzer.'
    )
  }

  /*
   * Die Medientaste kennt nur eine Taste für an und aus — dieselbe, die auf
   * der Tastatur zwischen Zurück und Weiter sitzt. „Weiter" und „Pause"
   * landen deshalb beide auf `play`; welches von beidem dabei herauskommt,
   * entscheidet die App und nicht James. Das ist die Grenze dieses Wegs, und
   * sie ist der Grund, warum bei Spotify der andere genommen wird.
   */
  const keys: Record<string, 'play' | 'next' | 'previous' | 'stop'> = {
    weiter: 'play',
    pause: 'play',
    stopp: 'stop',
    nächster: 'next',
    vorheriger: 'previous'
  }
  await mediaKey(keys[action])
  return { action, via: 'windows' }
}

/**
 * Lautstärke.
 *
 * Bei Spotify eine Zahl auf dem Gerät selbst — der Echo Dot wird leiser, nicht
 * dieser Rechner. Sonst die Systemlautstärke in Schritten, so wie `volume` es
 * auch sonst macht.
 */
export async function setMusicVolume(percent: number): Promise<{ via: 'spotify' | 'windows' }> {
  if (await spotifyIsPlaying()) {
    await spotify.setVolume(percent)
    return { via: 'spotify' }
  }
  // Ohne auslesbaren Istwert bleibt nur die Richtung. Ein Ziel unter fünfzig
  // heißt leiser, darüber lauter — grob, aber es tut das Erwartete.
  const steps = Math.max(1, Math.round(Math.abs(percent - 50) / 5))
  await adjustVolume(percent >= 50 ? steps : -steps)
  return { via: 'windows' }
}

// ─────────────────────────────────────────────────────────────
// Was läuft
// ─────────────────────────────────────────────────────────────

/**
 * Was gerade spielt — erst Spotify fragen, dann Windows.
 *
 * Die Reihenfolge ist nicht beliebig: Spotify weiß auch dann Bescheid, wenn
 * die Musik auf dem Echo Dot läuft und dieser Rechner gar nichts davon
 * mitbekommt. Windows weiß nur, was hier spielt — dafür weiß es das auch bei
 * Apple Music und im Browser.
 */
export async function nowPlaying(): Promise<NowPlaying | null> {
  if (spotify.spotifyConnected()) {
    try {
      const playing = await spotify.nowPlaying()
      if (playing) return playing
    } catch {
      // Kein Grund aufzugeben — Windows weiß es vielleicht.
    }
  }
  return output.windowsNowPlaying()
}

/** Nach einem Wechsel der Zugangsdaten gilt nichts Gemerktes mehr. */
export function forgetMusicCaches(): void {
  spotify.forgetProfile()
  apple.forgetDeveloperToken()
}

export { connectSpotify, disconnectSpotify } from './spotify'
export { setOutput } from './output'
