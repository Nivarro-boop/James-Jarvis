import assert from 'node:assert/strict'
import { it } from 'node:test'
import { app } from 'electron'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { clearPcProfile, docxText, refreshPcProfile, searchPcProfile, profilePathAllowed, readPcProfile } from '@main/agent/pcProfile'
import { setSettings } from '@main/store/settings'

function archive(text: string): Buffer {
  const name = Buffer.from('word/document.xml')
  const compressed = deflateRawSync(text)
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(8, 10)
  central.writeUInt32LE(compressed.length, 20); central.writeUInt16LE(name.length, 28)
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 10)
  end.writeUInt32LE(local.length + name.length + compressed.length, 16)
  return Buffer.concat([local, name, compressed, central, name, end])
}
it('liest begrenzten Dokumenttext und weist defekte oder zu große ZIP-Inhalte ab', () => {
  assert.equal(docxText(archive('<w:p>Hallo &amp; Welt</w:p>')), 'Hallo & Welt\n')
  assert.equal(docxText(Buffer.from([0x50, 0x4b, 0x05, 0x06])), '')
  assert.equal(docxText(archive('x'.repeat(3 * 1024 * 1024))), '')
  const invalid = archive('Test'); invalid.writeUInt32LE(0xffffffff, invalid.length - 22 + 16)
  assert.equal(docxText(invalid), '')
})

it('scans selected folders, excludes subtrees, and invalidates old profiles after scope changes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'james-profile-scope-'))
  t.mock.method(app, 'getPath', () => root)
  const previous = process.env.ProgramData
  process.env.ProgramData = root
  t.after(() => { if (previous === undefined) delete process.env.ProgramData; else process.env.ProgramData = previous; rmSync(root, { recursive: true, force: true }) })
  const chosen = join(root, 'chosen'), excluded = join(chosen, 'excluded')
  mkdirSync(excluded, { recursive: true })
  writeFileSync(join(chosen, 'allowed.txt'), 'Allowed content')
  writeFileSync(join(excluded, 'other.txt'), 'Excluded content')
  setSettings({ pcProfile: true, gamingMode: false, pcProfileFolders: [chosen], pcProfileExcludedFolders: [excluded] })
  assert.equal(profilePathAllowed(excluded), false)
  assert.equal(profilePathAllowed(join(excluded, 'other.txt')), false)
  const profile = await refreshPcProfile(true)
  assert.ok(profile?.documents.some(d => d.name === 'allowed.txt'))
  assert.ok(!profile?.documents.some(d => d.name === 'other.txt'))
  setSettings({ pcProfileExcludedFolders: [chosen] })
  assert.equal(readPcProfile(), null)
})
it('ein gelöschtes Profil wird von einem bereits gestarteten Scan nicht neu gespeichert', async t => {
  const root = mkdtempSync(join(tmpdir(), 'james-profile-'))
  t.mock.method(app, 'getPath', () => root)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  setSettings({ pcProfile: true, gamingMode: false })
  const pending = refreshPcProfile(true)
  clearPcProfile()
  assert.equal(await pending, null)
  assert.equal(existsSync(join(root, 'pc-profile.json')), false)
  writeFileSync(join(root, 'pc-profile.json'), JSON.stringify({ programs: ['Test'], folders: [], recent: [], documents: [] }))
  setSettings({ pcProfile: false })
  assert.deepEqual(searchPcProfile('Test'), { programs: [], files: [], documents: [] })
})
