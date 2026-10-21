import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { Database } from 'node-sqlite3-wasm'
import { gunzipSync } from 'node:zlib'
import type { RecoveryPreview, RecoveryProfileResult } from '@shared/recovery'
import { DEFAULT_SETTINGS } from '@shared/config/defaults'
import { validateSettingsPatch } from '@shared/config/validation'

const BACKUP_FILE = /^(automatic-\d{4}-\d{2}-\d{2}|manual-\d+-[a-f0-9-]+)\.james-backup\.json\.gz$/
const MAX_COMPRESSED_BYTES = 96 * 1024 * 1024
const MAX_JSON_BYTES = 96 * 1024 * 1024
const MAX_DATABASE_BYTES = 64 * 1024 * 1024
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'binary')
const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TABLES = new Set(['memories', 'conversations', 'reminders', 'actions', 'schedules', 'price_watches', 'price_history', 'research_runs', 'costs', 'timers', 'contacts', 'token_savings', 'incidents'])
const REQUIRED_TABLES = ['memories', 'conversations', 'reminders', 'actions', 'schedules']

interface BackupPayload {
  format: 'void-james-backup'
  version: 1
  createdAt: number
  appVersion: string
  settings: Record<string, any>
  skills?: unknown
  database: { encoding: 'base64'; sqlite: string }
  excluded?: string[]
}

function backupDirectory(): string {
  const dir = join(app.getPath('userData'), 'backups')
  const stat = (() => { try { return lstatSync(dir) } catch { return null } })()
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('Der Sicherungsordner ist kein sicherer lokaler Ordner.')
  if (!stat) mkdirSync(dir, { recursive: true })
  return dir
}

function getBackupFile(fileName: string): { path: string; bytes: Buffer } {
  if (typeof fileName !== 'string' || basename(fileName) !== fileName || !BACKUP_FILE.test(fileName)) {
    throw new Error('Ungültiger lokaler Sicherungsname.')
  }
  const file = join(backupDirectory(), fileName)
  const before = lstatSync(file)
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > MAX_COMPRESSED_BYTES) {
    throw new Error('Die Sicherung ist keine zulässige reguläre Datei oder überschreitet die Größenbegrenzung.')
  }
  const bytes = readFileSync(file)
  const after = lstatSync(file)
  if (!after.isFile() || after.isSymbolicLink() || before.ino !== after.ino || before.size !== after.size || bytes.length !== after.size) {
    throw new Error('Die Sicherungsdatei wurde während des Lesens verändert.')
  }
  return { path: file, bytes }
}

function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }

function parseBackup(bytes: Buffer): { payload: BackupPayload; database: Buffer; tables: string[] } {
  let json: Buffer
  try { json = gunzipSync(bytes, { maxOutputLength: MAX_JSON_BYTES }) }
  catch { throw new Error('Sicherung ist beschädigt oder überschreitet die zulässige Entpackgröße.') }
  let value: unknown
  try { value = JSON.parse(json.toString('utf8')) }
  catch { throw new Error('Sicherungsinhalt ist kein gültiges JSON.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unbekanntes Sicherungsformat.')
  const p = value as Partial<BackupPayload>
  // Version 2 has no implemented, validated extras schema yet. Do not treat it
  // as v1 or silently ignore fields that might later carry restorable data.
  if (p.format !== 'void-james-backup' || p.version !== 1) throw new Error('Nicht unterstütztes Sicherungsformat oder Version.')
  if (!Number.isFinite(p.createdAt) || typeof p.appVersion !== 'string' || !p.settings || typeof p.settings !== 'object' || Array.isArray(p.settings)) throw new Error('Sicherungsmetadaten sind ungültig.')
  sanitizeSettings(p.settings as Record<string, any>)
  if (!p.database || p.database.encoding !== 'base64' || typeof p.database.sqlite !== 'string' || p.database.sqlite.length > Math.ceil(MAX_DATABASE_BYTES / 3) * 4 + 8 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.database.sqlite)) throw new Error('Datenbank fehlt oder ist kein kanonisches Base64.')
  const database = Buffer.from(p.database.sqlite, 'base64')
  if (database.toString('base64') !== p.database.sqlite || database.length < 100 || database.length > MAX_DATABASE_BYTES || !database.subarray(0, 16).equals(SQLITE_HEADER)) throw new Error('Datenbankgröße oder SQLite-Kennung ist ungültig.')
  const tables = inspectDatabase(database)
  return { payload: p as BackupPayload, database, tables }
}

function inspectDatabase(databaseBytes: Buffer): string[] {
  const temp = join(app.getPath('temp'), `james-recovery-check-${randomUUID()}.db`)
  writeFileSync(temp, databaseBytes, { flag: 'wx', mode: 0o600 })
  let db: Database | null = null
  try {
    db = new Database(temp, { readOnly: true })
    const check = db.get('PRAGMA integrity_check') as { integrity_check?: unknown } | undefined
    if (check?.integrity_check !== 'ok') throw new Error('SQLite-Integritätsprüfung fehlgeschlagen.')
    const objects = db.all("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'") as Array<{ type: string; name: string }>
    const tables = objects.filter(x => x.type === 'table').map(x => x.name).sort()
    if (objects.some(x => !['table', 'index'].includes(x.type)) || tables.some(name => !TABLES.has(name)) || REQUIRED_TABLES.some(name => !tables.includes(name))) {
      throw new Error('Datenbank enthält ein unbekanntes Schema, Views oder Trigger; Import wird abgebrochen.')
    }
    return tables
  } finally {
    try { db?.close() } finally { rmSync(temp, { force: true }) }
  }
}

function sanitizeSettings(source: Record<string, any>): Record<string, any> {
  // Start from known application defaults. Copy only low-risk presentation and
  // audio preferences; imported URLs, commands, paths, keys, tokens, service
  // configuration and unknown fields never enter the recovered profile.
  const settings = structuredClone(DEFAULT_SETTINGS) as Record<string, any>
  const scalarKeys: Record<string, string[]> = {
    personality: ['humor', 'address', 'name'],
    audio: ['echoCancellation', 'noiseSuppression', 'autoGainControl', 'outputEqEnabled', 'outputHighShelfGainDb', 'outputCompressorEnabled', 'outputGain', 'jitterBufferMs', 'halfDuplex'],
    vad: ['silenceDurationMs', 'prefixPaddingMs', 'startSensitivity', 'endSensitivity', 'localGateEnabled', 'localGateThreshold']
  }
  const copyGroup = (group: string): void => {
    const input = source[group]
    if (input === undefined) return
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`Ungültige importierte Einstellungen: ${group}.`)
    for (const key of scalarKeys[group] ?? []) {
      if (Object.hasOwn(input, key)) settings[group][key] = input[key]
    }
  }
  for (const key of ['language', 'persona', 'assistantRole']) {
    if (Object.hasOwn(source, key)) settings[key] = source[key]
  }
  for (const group of Object.keys(scalarKeys)) copyGroup(group)

  // An isolated profile must not start background services or inherit remote
  // providers. Local speech remains available on explicit user action only.
  settings.brainProvider = 'ollama'
  settings.speech.provider = 'piper'
  settings.speech.hearProvider = 'whisper'
  settings.speech.thinkProvider = 'ollama'
  settings.automaticBackups = false
  settings.launchOnStartup = false
  settings.mcpServers = []
  settings.learnSkills = false
  settings.gamingMode = true
  settings.diagnosticReporting.enabled = false
  settings.diagnosticReporting.automatic = false
  settings.diagnosticReporting.capabilityGaps = false
  settings.diagnosticReporting.url = ''
  settings.wake.enabled = false
  settings.wake.clap = false
  settings.wake.pushToTalkHotkey = ''
  settings.wake.pauseHotkey = ''
  settings.companion.enabled = false
  settings.sip.enabled = false
  settings.telephony.incoming = false
  settings.telephony.conversation = false
  settings.alexa.enabled = false
  settings.localFallback.enabled = false
  validateSettingsPatch(settings)
  return settings
}

/** Parse and validate one exact local backup; no imported data is applied to the running profile. */
export function previewRecovery(fileName: string): RecoveryPreview {
  const { bytes } = getBackupFile(fileName)
  const { payload, database, tables } = parseBackup(bytes)
  return {
    fileName, digest: sha256(bytes), backupFormat: payload.format, backupVersion: payload.version,
    createdAt: payload.createdAt, appVersion: payload.appVersion, compressedBytes: bytes.length,
    databaseBytes: database.length, integrity: 'ok', tables,
    included: ['SQLite-Datenbank', 'Einstellungen: nur ausgewählte UI-/Persönlichkeits-/Audio-Präferenzen; übrige Werte kommen aus sicheren Defaults', 'Fertigkeiten nur als passives recovered-skills.json-Archiv; sie werden nicht geladen oder ausgeführt'],
    excluded: ['Keystore und Zugangsschlüssel', 'OAuth-Tokens', 'MCP-Server einschließlich Befehlen, Argumenten, Headern und Umgebungswerten', 'Hermes-Profil', 'Protokolle', 'Arbeitskontext, Board, Aufgaben, Kalenderfreigabe und Feature-Packs (nicht in Backup-Version 1 enthalten)'],
    warnings: ['Es wird ein neues, getrenntes Recovery-Profil angelegt. Das aktuell verwendete Profil wird nicht verändert.', 'Scheduler, Alexa, Telefonie, Fernbedienung, Wakeword/Hotkeys, Autostart, Diagnosen, automatische Backups und MCP-Server bleiben deaktiviert. Spracheingabe/-ausgabe ist auf Whisper/Ollama/Piper voreingestellt; es wird kein Hintergrunddienst gestartet.', 'Der Import verändert keine Live-Datenbank und führt keine SQL-Skripte aus. Nur Backup-Version 1 wird unterstützt; Version 2 wird abgelehnt, bis ihr Schema vollständig validiert ist.']
  }
}

/** Create a new, isolated Electron userData tree. Caller must obtain explicit confirmation first. */
export function createRecoveryProfile(fileName: string, expectedDigest: string, confirmed: true): RecoveryProfileResult {
  if (confirmed !== true) throw new Error('Die ausdrückliche Bestätigung fehlt.')
  if (!/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error('Ungültige Vorschau-Prüfsumme; bitte erneut prüfen.')
  const { bytes } = getBackupFile(fileName)
  const digest = sha256(bytes)
  if (digest !== expectedDigest) throw new Error('Die Sicherungsdatei hat sich seit der Vorschau verändert; bitte erneut prüfen.')
  const { payload, database } = parseBackup(bytes)
  const profileId = randomUUID()
  if (!PROFILE_ID.test(profileId)) throw new Error('Recovery-Profilkennung ungültig.')
  const root = join(app.getPath('appData'), 'james-recovery-profiles')
  const rootStat = (() => { try { return lstatSync(root) } catch { return null } })()
  if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink())) throw new Error('Recovery-Profilordner ist kein sicherer Ordner.')
  if (!rootStat) mkdirSync(root, { recursive: true, mode: 0o700 })
  const stage = join(root, `.${profileId}.staging`)
  const target = join(root, profileId)
  try { lstatSync(target); throw new Error('Recovery-Zielprofil existiert bereits; es wird nichts überschrieben.') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  let published = false
  mkdirSync(stage, { recursive: false, mode: 0o700 })
  try {
    const data = join(stage, 'data')
    mkdirSync(data, { mode: 0o700 })
    writeFileSync(join(data, 'jarvis.db'), database, { flag: 'wx', mode: 0o600 })
    // Disable SQL-backed schedules before any normal app code can consume them.
    const imported = new Database(join(data, 'jarvis.db'))
    try {
      const available = new Set((imported.all("SELECT name FROM sqlite_master WHERE type='table'") as Array<{name:string}>).map(row => row.name))
      if (available.has('schedules')) imported.run('UPDATE schedules SET active = 0')
      if (available.has('price_watches')) imported.run('UPDATE price_watches SET active = 0')
    } finally { imported.close() }
    writeFileSync(join(stage, 'settings.json'), JSON.stringify(sanitizeSettings(payload.settings), null, 2), { flag: 'wx', mode: 0o600 })
    if (payload.skills !== undefined) writeFileSync(join(stage, 'recovered-skills.json'), JSON.stringify(payload.skills), { flag: 'wx', mode: 0o600 })
    const marker = { format: 'james-recovery-profile', version: 1, id: profileId, createdAt: Date.now(), sourceFile: fileName, sourceDigest: digest, sourceBackupVersion: payload.version, safeMode: true }
    writeFileSync(join(stage, '.james-recovery.json'), JSON.stringify(marker, null, 2), { flag: 'wx', mode: 0o600 })
    // Validate generated marker/layout before publishing the directory atomically.
    const check = JSON.parse(readFileSync(join(stage, '.james-recovery.json'), 'utf8'))
    if (check.format !== 'james-recovery-profile' || check.id !== profileId || check.sourceDigest !== digest || check.safeMode !== true) throw new Error('Recovery-Marker konnte nicht validiert werden.')
    renameSync(stage, target)
    published = true
    return { profileId, digest, directory: target, launchArgument: `--james-recovery-profile=${profileId}` }
  } catch (error) {
    rmSync(stage, { recursive: true, force: true })
    if (published) rmSync(target, { recursive: true, force: true })
    throw error
  }
}

/** Relaunch only after a separate explicit user action and only into our exact marked profile. */
export function activateRecoveryProfile(profileId: string, confirmed: true): void {
  if (confirmed !== true || !PROFILE_ID.test(profileId)) throw new Error('Ungültige oder nicht bestätigte Recovery-Aktivierung.')
  const directory = join(app.getPath('appData'), 'james-recovery-profiles', profileId)
  const dirStat = lstatSync(directory)
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('Recovery-Profilordner fehlt oder ist unsicher.')
  const markerFile = join(directory, '.james-recovery.json')
  const markerStat = lstatSync(markerFile)
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 4096) throw new Error('Recovery-Profilmarker fehlt oder ist unsicher.')
  const marker = JSON.parse(readFileSync(markerFile, 'utf8')) as Record<string, unknown>
  if (marker.format !== 'james-recovery-profile' || marker.version !== 1 || marker.id !== profileId || marker.safeMode !== true || typeof marker.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(marker.sourceDigest)) throw new Error('Recovery-Profilmarker ist ungültig.')
  const argument = `--james-recovery-profile=${profileId}`
  const args = process.argv.slice(1).filter(value => !value.startsWith('--james-recovery-profile=') && value !== '--user-data-dir' && !value.startsWith('--user-data-dir='))
  app.relaunch({ args: [...args, argument] })
  app.quit()
}
