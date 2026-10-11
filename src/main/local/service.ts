import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/**
 * Fremde Programme am Leben halten.
 *
 * whisper und piper sind keine Bibliotheken, sondern Prozesse, und beide teilen
 * dieselben drei Eigenschaften: Ihr Start ist teuer, sie müssen deshalb laufen
 * bleiben, und sie dürfen die App nicht überleben. Der letzte Punkt ist der,
 * der ohne Hilfe schiefgeht — ein zurückgelassener whisper-server hält ein
 * halbes Gigabyte Modell im Speicher und den Port besetzt, und beim nächsten
 * Start redet die App mit dem Gespenst statt mit dem neuen Dienst.
 *
 * Deshalb führt dieses Modul ein Verzeichnis aller gestarteten Prozesse. Wer
 * hier spawnt, wird beim Herunterfahren mit beendet, ohne dass irgendwo eine
 * zweite Liste gepflegt werden muss.
 *
 * Bewusst kein selbsttätiger Neustart: Ein Dienst, der beim Start abstürzt,
 * stürzt auch beim zweiten Mal ab, und eine Schleife daraus verdeckt nur den
 * Grund. Der Aufrufer erfährt vom Ende und entscheidet selbst.
 */

export interface ManagedProcess {
  readonly child: ChildProcessWithoutNullStreams
  /** Von uns beendet — dann ist ein Exit kein Absturz. */
  readonly stopping: boolean
  stop(): void
}

export interface SpawnOptions {
  /** Für die Protokollzeilen. */
  name: string
  file: string
  args: string[]
  env?: NodeJS.ProcessEnv
  cwd?: string
  onStdout?(chunk: Buffer): void
  onStderr?(text: string): void
  /** Der Prozess ist weg. `stopping` sagt, ob das gewollt war. */
  onExit(code: number | null, stopping: boolean): void
}

const running = new Set<ManagedProcess>()

export function spawnManaged(opts: SpawnOptions): ManagedProcess {
  const child = spawn(opts.file, opts.args, {
    windowsHide: true,
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe']
  })

  let stopping = false
  const handle: ManagedProcess = {
    child,
    get stopping() {
      return stopping
    },
    stop() {
      if (stopping) return
      stopping = true
      running.delete(handle)
      try {
        child.kill()
      } catch {
        // War schon weg.
      }
    }
  }
  running.add(handle)

  /**
   * stdout bleibt roh.
   *
   * piper schreibt dort PCM, und eine Zeichenkodierung darüberzulegen würde
   * jedes Byte über 0x7F verderben — aus Sprache würde Rauschen. Wer Text
   * erwartet, wandelt selbst um; wer Ton erwartet, bekommt ihn unangetastet.
   */
  if (opts.onStdout) child.stdout.on('data', opts.onStdout)

  child.stderr.setEncoding('utf-8')
  child.stderr.on('data', (text: string) => {
    if (opts.onStderr) opts.onStderr(text)
    else if (text.trim()) console.debug(`[${opts.name}]`, text.trim().slice(0, 400))
  })

  child.on('error', (err) => {
    console.error(`[${opts.name}] ließ sich nicht starten:`, err.message)
    running.delete(handle)
    opts.onExit(null, stopping)
  })

  child.on('exit', (code) => {
    running.delete(handle)
    if (!stopping) console.warn(`[${opts.name}] beendet (Code ${code})`)
    opts.onExit(code, stopping)
  })

  return handle
}

/** Beim Herunterfahren: keinen Dauerläufer zurücklassen. */
export function stopLocalServices(): void {
  for (const handle of [...running]) handle.stop()
}

/**
 * Warten, bis etwas zutrifft — mit Frist statt für immer.
 *
 * Der Rückgabewert ist `false` bei Ablauf und nicht eine Ausnahme, weil beide
 * Aufrufer daraus einen ganzen Satz für die Einstellungsseite machen wollen und
 * dafür wissen müssen, woran es lag.
 */
export async function waitUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
  everyMs = 250
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, everyMs))
  }
}
