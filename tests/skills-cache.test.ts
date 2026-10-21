import assert from 'node:assert/strict'
import { it } from 'node:test'
import { app } from 'electron'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSkills, findSkill, saveSkill, useSkill, patchSkill, deleteSkill, serializeSkill, skillIndexForPrompt } from '@main/agent/skills'

it('reuses unchanged skill files and refreshes edits, additions, deletions, writes and profile changes', t => {
  const root = mkdtempSync(join(tmpdir(), 'james-skill-cache-'))
  let profile = join(root, 'first')
  t.mock.method(app, 'getPath', () => profile)
  t.after(() => {
    assert.ok(root.startsWith(join(tmpdir(), 'james-skill-cache-')))
    rmSync(root, { recursive: true, force: true })
  })
  const folder = join(profile, 'skills')
  mkdirSync(folder, { recursive: true })
  const skill = { name: 'Kalender', description: 'Termine prüfen', source: 'manual' as const, uses: 1, updated: '', steps: 'first' }
  const file = join(folder, 'kalender.md')
  writeFileSync(file, serializeSkill(skill))
  const fs = require('node:fs') as typeof import('node:fs')
  const read = fs.readFileSync
  let reads = 0
  t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof read>) => {
    if (String(args[0]).startsWith(folder)) reads++
    return Reflect.apply(read, fs, args)
  })
  assert.equal(listSkills()[0].steps, 'first')
  const originalReads = reads
  for (let n = 0; n < 5; n++) skillIndexForPrompt(30, 'Kalender')
  assert.equal(reads, originalReads, 'unchanged instructions should not be read on every prompt')

  const leaked = listSkills()[0]
  leaked.steps = 'changed by caller'
  assert.equal(listSkills()[0].steps, 'first')
  writeFileSync(file, serializeSkill({ ...skill, steps: 'other' }))
  utimesSync(file, new Date(1_700_000_000_000), new Date(1_700_000_000_000))
  assert.equal(listSkills()[0].steps, 'other')

  writeFileSync(join(folder, 'external.md'), serializeSkill({ ...skill, name: 'Extern' }))
  assert.equal(listSkills().length, 2)
  unlinkSync(join(folder, 'external.md'))
  assert.equal(listSkills().length, 1)
  writeFileSync(join(folder, 'broken.md'), 'invalid header')
  assert.equal(listSkills().length, 1)
  writeFileSync(join(folder, 'broken.md'), serializeSkill({ ...skill, name: 'Repariert' }))
  assert.equal(listSkills().length, 2)

  saveSkill({ ...skill, steps: 'saved' })
  assert.equal(listSkills().find(s => s.slug === 'kalender')?.steps, 'saved')
  assert.equal(useSkill('Kalender')?.uses, 2)
  assert.equal(listSkills().find(s => s.slug === 'kalender')?.uses, 2)
  const plusName = saveSkill({ ...skill, name: 'A+B', steps: 'plus steps' }).skill
  const spacedName = saveSkill({ ...skill, name: 'A B', steps: 'space steps' }).skill
  assert.equal(plusName.slug, 'a-b')
  assert.notEqual(spacedName.slug, plusName.slug)
  assert.equal(findSkill('A+B')?.steps, 'plus steps')
  assert.equal(findSkill('A B')?.steps, 'space steps')
  saveSkill({ ...skill, name: 'A B', steps: 'updated space steps' })
  assert.equal(findSkill('A+B')?.steps, 'plus steps', 'updating a slug collision must not overwrite its neighbor')
  assert.equal(findSkill('A B')?.steps, 'updated space steps')
  patchSkill('Kalender', 'saved', 'patched')
  assert.equal(listSkills().find(s => s.slug === 'kalender')?.steps, 'patched')
  assert.equal(deleteSkill('Kalender'), true)
  assert.equal(listSkills().some(s => s.slug === 'kalender'), false)

  profile = join(root, 'second')
  assert.deepEqual(listSkills(), [])
  saveSkill({ ...skill, steps: 'new profile' })
  assert.equal(listSkills()[0].steps, 'new profile')
})
