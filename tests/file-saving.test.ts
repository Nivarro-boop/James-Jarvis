import assert from 'node:assert/strict'
import { it, type TestContext } from 'node:test'
import { app } from 'electron'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { saveOfficeFile } from '@main/office/save'
import { fileTools } from '@main/tools/impl/files'
import type { ToolContext } from '@main/tools/registry'

function isolatedFolder(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'james-file-saving-'))
  t.mock.method(app, 'getPath', () => root)
  t.after(() => {
    assert.ok(root.startsWith(join(tmpdir(), 'james-file-saving-')))
    rmSync(root, { recursive: true, force: true })
  })
  return root
}

it('preserves every document when concurrent saves request the same title', async t => {
  const root = isolatedFolder(t)
  writeFileSync(join(root, 'Bericht.docx'), 'existing document')
  const contents = Array.from({ length: 8 }, (_, n) => Buffer.from(`document ${n}`))
  const results = await Promise.all(contents.map(data => saveOfficeFile(data, 'Bericht', '.docx', undefined, false)))
  assert.equal(new Set(results.map(result => result.path)).size, contents.length)
  for (const [index, result] of results.entries()) {
    assert.deepEqual(readFileSync(result.path), contents[index])
    assert.equal(result.bytes, contents[index].length)
  }
  assert.equal(readFileSync(join(root, 'Bericht.docx'), 'utf8'), 'existing document')
})

it('does not overwrite another save after the numbered document names are occupied', async t => {
  const root = isolatedFolder(t)
  for (let n = 1; n < 100; n++) writeFileSync(join(root, `Bericht${n === 1 ? '' : ` (${n})`}.docx`), 'existing')
  t.mock.method(Date, 'now', () => 123456789)
  const results = await Promise.all(['first', 'second'].map(text => saveOfficeFile(Buffer.from(text), 'Bericht', '.docx', undefined, false)))
  assert.notEqual(results[0].path, results[1].path)
  assert.equal(readFileSync(results[0].path, 'utf8'), 'first')
  assert.equal(readFileSync(results[1].path, 'utf8'), 'second')
})

const fileWrite = fileTools.find(tool => tool.name === 'file_write')!
// file_write does not use the tool context.
const context = {} as ToolContext

it('allows exactly one new text file and reports the competing writes without data loss', async t => {
  const root = isolatedFolder(t)
  const contents = Array.from({ length: 8 }, (_, n) => `note ${n}`)
  const outcomes = await Promise.allSettled(contents.map(content => fileWrite.execute({ name: 'Notiz.txt', content }, context)))
  const successful = outcomes.flatMap((outcome, n) => outcome.status === 'fulfilled' ? [n] : [])
  assert.equal(successful.length, 1)
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') assert.match(String(outcome.reason), /gibt es schon/)
  }
  assert.equal(readFileSync(join(root, 'Notiz.txt'), 'utf8'), contents[successful[0]])
})

it('still supports explicitly requested text replacement and appending', async t => {
  const root = isolatedFolder(t)
  const target = join(root, 'Notiz.txt')
  writeFileSync(target, 'old text')
  await fileWrite.execute({ name: 'Notiz.txt', content: 'replacement', mode: 'überschreiben' }, context)
  await fileWrite.execute({ name: 'Notiz.txt', content: 'addition', mode: 'anhängen' }, context)
  assert.equal(readFileSync(target, 'utf8'), 'replacement\naddition')
})
