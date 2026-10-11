import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { getSecret, setSecret } from '../secrets/keystore'
import { getSettings } from '../store/settings'
import { hermesBase, hermesHealth } from './hermes'
import { stopOwnedChild } from './gracefulChild'

let child: ChildProcess | null = null
let ownedInstallation: { python: string; source: string; profile: string } | null = null
let ownedBase = ''
let generation = 0
let starting: Promise<{ ok: boolean; detail: string }> | null = null
let stopping: Promise<void> | null = null

export function startHermesGateway(): Promise<{ ok: boolean; detail: string }> {
  if (starting) return starting
  starting = start().finally(() => { starting = null })
  return starting
}

async function start(): Promise<{ ok: boolean; detail: string }> {
  const cancelled = { ok: false, detail: 'Hermes-Start wurde abgebrochen.' }
  let currentGeneration = generation
  if (stopping) await stopping
  if (generation !== currentGeneration) return cancelled
  const requestedBase = hermesBase(getSettings().hermes.baseUrl)
  if (child && ownedBase !== requestedBase) {
    const restartGeneration = generation + 1
    await stopHermesGateway()
    if (generation !== restartGeneration) return cancelled
    currentGeneration = restartGeneration
  }
  const existing = await hermesHealth()
  if (generation !== currentGeneration) return cancelled
  if (existing.ok) return existing
  if (child && child.exitCode === null) return { ok: false, detail: 'Hermes startet noch. Verbindung gleich erneut prüfen.' }
  try {
    const root = join(process.env.LOCALAPPDATA || app.getPath('userData'), 'Void James Hermes')
    const file = join(root, 'installation.json')
    if (!existsSync(file)) throw new Error('Hermes ist noch nicht installiert. scripts/install-hermes.ps1 mit dem Hermes-ZIP ausführen.')
    const manifest = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as { python: string; source: string; profile: string }
    if (!existsSync(manifest.python) || !existsSync(join(manifest.source, 'hermes_cli', 'main.py'))) throw new Error('Die Hermes-Installation ist unvollständig.')
    const url = new URL(hermesBase(getSettings().hermes.baseUrl))
    if (url.pathname !== '/' || url.protocol !== 'http:') throw new Error('Für den verwalteten Start eine lokale HTTP-Adresse ohne Pfad verwenden.')
    const key = getSecret('hermes') ?? randomBytes(32).toString('hex')
    if (!getSecret('hermes')) setSecret('hermes', key)
    const env: NodeJS.ProcessEnv = {}
    for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC']) {
      if (process.env[name]) env[name] = process.env[name]
    }
    Object.assign(env, { HERMES_HOME: manifest.profile, API_SERVER_KEY: key,
      API_SERVER_HOST: url.hostname === '[::1]' ? '::1' : url.hostname, API_SERVER_PORT: url.port || '80', PYTHONUTF8: '1' })
    const processChild = spawn(manifest.python, ['-m', 'hermes_cli.main', 'gateway', 'run'], {
      cwd: manifest.source, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']
    })
    child = processChild
    ownedInstallation = manifest
    ownedBase = requestedBase
    let spawnError = ''
    processChild.on('error', error => { spawnError = error.message })
    // Drain stderr without copying upstream logs or credentials into the UI.
    processChild.stderr?.on('data', () => {})
    processChild.once('exit', () => { if (child === processChild) { child = null; ownedInstallation = null; ownedBase = '' } })
    for (let attempt = 0; attempt < 90; attempt++) {
      if (spawnError) throw new Error(`Hermes konnte nicht gestartet werden: ${spawnError}`)
      if (processChild.exitCode !== null) throw new Error(`Hermes wurde beim Start beendet (${processChild.exitCode}). Hermes-Profilprotokoll prüfen.`)
      await new Promise(resolve => setTimeout(resolve, 1000))
      if (generation !== currentGeneration) return cancelled
      const health = await hermesHealth()
      if (generation !== currentGeneration) return cancelled
      if (health.ok) return { ok: true, detail: 'Hermes-Gateway läuft lokal. Modellzugänge und zusätzliche Kanäle werden im Hermes-Profil eingerichtet.' }
    }
    return { ok: false, detail: 'Hermes startet noch oder sein Gateway ist nicht erreichbar. Verbindung erneut prüfen.' }
  } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : String(error) } }
}

export function stopHermesGateway(): Promise<void> {
  generation++
  if (stopping) return stopping
  const current = child
  const manifest = ownedInstallation
  child = null
  ownedInstallation = null
  ownedBase = ''
  if (!current?.pid) return Promise.resolve()
  const requestStop = async (): Promise<void> => {
    if (process.platform !== 'win32' || !manifest) { current.kill(); return }
    // Hermes' Windows marker includes PID + process start time. Use its own
    // writer, scoped to this profile; never invoke the CLI's orphan sweep.
    await new Promise<void>(resolve => {
      const env: NodeJS.ProcessEnv = { HERMES_HOME: manifest.profile, PYTHONUTF8: '1' }
      for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC']) {
        if (process.env[name]) env[name] = process.env[name]
      }
      const helper = spawn(manifest.python, ['-c', 'import sys; from gateway.status import write_planned_stop_marker; write_planned_stop_marker(int(sys.argv[1]))', String(current.pid)], {
        cwd: manifest.source, env, windowsHide: true, stdio: 'ignore'
      })
      const timeout = setTimeout(() => { helper.kill(); resolve() }, 2_000)
      helper.once('exit', () => { clearTimeout(timeout); resolve() })
      helper.once('error', () => { clearTimeout(timeout); resolve() })
    })
  }
  const forceStop = async (): Promise<void> => {
    if (process.platform !== 'win32') { current.kill('SIGKILL'); return }
    await new Promise<void>(resolve => {
      const killer = spawn('taskkill', ['/PID', String(current.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      const timeout = setTimeout(() => { killer.kill(); current.kill(); resolve() }, 2_000)
      killer.once('exit', () => { clearTimeout(timeout); resolve() })
      killer.once('error', () => { clearTimeout(timeout); current.kill(); resolve() })
    })
  }
  stopping = stopOwnedChild(current, requestStop, forceStop).finally(() => { stopping = null })
  return stopping
}
