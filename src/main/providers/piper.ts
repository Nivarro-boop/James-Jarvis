import { existsSync, readFileSync } from 'node:fs'
import { AUDIO_CONSTANTS, PIPER } from '@shared/config/defaults'
import type { PiperHealth, Settings } from '@shared/types'
import { getSettings } from '../store/settings'
import { spawnManaged, waitUntil, type ManagedProcess } from '../local/service'
import {
  baseName,
  piperDir,
  piperEspeakData,
  piperExe,
  piperHostScript,
  piperVoicePath
} from '../local/paths'
import { sendToCrystal } from '../ipc/emit'

/**
 * Der Mund auf diesem Rechner.
 *
 * piper ist unter Windows nicht ein Programm, sondern zwei, und beide sind
 * unfertig: Die eigenständige `piper.exe` stammt vom November 2023 aus einem
 * archivierten Projekt, die gepflegte Fassung gibt es nur als Python-Paket.
 * Dieses Modul hält beide hinter einer Schnittstelle. Bei `auto` wird erst die
 * .exe versucht — stirbt sie beim Laden des Modells, tritt der Python-Wirt an
 * ihre Stelle. Was am Ende wirklich läuft, steht in `PiperHealth`; geraten wird
 * nichts.
 *
 * Vier Entscheidungen tragen das Ganze:
 *
 * 1. **Ein Dauerläufer, kein Aufruf je Satz.** Beide Fassungen laden beim Start
 *    eine ONNX-Sitzung, und das kostet je nach Stimme mehrere hundert
 *    Millisekunden bis Sekunden. Wer für jeden Satz neu startet, zahlt das vor
 *    jedem Satz. Deshalb bleibt der Prozess stehen, und deshalb wird er beim
 *    Dazwischenreden ausdrücklich nicht getötet.
 *
 * 2. **Der Satz endet, wo der Strom verstummt — aber nur bei der .exe.** Ihr
 *    `--output_raw` schreibt nacktes PCM ohne jede Grenze; wo eine Äußerung
 *    aufhört, steht nirgends. Naheliegend wäre, die Zeile „Real-time factor" zu
 *    zählen, die piper nach jeder Äußerung protokolliert — das geht nicht:
 *    stdout und stderr sind zwei Röhren ohne gemeinsame Reihenfolge, die
 *    Protokollzeile kann vor dem letzten Tonblock bei uns ankommen. Übrig
 *    bleibt eine Ruhefrist: Kommt `EXE_QUIET_MS` lang nichts mehr, gilt der
 *    Satz als fertig. Das ist eine Vermutung und keine Grenze, und sie steht
 *    hier als solche. Der Python-Wirt braucht sie nicht — er rahmt seine Blöcke
 *    und meldet das Ende genau.
 *
 * 3. **Umgerechnet wird hier.** Die Stimmen liefern 22050 oder 16000 Hz, der
 *    Player läuft fest auf 24000. Die Rate steht in der `.onnx.json` neben der
 *    Stimme und wird von dort gelesen, nicht geraten. Der Rest eines Blocks
 *    wandert in den nächsten — ohne diesen Übertrag knackt es an jeder
 *    Blockgrenze, also sechzigmal in der Sekunde.
 *
 * 4. **Abgebrochen wird ohne Totschlag.** `piperAbort` wirft alles zu einer
 *    Stromnummer weg: was in der Warteschlange steht und was gerade
 *    synthetisiert wird. Der laufende Satz wird dabei zu Ende gerechnet und
 *    sein Ton verworfen, statt den Prozess zu erschlagen — bei der .exe wäre es
 *    sonst unmöglich, den nachlaufenden Ton vom ersten Satz der nächsten
 *    Antwort zu unterscheiden.
 */

/** Was piper.exe nach dem letzten Tonblock schweigen muss, damit der Satz als fertig gilt.
 *
 * Innerhalb einer Äußerung folgen die Blöcke einander in einstelligen
 * Millisekunden — der schreibende Faden läuft, während gerechnet wird. Die
 * einzige echte Lücke entsteht, wenn eine Zeile mehr als einen Satz enthält:
 * Dann phonemisiert und rechnet piper dazwischen neu. 250 ms decken das auf
 * einem warmgelaufenen Prozess ab.
 *
 * Kosten tut die Frist fast nichts: Ton geht hinaus, sobald er kommt, und
 * synthetisiert wird rund zehnmal schneller als gesprochen. Die Frist verzögert
 * also nur den Beginn des nächsten Satzes, und der liegt ohnehin lange vor dem
 * Zeitpunkt, an dem der Player ihn braucht. Hörbar wird sie erst, wenn der
 * Player leerläuft — also beim allerersten Satz einer Antwort.
 */
const EXE_QUIET_MS = 250

/**
 * So lange darf der Python-Wirt für „bereit" brauchen.
 *
 * Er importiert dabei onnxruntime und lädt das Modell von der Platte. Auf einem
 * kalten Rechner sind zehn Sekunden nicht ungewöhnlich; dreißig sind die
 * Grenze, hinter der etwas kaputt ist und nicht bloß langsam.
 */
const PYTHON_BOOT_MS = 30_000

/**
 * So lange bleibt eine abgebrochene Stromnummer in Erinnerung.
 *
 * Gebraucht für ein Wettrennen: Ein `piper:speak` kann schon auf der Leitung
 * liegen, während der Abbruch abgeschickt wird. Ohne dieses Gedächtnis würde
 * genau dieser Satz nach dem Verstummen doch noch gesprochen. Nach ein paar
 * Sekunden kann nichts mehr unterwegs sein, und die Nummer wird vergessen —
 * eine Liste, die eine Sitzung lang wächst, wäre der schlechtere Tausch.
 */
const ABORT_MEMORY_MS = 5_000

/** Was der Wirt auf stderr voranstellt, wenn ein Satz für den Nutzer bestimmt ist. */
const HOST_NOTE = 'piper-host:'

/** Der Wirt beendet sich damit, wenn das Python-Paket fehlt (PIPER.pythonPackage). */
const HOST_EXIT_PACKAGE = 3

const FRAME_MAGIC = 'PIP1'
const FRAME_HEADER = 16
const KIND_AUDIO = 0
const KIND_END = 1
const KIND_ERROR = 2
const KIND_READY = 3

type Backend = 'exe' | 'python'

/**
 * piper kann nicht.
 *
 * `fatal` heißt: auch beim nächsten Versuch nicht — es fehlt ein Stück, und
 * kein Wiederholen bringt es herbei. Der Aufrufer soll dann den Sprecher
 * wechseln, statt stumm zu bleiben. Alles andere ist vorübergehend.
 */
class PiperUnavailable extends Error {
  constructor(
    message: string,
    readonly fatal: boolean
  ) {
    super(message)
    this.name = 'PiperUnavailable'
  }
}

/** Ein Satz, der gesprochen werden soll. */
interface Task {
  id: number
  /** Zu welchem Strom er gehört. `null` heißt Aufwärmen: Ton wird verworfen. */
  stream: number | null
  text: string
}

/** Der Satz, an dem piper gerade rechnet. Höchstens einer — piper kann nur eines. */
interface Active {
  task: Task
  settle(err: Error | null): void
  /** Lebenszeichen-Frist. Läuft sie ab, hängt der Prozess. */
  guard: NodeJS.Timeout | null
  /** Die Ruhefrist der .exe. */
  quiet: NodeJS.Timeout | null
  /** Ein halbes Sample vom letzten Block (nur .exe — Rohrblöcke enden beliebig). */
  carry: number | null
}

let proc: ManagedProcess | null = null
let backend: Backend | null = null
/** Zählt die Prozesse mit, damit das Ende eines alten den neuen nicht anfasst. */
let generation = 0
/** Womit gestartet wurde. Ändert sich das, muss der Prozess neu aufgesetzt werden. */
let signature = ''
let starting: Promise<void> | null = null
/** Was die Stimme wirklich liefert, aus der `.onnx.json` gelesen. */
let sampleRate = 0
let lastWarmupMs: number | null = null
/** Bei `auto`: Die .exe hat es versucht und ist gestorben. Nicht noch einmal. */
let exeBroken = false
/** Der letzte Satz, den der Wirt für den Nutzer bestimmt hat. */
let hostNote: string | null = null
/** Der Python-Wirt hat sein Modell geladen. */
let ready = false

let active: Active | null = null
let queue: Task[] = []
let pumping = false
let nextTaskId = 1
/** Angefangene Rahmen des Wirts, die noch nicht vollständig eingetroffen sind. */
let inbox: Buffer = Buffer.alloc(0)
/** Stromnummern, die dazwischengeredet wurden. Siehe ABORT_MEMORY_MS. */
const aborted = new Set<number>()

// ─────────────────────────────────────────────────────────────
// Was da sein muss
// ─────────────────────────────────────────────────────────────

function configSignature(settings: Settings): string {
  const p = settings.piper
  return [p.backend, piperExe(settings), p.pythonPath, piperVoicePath(settings), p.lengthScale].join(
    '|'
  )
}

/**
 * Die Beschreibung neben der Stimme.
 *
 * piper legt sie als `<stimme>.onnx.json` ab, manche Sammlungen kürzen sie zu
 * `<stimme>.json`. Beide Namen werden nachgesehen, bevor gemeldet wird, sie
 * fehle — ein Fehler, der nur an einer Namenskonvention hängt, ist keiner.
 */
function voiceConfigPath(settings: Settings): string | null {
  const voice = piperVoicePath(settings)
  const beside = `${voice}.json`
  if (existsSync(beside)) return beside
  const shortened = voice.replace(/\.onnx$/i, '.json')
  return existsSync(shortened) ? shortened : null
}

/**
 * Die Abtastrate der Stimme — gelesen, nicht geraten.
 *
 * Sie ist der Wert, an dem eine falsche Annahme sofort hörbar wird: Wer 22050
 * als 24000 abspielt, bekommt eine Stimme, die zu hoch und zu schnell ist. Die
 * Zahl steht in der Beschreibung neben der Stimme, und dort wird sie geholt.
 */
function readVoiceRate(settings: Settings): number {
  const voice = piperVoicePath(settings)
  if (!existsSync(voice)) {
    throw new PiperUnavailable(
      `Die Stimme ${baseName(voice)} fehlt. Hol sie in den Einstellungen unter Stimme.`,
      true
    )
  }
  const config = voiceConfigPath(settings)
  if (!config) {
    throw new PiperUnavailable(
      `Neben ${baseName(voice)} fehlt die Beschreibung ${baseName(voice)}.json. In ihr steht ` +
        `die Abtastrate — ohne sie klänge die Stimme zu hoch oder zu tief.`,
      true
    )
  }
  try {
    const parsed = JSON.parse(readFileSync(config, 'utf-8')) as { audio?: { sample_rate?: number } }
    const rate = Number(parsed.audio?.sample_rate)
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('keine Abtastrate')
    return rate
  } catch (err) {
    throw new PiperUnavailable(
      `Die Beschreibung ${baseName(config)} ist unlesbar (${(err as Error).message}). ` +
        `Lade die Stimme in den Einstellungen unter Stimme noch einmal.`,
      true
    )
  }
}

/** Ein Versuch, piper zum Laufen zu bringen: welche Fassung, mit welchem Programm. */
interface Attempt {
  kind: Backend
  file: string
  label: string
}

/**
 * Was in welcher Reihenfolge versucht wird.
 *
 * Bei `auto` steht die .exe vorn, weil sie ein einzelnes Programm ist und
 * nichts voraussetzt, was der Nutzer selbst installieren müsste. Ist sie in
 * dieser Sitzung schon gestorben, wird sie nicht noch einmal gefragt.
 *
 * Ohne eingetragenen Python-Pfad werden zwei Namen probiert: `python` und `py`.
 * Der zweite ist der Windows-Starter und oft der einzige, der im Pfad steht —
 * `python` ist dort auf frischen Ständen nur ein Platzhalter, der den Store
 * öffnet.
 */
function attempts(settings: Settings): Attempt[] {
  const exe: Attempt = {
    kind: 'exe',
    file: piperExe(settings),
    label: 'Die eigenständige piper.exe'
  }
  const chosen = settings.piper.pythonPath.trim()
  const python: Attempt[] = (chosen ? [chosen] : ['python', 'py']).map((file) => ({
    kind: 'python' as const,
    file,
    label: `Python (${file})`
  }))

  if (settings.piper.backend === 'exe') return [exe]
  if (settings.piper.backend === 'python') return python
  return exeBroken ? python : [exe, ...python]
}

/**
 * Was diesem Versuch fehlt, in einem Satz, den man beantworten kann.
 *
 * Die Stimme wird hier nicht geprüft — das erledigt `readVoiceRate`, weil es
 * sie ohnehin lesen muss und beide Fassungen sie gleichermaßen brauchen.
 */
function missingPiece(attempt: Attempt, settings: Settings): string | null {
  if (attempt.kind === 'exe') {
    if (!existsSync(attempt.file)) {
      return `piper.exe liegt nicht in ${piperDir(settings)}. Hol es in den Einstellungen unter Stimme.`
    }
    if (!existsSync(piperEspeakData(settings))) {
      return (
        `Die Aussprachedaten espeak-ng-data fehlen neben piper.exe. Ohne sie kann piper kein ` +
        `Wort in Laute übersetzen — hol die piper-Dateien in den Einstellungen noch einmal.`
      )
    }
    return null
  }
  if (!existsSync(piperHostScript())) {
    return (
      `Der Wirt piper-host.py fehlt im Programmordner. Ohne ihn gibt es die gepflegte ` +
      `piper-Fassung nicht; nimm in den Einstellungen unter Stimme die eigenständige.`
    )
  }
  return null
}

// ─────────────────────────────────────────────────────────────
// Umrechnen auf die Rate des Players
// ─────────────────────────────────────────────────────────────

const NO_SAMPLES = new Int16Array(0)

/**
 * Lineare Interpolation auf die Rate des Players, über Blockgrenzen hinweg.
 *
 * Der ganze Aufwand steckt im Übertrag. Ein Ausgabewert liegt fast nie genau
 * auf einem Eingabewert, sondern zwischen zweien — und an der Blockgrenze
 * liegt der eine im alten Block und der andere im neuen. Wer jeden Block für
 * sich rechnet, setzt dort einen Sprung, und bei 22050 auf 24000 passiert das
 * sechzigmal in der Sekunde: ein feines, regelmäßiges Knacken, das nach einem
 * kaputten Kabel klingt.
 *
 * Gemerkt werden deshalb zwei Dinge: der letzte Wert des vorigen Blocks und die
 * Bruchstelle, an der der nächste Ausgabewert fällig ist. `t` ist diese Stelle,
 * gemessen in Eingabewerten ab dem Anfang des aktuellen Blocks; sie darf bis
 * −1 zurückreichen, und genau dafür liegt der letzte Wert von vorhin bereit.
 */
interface Resampler {
  stream: number
  push(block: Int16Array): Int16Array
}

function createResampler(from: number, to: number, stream: number): Resampler {
  const step = from / to
  let prev = 0
  let t = 0

  return {
    stream,
    push(block) {
      const n = block.length
      if (n === 0) return NO_SAMPLES
      // Eine Stimme in der Rate des Players gibt es bisher nicht, aber wenn sie
      // käme, wäre jede Rechnung hier nur Verlust.
      if (from === to) return block

      const count = t < n - 1 ? Math.ceil((n - 1 - t) / step) : 0
      const out = new Int16Array(count)
      for (let k = 0; k < count; k++) {
        const index = Math.floor(t)
        const fraction = t - index
        const left = index < 0 ? prev : block[index]
        const right = block[index + 1]
        out[k] = Math.round(left + (right - left) * fraction)
        t += step
      }

      prev = block[n - 1]
      t -= n
      return out
    }
  }
}

let resampler: Resampler | null = null

/**
 * Rohe Bytes als Sammlung von Abtastwerten.
 *
 * Ein Byte, das nicht mehr für ein ganzes Sample reicht, bleibt liegen — der
 * Aufrufer trägt es in den nächsten Block. Ohne diesen Übertrag verschiebt sich
 * alles Folgende um ein Byte, und aus Sprache wird ab dieser Stelle Rauschen.
 */
function pcmFrom(bytes: Buffer): Int16Array {
  const usable = bytes.length - (bytes.length % 2)
  if (usable <= 0) return NO_SAMPLES
  const pcm = new Int16Array(usable / 2)
  new Uint8Array(pcm.buffer).set(bytes.subarray(0, usable))
  return pcm
}

/**
 * Ein Stück Ton auf die Reise schicken — oder es wegwerfen.
 *
 * Weggeworfen wird in zwei Fällen: beim Aufwärmen, dessen Ton niemand hören
 * soll, und nach einem Abbruch. Der zweite ist der wichtige: Der laufende Satz
 * rechnet weiter, sein Ton darf aber nach dem Verstummen nicht mehr eintreffen.
 */
function deliver(pcm: Int16Array, task: Task): void {
  if (pcm.length === 0) return
  const stream = task.stream
  if (stream === null || aborted.has(stream)) return

  if (!resampler || resampler.stream !== stream) {
    resampler = createResampler(sampleRate, AUDIO_CONSTANTS.OUTPUT_SAMPLE_RATE, stream)
  }
  const out = resampler.push(pcm)
  if (out.length > 0) sendToCrystal('piper:audio', { stream, pcm: out })
}

// ─────────────────────────────────────────────────────────────
// Der laufende Satz
// ─────────────────────────────────────────────────────────────

function finishActive(err: Error | null): void {
  const current = active
  if (!current) return
  active = null
  if (current.guard) clearTimeout(current.guard)
  if (current.quiet) clearTimeout(current.quiet)
  current.settle(err)
}

/**
 * Die Frist auf ein Lebenszeichen neu stellen.
 *
 * Sie greift zweimal: vor dem ersten Ton, wenn der Prozess gar nicht antwortet,
 * und mittendrin, wenn er stehenbleibt. Bei der .exe ist ihr Ablauf mehr als
 * ein Fehler — danach ist nicht mehr zu unterscheiden, welcher Ton zu welchem
 * Satz gehört, also wird der Prozess neu aufgesetzt statt weitergefragt.
 */
function bump(current: Active): void {
  if (current.guard) clearTimeout(current.guard)
  current.guard = setTimeout(() => {
    const seconds = Math.round(PIPER.sentenceTimeoutMs / 1000)
    if (backend === 'exe') {
      stopProcess(
        `piper hat ${seconds} Sekunden lang nicht geantwortet und wurde neu aufgesetzt.`
      )
      return
    }
    finishActive(
      new PiperUnavailable(`piper hat für einen Satz länger als ${seconds} Sekunden gebraucht.`, false)
    )
  }, PIPER.sentenceTimeoutMs)
}

/** Die Ruhefrist der .exe neu stellen — siehe EXE_QUIET_MS. */
function hush(current: Active): void {
  if (current.quiet) clearTimeout(current.quiet)
  current.quiet = setTimeout(() => finishActive(null), EXE_QUIET_MS)
}

/**
 * Einen Satz hineingeben und warten, bis er heraus ist.
 *
 * Zeilenweise, weil beide Fassungen zeilenweise lesen — der Satz ist deshalb
 * vorher von Zeilenumbrüchen befreit worden. An die .exe geht nackter Text, an
 * den Wirt eine Zeile JSON mit der Auftragsnummer, an der er seine Rahmen
 * kennzeichnet.
 */
function speakOnce(task: Task): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = proc?.child
    if (!child) {
      reject(new PiperUnavailable('piper läuft nicht.', false))
      return
    }

    const current: Active = {
      task,
      settle: (err) => (err ? reject(err) : resolve()),
      guard: null,
      quiet: null,
      carry: null
    }
    active = current

    const line =
      backend === 'python'
        ? `${JSON.stringify({ id: task.id, text: task.text })}\n`
        : `${task.text}\n`

    try {
      child.stdin.write(Buffer.from(line, 'utf-8'))
    } catch (err) {
      finishActive(
        new PiperUnavailable(`piper nimmt keinen Text mehr an: ${(err as Error).message}`, false)
      )
      return
    }
    bump(current)
  })
}

/**
 * Rohes PCM von der .exe.
 *
 * Blöcke aus einer Röhre enden an beliebiger Stelle, auch mitten in einem
 * Abtastwert. Das übrige Byte wandert deshalb in den nächsten Block.
 */
function onExeBytes(chunk: Buffer): void {
  const current = active
  if (!current) return

  let bytes = chunk
  if (current.carry !== null) {
    bytes = Buffer.concat([Buffer.from([current.carry]), chunk])
    current.carry = null
  }
  if (bytes.length % 2 === 1) {
    current.carry = bytes[bytes.length - 1]
    bytes = bytes.subarray(0, bytes.length - 1)
  }

  bump(current)
  hush(current)
  deliver(pcmFrom(bytes), current.task)
}

/**
 * Gerahmtes PCM vom Python-Wirt.
 *
 * Erst zusammensetzen, dann auseinandernehmen: Ein Rahmen kann über zwei
 * Blöcke der Röhre verteilt eintreffen, und zwei Rahmen können in einem Block
 * stecken. Stimmt die Kennung nicht, ist der Strom verrutscht — dann ist jeder
 * weitere Ton geraten, und der Wirt wird neu aufgesetzt statt weiterbenutzt.
 */
function onHostBytes(chunk: Buffer): void {
  inbox = inbox.length === 0 ? chunk : Buffer.concat([inbox, chunk])

  for (;;) {
    if (inbox.length < FRAME_HEADER) return
    if (inbox.subarray(0, 4).toString('latin1') !== FRAME_MAGIC) {
      stopProcess('Der Python-Wirt hat den Tonstrom verloren und wurde neu aufgesetzt.')
      return
    }
    const id = inbox.readUInt32LE(4)
    const kind = inbox.readUInt32LE(8)
    const length = inbox.readUInt32LE(12)
    if (inbox.length < FRAME_HEADER + length) return

    const payload = inbox.subarray(FRAME_HEADER, FRAME_HEADER + length)
    inbox = inbox.subarray(FRAME_HEADER + length)
    handleFrame(id, kind, payload)
  }
}

function handleFrame(id: number, kind: number, payload: Buffer): void {
  if (kind === KIND_READY) {
    ready = true
    // Der Wirt hat das Modell geladen und weiß es besser als die Datei daneben.
    // Auseinander gehen die beiden nur, wenn jemand eine fremde Beschreibung
    // zur Stimme gelegt hat — dann ist der geladene Wert der richtige.
    try {
      const rate = Number((JSON.parse(payload.toString('utf-8')) as { rate?: number }).rate)
      if (Number.isFinite(rate) && rate > 0 && rate !== sampleRate) {
        console.info(`[piper] Der Wirt spricht mit ${rate} Hz, die Beschreibung nannte ${sampleRate}.`)
        sampleRate = rate
        resampler = null
      }
    } catch {
      // Ohne lesbare Angabe bleibt es bei dem, was neben der Stimme steht.
    }
    return
  }

  const current = active
  // Rahmen zu einem Auftrag, den wir schon aufgegeben haben — nach einer
  // abgelaufenen Frist etwa. Genau dafür trägt jeder Rahmen seine Nummer: Ohne
  // sie liefe dieser Ton in den nächsten Satz hinein.
  if (!current || current.task.id !== id) return

  if (kind === KIND_AUDIO) {
    bump(current)
    deliver(pcmFrom(payload), current.task)
    return
  }
  if (kind === KIND_END) {
    finishActive(null)
    return
  }
  if (kind === KIND_ERROR) {
    const reason = payload.toString('utf-8').trim()
    finishActive(new PiperUnavailable(reason || 'piper konnte den Satz nicht sprechen.', false))
  }
}

// ─────────────────────────────────────────────────────────────
// Der Prozess
// ─────────────────────────────────────────────────────────────

function stopProcess(reason = 'piper wurde neu aufgesetzt.'): void {
  const dying = proc
  proc = null
  backend = null
  signature = ''
  ready = false
  inbox = Buffer.alloc(0)
  resampler = null
  // Der laufende Satz muss hier enden und nicht im Abschiedsruf des Prozesses:
  // Dort wäre nicht mehr zu erkennen, ob er zu diesem oder zum nächsten
  // Prozess gehörte, und ein Versprechen, das niemand einlöst, hält die
  // Warteschlange für immer an.
  finishActive(new PiperUnavailable(reason, false))
  dying?.stop()
}

async function start(attempt: Attempt, settings: Settings): Promise<void> {
  const missing = missingPiece(attempt, settings)
  if (missing) throw new PiperUnavailable(missing, true)

  sampleRate = readVoiceRate(settings)
  resampler = null
  hostNote = null
  ready = false
  inbox = Buffer.alloc(0)

  const voice = piperVoicePath(settings)
  const args =
    attempt.kind === 'exe'
      ? exeArgs(settings, voice)
      : hostArgs(settings, voice)

  const gen = ++generation
  let gone: PiperUnavailable | null = null

  const handle = spawnManaged({
    name: 'piper',
    file: attempt.file,
    args,
    // espeak-ng-data und die DLLs sucht die .exe neben sich; ein fremdes
    // Arbeitsverzeichnis lässt sie ohne verständliche Meldung scheitern.
    cwd: attempt.kind === 'exe' ? piperDir(settings) : undefined,
    env:
      attempt.kind === 'python'
        ? {
            ...process.env,
            // Ohne diese drei liest Python seine Eingabe in der Codepage der
            // Konsole. Aus „für" wird dann „fÃ¼r" oder ein Fehler — beides
            // mitten in einem Satz, den jemand hören soll.
            PYTHONIOENCODING: 'utf-8',
            PYTHONUTF8: '1',
            PYTHONUNBUFFERED: '1'
          }
        : undefined,
    onStdout: attempt.kind === 'exe' ? onExeBytes : onHostBytes,
    onStderr: (text) => {
      for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (!line) continue
        if (line.startsWith(HOST_NOTE)) hostNote = line.slice(HOST_NOTE.length).trim()
        else console.debug('[piper]', line.slice(0, 300))
      }
    },
    onExit: (code, stopping) => {
      if (gen !== generation) return
      proc = null
      backend = null
      // Ein gewolltes Ende hat `stopProcess` schon aufgeräumt, samt Satz.
      if (stopping) return
      const reason =
        code === null
          ? `${attempt.label} ließ sich nicht starten.`
          : (hostNote ?? `piper hat sich beendet (Code ${code}).`)
      gone = new PiperUnavailable(reason, code === null || code === HOST_EXIT_PACKAGE)
      finishActive(gone)
    }
  })

  proc = handle
  backend = attempt.kind

  /**
   * Ein EPIPE auf stdin ist ein Ereignis, kein Rückgabewert.
   *
   * Stirbt der Prozess zwischen zwei Sätzen, wirft die nächste Schreibung
   * nicht — sie meldet den Fehler am Strom. Ohne Zuhörer nimmt Node das als
   * unbehandelten Fehler und reißt den Hauptprozess mit. Das Ende meldet
   * ohnehin `onExit`, hier genügt das Zuhören selbst.
   */
  handle.child.stdin.on('error', (err) => {
    console.debug('[piper] stdin:', err.message)
  })

  if (attempt.kind === 'python') {
    const up = await waitUntil(async () => ready || gone !== null, PYTHON_BOOT_MS, 100)
    if (gone) throw gone
    if (!up) {
      stopProcess('Der Python-Wirt hat sich nicht gemeldet.')
      throw new PiperUnavailable(
        `Der Python-Wirt hat sich in ${Math.round(PYTHON_BOOT_MS / 1000)} Sekunden nicht ` +
          `gemeldet. Prüfe, ob ${PIPER.pythonPackage} in ${attempt.file} installiert ist.`,
        false
      )
    }
  }

  /**
   * Der Aufwärmsatz ist zugleich die Prüfung.
   *
   * Bei `auto` ist er der einzige ehrliche Weg herauszufinden, ob die .exe auf
   * diesem Windows-Stand überhaupt ein Modell laden kann — sie stürzt dabei auf
   * manchen Ständen ab, und das steht in keiner Versionsnummer. Sein Ton wird
   * verworfen, seine Dauer nicht: Sie ist die einzige belastbare Auskunft
   * darüber, was dieser Rechner beim ersten Wort kostet.
   */
  const started = Date.now()
  await speakOnce({ id: takeTaskId(), stream: null, text: PIPER.warmupText })
  lastWarmupMs = Date.now() - started
}

function exeArgs(settings: Settings, voice: string): string[] {
  const args = [
    '--model', voice,
    '--espeak_data', piperEspeakData(settings),
    // Ausdrücklich mitgegeben statt gesucht: Bei einer Beschreibung, die nicht
    // `<stimme>.onnx.json` heißt, findet piper sie sonst nicht.
    '-c', voiceConfigPath(settings) ?? `${voice}.json`,
    '--output_raw'
    // `--sentence_silence` wird ausdrücklich nicht verstellt. piper hängt von
    // sich aus 0,2 Sekunden Stille an jeden Satz, und die sind hier keine
    // Verschwendung, sondern die einzige Lücke zwischen zwei Sätzen: Der Player
    // spielt aneinandergehängte Blöcke ohne Pause weiter, und auf null gesetzt
    // klebte das Ende jedes Satzes am Anfang des nächsten. Die Ruhefrist hilft
    // dagegen nicht — sie hält nur die Warteschlange an, sie erzeugt keinen Ton.
  ]
  // Eins heißt „die Vorgabe der Stimme", und manche Stimmen bringen dafür einen
  // anderen Wert mit. Wer die Eins durchreicht, überschreibt sie.
  if (settings.piper.lengthScale !== 1) {
    args.push('--length_scale', String(settings.piper.lengthScale))
  }
  return args
}

function hostArgs(settings: Settings, voice: string): string[] {
  const args = [piperHostScript(), '--voice', voice]
  if (settings.piper.lengthScale !== 1) {
    args.push('--length-scale', String(settings.piper.lengthScale))
  }
  return args
}

/**
 * piper hochfahren, wenn er nicht schon läuft.
 *
 * Wirft mit einem lesbaren Satz, wenn keine Fassung will — der Aufrufer reicht
 * ihn unverändert an die Oberfläche weiter oder schickt ihn als `piper:failed`
 * hinaus.
 */
async function ensureProcess(): Promise<void> {
  const settings = getSettings()
  const wanted = configSignature(settings)

  // Ein piper, der mit einer anderen Stimme läuft, ist der falsche piper. Die
  // Stimme steckt in der ONNX-Sitzung; austauschen lässt sie sich nicht.
  if (proc && signature !== wanted) stopProcess('Die Einstellungen haben sich geändert.')
  if (proc) return
  if (starting) return starting

  starting = (async () => {
    const settings = getSettings()
    const notes: string[] = []
    let allFatal = true

    for (const attempt of attempts(settings)) {
      try {
        await start(attempt, settings)
        signature = wanted
        return
      } catch (err) {
        const failure = err as Error
        notes.push(`${attempt.label}: ${failure.message}`)
        if (!(failure instanceof PiperUnavailable) || !failure.fatal) allFatal = false
        stopProcess('Dieser Versuch ist gescheitert.')
        // Bei `auto` ist der Sturz der .exe genau der Fall, für den der zweite
        // Weg gebaut wurde. Gemerkt wird er für die Sitzung, damit nicht jeder
        // Satz erneut auf den Absturz wartet.
        if (attempt.kind === 'exe' && settings.piper.backend === 'auto') exeBroken = true
      }
    }

    throw new PiperUnavailable(notes.join(' '), allFatal)
  })()

  try {
    await starting
  } finally {
    starting = null
  }
}

function takeTaskId(): number {
  // Die Null gehört dem „bereit"-Rahmen des Wirts und kommt deshalb nicht vor.
  const id = nextTaskId
  nextTaskId = nextTaskId >= 0xffffffff ? 1 : nextTaskId + 1
  return id
}

// ─────────────────────────────────────────────────────────────
// Die Warteschlange
// ─────────────────────────────────────────────────────────────

/**
 * Ein Satz nach dem anderen.
 *
 * Nebenläufig geht hier nichts, und das ist keine Bequemlichkeit: piper hält
 * eine ONNX-Sitzung und beantwortet eine Zeile nach der anderen. Zwei Sätze
 * gleichzeitig hineinzugeben hieße bei der .exe, zwei Tonströme in einer Röhre
 * zu haben, die man nicht mehr auseinandersortieren kann.
 */
async function pump(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    for (;;) {
      const job = queue.shift()
      if (!job) break
      if (job.stream !== null && aborted.has(job.stream)) continue

      try {
        await ensureProcess()
      } catch (err) {
        failStream(job.stream, err as Error)
        continue
      }
      // Während piper hochfuhr, kann längst dazwischengeredet worden sein.
      if (job.stream !== null && aborted.has(job.stream)) continue

      try {
        await speakOnce(job)
      } catch (err) {
        failStream(job.stream, err as Error)
        continue
      }
      if (job.stream !== null) maybeIdle(job.stream)
    }
  } finally {
    pumping = false
  }
}

function failStream(stream: number | null, err: Error): void {
  const reason = err.message
  const fatal = err instanceof PiperUnavailable ? err.fatal : false
  console.warn('[piper]', reason)
  if (stream === null) return
  // Was von diesem Strom noch aussteht, scheitert am selben Grund. Es
  // nacheinander abarbeiten hieße, denselben Satz mehrmals zu melden.
  queue = queue.filter((task) => task.stream !== stream)
  sendToCrystal('piper:failed', { stream, reason, fatal })
}

/**
 * Ist dieser Strom durch?
 *
 * Nach einem Abbruch geht ausdrücklich kein `piper:idle` hinaus: Der Strom hat
 * nichts zu Ende gesprochen, er wurde weggeworfen — und wer ihn abgebrochen
 * hat, weiß das ohnehin, er hat es selbst getan.
 */
function maybeIdle(stream: number): void {
  if (aborted.has(stream)) return
  if (active?.task.stream === stream) return
  if (queue.some((task) => task.stream === stream)) return
  sendToCrystal('piper:idle', { stream })
}

/** Zeilenweise gelesen wird beidseits — ein Umbruch im Satz wäre eine zweite Äußerung. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Ist da überhaupt etwas zu sprechen?
 *
 * „…" oder „?!" sind kein Satz, sondern Satzzeichen, und piper gibt darauf
 * keinen einzigen Ton zurück. Für die .exe wäre das kein harmloser Leerlauf:
 * Ohne Ton läuft die Ruhefrist nie an, und erst die Lebenszeichen-Frist beendet
 * das nach zehn Sekunden — mitsamt Neustart des Prozesses. Billiger ist, gar
 * nicht erst zu fragen.
 */
function worthSaying(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text)
}

// ─────────────────────────────────────────────────────────────
// Was Phase 2 aufruft
// ─────────────────────────────────────────────────────────────

/**
 * Einen fertigen Satz sprechen lassen.
 *
 * Kehrt sofort zurück; gesprochen wird in der Warteschlange. Fehler kommen
 * deshalb nicht als Ausnahme zurück, sondern als `piper:failed` mit derselben
 * Stromnummer — der Aufrufer wartet an dieser Stelle nicht.
 */
export function piperSpeak(stream: number, text: string): void {
  const line = oneLine(text)
  if (!worthSaying(line)) {
    // Nichts zu sagen. Trotzdem muss der Strom zu Ende gehen, sonst wartet der
    // Empfänger auf ein `piper:idle`, das nie kommt.
    maybeIdle(stream)
    return
  }
  if (aborted.has(stream)) return

  queue.push({ id: takeTaskId(), stream, text: line })
  void pump().catch((err) => console.error('[piper] Die Warteschlange ist gestolpert:', err))
}

/**
 * Dazwischengeredet: alles zu dieser Stromnummer verwerfen.
 *
 * Der Prozess wird ausdrücklich nicht getötet — sein Start kostet je nach
 * Fassung mehrere hundert Millisekunden bis Sekunden, und danach ist die
 * ONNX-Sitzung wieder kalt. Der laufende Satz rechnet zu Ende, sein Ton fällt
 * ab hier auf den Boden. Bei der .exe ist das sogar Bedingung: Ihr nachlaufender
 * Ton wäre vom ersten Satz der nächsten Antwort nicht zu unterscheiden.
 */
export function piperAbort(stream: number): void {
  aborted.add(stream)
  setTimeout(() => aborted.delete(stream), ABORT_MEMORY_MS).unref()
  queue = queue.filter((task) => task.stream !== stream)
  if (resampler?.stream === stream) resampler = null
}

/**
 * Prozess und ONNX-Sitzung warmlaufen lassen, solange noch niemand wartet.
 *
 * Scheitert das, bleibt es hier bei einer Zeile im Protokoll: Zum Aufwärmen
 * gehört keine Stromnummer, also gibt es niemanden, dem man es melden könnte.
 * Der erste wirkliche Satz meldet es dann ordentlich.
 */
export async function piperPrewarm(): Promise<void> {
  try {
    await ensureProcess()
  } catch (err) {
    console.info('[piper] steht noch nicht bereit:', (err as Error).message)
  }
}

/**
 * Spricht piper, und womit?
 *
 * Fährt ihn hoch, wenn er nicht läuft, und wärmt ihn dabei auf. Die gemessene
 * Dauer steht in der Auskunft, weil sie die einzige ehrliche Zahl über den
 * Kaltstart auf diesem Rechner ist — sie hängt an der CPU, an der Stimme und
 * daran, was sonst noch läuft.
 */
export async function piperHealth(): Promise<PiperHealth> {
  const settings = getSettings()
  const voice = baseName(piperVoicePath(settings))

  try {
    await ensureProcess()
  } catch (err) {
    return { ok: false, detail: (err as Error).message, backend: null, voice, sampleRate: 0 }
  }

  const fassung = backend === 'exe' ? 'die eigenständige Fassung' : 'die gepflegte Python-Fassung'
  const warmup =
    lastWarmupMs === null ? '' : ` Der Aufwärmsatz dauerte ${(lastWarmupMs / 1000).toFixed(1)} Sekunden.`
  const rate =
    sampleRate === AUDIO_CONSTANTS.OUTPUT_SAMPLE_RATE
      ? `${sampleRate} Hz, also genau die des Players`
      : `${sampleRate} Hz und wird hier auf ${AUDIO_CONSTANTS.OUTPUT_SAMPLE_RATE} Hz umgerechnet`

  return {
    ok: true,
    detail: `piper spricht mit ${voice} über ${fassung}. Die Stimme liefert ${rate}.${warmup}`,
    backend,
    voice,
    sampleRate
  }
}

/**
 * Nach einem Stimmen- oder Fassungswechsel.
 *
 * Die alte Messung ist dann nichts mehr wert, und der laufende Prozess hält
 * noch das alte Modell — die Stimme steckt in der ONNX-Sitzung und lässt sich
 * nicht austauschen. Auch die Erinnerung daran, dass die .exe gestorben ist,
 * wird gelöscht: Sie ist an einer bestimmten Stimme gestorben, und mit der
 * nächsten kann es anders ausgehen.
 */
export function forgetPiperWarmup(): void {
  lastWarmupMs = null
  exeBroken = false
  stopProcess('Die Stimme wurde gewechselt.')
}
