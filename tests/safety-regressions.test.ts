import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app, safeStorage } from 'electron'
import { clearChallenges, issueChallenge, verifyConfirmation } from '@main/tools/permissions'
import { validateSettingsPatch } from '@shared/config/validation'
import { DEFAULT_SETTINGS } from '@shared/config/defaults'
import { getSettings, setSettings } from '@main/store/settings'
import { closeDb } from '@main/db'
import { checkBudget, reserveBudget } from '@main/agent/budget'
import { getSecret, setSecret } from '@main/secrets/keystore'

describe('Ausdrückliche Zustimmung', () => {
  for (const text of ['Wie spät ist es?', '', 'vielleicht', 'ja, aber an jemand anderen', 'ja?', 'nein', 'warte']) {
    it(`gibt eine Aktion bei „${text}“ nicht frei`, () => {
      clearChallenges()
      issueChallenge('gmail_send', { to: 'test@example.invalid' }, 'Testfrage')
      assert.equal(verifyConfirmation('gmail_send', { to: 'test@example.invalid' }, {
        lastUserText: text, lastUserTextAt: Date.now()
      }).ok, false)
    })
  }
  for (const text of ['Ja.', 'Ja bitte!', 'okay', 'mach das']) {
    it(`gibt die passende Aktion nach „${text}“ genau einmal frei`, () => {
      clearChallenges()
      const args = { to: 'test@example.invalid' }
      issueChallenge('gmail_send', args, 'Testfrage')
      const turn = { lastUserText: text, lastUserTextAt: Date.now() }
      assert.equal(verifyConfirmation('gmail_send', args, turn).ok, true)
      assert.equal(verifyConfirmation('gmail_send', args, turn).ok, false)
    })
  }
  it('akzeptiert keine geänderten Argumente und keinen alten Beitrag', () => {
    clearChallenges()
    const args = { to: 'test@example.invalid' }
    issueChallenge('gmail_send', args, 'Testfrage')
    assert.equal(verifyConfirmation('gmail_send', args, { lastUserText: 'ja', lastUserTextAt: 0 }).ok, false)
    assert.equal(verifyConfirmation('gmail_send', { to: 'other@example.invalid' }, {
      lastUserText: 'ja', lastUserTextAt: Date.now()
    }).ok, false)
    clearChallenges()
  })
})

describe('Einstellungen validieren', () => {
  it('akzeptiert Vorgaben und nullable Geräte', () => {
    validateSettingsPatch(DEFAULT_SETTINGS)
    validateSettingsPatch({ audio: { inputDeviceId: null }, speech: { provider: 'openai' } })
    validateSettingsPatch({mcpServers:[{id:'valid',name:'Valid',enabled:true,command:'node',args:['server.js'],env:{PATH:'test'},secretEnv:['API_KEY']}]})
  })
  for (const patch of [null, [], { audio: null }, { wake: { threshold: NaN } },
    { companion: { port: 65535 } }, { music: { spotifyRedirectPort: 123.5 } }, { speech: { provider: 'unknown' } },
    { audio: { outputGain: 'loud' } }, {wake:{modelName:'../bad.onnx'}},
    {mcpServers:[{id:'bad',name:'Bad',enabled:'yes',command:'node',args:[]}]},
    {mcpServers:[{id:'bad',name:'Bad',enabled:true,command:'node',args:[42]}]},
    {mcpServers:[{id:'bad',name:'Bad',enabled:true,command:'node',args:[],env:{API_KEY:42}}]},
    {mcpServers:[{id:'bad',name:'Bad',enabled:true,command:'',args:[],url:'file:///secret'}]},
    JSON.parse('{"__proto__":{"polluted":true}}')]) {
    it(`weist ungültige Daten ${JSON.stringify(patch)} ab`, () => assert.throws(() => validateSettingsPatch(patch)))
  }
})

it('reserviert laufende Recherchekosten und hält Speicherfehler vom Cache fern', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'james-regression-'))
  t.mock.method(app, 'getPath', () => root)
  t.mock.method(safeStorage, 'isEncryptionAvailable', () => true)
  t.after(() => {
    closeDb()
    assert.ok(root.startsWith(join(tmpdir(), 'james-regression-')))
    rmSync(root, { recursive: true, force: true })
  })
  setSettings({ dailyCostLimitUsd: 5 })
  reserveBudget(2, 'research', 'first pending job')
  reserveBudget(2, 'research', 'second pending job')
  assert.equal(checkBudget(2).ok, false)
  assert.throws(() => reserveBudget(2, 'research', 'third pending job'), /Tageslimit/)
  assert.throws(() => checkBudget(-1), /Kostenschätzung/)
  assert.throws(() => setSettings({ audio: null } as never))
  assert.ok(getSettings().audio)

  setSecret('openai', 'dummy-key-original')
  const target = join(root, 'secure', 'secrets.bin')
  assert.ok(readFileSync(target).length > 0)
  // A directory at the destination reliably prevents replacing the store on Windows.
  rmSync(target)
  mkdirSync(target)
  assert.throws(() => setSecret('openai', 'dummy-key-rejected'))
  assert.equal(getSecret('openai'), 'dummy-key-original')
})
