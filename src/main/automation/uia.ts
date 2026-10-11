import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { resourceFile } from '../resources'

/**
 * Fenster lesen und bedienen, ohne sie anzufassen.
 *
 * Der zweite Weg neben der Bildschirmsteuerung, und für alles, was eine
 * gewöhnliche Oberfläche hat, der bessere. Windows führt zu jedem Fenster
 * einen Baum aus Rollen, Namen und Fähigkeiten — Barrierefreiheit ist der
 * Zweck, aber es ist genau die Beschreibung, die ein Modell braucht.
 *
 * Drei Unterschiede zum Foto, und jeder einzelne wiegt schwer:
 *
 * - **Kein Vordergrund nötig.** Ein Mausklick per Nachricht verpufft bei einem
 *   Fenster, das nicht aktiv ist — gemessen, zehn Sekunden gewartet, nichts.
 *   Ein Invoke über diesen Baum kommt an. James kann damit arbeiten, während
 *   Void etwas anderes tut, statt ihm die Maus wegzunehmen.
 *
 * - **Kein Raten.** "Drücke Settings" trifft; "klicke bei 487, 203" trifft, bis
 *   das Fenster verschoben wird.
 *
 * - **Ein Bruchteil der Kosten.** Der Baum des Ollama-Fensters sind rund
 *   zweihundert Token, ein Bildschirmfoto mit zwei Kacheln rund sechzehnhundert
 *   — und zwar bei jedem Schritt aufs Neue.
 *
 * Ein Dauerläufer wie der Eingabeserver, aus demselben Grund und einem
 * zweiten: Die Verweise auf gefundene Elemente müssen zwischen zwei Befehlen
 * überleben, denn erst wird gelesen und dann gehandelt.
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

/** Ein Bedienelement, so wie das Modell es zu sehen bekommt. */
export interface UiaElement {
  /** Die Nummer, mit der es angesprochen wird. Gilt bis zum nächsten Lesen. */
  ref: number
  /** Button, Edit, Hyperlink, CheckBox … */
  rolle: string
  name: string
  /**
   * Was damit geht — und das ist wichtiger als die Rolle.
   *
   * `Invoke` heißt drücken, `Value` heißt beschreiben, `Toggle` heißt
   * umschalten. Wer die Muster sieht, muss nicht raten, ob ein Druck etwas
   * bewirkt.
   */
  kann: string[]
  id?: string
  x?: number
  y?: number
  /** Der aktuelle Inhalt eines Textfelds — ergänzen oder ersetzen? */
  wert?: string
  zustand?: string
}

export interface UiaTree {
  fenster: string
  /** Wie viele Elemente das Fenster hat. */
  gefunden: number
  /** Wie viele davon in der Liste stehen (der Rest fiel unter die Grenze). */
  gezeigt: number
  elemente: UiaElement[]
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
    console.debug('[uia] unlesbare Zeile:', trimmed.slice(0, 200))
    return
  }

  const id = Number(message.id ?? 0)
  const entry = pending.get(id)
  if (!entry) return
  pending.delete(id)
  clearTimeout(entry.timer)

  if (message.ok) entry.resolve((message.data as Record<string, unknown>) ?? {})
  else entry.reject(new Error(String(message.error ?? 'Unbekannter Fehler der Fenstersteuerung.')))
}

async function ensureServer(): Promise<void> {
  if (ready) return ready

  ready = new Promise<void>((resolve, reject) => {
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resourceFile('uia-server.ps1')],
      { windowsHide: true }
    )

    child = proc
    let started = false
    const startTimer = setTimeout(() => {
      if (started) return
      proc.kill()
      reject(new Error('Die Fenstersteuerung ließ sich nicht starten.'))
    }, 15_000)

    proc.stdout.setEncoding('utf-8')
    proc.stdout.on('data', (chunk: string) => {
      if (child !== proc) return
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
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
      if (text) console.error('[uia]', text.slice(0, 400))
    })

    proc.on('error', (err) => {
      clearTimeout(startTimer)
      if (child === proc) cleanup(`Die Fenstersteuerung ist abgestürzt: ${err.message}`)
      reject(err)
    })

    proc.on('exit', (code) => {
      clearTimeout(startTimer)
      if (child === proc) cleanup(`Die Fenstersteuerung wurde beendet (Code ${code}).`)
      if (!started) reject(new Error('Die Fenstersteuerung hat sich sofort beendet.'))
    })
  })

  return ready
}

async function send(
  op: string,
  args: Record<string, unknown> = {},
  timeoutMs = 30_000
): Promise<Record<string, unknown>> {
  await ensureServer()
  const proc = child
  if (!proc) throw new Error('Die Fenstersteuerung läuft nicht.')

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

export async function uiaAvailable(): Promise<boolean> {
  try {
    await send('ping', {}, 20_000)
    return true
  } catch {
    return false
  }
}

/** Offene Fenster mit Titel — die Auswahl, aus der ein Ziel wird. */
export async function uiaWindows(): Promise<{ titel: string; aktiv: boolean }[]> {
  const result = await send('windows')
  return (result.fenster as { titel: string; aktiv: boolean }[]) ?? []
}

/**
 * Den Baum eines Fensters lesen.
 *
 * `window` leer oder "aktiv" nimmt das Fenster im Vordergrund; sonst wird
 * erst genau und dann ungefähr nach dem Titel gesucht.
 */
export async function uiaRead(window: string, limit = 120): Promise<UiaTree> {
  const result = await send('tree', { window, limit }, 45_000)
  return result as unknown as UiaTree
}

export async function uiaInvoke(ref: number): Promise<string> {
  const result = await send('invoke', { ref })
  return String(result.getan ?? 'invoke')
}

export async function uiaSetValue(ref: number, text: string): Promise<void> {
  await send('setValue', { ref, text })
}

export async function uiaToggle(ref: number): Promise<void> {
  await send('toggle', { ref })
}

export async function uiaExpand(ref: number, close = false): Promise<void> {
  await send('expand', { ref, close })
}

export async function uiaFocus(ref: number): Promise<void> {
  await send('focus', { ref })
}

/** Beim Herunterfahren: den Dauerläufer nicht zurücklassen. */
export function stopUia(): void {
  child?.kill()
  cleanup('Die Fenstersteuerung wurde beendet.')
}
