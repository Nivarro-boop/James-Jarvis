import { app, screen } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { APP_REGISTRY, type AppEntry } from '@shared/config/apps'
import { resourceFile } from '../resources'
import {
  powershellInput,
  powershellWindows,
  type Modifier,
  type MouseButton,
  type ScrollDirection,
  type WindowRect
} from './inputServer'

export type { Modifier, MouseButton, ScrollDirection }

const execFileAsync = promisify(execFile)

/**
 * Desktop-Steuerung unter Windows.
 *
 * Maus und Tastatur laufen über den dauerhaften PowerShell-Prozess mit
 * user32.dll. Windows-Shell-Aufgaben verwenden denselben Prozess oder
 * PowerShell-Einzelaufrufe als Rückfall.
 */

type InputBackend = {
  name: 'powershell'
  move(x: number, y: number): Promise<void>
  click(button: MouseButton, count: number, modifiers: Modifier[]): Promise<void>
  mouseDown(button: MouseButton, x?: number, y?: number): Promise<void>
  mouseUp(button: MouseButton, x?: number, y?: number): Promise<void>
  drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void>
  scroll(direction: ScrollDirection, amount: number, x?: number, y?: number): Promise<void>
  type(text: string): Promise<void>
  keys(combo: string, repeat: number): Promise<void>
  media(action: 'play' | 'next' | 'previous' | 'stop'): Promise<void>
  cursor(): Promise<{ x: number; y: number }>
}

let backend: InputBackend | null = null
let backendProbe: Promise<InputBackend> | null = null

async function getBackend(): Promise<InputBackend> {
  if (backend) return backend
  if (backendProbe) return backendProbe
  backendProbe = (async () => {
    if (process.platform !== 'win32') throw new Error('Die Bildschirmsteuerung unterstützt Windows.')
    const status = await powershellInput.availability()
    if (!status.ok) throw new Error(`Die Bildschirmsteuerung ist nicht verfügbar: ${status.grund ?? 'PowerShell startet nicht.'}`)
    backend = { name: 'powershell', ...powershellInput }
    return backend
  })().catch((error) => { backendProbe = null; throw error })
  return backendProbe
}
/**
 * Für die Diagnose in den Einstellungen — mit Grund, falls es nicht geht.
 *
 * `grund` steht nur im Fehlerfall und ist der Satz, der die Ursache benennt.
 */
export async function inputBackendStatus(): Promise<{ name: string; grund?: string }> {
  try {
    return { name: (await getBackend()).name }
  } catch (err) {
    return {
      name: 'nicht verfügbar',
      grund: err instanceof Error ? err.message : String(err)
    }
  }
}

/** Nur der Name — für Stellen, die bloß wissen wollen, ob es überhaupt geht. */
export async function inputBackendName(): Promise<string> {
  return (await inputBackendStatus()).name
}

function helperScript(): string {
  return resourceFile('windows-helper.ps1')
}

async function runHelper<T>(action: string, args: Record<string, string | number> = {}): Promise<T> {
  const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperScript(), '-Action', action]
  for (const [key, value] of Object.entries(args)) {
    argv.push(`-${key[0].toUpperCase()}${key.slice(1)}`, String(value))
  }
  const { stdout } = await execFileAsync('powershell.exe', argv, {
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  })
  const trimmed = stdout.trim()
  if (!trimmed) return [] as unknown as T
  /*
    Was PowerShell hier ausgibt, ist fast immer JSON — aber eben nur fast.
    Bricht das Skript mitten in der Ausgabe ab, steht dort ein halbes Objekt;
    schreibt jemand versehentlich eine Zeile mit Write-Output dazwischen, steht
    dort Text davor. Ohne diesen Fang meldet James dann laut "Unexpected token
    <" — eine Meldung über einen Parser, an einer Stelle, an der es um ein
    Fenster ging. Der Anfang der echten Antwort steht mit dabei: Genau der sagt,
    was schiefging.
  */
  try {
    return JSON.parse(trimmed) as T
  } catch {
    throw new Error(
      `Windows hat auf "${action}" nicht mit JSON geantwortet: ${trimmed.slice(0, 200)}`
    )
  }
}

// ─────────────────────────────────────────────────────────────
// App-Auflösung
// ─────────────────────────────────────────────────────────────

interface ShortcutEntry {
  name: string
  target: string
  arguments: string
  workDir: string
}

let shortcutCache: ShortcutEntry[] | null = null
let shortcutCacheAt = 0
const SHORTCUT_TTL_MS = 10 * 60 * 1000

async function shortcuts(): Promise<ShortcutEntry[]> {
  if (shortcutCache && Date.now() - shortcutCacheAt < SHORTCUT_TTL_MS) return shortcutCache
  try {
    shortcutCache = await runHelper<ShortcutEntry[]>('resolve-shortcuts')
    shortcutCacheAt = Date.now()
  } catch (err) {
    console.error('[desktop] Verknüpfungen nicht lesbar:', err)
    shortcutCache = []
  }
  return shortcutCache
}

function expand(path: string): string {
  return path.replace(/%([^%]+)%/g, (_match, name: string) => process.env[name] ?? `%${name}%`)
}

export interface ResolvedApp {
  entry: AppEntry
  path: string
  args: string[]
}

/**
 * Findet die passende Anwendung zu einem gesprochenen Namen.
 *
 * Reihenfolge: fest hinterlegter Pfad, dann Verknüpfungen. Die Alias-Listen
 * sind wichtiger als sie aussehen — gesprochen kommt "no risk" an, nicht
 * "NoRiskClient".
 */
export async function resolveApp(spoken: string): Promise<ResolvedApp | null> {
  const needle = spoken.toLowerCase().trim()

  const scored = APP_REGISTRY.map((entry) => {
    let score = 0
    for (const alias of entry.aliases) {
      if (needle === alias) score = Math.max(score, 100)
      else if (needle.includes(alias)) score = Math.max(score, 70 + alias.length)
      else if (alias.includes(needle) && needle.length >= 3) score = Math.max(score, 40)
    }
    if (entry.label.toLowerCase() === needle) score = Math.max(score, 95)
    return { entry, score }
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)

  for (const { entry } of scored) {
    if (entry.path) {
      const expanded = expand(entry.path)
      // Systembefehle wie explorer.exe haben keinen absoluten Pfad.
      if (!expanded.includes('\\') || existsSync(expanded)) {
        return { entry, path: expanded, args: entry.args ?? [] }
      }
    }

    const links = await shortcuts()
    const link = links.find((l) => {
      const name = l.name.toLowerCase()
      return entry.aliases.some((a) => name.includes(a)) || name.includes(entry.label.toLowerCase())
    })
    if (link) {
      return {
        entry,
        path: link.target,
        args: link.arguments ? link.arguments.split(' ').filter(Boolean) : (entry.args ?? [])
      }
    }
  }

  // Nichts in der Registry — direkt über die Verknüpfungsnamen versuchen.
  const links = await shortcuts()
  const direct = links.find((l) => l.name.toLowerCase().includes(needle))
  if (direct) {
    return {
      entry: {
        id: 'adhoc',
        label: direct.name,
        path: direct.target,
        aliases: [needle],
        category: 'system'
      },
      path: direct.target,
      args: direct.arguments ? direct.arguments.split(' ').filter(Boolean) : []
    }
  }

  return null
}

export async function launch(resolved: ResolvedApp): Promise<void> {
  const { spawn } = await import('node:child_process')
  const child = spawn(resolved.path, resolved.args, {
    detached: true,
    stdio: 'ignore',
    // Ohne das Arbeitsverzeichnis finden manche Launcher ihre Ressourcen nicht.
    cwd: resolved.path.includes('\\')
      ? resolved.path.slice(0, resolved.path.lastIndexOf('\\'))
      : undefined
  })
  child.unref()
}

/**
 * Das echte Programmsymbol als Data-URL, für die Denkblase an der Kugel.
 *
 * Aus der Programmdatei selbst gelesen, nicht aus einer mitgelieferten
 * Sammlung: So stimmt das Logo auch nach einem Update des Launchers, und für
 * Programme, die James nur über eine Verknüpfung kennt, gibt es trotzdem eins.
 * Ohne Datei (Systembefehle, Protokoll-Links) bleibt es bei `undefined`.
 *
 * Gelesen über `resources/app-icons.ps1` und nicht über `app.getFileIcon`:
 * Electron liefert beim NoRisk Launcher nur das allgemeine Fenstersymbol.
 * Das kostet einen PowerShell-Start, deshalb wird für die bekannten Programme
 * beim Start vorgeladen (`prefetchAppIcons`) und sonst nie auf das Symbol
 * gewartet, bevor ein Programm startet.
 */
const iconCache = new Map<string, string | undefined>()

async function extractIcons(paths: string[]): Promise<Record<string, string>> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resourceFile('app-icons.ps1')],
    {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 20_000,
      env: { ...process.env, JARVIS_ICON_PATHS: JSON.stringify(paths) }
    }
  )
  const parsed = JSON.parse(stdout.trim() || '{}') as Record<string, string>
  return parsed && typeof parsed === 'object' ? parsed : {}
}

function iconable(path: string): boolean {
  return path.includes('\\') && /\.(exe|lnk|ico)$/i.test(path) && existsSync(path)
}

/** Was schon da ist, ohne zu warten. `undefined` auch, wenn es noch niemand gelesen hat. */
export function cachedAppIcon(resolved: ResolvedApp): string | undefined {
  return iconCache.get(resolved.path)
}

export async function appIcon(resolved: ResolvedApp): Promise<string | undefined> {
  const path = resolved.path
  if (iconCache.has(path)) return iconCache.get(path)
  let icon: string | undefined
  if (iconable(path)) {
    try {
      const found = (await extractIcons([path]))[path]
      if (found) icon = `data:image/png;base64,${found}`
    } catch (err) {
      console.warn('[desktop] Programmsymbol nicht lesbar:', err instanceof Error ? err.message : err)
    }
    if (!icon) {
      try {
        const image = await app.getFileIcon(path, { size: 'large' })
        icon = image.isEmpty() ? undefined : image.toDataURL()
      } catch {
        icon = undefined
      }
    }
  }
  iconCache.set(path, icon)
  return icon
}

/** Die Symbole aller fest hinterlegten Programme auf einmal — ein PowerShell-Start statt zwanzig. */
export async function prefetchAppIcons(): Promise<void> {
  const paths = APP_REGISTRY.map((entry) => (entry.path ? expand(entry.path) : ''))
    .filter((path) => path && !iconCache.has(path) && iconable(path))
  if (paths.length === 0) return
  try {
    const found = await extractIcons(paths)
    for (const path of paths) {
      if (found[path]) iconCache.set(path, `data:image/png;base64,${found[path]}`)
    }
  } catch (err) {
    console.warn('[desktop] Programmsymbole nicht vorgeladen:', err instanceof Error ? err.message : err)
  }
}

/** Bekannte Anwendungen für die Sprachausgabe und die Einstellungen. */
export function knownApps(): { id: string; label: string; aliases: string[] }[] {
  return APP_REGISTRY.map((a) => ({ id: a.id, label: a.label, aliases: a.aliases }))
}

// ─────────────────────────────────────────────────────────────
// Fenster
// ─────────────────────────────────────────────────────────────

export interface WindowInfo {
  pid: number
  name: string
  title: string
}

/**
 * Fensterbefehle bevorzugt über den mitlaufenden Prozess.
 *
 * Gemessen auf diesem Rechner: ein Einzelaufruf von windows-helper.ps1 kostet
 * 720 bis 790 ms, weil jedes Mal ein PowerShell startet, das Profil übergeht,
 * das Skript einliest und `Add-Type` den C#-Compiler ruft. Über die stehende
 * Leitung ist dasselbe eine JSON-Zeile hin und eine zurück.
 *
 * Das ist keine Feinheit: `open_app` fragt erst die Fensterliste ab und holt
 * dann nach vorn — allein das waren anderthalb Sekunden, bevor überhaupt
 * etwas passierte. Für einen Sprachassistenten ist das der Unterschied
 * zwischen „sofort" und „er hat mich wohl nicht gehört".
 *
 * Der alte Weg bleibt als Rückfall. Er ist derselbe Code wie vorher und
 * greift, wenn der Dauerläufer nicht steht, aber ein Einzelaufruf möglich ist.
 */
async function viaServer<T>(fast: () => Promise<T>, slow: () => Promise<T>): Promise<T> {
  try {
    return await fast()
  } catch (err) {
    console.debug('[desktop] Dauerläufer nicht nutzbar, nehme Einzelaufruf:', String(err).slice(0, 160))
    return slow()
  }
}

export async function listWindows(): Promise<WindowInfo[]> {
  return viaServer(
    () => powershellWindows.list(),
    () => runHelper<WindowInfo[]>('list-windows')
  )
}

export interface FocusResult {
  ok: boolean
  title?: string
  error?: string
  /** Fensterlage in echten Bildpunkten, falls ermittelbar. */
  bounds?: { x: number; y: number; width: number; height: number } | null
}

export async function focusWindow(match: string): Promise<FocusResult> {
  return viaServer(
    () => powershellWindows.focus(match),
    () => runHelper<FocusResult>('focus-window', { match })
  )
}

/**
 * Welcher Bildschirm zeigt dieses Fenster?
 *
 * Die Fensterlage kommt in echten Bildpunkten, Electrons `bounds` sind in
 * geräteunabhängigen Punkten — deshalb erst den Mittelpunkt zurückrechnen und
 * dann den nächstgelegenen Bildschirm suchen.
 */
export function displayForWindow(
  bounds: { x: number; y: number; width: number; height: number } | null | undefined
): DisplayTarget | null {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null
  const center = screen.screenToDipPoint({
    x: bounds.x + Math.round(bounds.width / 2),
    y: bounds.y + Math.round(bounds.height / 2)
  })
  const display = screen.getDisplayNearestPoint(center)
  const all = screen.getAllDisplays()
  const index = all.findIndex((d) => d.id === display.id)
  return toTarget(display, index < 0 ? 0 : index, screen.getPrimaryDisplay().id)
}

// ─────────────────────────────────────────────────────────────
// Eingabe
// ─────────────────────────────────────────────────────────────

export async function typeText(text: string): Promise<void> {
  await (await getBackend()).type(text)
}

/** Tastenkombination aus gesprochenen Namen, z. B. "strg+shift+t". */
export async function pressHotkey(combo: string, repeat = 1): Promise<void> {
  await (await getBackend()).keys(combo, repeat)
}

export async function moveMouse(x: number, y: number): Promise<void> {
  await (await getBackend()).move(x, y)
}

/**
 * Klickt — ein-, zwei- oder dreifach, wahlweise mit gehaltenen Modifikatoren.
 *
 * Dreifachklick ist kein Kuriosum: er markiert in fast jedem Textfeld die
 * ganze Zeile und ist damit der zuverlässigste Weg, ein gefülltes Feld zu
 * überschreiben. Strg- und Umschalt-Klick sind das Gegenstück für Listen.
 */
export async function click(
  button: MouseButton = 'left',
  count = 1,
  modifiers: Modifier[] = []
): Promise<void> {
  await (await getBackend()).click(button, count, modifiers)
}

export async function mouseDown(button: MouseButton = 'left', x?: number, y?: number): Promise<void> {
  await (await getBackend()).mouseDown(button, x, y)
}

export async function mouseUp(button: MouseButton = 'left', x?: number, y?: number): Promise<void> {
  await (await getBackend()).mouseUp(button, x, y)
}

/** Scrollt an einer Stelle. Ohne Position dort, wo der Zeiger gerade steht. */
export async function scroll(
  direction: ScrollDirection,
  amount = 3,
  x?: number,
  y?: number
): Promise<void> {
  await (await getBackend()).scroll(direction, amount, x, y)
}

/** Zeigerposition in echten Bildpunkten. */
export async function cursorPosition(): Promise<{ x: number; y: number }> {
  return (await getBackend()).cursor()
}

/** Ziehen von einer Stelle zur anderen — beide Punkte in echten Bildpunkten. */
export async function drag(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number
): Promise<void> {
  await (await getBackend()).drag(fromX, fromY, toX, toY)
}

// ─────────────────────────────────────────────────────────────
// Bildschirm
// ─────────────────────────────────────────────────────────────

/** Ein Bildschirm, wie ihn die Bildschirmsteuerung sieht. */
export interface DisplayTarget {
  id: number
  /** Für die Sprachausgabe: "Hauptbildschirm", "Bildschirm 2". */
  label: string
  /** Lage und Größe in geräteunabhängigen Punkten. */
  bounds: { x: number; y: number; width: number; height: number }
  /**
   * Dasselbe ohne Taskleiste und angedockte Leisten.
   *
   * Für Bildschirmfotos ist `bounds` richtig — abgebildet wird, was zu sehen
   * ist, Taskleiste eingeschlossen. Zum Hinlegen eines Fensters ist es falsch:
   * Die untere Fensterzeile mit den Knöpfen verschwände hinter der Leiste.
   */
  workArea: { x: number; y: number; width: number; height: number }
  scaleFactor: number
  primary: boolean
}

export interface Screenshot {
  /** Bilddaten als Base64, ohne data-URL-Präfix. */
  base64: string
  /** Passend zu `format` — gehört so in die `inlineData` der Anfrage. */
  mimeType: 'image/jpeg' | 'image/png'
  width: number
  height: number
  /** Was das Bild beim Modell voraussichtlich kostet. */
  tokens: number
  /** Von welchem Bildschirm das Bild stammt. */
  display: DisplayTarget
}

/**
 * Wie Gemini Bilder abrechnet — und warum die Bildgröße hier nicht beliebig ist.
 *
 * Ein Bild wird in Kacheln von 768 mal 768 Bildpunkten zerlegt, und jede Kachel
 * kostet dieselbe feste Zahl Token. Der Preis hängt also nicht an der Datenmenge,
 * sondern allein an der Kantenlänge — und er springt: 1536 Bildpunkte breit
 * kosten genau so viel wie 769, weil beides zwei Kacheln sind. Ein Bild, das
 * knapp über einer Kachelgrenze liegt, zahlt eine volle Kachel für ein paar
 * Bildpunkte Rand.
 *
 * Vorher ging jedes Bild mit 1280 Bildpunkten Breite raus. Auf einem 16:9-Schirm
 * sind das 1280 mal 720 — zwei Kacheln, aber keine davon ganz gefüllt. Für
 * denselben Preis sind 1365 mal 768 drin, also rund vierzehn Prozent mehr
 * Bildfläche geschenkt.
 */
const TILE_PX = 768
const TOKENS_PER_TILE = 258

function tileCount(width: number, height: number): number {
  return Math.ceil(width / TILE_PX) * Math.ceil(height / TILE_PX)
}

/**
 * Die größte Fassung eines Bildes, die noch in ein Kachelbudget passt.
 *
 * Durchprobiert werden alle Kachelraster, deren Fläche das Budget einhält —
 * bei drei Kacheln also 3×1, 1×3, 2×1, 1×2 und 1×1. Für jedes wird das Bild
 * seitenverhältnistreu hineingelegt; gewonnen hat das mit der größten Fläche.
 * Ein Querformat landet so von selbst im liegenden Raster.
 *
 * Vergrößert wird nie: ein hochskaliertes Bild kostet echte Token und zeigt
 * kein einziges zusätzliches Detail.
 */
function fitToTiles(
  width: number,
  height: number,
  maxTiles: number
): { width: number; height: number } {
  let best = { width, height }
  let bestArea = 0

  for (let cols = 1; cols <= maxTiles; cols++) {
    for (let rows = 1; cols * rows <= maxTiles; rows++) {
      const scale = Math.min(1, (cols * TILE_PX) / width, (rows * TILE_PX) / height)
      const w = Math.max(1, Math.round(width * scale))
      const h = Math.max(1, Math.round(height * scale))
      if (w * h > bestArea) {
        bestArea = w * h
        best = { width: w, height: h }
      }
    }
  }

  return best
}

export interface CaptureOptions {
  /**
   * Wie viele Kacheln das Bild höchstens kosten darf. Zwei sind der
   * Alltagswert: auf einem 16:9-Schirm 1365 mal 768 Bildpunkte, genug um
   * Menüs und Knöpfe sicher zu treffen. Für kleinen Text gibt es `zoom`,
   * und das ist der bessere Weg — ein Ausschnitt in voller Auflösung kostet
   * weniger als ein durchgehend größeres Vollbild.
   */
  maxTiles?: number
  /** Welcher Bildschirm. Ohne Angabe der unter dem Mauszeiger. */
  target?: DisplayTarget
  /**
   * PNG nur, wenn das Bild auf der Platte landet.
   *
   * Fürs Modell ist JPEG in jeder Hinsicht besser: gleiche Kachelzahl, also
   * gleicher Preis, aber ein Zehntel der Datenmenge. Die Zeit, die ein
   * halbes Megabyte Base64 auf der Leitung liegt, merkt man in einem
   * Durchlauf mit zwanzig Schritten deutlich.
   */
  format?: 'jpeg' | 'png'
  /** Nur für JPEG. 80 ist der Punkt, an dem Text noch sauber lesbar bleibt. */
  quality?: number
}

function toTarget(display: Electron.Display, index: number, primaryId: number): DisplayTarget {
  return {
    id: display.id,
    label: display.id === primaryId ? 'Hauptbildschirm' : `Bildschirm ${index + 1}`,
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor || 1,
    primary: display.id === primaryId
  }
}

export function listDisplays(): DisplayTarget[] {
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((d, i) => toTarget(d, i, primaryId))
}

/**
 * Der Bildschirm, um den es gerade geht: der unter dem Mauszeiger.
 *
 * Vorher wurde immer der Hauptbildschirm genommen. Auf einem zweiten Monitor
 * war die Bildschirmsteuerung damit blind — sie fotografierte den einen
 * Schirm und klickte anhand dessen auf den anderen.
 */
export function activeDisplay(): DisplayTarget {
  const primaryId = screen.getPrimaryDisplay().id
  const all = screen.getAllDisplays()
  const here = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const index = all.findIndex((d) => d.id === here.id)
  return toTarget(here, index < 0 ? 0 : index, primaryId)
}

/**
 * Rechnet eine Stelle im Bild (0 bis 1000) in einen echten Mauspunkt um.
 *
 * Zwei Fallen stecken hier drin. Erstens sind Electrons `bounds` in
 * geräteunabhängigen Punkten: bei 150 Prozent Skalierung meldet Electron für
 * ein 2560er Panel 1707, und wer damit klickt, landet systematisch links oben
 * daneben. `dipToScreenPoint` erledigt die Umrechnung pro Bildschirm richtig,
 * auch wenn zwei Monitore unterschiedlich skaliert sind — von Hand mit einem
 * einzigen Faktor zu multiplizieren wäre genau dort wieder falsch.
 *
 * Zweitens der Rand: 1000 läge exakt auf dem ersten Bildpunkt des nächsten
 * Bildschirms. Deshalb bleibt der letzte Punkt ausgespart.
 */
export function displayPoint(
  display: DisplayTarget,
  normX: number,
  normY: number
): { x: number; y: number } {
  const frac = (value: number): number => Math.min(1, Math.max(0, value / 1000))
  const dip = {
    x: Math.round(display.bounds.x + frac(normX) * (display.bounds.width - 1)),
    y: Math.round(display.bounds.y + frac(normY) * (display.bounds.height - 1))
  }
  return screen.dipToScreenPoint(dip)
}

async function grab(target: DisplayTarget, size: { width: number; height: number }): Promise<Electron.NativeImage> {
  const { desktopCapturer } = await import('electron')

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: size
  })

  // `display_id` kommt als Zeichenkette. Findet sich nichts, lieber das erste
  // Bild als gar keines — ein falscher Schirm ist immer noch besser als ein
  // Abbruch mitten in einer Aufgabe.
  const source =
    sources.find((s) => String(s.display_id) === String(target.id)) ?? sources[0]
  if (!source) throw new Error('Der Bildschirm konnte nicht aufgenommen werden.')
  return source.thumbnail
}

/** Echte Bildpunkte eines Bildschirms — `bounds` ist geräteunabhängig. */
function fullPixels(target: DisplayTarget): { width: number; height: number } {
  return {
    width: Math.round(target.bounds.width * target.scaleFactor),
    height: Math.round(target.bounds.height * target.scaleFactor)
  }
}

function encode(
  image: Electron.NativeImage,
  display: DisplayTarget,
  format: 'jpeg' | 'png',
  quality: number
): Screenshot {
  const size = image.getSize()
  return {
    base64: (format === 'png' ? image.toPNG() : image.toJPEG(quality)).toString('base64'),
    mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
    width: size.width,
    height: size.height,
    tokens: tileCount(size.width, size.height) * TOKENS_PER_TILE,
    display
  }
}

/**
 * Bildschirmaufnahme über Electrons desktopCapturer.
 *
 * Verkleinert wird schon beim Aufnehmen, nicht hinterher: `thumbnailSize` geht
 * an die Aufnahme selbst, und ein Vollbild in 4K erst zu holen, um es dann
 * wegzuwerfen, kostet auf einem großen Schirm spürbar Zeit.
 */
export async function captureScreen(opts: CaptureOptions = {}): Promise<Screenshot> {
  const display = opts.target ?? activeDisplay()
  const full = fullPixels(display)
  const size =
    opts.maxTiles && opts.maxTiles > 0
      ? fitToTiles(full.width, full.height, opts.maxTiles)
      : full

  const image = await grab(display, size)
  return encode(image, display, opts.format ?? 'jpeg', opts.quality ?? 80)
}

/**
 * Ausschnitt in voller Auflösung.
 *
 * Der Grund ist Lesbarkeit: ein 4K-Schirm auf Kachelmaß heruntergerechnet
 * macht aus einer Menüzeile einen grauen Strich. Wer den Text darin braucht,
 * bekommt ihn nur, wenn der Ausschnitt ungeschrumpft aufgenommen wird.
 *
 * Und er ist zugleich der billigere Weg: Ein Viertel des Schirms in voller
 * Auflösung ist kleiner als der ganze Schirm — deshalb ist es richtig, das
 * Vollbild klein zu halten und für Text hierher zu greifen, statt umgekehrt
 * jedes Bild größer zu schicken.
 *
 * Der Bereich wird in denselben 0-bis-1000-Koordinaten angegeben wie alles
 * andere, damit das Modell nicht zwischen zwei Zahlensystemen wechseln muss.
 */
export async function captureRegion(
  region: { x: number; y: number; width: number; height: number },
  opts: CaptureOptions = {}
): Promise<Screenshot> {
  const display = opts.target ?? activeDisplay()
  const image = await grab(display, fullPixels(display))
  const size = image.getSize()

  const clampFrac = (value: number): number => Math.min(1, Math.max(0, value / 1000))

  /**
   * Erst die Größe, dann der Ursprung — und der weicht zurück, statt die
   * Größe zu beschneiden.
   *
   * Andersherum lief der Ausschnitt am Rand über die Bildkante hinaus: Steht
   * der Ursprung schon fast rechts, bleiben weniger als die Mindestbreite
   * übrig, und `Math.max` machte daraus wieder sechzehn Bildpunkte — sechzehn,
   * die es nicht mehr gibt. Electron liefert für so einen Zuschnitt kein
   * kleineres Bild, sondern gar keins, und der Schritt scheiterte an einer
   * Stelle, an der das Modell nur etwas genauer hinsehen wollte.
   */
  const width = Math.max(16, Math.min(size.width, Math.round(clampFrac(region.width) * size.width)))
  const height = Math.max(16, Math.min(size.height, Math.round(clampFrac(region.height) * size.height)))
  const x = Math.min(Math.round(clampFrac(region.x) * size.width), size.width - width)
  const y = Math.min(Math.round(clampFrac(region.y) * size.height), size.height - height)

  let cropped = image.crop({ x, y, width, height })

  // Auch ein Ausschnitt kann groß sein — ein Drittel eines 4K-Schirms sind
  // immer noch sechs Kacheln. Passt er nicht ins Budget, wird er verkleinert;
  // er bleibt trotzdem schärfer als derselbe Bereich im Vollbild.
  const budget = opts.maxTiles ?? 2
  const fitted = fitToTiles(width, height, budget)
  if (fitted.width !== width || fitted.height !== height) {
    cropped = cropped.resize({ width: fitted.width, height: fitted.height, quality: 'best' })
  }

  return encode(cropped, display, opts.format ?? 'jpeg', opts.quality ?? 88)
}

// ─────────────────────────────────────────────────────────────
// Lautstärke
// ─────────────────────────────────────────────────────────────

export async function adjustVolume(steps: number): Promise<void> {
  await runHelper('set-volume', { value: steps })
}

export async function mediaKey(action: 'play' | 'next' | 'previous' | 'stop'): Promise<void> {
  await (await getBackend()).media(action)
}

// ─────────────────────────────────────────────────────────────
// Fenster anordnen, schließen, Bildschirm sperren
// ─────────────────────────────────────────────────────────────

export type WindowArrangement = 'left' | 'right' | 'maximize' | 'minimize' | 'restore'

/**
 * Welchen Bildschirm meint „auf den rechten"?
 *
 * Gesprochen kommt kein Index an, sondern eine Lage im Raum. Die Zuordnung
 * geht deshalb über die tatsächliche Anordnung der Monitore: sortiert nach
 * ihrer x-Koordinate ist der erste der linke und der letzte der rechte,
 * unabhängig davon, welcher davon der Hauptbildschirm ist und in welcher
 * Reihenfolge Windows sie aufzählt.
 *
 * Nur ein Bildschirm angeschlossen? Dann ist jede Lageangabe dieser eine.
 * Das ist keine Nachlässigkeit, sondern die richtige Antwort: „leg das nach
 * rechts" bei einem Monitor heißt die rechte Hälfte, und genau das macht
 * `how` daraus.
 */
export function resolveDisplay(spoken: string | undefined): DisplayTarget | null {
  return pickDisplay(listDisplays(), spoken)
}

/**
 * Dieselbe Wahl, aber ohne Electron.
 *
 * Getrennt, damit sie prüfbar ist: Welcher Bildschirm bei „auf den rechten"
 * herauskommt, ist die eine Stelle hier, an der man sich lautlos vertun kann —
 * eine vertauschte Sortierung fällt im Betrieb erst auf, wenn das Fenster auf
 * dem falschen Schirm steht, und dann sieht es aus wie ein Fehler des Modells.
 */
export function pickDisplay(
  all: DisplayTarget[],
  spoken: string | undefined
): DisplayTarget | null {
  if (all.length === 0) return null
  const wanted = (spoken ?? '').toLowerCase().trim()
  if (!wanted) return null
  if (all.length === 1) return all[0]

  const byPosition = [...all].sort((a, b) => a.bounds.x - b.bounds.x)

  // „Hauptbildschirm" und „primären" gehören dazu: Mit einer Wortgrenze direkt
  // hinter „haupt" traf nur das nackte Wort, nicht das zusammengesetzte, das
  // man tatsächlich sagt. Ebenso „linker" und „rechter Monitor".
  if (/\b(haupt\w*|primär\w*|primar\w*|main)\b/.test(wanted)) {
    return all.find((d) => d.primary) ?? byPosition[0]
  }
  if (/\b(links|linke[mnrs]?|left)\b/.test(wanted)) return byPosition[0]
  if (/\b(rechts|rechte[mnrs]?|right)\b/.test(wanted)) return byPosition[byPosition.length - 1]
  if (/\b(mitte|mittlere[mnrs]?|middle)\b/.test(wanted) && byPosition.length >= 3) {
    return byPosition[Math.floor(byPosition.length / 2)]
  }

  // „auf Bildschirm zwei", „zweiter Monitor", „auf dem 2."
  const words: Record<string, number> = {
    erste: 1, ersten: 1, erster: 1, eins: 1,
    zweite: 2, zweiten: 2, zweiter: 2, zwei: 2,
    dritte: 3, dritten: 3, dritter: 3, drei: 3,
    vierte: 4, vierten: 4, vierter: 4, vier: 4
  }
  const digit = wanted.match(/\b([1-9])\b/)?.[1]
  const named = Object.keys(words).find((w) => wanted.includes(w))
  const index = digit ? Number(digit) : named ? words[named] : 0
  if (index >= 1 && index <= all.length) return all[index - 1]

  return null
}

/**
 * Wohin das Fenster gelegt wird, in geräteunabhängigen Punkten.
 *
 * `restore` bekommt bewusst kein Rechteck: „mach es wieder normal" heißt, die
 * Größe zurückzugeben, die der Nutzer dem Fenster einmal gegeben hat, und
 * nicht, eine neue zu erfinden. Nur wenn dabei ausdrücklich ein anderer
 * Bildschirm genannt ist, muss doch etwas gesetzt werden — sonst bliebe das
 * Fenster stehen, wo es war.
 */
export function arrangementRect(
  display: DisplayTarget,
  how: WindowArrangement,
  displayWasNamed: boolean
): { x: number; y: number; width: number; height: number } | null {
  const area = display.workArea
  const half = Math.floor(area.width / 2)
  switch (how) {
    case 'left':
      return { x: area.x, y: area.y, width: half, height: area.height }
    case 'right':
      return { x: area.x + half, y: area.y, width: area.width - half, height: area.height }
    case 'maximize':
      // Das Rechteck bringt es auf den richtigen Schirm, das Maximieren
      // danach erledigt der Server — siehe die Reihenfolge dort.
      return { x: area.x, y: area.y, width: area.width, height: area.height }
    case 'restore':
      /*
       * „Mach es wieder normal" heißt: die Größe zurück, die der Nutzer dem
       * Fenster einmal selbst gegeben hat. Eine neue zu erfinden wäre das
       * Gegenteil davon — deshalb hier kein Rechteck, der Server stellt bloß
       * wieder her.
       *
       * Es sei denn, ausdrücklich ein Bildschirm ist genannt: „hol das
       * normal auf den rechten Schirm" muss das Fenster bewegen, und die
       * ursprüngliche Lage lag ja gerade woanders. Dann zwei Drittel der
       * Fläche, mittig — groß genug zum Arbeiten, ohne den Schirm zuzukleben.
       */
      if (!displayWasNamed) return null
      return {
        x: area.x + Math.round(area.width / 6),
        y: area.y + Math.round(area.height / 6),
        width: Math.round((area.width * 2) / 3),
        height: Math.round((area.height * 2) / 3)
      }
    default:
      return null
  }
}

/**
 * Fenster anordnen — wahlweise auf einem bestimmten Bildschirm.
 *
 * Vorher lief das über `SystemParametersInfo(SPI_GETWORKAREA)`, und das
 * liefert immer den Arbeitsbereich des Hauptbildschirms. Auf einem Rechner
 * mit zwei Monitoren hieß „leg Chrome nach rechts" deshalb: rechte Hälfte des
 * Hauptbildschirms, ganz gleich wo das Fenster stand und was gemeint war.
 * „Hol das auf den rechten Bildschirm" ließ sich überhaupt nicht sagen.
 *
 * Jetzt entscheidet Electron, wo die Bildschirme liegen — es weiß es genau,
 * inklusive unterschiedlicher Skalierung —, und die Umrechnung in echte
 * Bildpunkte macht `dipToScreenRect` pro Bildschirm richtig. Ohne Angabe
 * bleibt das Fenster auf seinem eigenen Schirm, statt zum Hauptbildschirm zu
 * springen.
 */
export async function arrangeWindow(
  match: string,
  how: WindowArrangement,
  display?: string
): Promise<{ ok: boolean; title?: string; error?: string; display?: string }> {
  const wanted = resolveDisplay(display)

  // Ohne Zielangabe: der Bildschirm, auf dem das Fenster gerade steht. Dafür
  // muss man wissen, wo es steht — der Fokuswechsel liefert die Lage mit und
  // ist ohnehin das, was gleich danach passieren würde.
  let target = wanted
  if (!target && how !== 'minimize') {
    const found = await focusWindow(match)
    if (!found.ok) return { ok: false, error: found.error ?? 'Kein passendes Fenster gefunden.' }
    target = displayForWindow(found.bounds) ?? activeDisplay()
  }

  const dipRect = target ? arrangementRect(target, how, wanted !== null) : null
  const rect: WindowRect | undefined = dipRect
    ? (screen.dipToScreenRect(null, dipRect) as WindowRect)
    : undefined

  const result = await viaServer(
    () => powershellWindows.arrange(match, how, rect),
    () => runHelper<{ ok: boolean; title?: string; error?: string }>('arrange-window', { match, how })
  )

  return { ...result, display: target?.label }
}

export async function closeWindow(
  match: string
): Promise<{ ok: boolean; title?: string; error?: string }> {
  return viaServer(
    () => powershellWindows.close(match),
    () => runHelper('close-window', { match })
  )
}

export async function lockScreen(): Promise<void> {
  await runHelper('lock')
}

export interface SystemStatus {
  cpuLoad: number
  memoryUsedGb: number
  memoryTotalGb: number
  disks: { drive: string; freeGb: number; totalGb: number }[]
  uptimeHours: number
  batteryPercent: number | null
  gpu: string | null
}

export async function systemStatus(): Promise<SystemStatus> {
  return runHelper<SystemStatus>('system-status')
}
