import assert from 'node:assert/strict'
import { it } from 'node:test'
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { Database } from 'node-sqlite3-wasm'
import { createBackup } from '@main/store/backups'
import { closeDb } from '@main/db'
import { getSettings, setSettings } from '@main/store/settings'
import { previewRecovery, createRecoveryProfile } from '@main/store/recovery'

const backupName = /^manual-\d+-[a-f0-9-]+\.james-backup\.json\.gz$/

it('previews and restores only into a separate safe profile; digest confirmation binds exact backup bytes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'james-recovery-'))
  t.mock.method(app, 'getPath', () => root)
  t.after(() => { closeDb(); rmSync(root, {recursive:true,force:true}) })
  setSettings({automaticBackups:false})
  getSettings().mcpServers = [{id:'secret-test',name:'Secret test',enabled:true,command:'node',args:['--token','arg-secret'],env:{TOKEN:'env-secret'},secretEnv:['TOKEN'],url:'',headers:{}}]
  const backup = await createBackup(false, 1234567890000)
  const filename = backup.file.split(/[\\/]/).pop()!
  assert.match(filename, backupName)
  const originalSettings = readFileSync(join(root, 'settings.json'))
  const exported = JSON.parse(gunzipSync(readFileSync(backup.file)).toString('utf8'))
  assert.deepEqual(exported.settings.mcpServers, [], 'all MCP definitions are excluded, including argv')
  assert.ok(exported.excluded.some((item: string) => item.includes('MCP-Server')))
  assert.ok(!JSON.stringify(exported).includes('arg-secret'))
  assert.ok(!JSON.stringify(exported).includes('env-secret'))
  exported.settings.language = 'en-US'
  exported.settings.audio.outputGain = 1.7
  exported.settings.audio.outputDeviceId = 'do-not-import-device'
  exported.settings.assistantRole = 'calendar'
  exported.settings.brainProvider = 'gemini'
  exported.settings.speech.hearProvider = 'gemini'
  exported.settings.speech.pythonPath = 'C:\\hostile\\python.exe'
  exported.settings.telephony.publicUrl = 'https://hostile.invalid'
  exported.settings.mcpServers = [{command:'evil',args:['embedded-secret']}]
  exported.settings.wake.enabled = true
  exported.settings.wake.clap = true
  exported.settings.wake.pushToTalkHotkey = 'Alt+Space'
  exported.settings.gamingMode = false
  exported.settings.automaticBackups = true
  exported.settings.launchOnStartup = true
  exported.settings.learnSkills = true
  exported.settings.diagnosticReporting.enabled = true
  exported.settings.unknownApiKey = 'must-not-import'
  writeFileSync(backup.file, gzipSync(JSON.stringify(exported)))
  const preview = previewRecovery(filename)
  assert.equal(preview.integrity, 'ok')
  assert.ok(preview.databaseBytes > 100)
  assert.match(preview.digest, /^[a-f0-9]{64}$/)
  assert.ok(preview.included.some(item => item.includes('passives')))
  const bytes = readFileSync(backup.file)
  assert.equal(preview.digest, createHash('sha256').update(bytes).digest('hex'))
  assert.throws(() => createRecoveryProfile(filename, '0'.repeat(64), true), /verändert/)
  const result = createRecoveryProfile(filename, preview.digest, true)
  assert.match(result.profileId, /^[0-9a-f-]{36}$/)
  assert.equal(result.launchArgument, `--james-recovery-profile=${result.profileId}`)
  assert.ok(existsSync(join(result.directory, 'recovered-skills.json')))
  assert.equal(readFileSync(join(root, 'settings.json')).compare(originalSettings), 0, 'active settings remain byte-identical')
  const recoveredSettings = JSON.parse(readFileSync(join(result.directory, 'settings.json'), 'utf8'))
  assert.equal(recoveredSettings.automaticBackups, false)
  assert.equal(recoveredSettings.launchOnStartup, false)
  assert.equal(recoveredSettings.language, 'en-US')
  assert.equal(recoveredSettings.assistantRole, 'calendar')
  assert.equal(recoveredSettings.audio.outputGain, 1.7)
  assert.equal(recoveredSettings.audio.outputDeviceId, null)
  assert.equal(recoveredSettings.brainProvider, 'ollama')
  assert.equal(recoveredSettings.speech.provider, 'piper')
  assert.equal(recoveredSettings.speech.hearProvider, 'whisper')
  assert.equal(recoveredSettings.speech.thinkProvider, 'ollama')
  assert.equal(recoveredSettings.speech.pythonPath, '')
  assert.equal(recoveredSettings.telephony.publicUrl, '')
  assert.equal(recoveredSettings.gamingMode, true)
  assert.equal(recoveredSettings.learnSkills, false)
  assert.equal(recoveredSettings.diagnosticReporting.enabled, false)
  assert.equal(recoveredSettings.diagnosticReporting.url, '')
  assert.equal(recoveredSettings.wake.enabled, false)
  assert.equal(recoveredSettings.wake.clap, false)
  assert.equal(recoveredSettings.wake.pushToTalkHotkey, '')
  assert.equal(recoveredSettings.wake.pauseHotkey, '')
  assert.equal(recoveredSettings.localFallback.enabled, false)
  assert.equal(recoveredSettings.unknownApiKey, undefined)
  assert.equal(JSON.stringify(recoveredSettings).includes('must-not-import'), false)
  assert.equal(recoveredSettings.companion.enabled, false)
  assert.equal(recoveredSettings.sip.enabled, false)
  assert.equal(recoveredSettings.telephony.incoming, false)
  assert.equal(recoveredSettings.telephony.conversation, false)
  assert.equal(recoveredSettings.alexa.enabled, false)
  assert.deepEqual(recoveredSettings.mcpServers, [])
  const db = new Database(join(result.directory, 'data', 'jarvis.db'), {readOnly:true})
  try {
    assert.equal((db.get('PRAGMA integrity_check') as any).integrity_check, 'ok')
    assert.ok((db.all('SELECT active FROM schedules') as any[]).every(row => row.active === 0))
  } finally { db.close() }
})

it('rejects unvalidated settings and backup versions without modifying a profile', async t => {
  const root = mkdtempSync(join(tmpdir(), 'james-recovery-version-'))
  t.mock.method(app, 'getPath', () => root)
  t.after(() => { closeDb(); rmSync(root, {recursive:true,force:true}) })
  const backup = await createBackup(false, 2234567890000)
  const name = backup.file.split(/[\\/]/).pop()!
  const dir = join(root, 'backups')
  const original = JSON.parse(gunzipSync(readFileSync(backup.file)).toString('utf8'))
  const invalidSettingsName = 'manual-2234567890001-abcdef12.james-backup.json.gz'
  writeFileSync(join(dir, invalidSettingsName), gzipSync(JSON.stringify({ ...original, settings: { ...original.settings, audio: { ...original.settings.audio, outputGain: 99 } } })))
  assert.throws(() => previewRecovery(invalidSettingsName), /Wert außerhalb des gültigen Bereichs/)
  const unsupportedName = 'manual-2234567890002-acde1234.james-backup.json.gz'
  writeFileSync(join(dir, unsupportedName), gzipSync(JSON.stringify({ ...original, version: 2, extras: { tasks: [] } })))
  assert.throws(() => previewRecovery(unsupportedName), /Nicht unterstütztes Sicherungsformat/)
  const profiles = join(root, 'james-recovery-profiles')
  assert.ok(!existsSync(profiles) || readdirSync(profiles).length === 0)
  assert.ok(existsSync(join(dir, name)))
})

it('rejects traversal, symlinks, damaged gzip, invalid sqlite and bounded-output gzip bombs', async t => {
  const root = mkdtempSync(join(tmpdir(), 'james-recovery-hostile-'))
  t.mock.method(app, 'getPath', () => root)
  t.after(() => { closeDb(); rmSync(root, {recursive:true,force:true}) })
  const backup = await createBackup()
  const dir = join(root, 'backups')
  const filename = backup.file.split(/[\\/]/).pop()!
  assert.throws(() => previewRecovery(`../${filename}`), /Ungültiger/)
  const linkName = `manual-123-${'a'.repeat(8)}.james-backup.json.gz`
  symlinkSync(backup.file, join(dir, linkName))
  assert.throws(() => previewRecovery(linkName), /reguläre Datei/)
  assert.throws(() => createRecoveryProfile(filename, '0'.repeat(64), true), /verändert/)
  writeFileSync(backup.file, Buffer.from('not gzip'))
  assert.throws(() => previewRecovery(filename), /beschädigt/)
  const bombName = `manual-456-${'b'.repeat(8)}.james-backup.json.gz`
  writeFileSync(join(dir, bombName), gzipSync(Buffer.alloc(97 * 1024 * 1024, 0x41)))
  assert.throws(() => previewRecovery(bombName), /Entpackgröße/)
  const invalidName = `manual-789-${'c'.repeat(8)}.james-backup.json.gz`
  writeFileSync(join(dir, invalidName), gzipSync(JSON.stringify({format:'void-james-backup',version:1,createdAt:1,appVersion:'x',settings:{},database:{encoding:'base64',sqlite:Buffer.from('not sqlite data').toString('base64')}})))
  assert.throws(() => previewRecovery(invalidName), /SQLite-Kennung/)
  assert.ok(readdirSync(dir).includes(filename))
})

it('removes its staging directory on a post-validation restore failure without touching active profile', t => {
  const root = mkdtempSync(join(tmpdir(), 'james-recovery-rollback-'))
  t.mock.method(app, 'getPath', () => root)
  t.after(() => rmSync(root, {recursive:true,force:true}))
  const dir = join(root, 'backups')
  mkdirSync(dir)
  const dbFile = join(root, 'minimal.db')
  const db = new Database(dbFile)
  try { db.exec('CREATE TABLE memories(x); CREATE TABLE conversations(x); CREATE TABLE reminders(x); CREATE TABLE actions(x); CREATE TABLE schedules(x);') }
  finally { db.close() }
  const database = readFileSync(dbFile)
  const name = 'manual-987-abcdef12.james-backup.json.gz'
  writeFileSync(join(dir, name), gzipSync(JSON.stringify({format:'void-james-backup',version:1,createdAt:100,appVersion:'test',settings:{},database:{encoding:'base64',sqlite:database.toString('base64')}})))
  const preview = previewRecovery(name)
  assert.throws(() => createRecoveryProfile(name, preview.digest, true))
  const profiles = join(root, 'james-recovery-profiles')
  assert.ok(!existsSync(profiles) || readdirSync(profiles).length === 0, 'failed stage was rolled back')
})
