import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DEFAULT_SETTINGS } from '../src/shared/config/defaults'
import { validateSettingsPatch } from '../src/shared/config/validation'
import { assistantRoleInfo, assistantRoleInstructions, assistantRoles } from '../src/shared/assistantRole'

test('existing and new profiles default to the personal assistant', () => {
  assert.equal(DEFAULT_SETTINGS.assistantRole, 'personal')
  assert.deepEqual(assistantRoles.map(({ id, label }) => [id, label]), [
    ['personal', 'Persönlicher Assistent'],
    ['calendar', 'Kalender-Assistent'],
    ['focus', 'Aufgaben & Fokus']
  ])
})

test('assistant role validation accepts exactly the supported enum values', () => {
  for (const assistantRole of ['personal', 'calendar', 'focus']) {
    assert.doesNotThrow(() => validateSettingsPatch({ assistantRole }))
  }
  for (const assistantRole of ['other', '', null, 1, false, [], {}]) {
    assert.throws(() => validateSettingsPatch({ assistantRole }), /Einstellung|Auswahl/)
  }
  // A legacy saved profile omitting the newly introduced setting remains valid;
  // the settings store fills it from DEFAULT_SETTINGS on load.
  assert.doesNotThrow(() => validateSettingsPatch({ language: 'de-DE' }))
})

test('role metadata and instructions are static and unknown values fall back safely', () => {
  assert.strictEqual(assistantRoleInfo('calendar'), assistantRoles[1])
  assert.strictEqual(assistantRoleInfo('focus'), assistantRoles[2])
  assert.strictEqual(assistantRoleInfo('not-a-role'), assistantRoles[0])
  assert.strictEqual(assistantRoleInfo(null), assistantRoles[0])
  assert.strictEqual(assistantRoleInfo({}), assistantRoles[0])

  const personal = assistantRoleInstructions('personal')
  const calendar = assistantRoleInstructions('calendar')
  const focus = assistantRoleInstructions('focus')
  assert.match(personal, /Schwerpunkt und Antwortverhalten/)
  assert.match(calendar, /Konflikte und sinnvolle Puffer/)
  assert.match(calendar, /kein Kalender verbunden/)
  assert.match(calendar, /nicht automatisch ab/)
  assert.match(calendar, /keine Kalenderänderungen ohne einen ausdrücklichen Auftrag/)
  assert.match(focus, /nächsten Schritt/)
  assert.match(focus, /keine Projektpflicht/)
  for (const instructions of [personal, calendar, focus]) {
    assert.match(instructions, /keine Berechtigungen/)
    assert.match(instructions, /keinen Anbieter/)
  }
})

test('buildSystemPrompt includes the selected static role policy in its shared prompt path', () => {
  // Importing the main prompt initializes DB/provider-dependent modules; source
  // integration is the stable, environment-independent check for this boundary.
  const source = readFileSync('src/main/agent/prompt.ts', 'utf8')
  assert.match(source, /import\s*\{\s*assistantRoleInstructions\s*\}\s*from\s*'@shared\/assistantRole'/)
  assert.match(source, /parts\.push\(assistantRoleInstructions\(settings\.assistantRole\)\)/)
})
