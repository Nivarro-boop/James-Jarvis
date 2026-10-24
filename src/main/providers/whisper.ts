import { cpus } from 'node:os'
import { existsSync } from 'node:fs'
import { WHISPER } from '@shared/config/defaults'
import type { Settings, WhisperHealth } from '@shared/types'
import { getSettings } from '../store/settings'
import { spawnManaged, waitUntil, type ManagedProcess } from '../local/service'
import { baseName, whisperDir, whisperModelPath, whisperServerExe, whisperVadPath } from '../local/paths'

/**
 * Die Ohren auf diesem Rechner.
 *
 * whisper.cpp bringt einen kleinen HTTP-Server mit, und der ist hier der ganze
 * Trick. Der naheliegende Weg wäre, für jeden Beitrag `whisper-cli.exe`
 * aufzurufen — das tun die meisten Node-Pakete so, und es ist der Grund, warum
 * sie unbrauchbar sind: Das Modell wird dabei jedes Mal von der Platte geholt,
 * bei `small` sind das knapp fünfhundert Megabyte vor dem ersten Wort. Der
 * Server lädt es einmal und behält es.
 *
 * Drei Dinge, die dieser Weg dafür selbst erledigen muss:
 *
 * 1. **Die Sprache festnageln.** Die Vorgabe des Servers ist Englisch, nicht
 *    „erkennen". Ohne `-l de` kommt auf deutsche Sprache englischer Kauderwelsch
 *    zurück, und die Spracherkennung auf fünf Sekunden ist ihr Geld nicht wert.
 *
 * 2. **Das Zeitfenster kürzen.** Der Encoder rechnet immer dreißig Sekunden,
 *    auch für einen Beitrag von zweien — die Eingabe wird schlicht mit Stille
 *    aufgefüllt. Wer das nicht kürzt, wartet für jedes „ja" so lange wie für
 *    einen Absatz. Das ist der einzige wirksame Hebel auf die Wartezeit, und er
 *    ist der Grund, warum `transcribe` die Länge des Beitrags mitbekommt.
 *
 * 3. **Die Halluzinationen abfangen.** Bei Stille erfindet Whisper Text, und
 *    auf Deutsch immer denselben: den Abspann einer Untertitelung. In den
 *    Trainingsdaten standen Untertiteldateien, und deren letzte Zeile hat das
 *    Modell auswendig gelernt. Dagegen helfen drei Stufen — Sprach­erkennung vor
 *    dem Modell, gesperrte Sonderzeichen im Modell, und eine Sperrliste danach.
 */

let proc: ManagedProcess | null = null
let starting: Promise<void> | null = null
/** Womit gestartet wurde. Ändert sich das, muss der Dienst neu aufgesetzt werden. */
let signature = ''
let lastWarmupMs: number | null = null
/** Höchstens eine Anfrage: Der Server nimmt intern ein Schloss. */
let inFlight: AbortController | null = null

function configSignature(settings: Settings): string {
  const w = settings.whisper
  return [whisperServerExe(settings), whisperModelPath(settings), w.port, threadCount(settings), w.vad, whisperVadPath(settings)].join('|')
}

/**
 * Wie viele Rechenfäden.
 *
 * Null heißt „such es dir aus", und die Wahl ist die Hälfte der logischen
 * Kerne: Node kennt nur die logische Zahl, und bei aktivem Hyperthreading ist
 * die Hälfte davon die Zahl der physischen. Mehr Fäden als physische Kerne
 * machen whisper messbar langsamer, nicht schneller.
 */
function threadCount(settings: Settings): number {
  if (settings.whisper.threads > 0) return settings.whisper.threads
  return Math.max(1, Math.min(8, Math.floor(cpus().length / 2)))
}

function baseUrl(settings: Settings): string {
  return `http://127.0.0.1:${settings.whisper.port}`
}

/**
 * Was fehlt, in einem Satz, den man beantworten kann.
 *
 * Gibt `null` zurück, wenn alles da ist. Die Reihenfolge folgt dem, was jemand
 * zuerst holen muss — den Dienst ohne Modell zu starten hilft niemandem.
 */
function missingPiece(settings: Settings): string | null {
  if (!existsSync(whisperServerExe(settings))) {
    return `whisper liegt nicht in ${whisperDir(settings)}. Hol es in den Einstellungen unter Spracherkennung.`
  }
  const model = whisperModelPath(settings)
  if (!existsSync(model)) {
    return `Das Sprachmodell ${baseName(model)} fehlt. Hol es in den Einstellungen unter Spracherkennung.`
  }
  if (settings.whisper.vad && !existsSync(whisperVadPath(settings))) {
    return `Die Spracherkennung ${baseName(whisperVadPath(settings))} fehlt. Ohne sie erfindet whisper bei Stille Sätze.`
  }
  return null
}

async function healthy(settings: Settings): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl(settings)}/health`, {
      signal: AbortSignal.timeout(2000)
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Den Dienst hochfahren, wenn er nicht schon läuft.
 *
 * Wirft mit einem lesbaren Satz, wenn etwas fehlt — der Aufrufer reicht ihn
 * unverändert an die Oberfläche weiter.
 */
async function ensureServer(): Promise<void> {
  const settings = getSettings()
  const wanted = configSignature(settings)

  // Ein Dienst, der mit anderen Einstellungen läuft, ist der falsche Dienst.
  // Das betrifft vor allem den Modellwechsel: Der Server tauscht ein Modell nur
  // auf ausdrückliche Anweisung, sonst spricht man weiter mit dem alten.
  if (proc && signature !== wanted) {
    proc.stop()
    proc = null
    starting = null
  }

  if (proc && (await healthy(settings))) return
  if (starting) return starting

  const missing = missingPiece(settings)
  if (missing) throw new Error(missing)

  starting = (async () => {
    const args = [
      '-m', whisperModelPath(settings),
      '--host', '127.0.0.1',
      '--port', String(settings.whisper.port),
      '-t', String(threadCount(settings)),
      // Ein Prozessor: Die Aufteilung zerteilt das Audio und lohnt erst bei
      // langen Dateien. Bei fünf Sekunden kostet sie nur Verwaltung.
      '-p', '1',
      '-l', 'de',
      // Keine Zeitmarken — und das ist kein Sparen, sondern eine Reparatur:
      // Mit Zeitmarken bricht der Server den Text nach sechzig Zeichen um und
      // liefert Sätze mit Zeilenumbrüchen mitten im Wort.
      '-nt',
      // Nicht-Sprach-Zeichen sperren, damit "[BLANK_AUDIO]" und "(Musik)" gar
      // nicht erst entstehen können.
      '-sns'
    ]
    if (settings.whisper.vad) {
      args.push('--vad', '-vm', whisperVadPath(settings))
    }

    let died: string | null = null
    proc = spawnManaged({
      name: 'whisper',
      file: whisperServerExe(settings),
      args,
      cwd: whisperDir(settings),
      onExit: (code, stopping) => {
        proc = null
        starting = null
        if (!stopping) died = `whisper hat sich beendet (Code ${code}).`
      }
    })
    signature = wanted

    const up = await waitUntil(() => healthy(settings), WHISPER.startupMs, 300)
    if (!up) {
      const reason =
        died ??
        `whisper antwortet nach ${Math.round(WHISPER.startupMs / 1000)} Sekunden nicht auf Port ${settings.whisper.port}.`
      proc?.stop()
      proc = null
      throw new Error(reason)
    }
  })()

  try {
    await starting
  } finally {
    starting = null
  }
}

/**
 * Wie viel vom Zeitfenster wirklich gerechnet werden muss.
 *
 * Der Encoder arbeitet auf 1500 Schritten für dreißig Sekunden. Ein Beitrag von
 * fünf Sekunden braucht davon ein Sechstel, plus einen Zuschlag für den
 * Übergang. Unter die eingestellte Untergrenze wird nicht gegangen: Dort kippt
 * die Erkennung, und eine falsche Abschrift ist teurer als eine langsame.
 *
 * Null in den Einstellungen heißt „ganzes Fenster" — dann wird das Feld gar
 * nicht erst mitgeschickt.
 */
export function audioContextFor(seconds: number, floor: number): number | null {
  if (floor <= 0) return null
  const needed = ((seconds + 0.5) / 30) * 1500 + 128
  const rounded = Math.ceil(needed / 64) * 64
  const value = Math.min(1500, Math.max(floor, rounded))
  // 1500 ist der Vorgabewert; ihn zu schicken ändert nichts und verschleiert nur.
  return value >= 1500 ? null : value
}

/**
 * Was übrig bleibt, wenn man Whisper nicht glaubt.
 *
 * Die Sperrliste greift nach den beiden Stufen im Dienst und fängt genau das
 * ab, was diese nicht können: ganze Sätze, die wie Sprache aussehen, weil sie
 * welche sind — nur eben aus dem Abspann einer fremden Untertiteldatei.
 */
export function cleanTranscript(raw: string): string {
  const text = raw.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const lower = text.toLowerCase()
  if (WHISPER.hallucinations.some((pattern) => pattern.test(lower))) return ''
  return text
}

export interface TranscribeResult {
  ok: boolean
  text: string
  ms: number
  error: string | null
}

/**
 * Einen Beitrag abtippen.
 *
 * `seconds` ist keine Beigabe: Daraus wird das Zeitfenster berechnet, und das
 * ist der Unterschied zwischen einer Antwort nach einer und nach drei Sekunden.
 *
 * Ein leerer Text ist kein Fehler. Er heißt: Da war nichts, was nach Sprache
 * klang — die Spracherkennung hat alles verworfen, oder die Sperrliste hat eine
 * Erfindung kassiert. Der Aufrufer soll dann schweigen, nicht neu versuchen.
 */
export async function transcribe(wavBase64: string, seconds: number): Promise<TranscribeResult> {
  const started = Date.now()
  try {
    await ensureServer()
  } catch (err) {
    return { ok: false, text: '', ms: Date.now() - started, error: (err as Error).message }
  }

  const settings = getSettings()

  // Eine Abschrift zur Zeit. Der Server serialisiert ohnehin — eine zweite
  // Anfrage würde also nur warten, und was sie abtippen soll, ist zu dem
  // Zeitpunkt längst überholt. Die alte wird deshalb abgebrochen, und das
  // Schließen der Verbindung beendet auch die Rechnung im Server.
  inFlight?.abort()
  const control = new AbortController()
  inFlight = control

  try {
    const audio = Buffer.from(wavBase64, 'base64')
    const form = new FormData()
    form.set('file', new Blob([audio], { type: 'audio/wav' }), 'beitrag.wav')
    form.set('language', 'de')
    form.set('response_format', 'json')
    // Ohne diese beiden läuft die Temperatur-Rückfallleiter: bis zu fünf
    // zusätzliche Durchläufe, wenn dem Modell sein eigenes Ergebnis nicht
    // gefällt. Das erklärt Ausreißer von sechs Sekunden bei sonst zweien.
    form.set('temperature', '0.0')
    form.set('temperature_inc', '-1')
    form.set('no_timestamps', 'true')
    form.set('suppress_nst', 'true')
    form.set('no_context', 'true')
    if (settings.whisper.vad) form.set('vad', 'true')

    const ctx = audioContextFor(seconds, settings.whisper.audioCtx)
    if (ctx !== null) form.set('audio_ctx', String(ctx))

    const response = await fetch(`${baseUrl(settings)}/inference`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.any([control.signal, AbortSignal.timeout(WHISPER.timeoutMs)])
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      return {
        ok: false,
        text: '',
        ms: Date.now() - started,
        error: explain(response.status, body)
      }
    }

    const payload = (await response.json()) as { text?: string }
    return {
      ok: true,
      text: cleanTranscript(payload.text ?? ''),
      ms: Date.now() - started,
      error: null
    }
  } catch (err) {
    const message = (err as Error).name === 'AbortError'
      ? 'Die Abschrift wurde von einem neueren Beitrag überholt.'
      : `whisper hat nicht geantwortet: ${(err as Error).message}`
    return { ok: false, text: '', ms: Date.now() - started, error: message }
  } finally {
    if (inFlight === control) inFlight = null
  }
}

function explain(status: number, body: string): string {
  if (body.includes('failed to read audio')) {
    return 'whisper konnte den Ton nicht lesen. Das ist ein Fehler im Format, nicht in der Aufnahme.'
  }
  if (body.includes("no 'file' field")) {
    return 'whisper hat keinen Ton in der Anfrage gefunden.'
  }
  return `whisper hat mit ${status} abgelehnt.`
}

/**
 * Eine Sekunde Stille als WAV.
 *
 * Für die Aufwärm-Anfrage: Der Server hat keine eigene dafür, und das Modell
 * beim Laden im Speicher zu haben heißt noch nicht, dass die erste Rechnung
 * schnell ist — Seitenfehler und heruntergetaktete Kerne kosten beim ersten Mal
 * spürbar. Die Antwort darauf interessiert nicht, nur die Dauer.
 */
function silenceWav(seconds = 1): string {
  const rate = 16000
  const samples = rate * seconds
  const bytes = Buffer.alloc(44 + samples * 2)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(36 + samples * 2, 4)
  bytes.write('WAVE', 8, 'ascii')
  bytes.write('fmt ', 12, 'ascii')
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(rate, 24)
  bytes.writeUInt32LE(rate * 2, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36, 'ascii')
  bytes.writeUInt32LE(samples * 2, 40)
  return bytes.toString('base64')
}

/**
 * Läuft whisper, und was kostet es hier?
 *
 * Startet den Dienst, wenn er nicht läuft, und wärmt ihn auf. Die gemessene
 * Dauer ist die einzige ehrliche Auskunft über die Wartezeit, die dieser
 * Rechner jeder Antwort hinzufügt — eine Zahl aus dem Netz hilft nicht, sie
 * hängt an der CPU, am Modell und daran, was sonst noch läuft.
 */
export async function whisperHealth(): Promise<WhisperHealth> {
  const settings = getSettings()
  const model = baseName(whisperModelPath(settings))

  try {
    await ensureServer()
  } catch (err) {
    return { ok: false, detail: (err as Error).message, model: '', warmupMs: null }
  }

  if (lastWarmupMs === null) {
    const probe = await transcribe(silenceWav(), 1)
    if (!probe.ok) {
      return { ok: false, detail: probe.error ?? 'whisper antwortet nicht.', model, warmupMs: null }
    }
    lastWarmupMs = probe.ms
  }

  const seconds = (lastWarmupMs / 1000).toFixed(1)
  return {
    ok: true,
    detail:
      `whisper läuft mit ${model} auf ${threadCount(settings)} Fäden. Eine Sekunde Ton ` +
      `dauerte beim Aufwärmen ${seconds} Sekunden — ungefähr so lange liegt zwischen ` +
      `deinem letzten Wort und dem Beginn der Antwort.`,
    model,
    warmupMs: lastWarmupMs
  }
}

/** Nach einem Modellwechsel ist die alte Messung nichts mehr wert. */
export function forgetWhisperWarmup(): void {
  lastWarmupMs = null
}
