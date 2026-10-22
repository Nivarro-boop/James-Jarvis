import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRecoveryProfile } from '../src/main/store/recoveryProfile'
import { isRecoveryIpcAllowed } from '../src/shared/recoverySafety'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'james-recovery-start-test-'))
  const id = randomUUID()
  const directory = join(root, 'james-recovery-profiles', id)
  mkdirSync(join(directory, 'data'), { recursive: true })
  const marker = { format: 'james-recovery-profile', version: 1, id, safeMode: true, sourceDigest: 'a'.repeat(64) }
  writeFileSync(join(directory, '.james-recovery.json'), JSON.stringify(marker))
  writeFileSync(join(directory, 'settings.json'), '{}')
  // The import step separately validates SQLite. This helper validates paths before loading it.
  writeFileSync(join(directory, 'data', 'jarvis.db'), 'fixture')
  return { root, id, directory, marker, args: [`--james-recovery-profile=${id}`], close: () => rmSync(root, { recursive: true, force: true }) }
}

test('ordinary startup keeps default selection and marked recovery selects only its UUID directory', () => {
  const f = fixture()
  try {
    assert.equal(resolveRecoveryProfile(f.root, ['electron', 'main.js']), null)
    assert.deepEqual(resolveRecoveryProfile(f.root, f.args), { id: f.id, directory: f.directory })
  } finally { f.close() }
})

test('invalid, duplicate, missing-value and traversal arguments fail closed', () => {
  const f = fixture()
  try {
    for (const args of [
      ['--james-recovery-profile'], ['--james-recovery-profile='],
      ['--james-recovery-profile=../../original'], [...f.args, ...f.args],
      ['--james-recovery-profile=not-a-uuid']
    ]) assert.throws(() => resolveRecoveryProfile(f.root, args))
    assert.throws(() => resolveRecoveryProfile(f.root, [`--james-recovery-profile=${randomUUID()}`]))
  } finally { f.close() }
})

test('unmarked profiles, mismatched digests and unsafe markers cannot boot', () => {
  const f = fixture()
  try {
    for (const patch of [{ id: randomUUID() }, { safeMode: false }, { version: 2 }, { sourceDigest: 'invalid' }]) {
      writeFileSync(join(f.directory, '.james-recovery.json'), JSON.stringify({ ...f.marker, ...patch }))
      assert.throws(() => resolveRecoveryProfile(f.root, f.args))
    }
    writeFileSync(join(f.directory, '.james-recovery.json'), 'x'.repeat(4097))
    assert.throws(() => resolveRecoveryProfile(f.root, f.args))
    rmSync(join(f.directory, '.james-recovery.json'))
    assert.throws(() => resolveRecoveryProfile(f.root, f.args))
  } finally { f.close() }
})

test('a symlinked imported settings file or profile directory is rejected', { skip: process.platform === 'win32' ? 'Creating symlinks requires privileges on Windows; real path validation is still tested there' : false }, () => {
  const f = fixture()
  try {
    const original = join(f.root, 'original-settings.json')
    writeFileSync(original, '{}')
    rmSync(join(f.directory, 'settings.json'))
    symlinkSync(original, join(f.directory, 'settings.json'))
    assert.throws(() => resolveRecoveryProfile(f.root, f.args), /Recovery/)
    rmSync(join(f.directory, 'settings.json'))
    writeFileSync(join(f.directory, 'settings.json'), '{}')
    const other = join(f.root, 'other-profile')
    mkdirSync(other)
    const otherId = randomUUID()
    symlinkSync(other, join(f.root, 'james-recovery-profiles', otherId), 'dir')
    assert.throws(() => resolveRecoveryProfile(f.root, [`--james-recovery-profile=${otherId}`]), /Recovery/)
  } finally { f.close() }
})

test('recovery denies remote reads, providers, tools, credential access and unknown future channels', () => {
  for (const channel of ['tools:call', 'agent:systemPrompt', 'secrets:get', 'secrets:set', 'secrets:getGeminiForLive', 'secrets:getElevenForLive', 'openai:realtimeSecret', 'settings:set', 'settings:reset', 'workspace:calendar-read', 'accounts:save', 'selfheal:repair', 'app:openGuide', 'future:run']) {
    assert.equal(isRecoveryIpcAllowed(channel, {}), false, channel)
  }
  assert.equal(isRecoveryIpcAllowed('workspace:calendar-enabled', { enabled: true }), false)
  assert.equal(isRecoveryIpcAllowed('workspace:calendar-enabled', null), false)
  assert.equal(isRecoveryIpcAllowed('app:pauseState', { paused: false }), false)
  assert.equal(isRecoveryIpcAllowed('app:pauseState', { paused: true, until: Date.now() + 100 }), false)
})

test('recovery allows local inspection, declarative pack state and deliberate return, not resume', () => {
  for (const channel of ['settings:get', 'context:get', 'activity:get', 'reminder:list', 'workspace:get', 'workspace:task-create', 'workspace:layout-set', 'packs:list', 'packs:toggle', 'backup:create', 'recovery:preview', 'recovery:returnToDefault']) {
    assert.equal(isRecoveryIpcAllowed(channel, {}), true, channel)
  }
  assert.equal(isRecoveryIpcAllowed('workspace:calendar-enabled', { enabled: false }), true)
  assert.equal(isRecoveryIpcAllowed('app:pauseState', { paused: true }), true)
})
