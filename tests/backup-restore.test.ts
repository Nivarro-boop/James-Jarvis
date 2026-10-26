import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
const fs = require('node:fs') as typeof import('node:fs')
import { app } from 'electron'
import { createBackup } from '@main/store/backups'
import { inspectBackup, stageRestore, applyPendingRestore, restorePending, cancelRestore } from '@main/store/restore'
import { appendTranscript, searchTranscript, closeDb } from '@main/db'
import { setSettings } from '@main/store/settings'

it('round-trips database, study progress, projects and work context while retaining credentials', async t => {
  const root = mkdtempSync(join(tmpdir(), 'james-restore-'))
  t.mock.method(app, 'getPath', () => root)
  t.after(() => { closeDb(); rmSync(root, { recursive: true, force: true }) })
  setSettings({ dailyBriefing: false, pcProfile: false, useDeviceLocation: false, diagnosticReporting: { enabled: false, automatic: false, capabilityGaps: false, url: '' } })
  mkdirSync(join(root, 'gehirn', 'projekte'), { recursive: true })
  mkdirSync(join(root, 'secure'))
  writeFileSync(join(root, 'secure', 'secrets.bin'), 'unchanged synthetic credentials')
  const project = join(root, 'gehirn', 'projekte', 'alpha.md')
  writeFileSync(project, '# Alpha\nOriginal project')
  writeFileSync(join(root, 'working-context.json'), JSON.stringify({ goal: 'Original task', status: 'paused' }))
  const study = { version: 1, decks: [{ id: 'a', title: 'Alpha', created: 1, cards: [{ id: 'c', question: 'Q', answer: 'A', box: 3, due: 1234, right: 8, wrong: 2 }] }] }
  writeFileSync(join(root, 'study.json'), JSON.stringify(study))
  appendTranscript('user', 'backup-original-message')
  const backup = await createBackup()
  appendTranscript('user', 'backup-newer-message')
  writeFileSync(project, '# Modified')
  const inspected = inspectBackup(backup.file, root)
  stageRestore(root, inspected.files)
  assert.equal(restorePending(root), true)
  assert.throws(() => stageRestore(root, inspected.files), /bereits/)
  closeDb()
  assert.equal(applyPendingRestore(root), true)
  assert.equal(restorePending(root), false)
  assert.match(readFileSync(project, 'utf8'), /Original project/)
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'study.json'), 'utf8')), study)
  assert.equal(searchTranscript('backup-original-message').length, 1)
  assert.equal(searchTranscript('backup-newer-message').length, 0)
  assert.equal(readFileSync(join(root, 'secure', 'secrets.bin'), 'utf8'), 'unchanged synthetic credentials')
  assert.ok(readdirSync(join(root, 'backups')).some(name => name.startsWith('before-restore-')))

  // Historical version-1 backups did not contain supplementary files.
  const payload = JSON.parse(gunzipSync(readFileSync(backup.file)).toString())
  delete payload.files; delete payload.filesVersion
  const legacy = join(root, 'legacy.gz')
  writeFileSync(legacy, gzipSync(JSON.stringify(payload)))
  assert.ok(inspectBackup(legacy, root).files['study.json'])
  payload.study.decks[0].cards[0].box = -1
  writeFileSync(legacy, gzipSync(JSON.stringify(payload)))
  const before = readFileSync(project)
  assert.throws(() => inspectBackup(legacy, root))
  assert.deepEqual(readFileSync(project), before)
  assert.throws(() => stageRestore(root, { '../outside': 'dGVzdA==' }), /Ungültiger/)
  stageRestore(root, inspected.files); cancelRestore(root)
  assert.equal(restorePending(root), false)
})

it('recovers a write-ahead journal before starting application services', t => {
  const root = mkdtempSync(join(tmpdir(), 'james-restore-crash-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'settings.json'), 'partial replacement')
  writeFileSync(join(root, '.restore-journal.json'), JSON.stringify({ 'settings.json': Buffer.from('original').toString('base64') }))
  assert.equal(applyPendingRestore(root), false)
  assert.equal(readFileSync(join(root, 'settings.json'), 'utf8'), 'original')
})

it('rolls back a partially written restore and does not retry a failed restore every startup', t => {
  const root = mkdtempSync(join(tmpdir(), 'james-restore-write-error-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const original = JSON.stringify({ language: 'de-DE' })
  writeFileSync(join(root, 'settings.json'), original)
  writeFileSync(join(root, 'study.json'), 'original study')
  stageRestore(root, { 'settings.json': Buffer.from('{"language":"en-US"}').toString('base64'), 'study.json': Buffer.from('replacement study').toString('base64') })
  const rename = fs.renameSync
  let failed = false
  t.mock.method(fs, 'renameSync', (from: string, to: string) => {
    if (!failed && to.endsWith('study.json')) { failed = true; throw new Error('synthetic disk error') }
    return rename(from, to)
  })
  assert.throws(() => applyPendingRestore(root), /synthetic disk error/)
  assert.equal(readFileSync(join(root, 'settings.json'), 'utf8'), original)
  assert.equal(readFileSync(join(root, 'study.json'), 'utf8'), 'original study')
  assert.equal(restorePending(root), false)
  assert.equal(applyPendingRestore(root), false)
})
