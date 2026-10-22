import assert from 'node:assert/strict'
import { it } from 'node:test'
import { installPendingUpdateForPlatform } from '../src/main/updater'

it('uses the native update handoff on macOS', () => {
  const calls: string[] = []
  installPendingUpdateForPlatform({
    quitAndInstall: () => calls.push('quitAndInstall'),
    install: () => { calls.push('install'); return true }
  }, 'darwin')
  assert.deepEqual(calls, ['quitAndInstall'])
})

it('uses NSIS silent install without relaunch on Windows', () => {
  const calls: unknown[][] = []
  installPendingUpdateForPlatform({
    quitAndInstall: () => calls.push(['quitAndInstall']),
    install: (...args) => { calls.push(args); return true }
  }, 'win32')
  assert.deepEqual(calls, [[true, false]])
})

it('does not silently skip a Windows update if NSIS install is unavailable', () => {
  assert.throws(
    () => installPendingUpdateForPlatform({ quitAndInstall: () => undefined }, 'win32'),
    /NSIS-Installer nicht verfügbar/
  )
})

// Exercise the actual updater module with isolated Electron/native lifecycle boundaries.
// No Squirrel process, installer, network request or shared process.platform mutation.
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'

function lifecycle(platform: string, failHandoff = false): { api: any; updater: EventEmitter; exits: number[]; calls: string[] } {
  const updater = new EventEmitter() as EventEmitter & Record<string, any>
  const exits: number[] = [], calls: string[] = []
  updater.checkForUpdates = () => Promise.resolve(null)
  updater.quitAndInstall = () => {
    calls.push('native-handoff')
    if (failHandoff) throw new Error('native handoff failed')
  }
  updater.install = () => { calls.push('nsis-install'); return true }
  const module = { exports: {} as any }
  const source = transformSync(readFileSync('src/main/updater.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code
  runInNewContext(source, {
    module, exports: module.exports, process: { platform }, console,
    setInterval: () => ({ unref: () => {} }),
    require: (name: string) => {
      if (name === 'electron') return { app: { isPackaged: true, getVersion: () => '1.3.9', exit: (code: number) => exits.push(code) } }
      if (name === 'electron-updater') return { autoUpdater: updater }
      if (name === './ipc/emit') return { broadcast: () => {} }
      throw new Error(`Unexpected updater dependency: ${name}`)
    }
  })
  const api = module.exports
  api.startAutoUpdate()
  return { api, updater, exits, calls }
}

it('keeps macOS alive for asynchronous Squirrel handoff and exits on its later error', () => {
  const { api, updater, exits, calls } = lifecycle('darwin')
  updater.emit('update-downloaded', { version: '1.3.10' })
  assert.equal(api.installPendingUpdate(), true, 'Caller must defer app.exit while Squirrel is fetching the ZIP')
  assert.deepEqual(calls, ['native-handoff'])
  assert.deepEqual(exits, [], 'Do not kill the local update proxy immediately')
  updater.emit('error', new Error('later native transfer failure'))
  assert.deepEqual(exits, [0], 'A failed async handoff must not keep an invisible app alive')
})

it('allows normal shutdown and removes its exit listener when the native Mac handoff throws', () => {
  const { api, updater, exits } = lifecycle('darwin', true)
  updater.emit('update-downloaded', { version: '1.3.10' })
  const listenersBefore = updater.listenerCount('error')
  assert.equal(api.installPendingUpdate(), false)
  assert.equal(updater.listenerCount('error'), listenersBefore)
  assert.deepEqual(exits, [])
})

it('does not defer shutdown or register a native exit listener without a ready update', () => {
  const { api, updater, exits, calls } = lifecycle('darwin')
  const listenersBefore = updater.listenerCount('error')
  assert.equal(api.installPendingUpdate(), false)
  assert.equal(updater.listenerCount('error'), listenersBefore)
  assert.deepEqual(exits, [])
  assert.deepEqual(calls, [])
})
