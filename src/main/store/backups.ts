import { app, shell } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, lstatSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { snapshotDb } from '../db'
import { getSettings } from './settings'
import { listSkills } from '../agent/skills'
import { listDecks } from '../study/store'
import type { BackupInfo } from '@shared/types'
import { backupSupplement } from './restore'

const BACKUP_FILE = /^(automatic-\d{4}-\d{2}-\d{2}|manual-\d+-[a-f0-9-]+)\.james-backup\.json\.gz$/
let ticker: NodeJS.Timeout | null = null
let initial: NodeJS.Timeout | null = null
const MAX_DATABASE_BYTES = 64 * 1024 * 1024
const compress = promisify(gzip)
let pending: Promise<void> = Promise.resolve()

function directory(): string {
  const dir = join(app.getPath('userData'), 'backups')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function listBackups(): BackupInfo[] {
  const dir = directory()
  return readdirSync(dir).filter(name => BACKUP_FILE.test(name)).flatMap(name => {
    const file = join(dir, name)
    const stat = lstatSync(file)
    return stat.isFile() ? [{ file, createdAt: stat.mtimeMs, bytes: stat.size, automatic: name.startsWith('automatic-') }] : []
  }).sort((a, b) => b.createdAt - a.createdAt)
}

function localDay(now: number): string {
  const date = new Date(now)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function createBackup(automatic = false, now = Date.now()): Promise<BackupInfo> {
  const next = pending.then(() => snapshot(automatic, now))
  pending = next.then(() => {}, () => {})
  return next
}

async function snapshot(automatic: boolean, now: number): Promise<BackupInfo> {
  const dir = directory()
  const name = automatic ? `automatic-${localDay(now)}` : `manual-${now}-${randomUUID()}`
  const file = join(dir, `${name}.james-backup.json.gz`)
  if (automatic && existsSync(file)) {
    const existing = listBackups().find(item => item.file === file)
    if (!existing) throw new Error('Sicherungsziel ist keine reguläre Datei.')
    return existing
  }
  const databaseFile = join(dir, `snapshot-${randomUUID()}.db`)
  const staging = `${file}.${randomUUID()}.tmp`
  try {
    const source = join(app.getPath('userData'), 'data', 'jarvis.db')
    if (existsSync(source) && lstatSync(source).size > MAX_DATABASE_BYTES) throw new Error('Datenbank größer als 64 MB; bitte manuell extern sichern.')
    snapshotDb(databaseFile)
    const settings = structuredClone(getSettings())
    // MCP environment values may contain credentials; omit their values.
    for (const server of settings.mcpServers) server.env = {}
    const payload = { format: 'void-james-backup', version: 1, createdAt: now,
      appVersion: app.getVersion(), settings, skills: listSkills(),
      study: { version: 1, decks: listDecks() },
      filesVersion: 1, files: backupSupplement(app.getPath('userData')),
      database: { encoding: 'base64', sqlite: readFileSync(databaseFile).toString('base64') },
      excluded: ['Keystore', 'OAuth-Tokens', 'MCP-Umgebungswerte', 'Browser-Sitzungen', 'Health-Werte', 'Sprachmodelle', 'Protokolldateien'] }
    const compressed = await compress(JSON.stringify(payload))
    writeFileSync(staging, compressed, { flag: 'wx', flush: true })
    renameSync(staging, file)
    if (automatic) for (const old of listBackups().filter(item => item.automatic)
      .sort((a,b) => basename(b.file).localeCompare(basename(a.file))).slice(7)) unlinkSync(old.file)
    return listBackups().find(item => item.file === file)!
  } finally {
    for (const temporary of [databaseFile, staging]) {
      try { unlinkSync(temporary) } catch { /* file may not have been created */ }
    }
  }
}

export async function ensureDailyBackup(now = Date.now()): Promise<void> {
  if (!getSettings().automaticBackups) return
  try { await createBackup(true, now) }
  catch (error) { console.warn('[backup] Automatische Sicherung fehlgeschlagen:', error) }
}

export function startBackups(): void {
  if (ticker) return
  initial = setTimeout(() => { initial = null; void ensureDailyBackup() }, 5000)
  initial.unref()
  ticker = setInterval(() => { void ensureDailyBackup() }, 60 * 60_000)
  ticker.unref()
}
export function stopBackups(): void {
  if (initial) clearTimeout(initial)
  if (ticker) clearInterval(ticker)
  initial = null; ticker = null
}
export function revealBackups(): void { void shell.openPath(directory()) }
export function flushBackups(): Promise<void> { return pending }
