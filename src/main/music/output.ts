import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { MusicDevice, NowPlaying } from '@shared/types'
import { resourceFile } from '../resources'

const execFileAsync = promisify(execFile)

/**
 * Wo der Ton dieses Rechners herauskommt.
 *
 * Das ist der zweite Weg zum Echo Dot, und er gilt für alles, was Spotify
 * Connect nicht abdeckt — Apple Music, YouTube, ein Video im Browser. Ein
 * Lautsprecher, der einmal über Bluetooth gekoppelt wurde, ist für Windows
 * ein Ausgabegerät wie jedes andere; ihn zum Standardgerät zu machen schickt
 * alles dorthin, was dieser Rechner abspielt.
 *
 * Der Unterschied zu Spotify Connect gehört ausgesprochen, weil er im Alltag
 * spürbar ist:
 *
 * - Connect schickt nur die Musik, und zwar direkt aus Spotifys Wolke. Dieser
 *   Rechner darf danach in den Ruhezustand gehen, und James' Stimme kommt
 *   weiter aus den Kopfhörern.
 * - Der Ausgabewechsel schickt *alles* — auch James. Wer Musik über das
 *   Wohnzimmer hört, hört dort auch die Antwort auf „wie spät ist es".
 *
 * Deshalb sagt das Werkzeug beim Umschalten dazu, was passiert, statt es
 * stillschweigend zu tun.
 */

interface HelperResult {
  ok: boolean
  error?: string
}

interface ListResult extends HelperResult {
  devices?: { id: string; name: string; kind: string; isActive: boolean }[]
}

interface PlayingResult extends HelperResult {
  playing?: boolean
  empty?: boolean
  title?: string
  artist?: string
  album?: string
  app?: string
}

async function run<T extends HelperResult>(
  action: 'list' | 'set' | 'now-playing',
  args: Record<string, string> = {},
  timeoutMs = 10_000
): Promise<T> {
  const argv = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    resourceFile('audio-devices.ps1'),
    '-Action',
    action
  ]
  for (const [key, value] of Object.entries(args)) {
    argv.push(`-${key[0].toUpperCase()}${key.slice(1)}`, value)
  }

  const { stdout } = await execFileAsync('powershell.exe', argv, {
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024
  })

  const trimmed = stdout.trim()
  if (!trimmed) return { ok: false, error: 'Windows hat nichts geantwortet.' } as T
  // Dieselbe Vorsicht wie beim Fensterhelfer: Eine Antwort, die kein JSON ist,
  // ist hier kein Absturz wert. Der Rückgabetyp hat ohnehin ein Feld dafür.
  try {
    return JSON.parse(trimmed) as T
  } catch {
    return {
      ok: false,
      error: `Windows hat nicht mit JSON geantwortet: ${trimmed.slice(0, 200)}`
    } as T
  }
}

// ─────────────────────────────────────────────────────────────
// Geräte
// ─────────────────────────────────────────────────────────────

/**
 * Die Ausgabegeräte, die Windows gerade führt.
 *
 * Nur die aktiven: Ein ausgestecktes Headset und ein abgeschalteter
 * Bluetooth-Lautsprecher stehen zwar in der Registrierung, aber Musik dorthin
 * zu schicken ist kein Angebot, das man machen sollte.
 */
export async function outputs(): Promise<MusicDevice[]> {
  const result = await run<ListResult>('list')
  if (!result.ok) throw new Error(result.error ?? 'Die Ausgabegeräte ließen sich nicht auflisten.')

  return (result.devices ?? []).map((d) => ({
    id: d.id,
    name: d.name,
    kind: 'output' as const,
    type: d.kind || 'Ausgabegerät',
    active: d.isActive,
    // Windows kennt zwar eine Lautstärke pro Gerät, aber sie auszulesen
    // verlangt IAudioEndpointVolume — noch eine COM-Schnittstelle für eine
    // Zahl, die niemand erfragt. `volume` regelt ohnehin das, was gerade
    // eingestellt ist.
    volumePercent: null
  }))
}

/**
 * Das Standardgerät umstellen.
 *
 * Windows meldet ein unbekanntes Gerät als 0x80070490 — „Element nicht
 * gefunden". Das passiert im Alltag genau dann, wenn ein Bluetooth-Gerät
 * zwischen Auflisten und Umschalten eingeschlafen ist, und das ist eine
 * Auskunft, die weiterhilft. Der rohe Text aus .NET ist es nicht.
 */
export async function setOutput(id: string): Promise<void> {
  const result = await run<HelperResult>('set', { id })
  if (result.ok) return

  if (result.error?.includes('0x80070490')) {
    throw new Error(
      'Windows kennt dieses Ausgabegerät gerade nicht. Bei einem Bluetooth-Lautsprecher heißt ' +
        'das meistens, dass er eingeschlafen ist — einmal antippen und es nochmal versuchen.'
    )
  }
  throw new Error(result.error ?? 'Das Ausgabegerät ließ sich nicht umstellen.')
}

// ─────────────────────────────────────────────────────────────
// Was gerade läuft
// ─────────────────────────────────────────────────────────────

/**
 * Was auf diesem Rechner gerade spielt — egal welche App es spielt.
 *
 * Windows führt darüber selbst Buch, sobald sich eine App bei den Medientasten
 * anmeldet. Das ist die Auskunft, die auch dann stimmt, wenn die Musik gar
 * nicht von James kommt, und die einzige, die es für Apple Music überhaupt
 * gibt.
 *
 * `null` heißt: keine Auskunft. Das ist kein Fehler — auf einem Windows, auf
 * dem gerade nichts spielt, gibt es diese Sitzung schlicht nicht.
 */
export async function windowsNowPlaying(): Promise<NowPlaying | null> {
  let result: PlayingResult
  try {
    result = await run<PlayingResult>('now-playing', {}, 8000)
  } catch {
    return null
  }

  if (!result.ok || result.empty || !result.title) return null

  return {
    playing: result.playing ?? false,
    title: result.title,
    artist: result.artist ?? '',
    album: result.album ?? '',
    source: 'windows',
    device: null,
    progressMs: null,
    durationMs: null
  }
}

/**
 * Welche App die Wiedergabe gerade hält.
 *
 * Gebraucht für eine einzige Unterscheidung, die aber zählt: Läuft schon
 * Apple Music, muss ein neuer Titel nicht erst die App wecken, und die
 * Wiedergabetaste danach würde ihn pausieren statt starten.
 */
export async function playingApp(): Promise<string | null> {
  try {
    const result = await run<PlayingResult>('now-playing', {}, 8000)
    return result.ok && result.app ? result.app : null
  } catch {
    return null
  }
}
