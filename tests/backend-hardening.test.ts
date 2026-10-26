import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { z } from 'zod'
import { getSettings, setSettings } from '@main/store/settings'
import { register } from '@main/tools/registry'
import { permissionFor, clearChallenges, issueChallenge } from '@main/tools/permissions'
import { runTool } from '@main/tools/runner'
import { closeDb } from '@main/db'
import { createProject, findProject, saveProject } from '@main/brain/store'
import { insideDrive, iCloudDriveList } from '@main/providers/icloud'
import { mailDispatcher } from '@main/providers/mailDispatch'

it('preserves opt-outs, enforces explicit permissions, and does not reapprove uncertain writes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'james-hardening-'))
  t.mock.method(app, 'getPath', () => root)
  t.after(() => { closeDb(); rmSync(root, { recursive: true, force: true }) })
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ diagnosticReporting: { enabled: false, automatic: false } }))
  assert.equal(getSettings().diagnosticReporting.enabled, false)
  assert.equal(getSettings().diagnosticReporting.automatic, false)
  let writes = 0
  register({ name: 'test_uncertain_write', group: 'workspace', description: 'Test', alwaysAsk: true, schema: z.object({}),
    async execute() { writes++; throw new Error('response lost') } })
  assert.equal(permissionFor('test_uncertain_write'), 'ask')
  setSettings({ permissions: { other_tool: 'ask', denied: 'deny' } })
  assert.equal(permissionFor('other_tool'), 'ask')
  assert.equal(permissionFor('denied'), 'deny')
  assert.equal(permissionFor('order_place'), 'ask')
  clearChallenges()
  issueChallenge('test_uncertain_write', {}, 'Test?')
  const req = { id: 'uncertain', name: 'test_uncertain_write', args: { confirmed: true }, userTurn: { lastUserText: 'ja', lastUserTextAt: Date.now() } }
  const failed = await runTool(req)
  assert.equal(writes, 1)
  assert.match(failed.error ?? '', /unklar/)
  await runTool({ ...req, id: 'retry' })
  await runTool({ ...req, id: 'retry-again-same-user-turn' })
  assert.equal(writes, 1, 'lost reply must not allow another write')

  const first = createProject('Alpha Website'), second = createProject('Alpha Mobile')
  assert.throws(() => findProject(''), /eindeutig/)
  assert.throws(() => findProject('Alpha'), /Mehrere/)
  assert.equal(findProject('Alpha', true), undefined)
  assert.equal(findProject(first.slug, true)?.title, first.title)
  assert.throws(() => saveProject({ ...second, slug: '../outside' }), /kennung/)
  assert.throws(() => createProject('  '), /Projektname/)

  const drive = join(root, 'drive'), outside = join(root, 'outside')
  mkdirSync(drive); mkdirSync(outside)
  writeFileSync(join(drive, 'inside.txt'), 'inside')
  writeFileSync(join(outside, 'synthetic.txt'), 'outside')
  symlinkSync(outside, join(drive, 'linked'), 'junction')
  await assert.rejects(insideDrive(drive, 'linked/synthetic.txt'), /außerhalb/)
  await assert.rejects(insideDrive(drive, '../outside/synthetic.txt'), /außerhalb/)
  assert.equal(readFileSync(await insideDrive(drive, 'inside.txt'), 'utf8'), 'inside')
  assert.equal((await iCloudDriveList('', undefined, undefined, drive))?.eintraege.length, 1)
})

it('deduplicates mail dispatch, including a side effect followed by a lost reply', async () => {
  const dispatch = mailDispatcher()
  let delivered = 0
  const send = async () => { delivered++; throw new Error('SMTP reply lost') }
  const id = 'synthetic-operation-1234', input = { to: 'test@example.invalid', body: 'test' }
  await Promise.all([assert.rejects(dispatch(id, input, send)), assert.rejects(dispatch(id, input, send))])
  await assert.rejects(dispatch(id, input, send))
  await assert.rejects(dispatch(id, { ...input, body: 'changed' }, send), /bereits/)
  assert.equal(delivered, 1)
  const result = await dispatch('synthetic-operation-5678', input, async () => ++delivered)
  assert.equal(result, 2)
})
