import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

async function harness() {
  const windows: { crystal: any; settings: any } = { crystal: null, settings: null }
  const bundle = await build({
    entryPoints: [resolve('src/main/ipc/emit.ts')], bundle: true, write: false,
    platform: 'node', format: 'cjs',
    plugins: [{ name: 'window-fixture', setup(b) {
      b.onResolve({ filter: /windows\/(crystal|settings)$/ }, args => ({ path: args.path.endsWith('/crystal') ? 'crystal' : 'settings', namespace: 'fixture' }))
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'crystal'
        ? 'export const getCrystalWindow = () => windows.crystal'
        : 'export const getSettingsWindow = () => windows.settings' }))
    } }]
  })
  const module = { exports: {} as any }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, windows })
  return { windows, ...module.exports }
}

it('reports missing or destroyed windows as undelivered', async () => {
  const h = await harness()
  for (const target of ['crystal', 'settings']) {
    const send = target === 'crystal' ? h.sendToCrystal : h.sendToSettings
    assert.equal(send('speak:request', { text: 'test', interrupt: false }), false)
    h.windows[target] = { isDestroyed: () => true }
    assert.equal(send('speak:request', { text: 'test', interrupt: false }), false)
  }
})

it('survives destruction between window checks and sending and still broadcasts to the other window', async () => {
  const h = await harness()
  let delivered = 0
  h.windows.crystal = { isDestroyed: () => false, get webContents() { throw new Error('Object has been destroyed') } }
  h.windows.settings = { isDestroyed: () => false, webContents: { send: () => { delivered++ } } }
  assert.equal(h.speak('hello'), false)
  h.broadcast('speak:request', { text: 'test', interrupt: false })
  assert.equal(delivered, 1)
  h.windows.settings.webContents.send = () => { throw new Error('Object has been destroyed') }
  assert.equal(h.sendToSettings('speak:request', { text: 'test', interrupt: false }), false)
})

it('delivers normally and handles a closing window visibility query', async () => {
  const h = await harness()
  let delivered = 0
  h.windows.crystal = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false,
    webContents: { send: () => { delivered++ } } }
  assert.equal(h.speak('hello'), true)
  assert.equal(delivered, 1)
  assert.equal(h.crystalVisible(), true)
  h.windows.crystal.isVisible = () => { throw new Error('Object has been destroyed') }
  assert.equal(h.crystalVisible(), false)
})
