import { app, shell } from 'electron'
import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { format } from 'node:util'

/**
 * Protokoll auf die Festplatte.
 *
 * Der Anlass ist handfest: Ein mit `electron-builder` gepacktes Programm ist
 * unter Windows ein GUI-Prozess und hängt an keiner Konsole. Alles, was hier
 * über `console.error` ging, fiel damit ersatzlos aus — beim Entwickeln sieht
 * man es im Terminal, beim Benutzer nie. Der `uncaughtException`-Handler in
 * `index.ts` schrieb seine Meldung jahrelang ins Leere.
 *
 * Das ist kein Schönheitsfehler, sondern der Unterschied zwischen "bei meinem
 * Vater stürzt es ab" und "bei meinem Vater stürzt es ab, und hier steht
 * warum". Wer die App nicht selbst gebaut hat, kann keine Entwicklerwerkzeuge
 * aufmachen; die Datei ist das einzige, was er verschicken kann.
 *
 * Deshalb wird sie auch synchron geschrieben. Ein Puffer wäre sparsamer, aber
 * die Zeilen, auf die es ankommt, sind genau die letzten vor dem Absturz —
 * und die stünden dann noch im Puffer.
 */

/** Ab hier wird rotiert. Zwei Megabyte sind als Textdatei noch zu verschicken. */
const MAX_BYTES = 2_000_000

/** So oft sehen wir nach der Dateigröße — nicht bei jeder Zeile. */
const SIZE_CHECK_EVERY = 200

let fd: number | null = null
let written = 0
let installed = false

export type LogLevel = 'info' | 'warn' | 'error' | 'debug' | 'start'

export interface LogEntry {
  ts: number
  level: LogLevel
  /** Bereits von Zugangsdaten bereinigt. */
  text: string
}

const listeners = new Set<(entry: LogEntry) => void>()

/**
 * Liefert neue Protokollzeilen an Diagnosemodule weiter.
 *
 * Das ist absichtlich ein kleiner interner Ereignisstrom und kein zweites
 * Logsystem. Die Datei bleibt die vollständige Wahrheit; die Selbstheilung
 * darf daraus nur strukturierte Störungen ableiten. Neue Zuhörer bekommen
 * ausschließlich bereinigten Text, damit auch die Störungsdatenbank niemals
 * versehentlich Zugangsdaten enthält.
 */
export function onLogEntry(listener: (entry: LogEntry) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit(entry: LogEntry): void {
  for (const listener of listeners) {
    try {
      listener(entry)
    } catch {
      // Ein Diagnosemodul darf weder die App noch ihr eigentliches Log stören.
    }
  }
}

/**
 * Muster, die nie in einer Datei stehen dürfen, die jemand weiterschickt.
 *
 * Die Datei ist zum Verschicken gedacht, und wer sie verschickt, liest sie
 * vorher nicht Zeile für Zeile durch. Ein Zugangsschlüssel darin wäre damit
 * ein Leck mit Ansage — gerade weil er meistens in genau der Fehlermeldung
 * steht, die man weitergeben will ("401 für Schlüssel AIza...").
 *
 * Bewusst großzügig: Lieber ein harmloser Hex-Klumpen unkenntlich gemacht als
 * ein echter Schlüssel durchgelassen.
 */
const SECRETS: Array<[RegExp, string]> = [
  [/AIza[0-9A-Za-z_-]{10,}/g, 'AIza…[entfernt]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-…[entfernt]'],
  [/\bya29\.[A-Za-z0-9._-]{10,}/g, 'ya29.…[entfernt]'],
  [/\b1\/\/[A-Za-z0-9._-]{10,}/g, '1//…[entfernt]'],
  [/\bAC[0-9a-fA-F]{32}\b/g, 'AC…[entfernt]'],
  [/\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g, 'Bearer …[entfernt]'],
  [/\b[0-9a-fA-F]{32,}\b/g, '…[entfernt]'],
  // Ein Schlüssel, der als Feld in einem geloggten Objekt steckt.
  [/("?(?:api[_-]?key|token|secret|password|authorization)"?\s*[:=]\s*"?)[^"\s,}]{8,}/gi, '$1…[entfernt]']
]

export function redactLogText(text: string): string {
  let out = text
  for (const [pattern, replacement] of SECRETS) out = out.replace(pattern, replacement)
  return out
}

function logDir(): string {
  const dir = join(app.getPath('userData'), 'logs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** Ersetzt genau eine alte Loggeneration; als kleine Einheit separat testbar. */
export function replaceRotatedLog(path: string, previous: string): boolean {
  try {
    if (existsSync(previous)) unlinkSync(previous)
    renameSync(path, previous)
    return true
  } catch {
    return false
  }
}

export function logFilePath(): string {
  return join(logDir(), 'jarvis.log')
}

/**
 * Beim Überlaufen die alte Datei einmal beiseitelegen.
 *
 * Nur eine Generation: Wer nach einem Fehler nachsieht, will den letzten Lauf
 * und den davor. Alles Ältere ist Ballast, den niemand liest und der beim
 * Verschicken im Weg steht.
 */
function rotateIfNeeded(): void {
  const path = logFilePath()
  try {
    if (!existsSync(path) || statSync(path).size < MAX_BYTES) return
  } catch {
    return
  }
  if (fd !== null) {
    try {
      closeSync(fd)
    } catch {
      /* egal — gleich kommt sowieso ein neuer Deskriptor */
    }
    fd = null
  }
  const previous = join(logDir(), 'jarvis-vorher.log')
  // `rename` ersetzt unter POSIX, unter Windows aber nicht zuverlässig eine
  // vorhandene Zieldatei. Nach der ersten Rotation blieb deshalb jede
  // weitere aus und jarvis.log wuchs ohne Grenze weiter.
  if (!replaceRotatedLog(path, previous)) {
    /* Läuft die alte Datei nicht weg, schreiben wir eben weiter hinein. */
  }
}

/**
 * Eine Zeile wegschreiben.
 *
 * Schlägt das fehl — volle Platte, Ordner schreibgeschützt, Datei von einem
 * Virenscanner gehalten —, wird das Protokoll stillschweigend abgeschaltet.
 * Eine App, die abstürzt, weil ihr Protokoll nicht schreiben kann, wäre die
 * Umkehrung des Zwecks.
 */
function writeLine(level: string, text: string): void {
  if (fd === null) return
  const stamp = new Date().toLocaleString('de-DE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
  try {
    writeSync(fd, `${stamp} [${level}] ${redactLogText(text)}\r\n`)
  } catch {
    fd = null
    return
  }
  if (++written % SIZE_CHECK_EVERY === 0) {
    rotateIfNeeded()
    if (fd === null) open()
  }
}

function open(): void {
  try {
    fd = openSync(logFilePath(), 'a')
  } catch {
    fd = null
  }
}

/**
 * Konsole umleiten statt jede Aufrufstelle anzufassen.
 *
 * Im Hauptprozess stehen knapp vierzig `console.error`-Aufrufe, und der
 * Renderer schickt seine eigenen über `windows/crystal.ts` ebenfalls durch
 * `console.log`. Sie alle umzuschreiben hieße, vierzig Stellen zu ändern und
 * bei der nächsten hinzugefügten daran denken zu müssen. Hier abzufangen
 * kostet eine Stelle und erwischt auch das, was Bibliotheken ausgeben.
 *
 * Die ursprüngliche Ausgabe bleibt erhalten: Beim Entwickeln steht alles
 * weiterhin im Terminal.
 */
export function initLogging(): void {
  if (installed) return
  installed = true

  rotateIfNeeded()
  open()

  // A detached Windows GUI process may inherit pipes whose parent exits.
  // Logging that EPIPE through the same console creates an exception loop.
  let terminalAvailable = !app.isPackaged
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      terminalAvailable = false
      writeLine('warn', `Terminalausgabe beendet (${error.code ?? 'Schreibfehler'}). Dateiprotokoll läuft weiter.`)
    })
  }

  const levels: Array<['log' | 'info' | 'warn' | 'error' | 'debug', string]> = [
    ['log', 'info'],
    ['info', 'info'],
    ['warn', 'warn'],
    ['error', 'error'],
    ['debug', 'debug']
  ]

  for (const [method, level] of levels) {
    const original = console[method].bind(console)
    console[method] = (...args: unknown[]): void => {
      if (terminalAvailable) {
        try { original(...args) }
        catch { terminalAvailable = false }
      }
      try {
        const text = redactLogText(format(...args))
        writeLine(level, text)
        emit({ ts: Date.now(), level: level as LogLevel, text })
      } catch {
        /* Formatieren kann an einem kaputten toString scheitern. */
      }
    }
  }

  writeLine(
    'start',
    `James-Jarvis ${app.getVersion()} — ${process.platform} ${process.arch}, Electron ${process.versions.electron}`
  )

  // Ein abgelehntes Promise beendet den Prozess nicht, hinterlässt aber
  // dieselbe Art halb erledigter Arbeit wie eine Ausnahme. Bisher fiel es
  // komplett unter den Tisch.
  process.on('unhandledRejection', (reason) => {
    console.error('[main] Unbehandelte Zurückweisung:', reason)
  })

  app.on('child-process-gone', (_event, details) => {
    console.error(
      `[child] ${details.type} beendet: ${details.reason}${
        details.name ? ` (${details.name})` : ''
      }`
    )
  })
}

/** Zeigt die Protokolldatei im Explorer, damit man sie verschicken kann. */
export function revealLog(): void {
  const path = logFilePath()
  if (existsSync(path)) {
    shell.showItemInFolder(path)
  } else {
    void shell.openPath(logDir())
  }
}
