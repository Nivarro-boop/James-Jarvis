import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { getSettings, setSettings } from '../../store/settings'
import {
  allDevices,
  controlMusic,
  matchDevice,
  nowPlaying,
  playMusic,
  setMusicVolume,
  setOutput,
  type ControlAction,
  type PlayKind
} from '../../music'
import { connectSpotify, transfer } from '../../music/spotify'

/**
 * Musik hören — und zwar dort, wo man sie hören will.
 *
 * Die Werkzeuge hängen bewusst an keinem Schlüssel. Das ist der Unterschied zu
 * Smart Home, und er hat einen Grund: Ein Teil davon geht *immer*. Die
 * Ausgabegeräte von Windows aufzulisten und umzustellen braucht keine
 * Einrichtung, und die Apple-Music-App nimmt einen Link entgegen, sobald sie
 * installiert ist. Nur Spotify verlangt eine Anmeldung — und was ohne sie
 * nicht geht, sagen die Fehlermeldungen unten in ganzen Sätzen, statt dass die
 * Werkzeuge verschwinden und James auf „mach Musik an" antwortet, er könne
 * keine Musik.
 *
 * Warum das ohne Home Assistant auskommt, steht in `music/index.ts`: Spotify
 * Connect ist selbst schon die Fernbedienung, und alles andere geht über den
 * Ausgang von Windows.
 */

// ─────────────────────────────────────────────────────────────
// Abspielen
// ─────────────────────────────────────────────────────────────

const play = defineTool({
  name: 'music_play',
  group: 'music',
  description:
    'Spielt Musik ab — bei Spotify oder Apple Music, wahlweise auf einem anderen Gerät wie dem ' +
    'Echo Dot. Für "spiel was von Bowie", "mach Musik an", "leg das neue Album auf", "spiel meine ' +
    'Playlist im Wohnzimmer". Nenne device nur, wenn der Nutzer ein Gerät genannt hat.',
  schema: z.object({
    query: z
      .string()
      .describe('Wonach gesucht wird — Titel, Album, Interpret oder Playlistname, wie gesprochen.'),
    kind: z
      .enum(['titel', 'album', 'interpret', 'playlist'])
      .optional()
      .describe('Was gemeint ist. Ohne Angabe interpret, weil "spiel was von X" der Regelfall ist.'),
    service: z
      .enum(['spotify', 'apple'])
      .optional()
      .describe('Nur setzen, wenn der Nutzer einen Dienst ausdrücklich nennt.'),
    device: z
      .string()
      .optional()
      .describe('Gerätename, etwa "Echo Dot". Weglassen, wenn der Nutzer keines genannt hat.')
  }),
  spokenHint: 'Einen Moment.',
  async execute({ query, kind, service, device }, ctx) {
    const outcome = await playMusic({
      query,
      kind: (kind ?? 'interpret') as PlayKind,
      service,
      device,
      // Apple Music braucht kalt bis zu zwölf Sekunden, bis es sich meldet.
      // Der Not-Aus muss auch in dieser Wartezeit greifen.
      signal: ctx.signal
    })

    return {
      läuft: outcome.what,
      dienst: outcome.service === 'spotify' ? 'Spotify' : 'Apple Music',
      gerät: outcome.device ?? 'wo zuletzt gespielt wurde',
      ...(outcome.switchedFrom
        ? {
            hinweis_dienst:
              `${outcome.switchedFrom === 'spotify' ? 'Spotify' : 'Apple Music'} war nicht ` +
              'einsatzbereit, deshalb der andere Dienst. Sag das dazu, in einem halben Satz.'
          }
        : {}),
      ...(outcome.note ? { hinweis_gerät: outcome.note } : {}),
      hinweis:
        'Bestätige knapp — was läuft und wo. Keine Aufzählung, keine Wiederholung der Suchanfrage.'
    }
  }
}) as ToolDefinition

// ─────────────────────────────────────────────────────────────
// Steuern
// ─────────────────────────────────────────────────────────────

const control = defineTool({
  name: 'music_control',
  group: 'music',
  description:
    'Steuert die laufende Musik: pausieren, weiter, nächster Titel, zurück, Zufallswiedergabe, ' +
    'Wiederholung. Greift auch auf einem anderen Gerät, wenn dort über Spotify gespielt wird.',
  schema: z.object({
    action: z.enum([
      'weiter',
      'pause',
      'nächster',
      'vorheriger',
      'stopp',
      'shuffle_an',
      'shuffle_aus',
      'wiederholen_an',
      'wiederholen_aus'
    ])
  }),
  async execute({ action }) {
    const outcome = await controlMusic(action as ControlAction)
    return {
      erledigt: outcome.action,
      über: outcome.via === 'spotify' ? 'Spotify' : 'die Medientasten von Windows',
      hinweis: 'Bestätige in drei Worten oder sag gar nichts, wenn man es ohnehin hört.'
    }
  }
}) as ToolDefinition

const volume = defineTool({
  name: 'music_volume',
  group: 'music',
  description:
    'Setzt die Lautstärke der Musik in Prozent. Bei Spotify wird das abspielende Gerät leiser — ' +
    'also der Echo Dot selbst, nicht dieser Rechner.',
  schema: z.object({
    percent: z.number().describe('Null bis hundert.')
  }),
  async execute({ percent }) {
    const value = Math.min(100, Math.max(0, Math.round(percent)))
    const outcome = await setMusicVolume(value)
    return {
      lautstärke: `${value} Prozent`,
      ...(outcome.via === 'windows'
        ? {
            hinweis:
              'Ging über die Systemlautstärke, weil gerade nichts über Spotify läuft. Windows gibt ' +
              'den Istwert nicht heraus, der Wert ist deshalb ungefähr.'
          }
        : {})
    }
  }
}) as ToolDefinition

// ─────────────────────────────────────────────────────────────
// Geräte
// ─────────────────────────────────────────────────────────────

const list = defineTool({
  name: 'music_devices',
  group: 'music',
  description:
    'Listet die Geräte, auf denen Musik laufen kann — Spotify-Connect-Geräte wie der Echo Dot und ' +
    'die Ausgabegeräte dieses Rechners. Nutze das, wenn du den genauen Namen brauchst oder der ' +
    'Nutzer fragt, wo überhaupt gespielt werden kann.',
  schema: z.object({}),
  spokenHint: 'Ich schau nach.',
  async execute() {
    const devices = await allDevices()
    if (devices.length === 0) {
      return {
        gefunden: 0,
        hinweis:
          'Es gibt kein einziges Ziel. Bei Spotify heißt das meistens, dass die App auf keinem ' +
          'Gerät offen ist — einmal dort abspielen, danach steht es in der Liste.'
      }
    }

    return {
      gefunden: devices.length,
      geräte: devices.map((d) => ({
        name: d.name,
        art:
          d.kind === 'connect'
            ? `${d.type} über Spotify Connect`
            : `Ausgabegerät dieses Rechners (${d.type})`,
        aktiv: d.active
      })),
      hinweis:
        'Fass zusammen statt aufzuzählen, sobald es mehr als vier sind. Der Unterschied ist ' +
        'wichtig: Auf einem Connect-Gerät spielt Spotify selbst, ein Ausgabegerät bekommt alles, ' +
        'was dieser Rechner abspielt — auch meine Stimme.'
    }
  }
}) as ToolDefinition

const switchDevice = defineTool({
  name: 'music_switch_device',
  group: 'music',
  description:
    'Schiebt die Wiedergabe auf ein anderes Gerät, ohne etwas Neues zu starten. Für "mach das im ' +
    'Wohnzimmer weiter", "auf den Echo", "wieder auf die Kopfhörer".',
  schema: z.object({
    device: z.string().describe('Der Gerätename, so wie der Nutzer ihn sagt.')
  }),
  spokenHint: 'Mach ich.',
  async execute({ device }) {
    const devices = await allDevices()
    const match = matchDevice(devices, device)

    if (!match.found) {
      if (match.ambiguous.length > 0) {
        return {
          umgeschaltet: false,
          mehrdeutig: match.ambiguous.map((d) => d.name),
          hinweis:
            'Darauf passen mehrere Geräte. Frag den Nutzer, welches gemeint ist, und ruf danach ' +
            'mit dem genauen Namen erneut auf.'
        }
      }
      return {
        umgeschaltet: false,
        verfügbar: devices.map((d) => d.name),
        hinweis: `Ein Gerät namens "${device}" gibt es nicht. Nenne dem Nutzer, was es stattdessen gibt.`
      }
    }

    const target = match.device

    if (target.kind === 'connect') {
      await transfer(target.id, true)
      return {
        umgeschaltet: true,
        gerät: target.name,
        über: 'Spotify Connect',
        hinweis:
          'Die Musik läuft jetzt dort weiter. Dieser Rechner ist nicht beteiligt — meine Stimme ' +
          'bleibt, wo sie war. Bestätige in einem halben Satz.'
      }
    }

    await setOutput(target.id)
    return {
      umgeschaltet: true,
      gerät: target.name,
      über: 'das Ausgabegerät von Windows',
      hinweis:
        'Ab jetzt kommt alles von diesem Rechner dort heraus — auch meine Stimme. Sag das dazu, ' +
        'einmal und knapp.'
    }
  }
}) as ToolDefinition

// ─────────────────────────────────────────────────────────────
// Nachsehen
// ─────────────────────────────────────────────────────────────

const playing = defineTool({
  name: 'music_now_playing',
  group: 'music',
  description:
    'Sagt, was gerade läuft und wo. Für "was ist das gerade", "wie heißt das Lied", "läuft noch was".',
  schema: z.object({}),
  async execute() {
    const current = await nowPlaying()
    if (!current) {
      return {
        läuft: false,
        hinweis: 'Es spielt gerade nichts. Sag das in vier Worten.'
      }
    }

    return {
      läuft: current.playing,
      titel: current.title,
      interpret: current.artist,
      ...(current.album ? { album: current.album } : {}),
      ...(current.device ? { gerät: current.device } : {}),
      quelle: current.source === 'spotify' ? 'Spotify' : 'diesem Rechner',
      hinweis:
        'Nenne Titel und Interpret, sonst nichts. Das Album nur auf Nachfrage, das Gerät nur, ' +
        'wenn es nicht das offensichtliche ist.'
    }
  }
}) as ToolDefinition

/**
 * Ein Ziel, auf dem in Zukunft ohne Nachfrage gespielt wird.
 *
 * Kein eigener Einstellungsdialog nötig — „spiel Musik immer im Wohnzimmer"
 * ist ein Satz, den man sagt, und danach soll es so sein. Die Prüfung, ob es
 * das Gerät überhaupt gibt, passiert hier und nicht erst beim nächsten
 * Abspielen: Ein Standardgerät, das auf nichts passt, wäre ein Fehler, der
 * erst Tage später auffällt.
 */
const setDefault = defineTool({
  name: 'music_set_default_device',
  group: 'music',
  description:
    'Merkt sich ein Gerät, auf dem ab sofort ohne weitere Angabe gespielt wird. Für "spiel Musik ' +
    'immer im Wohnzimmer" oder "standardmäßig auf dem Echo".',
  schema: z.object({
    device: z
      .string()
      .describe('Der Gerätename. Ein leerer Wert nimmt die Vorgabe wieder zurück.')
  }),
  async execute({ device }) {
    if (!device.trim()) {
      setSettings({ music: { ...getSettings().music, defaultDevice: '' } })
      return {
        gemerkt: false,
        hinweis: 'Ab jetzt wieder dort, wo zuletzt gespielt wurde.'
      }
    }

    const match = matchDevice(await allDevices(), device)
    if (!match.found) {
      return {
        gemerkt: false,
        ...(match.ambiguous.length > 0 ? { mehrdeutig: match.ambiguous.map((d) => d.name) } : {}),
        hinweis:
          match.ambiguous.length > 0
            ? 'Darauf passen mehrere Geräte. Frag nach, welches gemeint ist.'
            : `Ein Gerät namens "${device}" gibt es nicht — nichts gemerkt.`
      }
    }

    setSettings({ music: { ...getSettings().music, defaultDevice: match.device.name } })
    return {
      gemerkt: true,
      gerät: match.device.name,
      hinweis: 'Bestätige in einem halben Satz.'
    }
  }
}) as ToolDefinition

/**
 * Spotify verbinden, ohne in die Einstellungen zu müssen.
 *
 * Öffnet die Anmeldung im Browser und wartet, bis der Nutzer zugestimmt hat.
 */
const connect = defineTool({
  name: 'music_connect_spotify',
  group: 'music',
  description:
    'Verbindet James mit dem Spotify-Konto des Nutzers. Öffnet die Anmeldung im Browser. ' +
    'Für "verbinde Spotify" oder wenn music_play meldet, dass Spotify nicht verbunden ist.',
  schema: z.object({}),
  spokenHint: 'Ich öffne die Spotify-Anmeldung.',
  async execute() {
    const result = await connectSpotify()
    if (!result.ok) return { verbunden: false, fehler: result.error }
    return { verbunden: true, konto: result.name }
  }
}) as ToolDefinition

export const musicTools: ToolDefinition[] = [
  connect,
  play,
  control,
  volume,
  list,
  switchDevice,
  playing,
  setDefault
]
