import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { resourceFile } from '../resources'

/**
 * Maus und Tastatur ohne native Node-Module.
 *
 * Die Bildschirmsteuerung hing bisher vollständig an `@nut-tree-fork/nut-js`.
 * Dessen native Bindings lassen sich auf diesem Rechner nicht bauen — den
 * Visual-Studio-Buildtools fehlt das ClangCL-Toolset — und ohne sie warf jeder
 * einzelne Klick "Die Desktopsteuerung ist nicht verfügbar". Damit war
 * `computer_task` nicht langsam oder unzuverlässig, sondern schlicht tot.
 *
 * Hier läuft stattdessen ein PowerShell-Prozess mit, der user32.dll anzapft.
 * Er wird beim ersten Bedarf gestartet und bleibt stehen: das `Add-Type` im
 * Skript ruft den C#-Compiler, was rund eine Sekunde dauert, und das will man
 * nicht pro Mausklick bezahlen. Befehle gehen als JSON-Zeilen rein, Antworten
 * als JSON-Zeilen raus.
 */

interface Pending {
  resolve: (value: Record<string, unknown>) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

let child: ChildProcessWithoutNullStreams | null = null
let ready: Promise<void> | null = null
let seq = 0
const pending = new Map<number, Pending>()
let buffer = ''

function scriptPath(): string {
  return resourceFile('input-server.ps1')
}

function cleanup(reason: string): void {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer)
    entry.reject(new Error(reason))
  }
  pending.clear()
  child = null
  ready = null
  buffer = ''
}

function handleLine(line: string): void {
  const trimmed = line.trim()
  if (!trimmed) return

  let message: Record<string, unknown>
  try {
    message = JSON.parse(trimmed)
  } catch {
    // PowerShell schreibt gelegentlich Warnungen dazwischen. Kein Grund,
    // den ganzen Kanal für kaputt zu erklären.
    console.debug('[input] unlesbare Zeile:', trimmed.slice(0, 200))
    return
  }

  const id = Number(message.id ?? 0)
  const entry = pending.get(id)
  if (!entry) return
  pending.delete(id)
  clearTimeout(entry.timer)

  if (message.ok) entry.resolve((message.data as Record<string, unknown>) ?? {})
  else entry.reject(new Error(String(message.error ?? 'Unbekannter Fehler der Eingabesteuerung.')))
}

async function ensureServer(): Promise<void> {
  if (ready) return ready

  ready = new Promise<void>((resolve, reject) => {
    const proc = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath()
      ],
      { windowsHide: true }
    )

    child = proc
    let started = false
    const startTimer = setTimeout(() => {
      if (started) return
      proc.kill()
      reject(new Error('Die Eingabesteuerung ließ sich nicht starten.'))
    }, 15_000)

    proc.stdout.setEncoding('utf-8')
    proc.stdout.on('data', (chunk: string) => {
      if (child !== proc) return
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)

        // Die Bereitmeldung kommt, sobald Add-Type durch ist.
        if (!started && line.includes('"ready"')) {
          started = true
          clearTimeout(startTimer)
          resolve()
        } else {
          handleLine(line)
        }
        index = buffer.indexOf('\n')
      }
    })

    proc.stderr.setEncoding('utf-8')
    proc.stderr.on('data', (chunk: string) => {
      const text = chunk.trim()
      if (text) console.error('[input]', text.slice(0, 400))
    })

    proc.on('error', (err) => {
      clearTimeout(startTimer)
      if (child === proc) cleanup(`Die Eingabesteuerung ist abgestürzt: ${err.message}`)
      reject(err)
    })

    proc.on('exit', (code) => {
      clearTimeout(startTimer)
      if (child === proc) cleanup(`Die Eingabesteuerung wurde beendet (Code ${code}).`)
      if (!started) reject(new Error('Die Eingabesteuerung hat sich sofort beendet.'))
    })
  })

  return ready
}

/** Einen Befehl absetzen und auf die Antwort warten. */
async function send(
  op: string,
  args: Record<string, unknown> = {},
  timeoutMs = 20_000
): Promise<Record<string, unknown>> {
  await ensureServer()
  const proc = child
  if (!proc) throw new Error('Die Eingabesteuerung läuft nicht.')

  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Die Aktion ${op} hat nicht geantwortet.`))
      if (child === proc) { proc.kill(); cleanup(`Die Aktion ${op} hat nicht geantwortet — Steuerungsdienst wird neu gestartet.`) }
    }, timeoutMs)

    pending.set(id, { resolve, reject, timer })
    proc.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`, (err) => {
      if (!err) return
      pending.delete(id)
      clearTimeout(timer)
      reject(err)
    })
  })
}

export type MouseButton = 'left' | 'right' | 'middle'
export type Modifier = 'ctrl' | 'shift' | 'alt' | 'win'
export type ScrollDirection = 'up' | 'down' | 'left' | 'right'

export const powershellInput = {
  /**
   * Ob der PowerShell-Weg trägt — und wenn nicht, warum.
   *
   * Der Grund wird mitgegeben und nicht weggeworfen. Vorher stand am Ende
   * dieser Kette in den Einstellungen nur „kein Weg gefunden": Der Fehler
   * wurde hier verschluckt, in `getBackend` durch einen allgemeinen Satz
   * ersetzt und in `inputBackendName` noch einmal verschluckt. Übrig blieb
   * eine rote Zeile ohne jeden Anhaltspunkt — bei einer Störung, die die
   * gesamte Bildschirmsteuerung stilllegt.
   */
  async availability(): Promise<{ ok: boolean; grund?: string }> {
    try {
      await send('ping', {}, 20_000)
      return { ok: true }
    } catch (err) {
      return { ok: false, grund: err instanceof Error ? err.message : String(err) }
    }
  },

  async available(): Promise<boolean> {
    return (await powershellInput.availability()).ok
  },

  move: (x: number, y: number) => send('move', { x, y }).then(() => undefined),

  click: (button: MouseButton, count: number, modifiers: Modifier[] = []) =>
    send('click', { button, count, modifiers }).then(() => undefined),

  mouseDown: (button: MouseButton, x?: number, y?: number) =>
    send('mousedown', { button, x, y }).then(() => undefined),

  mouseUp: (button: MouseButton, x?: number, y?: number) =>
    send('mouseup', { button, x, y }).then(() => undefined),

  drag: (fromX: number, fromY: number, toX: number, toY: number) =>
    send('drag', { x: fromX, y: fromY, x2: toX, y2: toY }, 30_000).then(() => undefined),

  scroll: (direction: ScrollDirection, amount: number, x?: number, y?: number) =>
    send('scroll', { direction, amount, x, y }).then(() => undefined),

  type: (text: string) =>
    // Lange Texte tippen sich in Häppchen; die Frist wächst entsprechend mit.
    send('type', { text }, 20_000 + text.length * 40).then(() => undefined),

  keys: (combo: string, repeat = 1) =>
    send('keys', { combo, repeat }, 20_000 + repeat * 500).then(() => undefined),

  media: (action: 'play' | 'next' | 'previous' | 'stop') =>
    send('media', { action }).then(() => undefined),

  volume: (steps: number) => send('volume', { steps }).then(() => undefined),

  async cursor(): Promise<{ x: number; y: number }> {
    const data = await send('cursor')
    return { x: Number(data.x ?? 0), y: Number(data.y ?? 0) }
  },

  async metrics(): Promise<{ width: number; height: number }> {
    const data = await send('metrics')
    return { width: Number(data.width ?? 0), height: Number(data.height ?? 0) }
  }
}

/**
 * Fensterbefehle über denselben Dauerläufer.
 *
 * Getrennt von `powershellInput` gehalten, weil es kein Eingabe-Backend ist:
 * `getBackend()` in desktop.ts wählt zwischen nut.js und PowerShell, und für
 * Fenster gibt es diese Wahl nicht — nut.js kann das gar nicht. Was es hier
 * gibt, ist nur die schnelle Fassung dessen, was windows-helper.ps1 auch kann;
 * fällt sie aus, greift dort der Rückfall.
 */
export interface WindowRect {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowOpResult {
  ok: boolean
  title?: string
  pid?: number
  error?: string
  bounds?: WindowRect | null
}

function toResult(data: Record<string, unknown>): WindowOpResult {
  const bounds = data.bounds as Record<string, number> | null | undefined
  return {
    ok: data.ok === true,
    title: typeof data.title === 'string' ? data.title : undefined,
    pid: typeof data.pid === 'number' ? data.pid : undefined,
    error: typeof data.error === 'string' ? data.error : undefined,
    bounds: bounds
      ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
      : null
  }
}

export const powershellWindows = {
  async list(): Promise<{ pid: number; name: string; title: string }[]> {
    const data = await send('windows', {}, 10_000)
    const list = (data.windows ?? []) as { pid: number; name: string; title: string }[]
    return Array.isArray(list) ? list : []
  },

  async focus(match: string): Promise<WindowOpResult> {
    return toResult(await send('focus', { match }, 10_000))
  },

  async close(match: string): Promise<WindowOpResult> {
    return toResult(await send('close', { match }, 10_000))
  },

  /**
   * `rect` ist bereits in echten Bildpunkten und darf fehlen — dann wird nur
   * maximiert, minimiert oder wiederhergestellt.
   */
  async arrange(
    match: string,
    how: string,
    rect?: WindowRect
  ): Promise<WindowOpResult> {
    return toResult(
      await send(
        'arrange',
        rect
          ? { match, how, x: rect.x, y: rect.y, w: rect.width, t: rect.height }
          : { match, how },
        10_000
      )
    )
  }
}

export function shutdownInput(): void {
  if (!child) return
  try {
    child.stdin.end()
    child.kill()
  } catch {
    // Prozess war schon weg.
  }
  cleanup('Beendet.')
}
