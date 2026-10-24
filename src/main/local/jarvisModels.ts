import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { homedir, tmpdir, cpus } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { app } from 'electron'
import type { HubFiles, HubModel, HubProgress, JarvisLocalModel, JarvisLocalStatus } from '@shared/types'
import { broadcast } from '../ipc/emit'
import { getSettings } from '../store/settings'

/**
 * Eigene lokale Modelle: GGUF-Dateien von Hugging Face, gerechnet von llama.cpp.
 *
 * Kein Ollama, kein LM Studio — James startet `llama-server` selbst mit der
 * gewählten Datei und spricht ihn über die OpenAI-kompatible Schnittstelle an.
 * Alles liegt unter ~/JamesJarvis: `llama/` für das Programm, `modelle/` für
 * die Dateien. Gesucht wird direkt auf huggingface.co, nur nach GGUF.
 */

const API = 'https://huggingface.co/api'
const SPLIT = /-\d{5}-of-\d{5}\.gguf$/i
const QUANT = /(IQ\d_[A-Z]+|Q\d_K_[SML]|Q\d_K|Q\d_\d|Q\d|BF16|F16|F32)/i
export const JARVIS_LOCAL_PORT = 8095

export function jarvisHome(...parts: string[]): string {
  return join(app?.getPath?.('home') ?? homedir(), 'JamesJarvis', ...parts)
}
const modelsDir = (): string => jarvisHome('modelle')
const runtimeDir = (): string => jarvisHome('llama')
const serverExe = (): string => join(runtimeDir(), 'llama-server.exe')

// ── Suche ───────────────────────────────────────────────────

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(20_000), headers: { Accept: 'application/json' } })
  if (res.status === 401 || res.status === 403) {
    throw new Error('Dieses Modell ist gesperrt. Auf huggingface.co anmelden und die Lizenz freigeben.')
  }
  if (!res.ok) throw new Error(`Hugging Face antwortet mit ${res.status}.`)
  return (await res.json()) as T
}

/**
 * Mehrere Wörter: Hugging Face sucht den Text als ein Stück. Deshalb wird nach
 * dem längsten Wort gesucht und der Rest hier gefiltert — „qwen coder 7b"
 * findet sonst nichts.
 */
export async function searchHub(query: string, sort = 'downloads'): Promise<HubModel[]> {
  const params = new URLSearchParams({
    filter: 'gguf',
    sort: ['downloads', 'likes', 'trendingScore', 'lastModified'].includes(sort) ? sort : 'downloads',
    direction: '-1',
    limit: '100',
    full: 'false'
  })
  const words = query.toLowerCase().split(/[\s,]+/).filter(Boolean)
  const main = [...words].sort((a, b) => b.length - a.length)[0]
  if (main) params.set('search', main)
  type Raw = { id: string; downloads?: number; likes?: number; pipeline_tag?: string; tags?: string[]; gated?: unknown }
  const list = await getJson<Raw[]>(`${API}/models?${params}`)
  return list
    .filter((m) => words.every((w) => m.id.toLowerCase().includes(w)))
    .slice(0, 40)
    .map((m) => ({
      id: m.id,
      downloads: m.downloads ?? 0,
      likes: m.likes ?? 0,
      license: (m.tags ?? []).find((t) => t.startsWith('license:'))?.slice(8) ?? '',
      gated: Boolean(m.gated)
    }))
}

function validRepo(repo: string): boolean {
  return /^[\w.-]+\/[\w.-]+$/.test(repo)
}

export async function hubFiles(repo: string): Promise<HubFiles> {
  if (!validRepo(repo)) throw new Error('Ungültiger Modellname.')
  type Entry = { type: string; path: string; size?: number; lfs?: { size?: number } }
  const tree = await getJson<Entry[]>(`${API}/models/${repo}/tree/main?recursive=true`)
  const files = tree
    .filter((f) => f.type === 'file' && /\.gguf$/i.test(f.path) && !/mmproj/i.test(f.path))
    .map((f) => ({
      path: f.path,
      size: f.lfs?.size ?? f.size ?? 0,
      quant: (basename(f.path).match(QUANT)?.[0] ?? '').toUpperCase(),
      split: SPLIT.test(f.path)
    }))
    .sort((a, b) => a.size - b.size)
  // Q4_K_M ist der übliche Mittelweg zwischen Güte und Größe.
  const recommended = files.find((f) => !f.split && f.quant === 'Q4_K_M') ?? files.find((f) => !f.split)
  return { repo, files, recommended: recommended?.path ?? '' }
}

// ── Download ────────────────────────────────────────────────

let download: AbortController | null = null

function progress(p: HubProgress): void {
  broadcast('hub:progress', p)
}

async function fetchTo(url: string, dest: string, label: string, signal: AbortSignal): Promise<void> {
  const res = await fetch(url, { signal })
  if (res.status === 401 || res.status === 403) throw new Error('Dieses Modell ist gesperrt (Freigabe auf huggingface.co nötig).')
  if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen (${res.status}).`)
  const total = Number(res.headers.get('content-length')) || 0
  mkdirSync(dirname(dest), { recursive: true })
  const part = `${dest}.part`
  const out = createWriteStream(part)
  let received = 0
  let last = 0
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.length
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
      if (Date.now() - last > 250) {
        last = Date.now()
        progress({ label, received, total, done: false, error: null })
      }
    }
    await new Promise<void>((ok, fail) => out.end((e?: Error | null) => (e ? fail(e) : ok())))
  } catch (e) {
    out.destroy()
    rmSync(part, { force: true })
    throw e
  }
  renameSync(part, dest)
}

async function freeBytes(dir: string): Promise<number> {
  try {
    const s = await statfs(dir)
    return s.bavail * s.bsize
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export async function installHubModel(repo: string, file: string): Promise<JarvisLocalModel> {
  if (download) throw new Error('Es läuft schon ein Download.')
  const info = await hubFiles(repo)
  const entry = info.files.find((f) => f.path === file)
  if (!entry) throw new Error('Datei nicht im Modell gefunden.')
  if (entry.split) throw new Error('Geteilte GGUF-Dateien werden nicht unterstützt. Bitte eine einzelne Datei wählen.')
  mkdirSync(modelsDir(), { recursive: true })
  if (entry.size && entry.size + 1024 ** 3 > (await freeBytes(modelsDir()))) {
    throw new Error('Nicht genug freier Speicherplatz (mindestens 1 GB Reserve).')
  }
  const dest = join(modelsDir(), repo.replace(/[^\w.-]+/g, '_'), basename(file))
  const label = `${repo} · ${entry.quant || basename(file)}`
  download = new AbortController()
  try {
    if (!existsSync(dest)) {
      const url = `https://huggingface.co/${repo}/resolve/main/${file.split('/').map(encodeURIComponent).join('/')}?download=true`
      await fetchTo(url, dest, label, download.signal)
    }
    progress({ label, received: entry.size, total: entry.size, done: true, error: null })
  } catch (e) {
    const aborted = download.signal.aborted
    const message = aborted ? 'Download abgebrochen.' : e instanceof Error ? e.message : String(e)
    progress({ label, received: 0, total: 0, done: true, error: message })
    throw new Error(message)
  } finally {
    download = null
  }
  return describe(dest)
}

export function cancelHubDownload(): void {
  download?.abort()
}

// ── Vorhandene Modelle ─────────────────────────────────────

function describe(path: string): JarvisLocalModel {
  const rel = relative(modelsDir(), path)
  const [folder] = rel.split(sep)
  return {
    path,
    name: basename(path, '.gguf'),
    source: folder && folder !== basename(path) ? folder.replace('_', '/') : '',
    size: existsSync(path) ? statSync(path).size : 0
  }
}

export function listLocalModels(): JarvisLocalModel[] {
  const root = modelsDir()
  if (!existsSync(root)) return []
  const found: JarvisLocalModel[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/\.gguf$/i.test(entry.name) && !/mmproj/i.test(entry.name)) found.push(describe(p))
    }
  }
  walk(root)
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

/** Nur innerhalb von ~/JamesJarvis/modelle — nie irgendeinen übergebenen Pfad. */
export async function removeLocalModel(path: string): Promise<void> {
  const abs = resolve(path)
  if (!abs.startsWith(modelsDir() + sep) || !/\.gguf$/i.test(abs)) throw new Error('Das ist kein Jarvis-Modell.')
  if (running?.model === abs) await stopLocalServer()
  rmSync(abs, { force: true })
  try {
    if (readdirSync(dirname(abs)).length === 0 && dirname(abs) !== modelsDir()) rmSync(dirname(abs), { recursive: true })
  } catch {
    // Ordner bleibt eben stehen.
  }
}

// ── llama.cpp ───────────────────────────────────────────────

let installingRuntime: Promise<void> | null = null

/**
 * Holt llama.cpp aus dem offiziellen GitHub-Release (CPU-Fassung, läuft
 * überall). Wer eine CUDA-Fassung schon in ~/JamesJarvis/llama liegen hat,
 * behält sie.
 */
export function installRuntime(): Promise<void> {
  installingRuntime ??= (async () => {
    type Release = { assets: { name: string; browser_download_url: string }[] }
    const release = await getJson<Release>('https://api.github.com/repos/ggml-org/llama.cpp/releases/latest')
    const asset = release.assets.find((a) => /bin-win-cpu-x64\.zip$/i.test(a.name))
    if (!asset) throw new Error('Im aktuellen llama.cpp-Release fehlt die Windows-Fassung.')
    const tmp = mkdtempSync(join(tmpdir(), 'jarvis-llama-'))
    try {
      const zip = join(tmp, asset.name)
      await fetchTo(asset.browser_download_url, zip, 'llama.cpp', new AbortController().signal)
      await new Promise<void>((ok, fail) =>
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force', zip, join(tmp, 'x')],
        { windowsHide: true }, (e) => (e ? fail(new Error('llama.cpp ließ sich nicht entpacken.')) : ok())))
      const exe = findFile(join(tmp, 'x'), 'llama-server.exe')
      if (!exe) throw new Error('llama-server.exe fehlt im Paket.')
      mkdirSync(runtimeDir(), { recursive: true })
      for (const name of readdirSync(dirname(exe))) {
        renameSync(join(dirname(exe), name), join(runtimeDir(), name))
      }
      progress({ label: 'llama.cpp', received: 1, total: 1, done: true, error: null })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })().finally(() => { installingRuntime = null })
  return installingRuntime
}

function findFile(dir: string, name: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === name) return p
    if (entry.isDirectory()) {
      const hit = findFile(p, name)
      if (hit) return hit
    }
  }
  return null
}

let running: { proc: ChildProcess; model: string; ready: Promise<void> } | null = null
const log: string[] = []

export function localBaseUrl(): string {
  return `http://127.0.0.1:${JARVIS_LOCAL_PORT}/v1`
}

/**
 * Startet `llama-server` mit dem eingestellten Modell, falls er nicht schon
 * damit läuft. Lagen werden automatisch zwischen Grafikkarte und RAM verteilt.
 */
export function ensureLocalServer(): Promise<void> {
  const model = getSettings().jarvisLocal?.model ?? ''
  if (!model) return Promise.reject(new Error('Kein lokales Jarvis-Modell gewählt.'))
  if (!existsSync(model)) return Promise.reject(new Error(`Modelldatei fehlt: ${basename(model)}`))
  if (!existsSync(serverExe())) return Promise.reject(new Error('llama.cpp ist nicht installiert.'))
  if (running?.model === model) return running.ready
  if (running) running.proc.kill()

  const threads = String(Math.max(2, Math.floor(cpus().length / 2)))
  const proc = spawn(serverExe(), [
    '-m', model, '--host', '127.0.0.1', '--port', String(JARVIS_LOCAL_PORT),
    '-c', '8192', '-np', '1', '-fa', 'on', '--jinja', '-fit', 'on', '-t', threads,
    '--reasoning-format', 'deepseek', '--no-webui', '-a', basename(model, '.gguf')
  ], { cwd: runtimeDir(), windowsHide: true })
  const keep = (d: Buffer): void => {
    log.push(...d.toString().split(/\r?\n/).filter(Boolean))
    if (log.length > 200) log.splice(0, log.length - 200)
  }
  proc.stdout?.on('data', keep)
  proc.stderr?.on('data', keep)
  const state = { proc, model, ready: Promise.resolve() }
  proc.on('exit', () => { if (running === state) running = null })
  running = state
  state.ready = (async () => {
    const start = Date.now()
    while (Date.now() - start < 180_000) {
      if (running !== state) throw new Error(`llama-server wurde beendet: ${log.slice(-3).join(' ')}`)
      try {
        if ((await fetch(`http://127.0.0.1:${JARVIS_LOCAL_PORT}/health`)).ok) return
      } catch {
        // lauscht noch nicht
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error('Das lokale Modell startet nicht (Zeitüberschreitung).')
  })()
  return state.ready
}

export async function stopLocalServer(): Promise<void> {
  const state = running
  running = null
  if (!state) return
  await new Promise<void>((done) => {
    state.proc.once('exit', () => done())
    state.proc.kill()
    setTimeout(done, 5000)
  })
}

export function jarvisLocalStatus(): JarvisLocalStatus {
  return {
    runtime: existsSync(serverExe()),
    runtimePath: runtimeDir(),
    modelsPath: modelsDir(),
    models: listLocalModels(),
    running: running?.model ?? '',
    downloading: Boolean(download || installingRuntime)
  }
}
