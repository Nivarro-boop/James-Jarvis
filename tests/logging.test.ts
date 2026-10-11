import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { replaceRotatedLog } from '@main/logging'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'
import { EventEmitter } from 'node:events'

it('schreibt nach einer geschlossenen Terminal-Pipe weiter ins Log ohne Fehlerschleife', async () => {
  const bundle = await build({entryPoints:[resolve('src/main/logging.ts')], bundle:true, write:false,
    platform:'node', format:'cjs', packages:'external', logLevel:'silent'})
  const logs: string[] = []
  let terminalWrites = 0
  const terminal = Object.fromEntries(['log','info','warn','error','debug'].map(key => [key, (..._args: unknown[]) => terminalWrites++]))
  const processFixture = { stdout: new EventEmitter(), stderr: new EventEmitter(), on() {},
    platform:'win32', arch:'x64', versions:{electron:'test'} }
  const module = {exports:{} as any}
  const load = (name: string): unknown => name === 'electron'
    ? {app:{isPackaged:false, getPath:()=>'/test-only', getVersion:()=> 'test', on() {}}, shell:{}}
    : name === 'node:fs' ? {...require('node:fs'), existsSync:()=>false, mkdirSync(){}, openSync:()=>10,
      writeSync:(_fd: number, line: string)=>logs.push(line), closeSync(){}}
    : require(name)
  runInNewContext(bundle.outputFiles[0].text, {module,exports:module.exports, require:load,
    process:processFixture, console:terminal})
  module.exports.initLogging()
  terminal.log('Vorher')
  assert.equal(terminalWrites,1)
  processFixture.stderr.emit('error',Object.assign(new Error('broken pipe'),{code:'EPIPE'}))
  terminal.error('Nachher')
  assert.equal(terminalWrites,1)
  assert.ok(logs.some(line=>line.includes('Nachher')))
  assert.equal(logs.filter(line=>line.includes('Terminalausgabe beendet')).length,1)
})

describe('Logrotation', () => {
  it('ersetzt auch eine schon vorhandene vorige Generation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-log-'))
    try {
      const current = join(dir, 'jarvis.log')
      const previous = join(dir, 'jarvis-vorher.log')
      writeFileSync(current, 'neu')
      writeFileSync(previous, 'alt')

      assert.equal(replaceRotatedLog(current, previous), true)
      assert.equal(readFileSync(previous, 'utf8'), 'neu')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
