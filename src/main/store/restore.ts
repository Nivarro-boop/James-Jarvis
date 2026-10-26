import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { Database } from 'node-sqlite3-wasm'
import { validateSettingsPatch } from '@shared/config/validation'
import { studyStoreSchema } from '../study/store'
import { serializeSkill } from '../agent/skills'

const MAX_PAYLOAD = 128 * 1024 ** 2
const PENDING = '.restore-pending.json', JOURNAL = '.restore-journal.json'
type Files = Record<string, string | null>
function supplementary(name: string): boolean {
  return ['working-context.json', 'pc-profile.json', 'gehirn/widgets.json'].includes(name) || /^gehirn\/(projekte|notizen)\/.+\.md$/.test(name)
}
function safeName(name: string): boolean {
  return !/[\\:\0]/.test(name) && name.split('/').every(p => p && p !== '.' && p !== '..') &&
    (['settings.json', 'study.json', 'data/jarvis.db', 'data/jarvis.db-wal', 'data/jarvis.db-shm'].includes(name) || /^skills\/[a-z0-9-]+\.md$/.test(name) || supplementary(name))
}
function target(root: string, name: string): string {
  if (!safeName(name)) throw new Error('Ungültiger Dateipfad in der Sicherung.')
  let current = root
  for (const part of name.split('/')) {
    current = join(current, part)
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Wiederherstellung über Verknüpfungen wird abgelehnt.')
  }
  return current
}
function atomic(file: string, data: string | Buffer): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  try { writeFileSync(temp, data, { flag: 'wx', flush: true }); renameSync(temp, file) }
  finally { rmSync(temp, { force: true }) }
}
function entries(value: unknown): Files {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 2500) throw new Error('Ungültiger Sicherungsbestand.')
  let bytes = 0
  const clean: Files = {}
  for (const [name, data] of Object.entries(value)) {
    if (!safeName(name) || (data !== null && typeof data !== 'string')) throw new Error('Ungültiger Sicherungseintrag.')
    if (data !== null) {
      const decoded = Buffer.from(data as string, 'base64')
      if (decoded.toString('base64') !== data) throw new Error('Ungültige Dateikodierung.')
      bytes += decoded.length
    }
    if (bytes > MAX_PAYLOAD) throw new Error('Sicherung ist zu groß.')
    clean[name] = data as string | null
  }
  return clean
}
function apply(root: string, files: Files): void {
  // Check every destination before replacing any of them.
  for (const name of Object.keys(files)) target(root, name)
  for (const [name, data] of Object.entries(files)) {
    const file = target(root, name)
    if (data === null) rmSync(file, { force: true })
    else atomic(file, Buffer.from(data, 'base64'))
  }
}

/** Deliberate allowlist; credentials, browser sessions, logs and Health stay excluded. */
export function backupSupplement(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  let total = 0
  const collect = (name: string): void => {
    const file = target(root, name)
    if (!existsSync(file)) return
    const info = lstatSync(file)
    if (!info.isFile() || info.size > 2 * 1024 ** 2 || Object.keys(files).length >= 2000 || (total += info.size) > 16 * 1024 ** 2) throw new Error('Zusätzliche Projektdaten überschreiten die Sicherungsgrenze.')
    files[name] = readFileSync(file).toString('base64')
  }
  for (const name of ['working-context.json', 'pc-profile.json', 'gehirn/widgets.json']) collect(name)
  const walk = (name: string, depth: number): void => {
    const dir = join(root, name)
    if (!existsSync(dir)) return
    if (lstatSync(dir).isSymbolicLink()) throw new Error('Projektverzeichnis ist eine Verknüpfung; bitte separat sichern.')
    if (depth > 8) throw new Error('Projektverzeichnis ist zu tief verschachtelt.')
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new Error('Projektdatei ist eine Verknüpfung; bitte separat sichern.')
      const path = `${name}/${item.name}`
      if (item.isDirectory()) walk(path, depth + 1)
      else if (item.name.endsWith('.md')) collect(path)
    }
  }
  walk('gehirn/projekte', 0); walk('gehirn/notizen', 0)
  return files
}

export function inspectBackup(path: string, root: string): { files: Files; createdAt: number; appVersion: string } {
  if (lstatSync(path).size > 64 * 1024 ** 2) throw new Error('Sicherungsdatei ist zu groß.')
  const payload = JSON.parse(gunzipSync(readFileSync(path), { maxOutputLength: MAX_PAYLOAD }).toString('utf8'))
  if (payload?.format !== 'void-james-backup' || payload.version !== 1 || !Number.isFinite(payload.createdAt) || !payload.settings || typeof payload.settings !== 'object') throw new Error('Unbekanntes Sicherungsformat.')
  validateSettingsPatch(payload.settings)
  const files: Files = { 'settings.json': Buffer.from(JSON.stringify(payload.settings, null, 2)).toString('base64') }
  if (payload.study !== undefined) files['study.json'] = Buffer.from(JSON.stringify(studyStoreSchema.parse(payload.study))).toString('base64')
  if (!Array.isArray(payload.skills) || payload.skills.length > 200) throw new Error('Ungültige Fertigkeiten in der Sicherung.')
  for (const skill of payload.skills) {
    if (!skill || typeof skill.slug !== 'string' || !/^[a-z0-9-]+$/.test(skill.slug) || typeof skill.name !== 'string' || typeof skill.description !== 'string' || typeof skill.steps !== 'string' || skill.steps.length > 6000 || !['auto', 'manual'].includes(skill.source) || !Number.isSafeInteger(skill.uses) || skill.uses < 0 || typeof skill.updated !== 'string') throw new Error('Ungültige Fertigkeit in der Sicherung.')
    files[`skills/${skill.slug}.md`] = Buffer.from(serializeSkill(skill)).toString('base64')
  }
  if (payload.files !== undefined) {
    if (payload.filesVersion !== 1) throw new Error('Unbekanntes Projektdateiformat.')
    for (const [name, data] of Object.entries(entries(payload.files))) {
      if (!supplementary(name) || data === null) throw new Error('Unerlaubte zusätzliche Sicherungsdatei.')
      if (name.endsWith('.json')) JSON.parse(Buffer.from(data, 'base64').toString('utf8'))
      files[name] = data
    }
  }
  if (payload.database?.encoding !== 'base64' || typeof payload.database.sqlite !== 'string') throw new Error('Datenbank fehlt in der Sicherung.')
  const db = Buffer.from(payload.database.sqlite, 'base64')
  if (db.length > 64 * 1024 ** 2 || db.subarray(0, 16).toString() !== 'SQLite format 3\0') throw new Error('Ungültige Sicherungsdatenbank.')
  const scratch = join(root, 'backups', `verify-${randomUUID()}.db`)
  mkdirSync(dirname(scratch), { recursive: true })
  try {
    writeFileSync(scratch, db)
    const database = new Database(scratch, { readOnly: true, fileMustExist: true })
    try { database.exec('PRAGMA trusted_schema=OFF'); if (database.get('PRAGMA integrity_check')?.integrity_check !== 'ok') throw new Error('Datenbankprüfung fehlgeschlagen.') }
    finally { database.close() }
  } finally { rmSync(scratch, { force: true }) }
  files['data/jarvis.db'] = db.toString('base64')
  files['data/jarvis.db-wal'] = null; files['data/jarvis.db-shm'] = null
  return { files: entries(files), createdAt: payload.createdAt, appVersion: String(payload.appVersion ?? '') }
}

export function stageRestore(root: string, files: Files): void {
  if (existsSync(join(root, PENDING))) throw new Error('Eine Wiederherstellung ist bereits vorgemerkt. Bitte James neu starten oder sie abbrechen.')
  const clean = entries(files)
  for (const name of Object.keys(clean)) target(root, name)
  // Existing secret environment values are deliberately not restored from backups.
  const current = join(root, 'settings.json')
  if (existsSync(current) && clean['settings.json']) {
    const old = JSON.parse(readFileSync(current, 'utf8'))
    const next = JSON.parse(Buffer.from(clean['settings.json'], 'base64').toString('utf8'))
    for (const server of next.mcpServers ?? []) {
      const match = old.mcpServers?.find((s: { id: string }) => s.id === server.id)
      server.env = match?.env ?? {}
    }
    clean['settings.json'] = Buffer.from(JSON.stringify(next, null, 2)).toString('base64')
  }
  atomic(join(root, PENDING), JSON.stringify(clean))
}
export function cancelRestore(root: string): void { rmSync(join(root, PENDING), { force: true }) }
export function restorePending(root: string): boolean { return existsSync(join(root, PENDING)) }

/** Run before opening SQLite or loading settings. Crash recovery rolls back first. */
export function applyPendingRestore(root: string): boolean {
  const journal = join(root, JOURNAL), pending = join(root, PENDING)
  if (existsSync(journal)) {
    apply(root, entries(JSON.parse(readFileSync(journal, 'utf8'))))
    rmSync(journal)
  }
  if (!existsSync(pending)) return false
  const files = entries(JSON.parse(readFileSync(pending, 'utf8'))), previous: Files = {}
  for (const name of Object.keys(files)) {
    const file = target(root, name)
    previous[name] = existsSync(file) ? readFileSync(file).toString('base64') : null
  }
  entries(previous)
  atomic(join(root, 'backups', `before-restore-${Date.now()}.json`), JSON.stringify(previous))
  atomic(journal, JSON.stringify(previous))
  try { apply(root, files) }
  catch (error) {
    apply(root, previous)
    renameSync(pending, join(root, 'backups', `failed-restore-${Date.now()}.json`))
    rmSync(journal)
    throw error
  }
  rmSync(pending); rmSync(journal)
  return true
}
