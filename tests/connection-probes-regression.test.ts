import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'

it('keeps other connection results when a single browser tab fails and shares concurrent checks', async () => {
  let opened = 0
  let closed = 0
  const fixture = { ctx: { pages: () => [], newPage: async () => {
    if (++opened === 1) throw new Error('Tab konnte nicht geöffnet werden')
    let url = ''
    return { goto: async (value: string) => { url = value }, url: () => url,
      waitForSelector: async () => ({}), close: async () => { closed++ } }
  } } }
  const bundled = await build({ entryPoints: [resolve('src/main/agent/connections.ts')], bundle: true,
    write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
    alias: { '@shared': resolve('src/shared') }, plugins: [{ name: 'connection-fixture', setup(b) {
      b.onResolve({ filter: /\/(chromeCdp|desktop|googleAuth|keystore|ollama|settings)$/ }, () => ({ path: 'dependencies', namespace: 'fixture' }))
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export const getContext = async () => fixture.ctx;
        export const probeContext = getContext;
        export const browserProfileExists = () => true;
        export const amazonSignedIn = async () => true;
        export const inputBackendStatus = async () => ({ available: true });
        export const hasGoogleAuth = () => false;
        export const hasSecret = () => false;
        export const getSettings = () => ({ brainProvider: 'chatgpt', speech: { thinkProvider: 'chatgpt' } });
        export const ollamaHealth = async () => ({ ok: true, models: [] });
      ` }))
    } }] })
  const module = { exports: {} as typeof import('../src/main/agent/connections') }
  runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, fixture, Error })
  const first = module.exports.checkConnections(false)
  assert.equal(first, module.exports.checkConnections(false))
  const results = await first
  assert.equal(opened, 4)
  assert.equal(closed, 3)
  assert.equal(results.find(result => result.id === 'gmailWeb')?.ok, false)
  assert.match(results.find(result => result.id === 'gmailWeb')!.detail, /Tab konnte/)
  for (const id of ['yahoo', 'amazon', 'whatsapp']) assert.equal(results.find(result => result.id === id)?.ok, true)
  await module.exports.checkConnections(false)
  assert.equal(opened, 8)
  assert.equal(closed, 7)
})
