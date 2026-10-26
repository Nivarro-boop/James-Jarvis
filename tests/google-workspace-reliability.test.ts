import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'

it('streams Google exports, refuses unsupported types, and reports a partially created document', async () => {
  let kind = 'application/vnd.google-apps.document', exports = 0, created = 0
  const drive = { files: {
    get: async () => ({ data: { mimeType: kind, name: 'Synthetic' } }),
    export: async (_args: unknown, options: { responseType: string; retry: boolean; timeout: number }) => {
      exports++
      assert.equal(options.responseType, 'stream'); assert.equal(options.retry, false); assert.equal(options.timeout, 20_000)
      return { data: Readable.from(['Synthetic export']) }
    }
  } }
  const docs = { documents: { create: async () => { created++; return { data: { documentId: 'synthetic-id' } } }, batchUpdate: async () => { throw new Error('lost reply') } } }
  const fixtures: Record<string, string> = {
    '../../providers/googleAuth': "export const googleClient=async()=>({});export const hasGoogleAuth=()=>true;export const hasWorkspaceAuth=()=>true;export const friendlyGoogleError=e=>e.message",
    googleapis: 'export const google={drive:()=>drive,docs:()=>docs}'
  }
  const bundle = await build({ entryPoints: ['src/main/tools/impl/googleWorkspace.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent', alias: { '@shared': resolve('src/shared') }, plugins: [{ name: 'fixtures', setup(b) {
    b.onResolve({ filter: /.*/ }, args => args.path in fixtures ? { path: args.path, namespace: 'fixture' } : undefined)
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: fixtures[args.path] }))
  } }] })
  const module = { exports: {} as any }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require, console, AbortSignal, AbortController, Buffer, process, setTimeout, clearTimeout, drive, docs })
  const tools = module.exports.googleWorkspaceTools
  const ctx = { signal: new AbortController().signal }
  const read = tools.find((t: { name: string }) => t.name === 'drive_read')
  assert.equal((await read.execute({ id: 'test' }, ctx)).text, 'Synthetic export')
  kind = 'application/vnd.google-apps.folder'
  assert.match((await read.execute({ id: 'test' }, ctx)).hinweis, /Keine Textdatei/)
  assert.equal(exports, 1)
  const create = tools.find((t: { name: string }) => t.name === 'docs_create')
  const partial = await create.execute({ titel: 'Synthetic', text: 'text' }, ctx)
  assert.equal(partial.teilweise, true)
  assert.match(partial.link, /synthetic-id/)
  assert.equal(created, 1)
})
