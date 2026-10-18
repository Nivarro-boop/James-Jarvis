import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

it('runs a real read-only notes connector with provenance, bounded output and path/shortcut isolation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'james-notes-protocol-'))
  const notes = join(root, 'notes'), outside = join(root, 'outside')
  await mkdir(notes); await mkdir(outside)
  await writeFile(join(notes, 'Plan.md'), 'Vorgabe: nur lokale Dateien.\nJames testet das Projekt.')
  await writeFile(join(notes, 'Long.txt'), 'Bounded '.repeat(5000))
  await writeFile(join(notes, 'TooLarge.md'), 'x'.repeat(70000))
  await writeFile(join(notes, '.private.txt'), 'not indexed')
  await writeFile(join(outside, 'Secret.txt'), 'must stay outside')
  await symlink(outside, join(notes, 'shortcut'), process.platform === 'win32' ? 'junction' : 'dir')
  const client = new Client({ name: 'james-test', version: '1' })
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('connectors/project-notes/server.mjs'), notes], stderr: 'pipe' })
  t.after(async () => {
    await client.close()
    assert.equal(dirname(root), tmpdir())
    assert.ok(root.startsWith(join(tmpdir(), 'james-notes-protocol-')))
    await rm(root, { recursive: true, force: true })
  })
  await client.connect(transport)
  const catalog = await client.listTools()
  assert.equal(catalog.tools.length, 3)
  assert.ok(catalog.tools.every(tool => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false))
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args })
  const data = (response: any) => JSON.parse(response.content[0].text)
  const list = data(await call('notes_list', {}))
  assert.ok(list.notes.some((note: any) => note.path === 'Plan.md'))
  assert.ok(list.notes.every((note: any) => !/private|Secret/.test(note.path)))
  const found = data(await call('notes_search', { query: 'lokale Dateien' }))
  assert.equal(found.matches[0].source.path, 'Plan.md')
  assert.equal(found.matches[0].source.connector, 'project-notes')
  assert.match(data(await call('notes_read', { path: 'Plan.md' })).text, /nur lokale Dateien/)
  const long = data(await call('notes_read', { path: 'Long.txt' }))
  assert.equal(long.truncated, true)
  assert.ok(long.text.length <= 12000)
  for (const path of ['../outside/Secret.txt', 'shortcut/Secret.txt', '.private.txt', 'C:/Secret.txt', 'Plan.md:stream', 'TooLarge.md']) assert.equal((await call('notes_read', { path })).isError, true)
})
