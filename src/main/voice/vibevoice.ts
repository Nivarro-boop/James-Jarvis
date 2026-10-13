import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { VoiceServiceStatus } from '@shared/types'
import { getSettings } from '../store/settings'
import { resourceFile } from '../resources'
import { report } from '../selfheal'

/**
 * Der VibeVoice-Dienst als Kindprozess.
 *
 * Die App startet ihn, wartet auf seine Bereitmeldung und hält ihn am Leben.
 * Gesprochen wird hier nichts — den Ton holt sich der Renderer direkt über
 * einen WebSocket auf 127.0.0.1 ab. Ihn erst durch die IPC-Brücke zu schicken
 * hieße, jede Sekunde Sprache zweimal zusätzlich zu kopieren, und zwar auf
 * dem Weg zu einem Player, der ohnehin im Renderer sitzt.
 *
 * Was hier stattdessen passiert: starten, zuhören, neu starten, abräumen.
 *
 * Der Dienst ist bewusst nicht Teil der Auslieferung. Er braucht eine
 * Python-Umgebung mit PyTorch — gut drei Gigabyte, die niemand geschenkt
 * bekommen will, der bei Geminis Stimme bleibt. Fehlt sie, meldet der
 * Zustand das und die Sprachschleife bleibt bei Gemini.
 */

/** Wo die Umgebung erwartet wird, wenn in den Einstellungen nichts steht. */
function defaultRoot(): string {
  // Alles Lokale liegt gemeinsam unter ~/JamesAI. Ältere Installationen
  // haben die Stimme noch unter ~/.void-jarvis — die gilt, bis sie umzieht.
  const current = join(app.getPath('home'), 'JamesAI', 'vibevoice')
  const legacy = join(app.getPath('home'), '.void-jarvis', 'vibevoice')
  return !existsSync(current) && existsSync(legacy) ? legacy : current
}

function pythonPath(): string {
  const configured = getSettings().speech?.pythonPath?.trim()
  if (configured) return configured
  return join(defaultRoot(), 'venv', 'Scripts', 'python.exe')
}

function voicesPath(): string {
  const configured = getSettings().speech?.voicesPath?.trim()
  if (configured) return configured
  return join(defaultRoot(), 'voices')
}

type Phase = 'aus' | 'startet' | 'lädt' | 'bereit' | 'fehler'

let child: ChildProcess | null = null
let phase: Phase = 'aus'
let detail = ''
let voices: string[] = []
let port = 0
let sessionToken = ''
let restarts = 0
let stopping = false
let readyWaiters: ((ok: boolean) => void)[] = []
let starting: Promise<VoiceServiceStatus> | null = null
let activeConfig = ''

/**
 * Wie oft nach einem Absturz neu gestartet wird.
 *
 * Drei. Stürzt er öfter, liegt es nicht an einem Zufall, sondern an der
 * Einrichtung — dann immer weiter zu starten belegt nur die Grafikkarte und
 * schreibt das Protokoll voll, ohne dass es besser wird.
 */
const MAX_RESTARTS = 3

/** Wie lange auf die Bereitmeldung gewartet wird. Das Modell lädt aus dem Cache. */
const READY_TIMEOUT_MS = 180_000

export function voiceServiceStatus(): VoiceServiceStatus {
  const python = pythonPath()
  const voicesDir = voicesPath()
  return {
    phase,
    detail,
    port,
    voices,
    running: phase === 'bereit',
    sessionToken,
    // Jedes Mal frisch nachgesehen und nicht gemerkt: Wer die Umgebung
    // gerade anlegt, drückt danach auf „Dienst starten" und erwartet, dass
    // die Anzeige den neuen Stand kennt — nicht den vom Programmstart.
    requirements: {
      python: { ok: existsSync(python), path: python },
      voices: { ok: existsSync(voicesDir), path: voicesDir }
    }
  }
}

function settle(ok: boolean): void {
  const waiters = readyWaiters
  readyWaiters = []
  for (const fn of waiters) fn(ok)
}

function configKey(): string {
  const speech = getSettings().speech
  return JSON.stringify([pythonPath(), voicesPath(), speech?.port ?? 8791])
}

/** Prüft, ob die Umgebung überhaupt da ist — bevor ein Prozess startet. */
export function voiceServiceInstalled(): boolean {
  return existsSync(pythonPath()) && existsSync(voicesPath())
}

async function startVoiceServiceNow(): Promise<VoiceServiceStatus> {
  if (child && (phase === 'bereit' || phase === 'startet' || phase === 'lädt')) {
    return voiceServiceStatus()
  }

  const python = pythonPath()
  const voicesDir = voicesPath()

  // Die Pfade stehen nicht mehr im Text: Sie stehen in `requirements`, wo die
  // Anzeige sie einzeln abhaken kann. Hier bleibt der Grund, nicht der Ort.
  if (!existsSync(python)) {
    phase = 'fehler'
    detail = 'Es fehlt die Python-Umgebung mit PyTorch. Solange spricht James mit Geminis Stimme.'
    return voiceServiceStatus()
  }
  if (!existsSync(voicesDir)) {
    phase = 'fehler'
    detail = 'Es fehlen die Sprecherprofile. Solange spricht James mit Geminis Stimme.'
    return voiceServiceStatus()
  }

  const script = resourceFile('vibevoice-server.py')
  if (!existsSync(script)) {
    phase = 'fehler'
    detail = 'Das Dienstskript fehlt in der Installation.'
    return voiceServiceStatus()
  }

  const settings = getSettings().speech
  const wanted = settings?.port ?? 8791
  // Loopback allein schützt einen WebSocket nicht: Jede gewöhnliche Webseite
  // im Browser kann 127.0.0.1 ansprechen. Ein neuer, nur über IPC an unseren
  // Renderer ausgegebener Schlüssel verhindert, dass eine fremde Seite die
  // GPU mit Sprachaufträgen belegt.
  sessionToken = randomBytes(24).toString('base64url')
  activeConfig = configKey()

  stopping = false
  phase = 'startet'
  detail = 'Der Dienst wird gestartet.'

  child = spawn(
    python,
    [
      script,
      '--voices',
      voicesDir,
      '--port',
      String(wanted),
      '--voice',
      settings?.speaker || 'de-Spk0_man',
      '--token',
      sessionToken
    ],
    {
      windowsHide: true,
      env: {
        ...process.env,
        // Ohne das bricht der Dienst beim ersten Umlaut in einer Meldung ab —
        // die Windows-Konsole ist nicht auf UTF-8 eingestellt.
        PYTHONIOENCODING: 'utf-8',
        // Die Ladewarnungen von transformers sind hier hunderte Zeilen lang
        // und sagen nichts, was jemanden angeht.
        TRANSFORMERS_VERBOSITY: 'error'
      }
    }
  )
  const spawned = child

  spawned.stdout?.setEncoding('utf-8')
  spawned.stdout?.on('data', (raw: string) => {
    if (child !== spawned) return
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('{')) continue
      try {
        const msg = JSON.parse(trimmed) as { status?: string; message?: string; port?: number; voices?: string[] }
        if (msg.status === 'loading') {
          phase = 'lädt'
          detail = 'Das Sprachmodell wird geladen und läuft warm.'
        } else if (msg.status === 'ready') {
          phase = 'bereit'
          detail = ''
          port = msg.port ?? wanted
          voices = msg.voices ?? []
          restarts = 0
          settle(true)
        } else if (msg.status === 'error') {
          phase = 'fehler'
          detail = msg.message ?? 'Unbekannter Fehler im Sprachdienst.'
          settle(false)
        }
      } catch {
        // Keine Statusmeldung, sondern gewöhnliche Ausgabe.
      }
    }
  })

  spawned.stderr?.setEncoding('utf-8')
  spawned.stderr?.on('data', (raw: string) => {
    if (child !== spawned) return
    // Nur das Ende behalten: Der Ladevorgang schreibt sehr viel, und was
    // interessiert, steht immer zuletzt.
    const line = raw.trim().split('\n').pop()?.slice(0, 300)
    if (line) console.info('[stimme]', line)
  })

  spawned.on('exit', (code) => {
    // Ein hart beendeter alter Prozess kann erst auslaufen, nachdem bereits
    // ein neuer gestartet wurde. Sein spätes Exit-Ereignis darf weder den
    // neuen Verweis löschen noch dessen Status auf „aus" setzen.
    if (child !== spawned) return
    child = null
    if (stopping) {
      phase = 'aus'
      detail = ''
      return
    }
    settle(false)
    if (restarts < MAX_RESTARTS) {
      restarts += 1
      phase = 'startet'
      detail = `Der Dienst hat sich beendet (Code ${code}), Versuch ${restarts} von ${MAX_RESTARTS}.`
      // Über die Selbstheilung statt direkt: Der Neustart passiert dort, und
      // dort wird auch mitgeschrieben, wie oft — sonst hätte James auf die
      // Frage, warum die Stimme weg war, keine Antwort.
      void report({
        area: 'stimme',
        code: 'dienst-beendet',
        message: `Der Sprachdienst hat sich unerwartet beendet (Code ${code}).`,
        context: { versuch: restarts, exitCode: code }
      })
    } else {
      phase = 'fehler'
      detail =
        `Der Sprachdienst hat sich ${MAX_RESTARTS} Mal beendet. James bleibt bei Geminis Stimme. ` +
        'Ein Blick ins Protokoll zeigt, woran es liegt.'
      void report({
        area: 'stimme',
        code: 'dienst-unbrauchbar',
        message: `Der Sprachdienst hat sich ${MAX_RESTARTS} Mal hintereinander beendet.`,
        context: { exitCode: code }
      })
    }
  })

  spawned.on('error', (err) => {
    if (child !== spawned) return
    child = null
    phase = 'fehler'
    detail = `Der Dienst ließ sich nicht starten: ${err.message}`
    settle(false)
  })

  const ready = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      resolve(false)
    }, READY_TIMEOUT_MS)
    readyWaiters.push((ok) => {
      clearTimeout(timer)
      resolve(ok)
    })
  })

  // Über `voiceServiceStatus()` gelesen, nicht direkt: `phase` wird
  // ausschließlich in Rückrufen gesetzt, die der Typprüfer hier nicht sieht —
  // er hielte die Variable sonst noch für 'startet' und den Vergleich für
  // sinnlos.
  if (!ready && voiceServiceStatus().phase !== 'fehler') {
    // Ein hängender Ladevorgang darf keinen unsichtbaren Python-Prozess samt
    // GPU-Speicher zurücklassen; sonst stünde beim nächsten Versuch ein
    // zweiter daneben.
    await stopVoiceService()
    phase = 'fehler'
    detail = 'Der Dienst hat sich nicht rechtzeitig gemeldet.'
  }

  return voiceServiceStatus()
}

/**
 * Alle Startaufrufer warten auf denselben Ladevorgang.
 *
 * Beim Wechsel auf VibeVoice startet der Einstellungs-Horcher den Dienst. Die
 * Sprachsitzung fragt fast gleichzeitig ebenfalls danach. Früher bekam der
 * zweite Aufruf während `lädt` sofort einen roten Zwischenstand zurück und
 * schaltete auf Gemini um — obwohl VibeVoice wenige Sekunden später bereit
 * war. Eine gemeinsame Promise macht aus beiden Fragen denselben Start.
 */
export function startVoiceService(): Promise<VoiceServiceStatus> {
  const wantedConfig = configKey()
  if (child && phase === 'bereit' && activeConfig === wantedConfig) {
    return Promise.resolve(voiceServiceStatus())
  }
  if (starting) {
    // Während des Ladens können Port oder Pfade geändert worden sein. Nach dem
    // gemeinsamen Lauf gegen den dann aktuellen Wunsch prüfen.
    return starting.then(() => startVoiceService())
  }
  starting = (async () => {
    if (child && activeConfig !== wantedConfig) await stopVoiceService()
    return startVoiceServiceNow()
  })().finally(() => {
    starting = null
  })
  return starting
}

export async function stopVoiceService(): Promise<void> {
  stopping = true
  restarts = 0
  settle(false)
  const running = child
  child = null
  phase = 'aus'
  detail = ''
  port = 0
  sessionToken = ''
  activeConfig = ''
  if (!running) return

  running.kill()
  // Ein Modell auf der Grafikkarte gibt seinen Speicher erst beim Ende des
  // Prozesses frei. Endet er nicht von selbst, wird nachgeholfen — sonst
  // belegt er beim nächsten Start noch die Karte, auf die der neue wartet.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      running.kill('SIGKILL')
      resolve()
    }, 3000)
    running.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * Mit welcher Einrichtung `applyVoiceSetting` zuletzt gestartet hat.
 *
 * Hierher kommt jede Änderung irgendeiner Einstellung, auch jeder Tastendruck
 * in einem ganz anderen Textfeld. Nach einem endgültigen Fehler startete das
 * früher bei jedem Buchstaben einen neuen Python-Prozess, der drei Gigabyte
 * Modell zu laden begann. Ein neuer Anlauf kommt jetzt nur, wenn sich an der
 * Einrichtung etwas geändert hat oder der Dienst aus ist — oder über den
 * Knopf in den Einstellungen und die Selbstheilung, die direkt starten.
 */
let appliedConfig: string | null = null

/** Startet oder stoppt den Dienst passend zur Einstellung. */
export async function applyVoiceSetting(): Promise<void> {
  const speech = getSettings().speech
  if (speech?.provider === 'vibevoice') {
    const config = configKey()
    if (config === appliedConfig && phase !== 'aus') return
    appliedConfig = config
    await startVoiceService()
  } else {
    appliedConfig = null
    if (child) await stopVoiceService()
  }
}
