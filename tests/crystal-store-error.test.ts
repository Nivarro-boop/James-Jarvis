import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'

const source = build({
  entryPoints: [resolve('src/renderer/store/crystalStore.ts')],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  logLevel: 'silent',
  plugins: [{
    name: 'crystal-store-test-fixtures',
    setup(build) {
      build.onResolve({ filter: /^zustand$/ }, () => ({ path: 'zustand', namespace: 'fixture' }))
      build.onResolve({ filter: /^@shared\/types$/ }, () => ({ path: 'types', namespace: 'fixture' }))
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
        loader: 'js',
        contents: path === 'zustand'
          ? `export const create = (initializer) => {
              let state
              const set = (partial) => { state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) } }
              const get = () => state
              state = initializer(set, get)
              const hook = () => state
              hook.getState = get
              return hook
            }`
          : `export const CRYSTAL_STATE_PRIORITY = { idle: 0, connecting: 1, research: 2, listening: 3, thinking: 4, tool: 4, speaking: 5, offline: 6, confirm: 7, error: 8, paused: 9 }`
      }))
    }
  }]
}).then(result => result.outputFiles[0].text)

function createStore() {
  let nextTimerId = 0
  const timers = new Map<number, { callback: () => void; cleared: boolean }>()
  const window = {
    setTimeout(callback: () => void): number {
      const id = ++nextTimerId
      timers.set(id, { callback, cleared: false })
      return id
    },
    clearTimeout(id: number): void {
      const timer = timers.get(id)
      if (timer) timer.cleared = true
    }
  }
  const module = { exports: {} as Record<string, any> }
  runInNewContext(sourceCode, { module, exports: module.exports, require, window, console })
  return { store: module.exports.useCrystal, timers }
}

let sourceCode = ''
const ready = source.then(code => { sourceCode = code })

it('ignores an old timeout when the same error message is reported again', async () => {
  await ready
  const { store, timers } = createStore()
  const setError = store.getState().setError as (message: string | null) => void

  setError('Verbindung fehlgeschlagen')
  const oldTimer = timers.get(1)!
  setError('Verbindung fehlgeschlagen')
  const newTimer = timers.get(2)!

  assert.equal(oldTimer.cleared, true)
  oldTimer.callback() // Simulate a timeout already queued when clearTimeout ran.
  assert.equal(store.getState().lastError, 'Verbindung fehlgeschlagen')
  assert.equal(store.getState().wishes.local, 'error')

  newTimer.callback()
  assert.equal(store.getState().lastError, null)
  assert.equal(store.getState().wishes.local, undefined)
})

it('invalidates an outstanding timeout when the error is explicitly cleared', async () => {
  await ready
  const { store, timers } = createStore()
  const setError = store.getState().setError as (message: string | null) => void

  setError('Verbindung fehlgeschlagen')
  const oldTimer = timers.get(1)!
  setError(null)
  oldTimer.callback()

  assert.equal(oldTimer.cleared, true)
  assert.equal(store.getState().lastError, null)
  assert.equal(store.getState().wishes.local, undefined)
})
