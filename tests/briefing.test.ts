import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'

it('loads independent briefing readers and respects denied tools while showing partial failures', async () => {
  const calls: string[] = []
  const fixtures: Record<string, string> = {
    '../store/settings': 'export const getSettings=()=>({dailyBriefing:true})',
    '../ipc/emit': 'export const sendToCrystal=()=>true',
    '../brain/store': "export const listProjects=()=>[{title:'Alpha',status:'aktiv',steps:[{done:false,text:'Weiterarbeiten'}]}]",
    '../tools/permissions': "export const permissionFor=name=>name==='gmail_summarize_inbox'?'deny':'allow'",
    '../tools/impl/brain': "export const dayEvents=async()=>{calls.push('calendar');throw Error('offline')}",
    '../tools/registry': `export const getTool=name=>({schema:{parse:x=>x},execute:async()=>{calls.push(name);return [{titel:'Heute fertig',faellig:'2020-01-01'}]}})`
  }
  const bundle = await build({ entryPoints: ['src/main/agent/dailyBriefing.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent', alias: { '@shared': resolve('src/shared') },
    plugins: [{ name: 'fixtures', setup(b) {
      b.onResolve({ filter: /.*/ }, args => args.path in fixtures ? { path: args.path, namespace: 'fixture' } : undefined)
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: fixtures[args.path] }))
    } }] })
  const module = { exports: {} as any }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require, console, AbortSignal, AbortController, calls, setTimeout, clearTimeout })
  const result = await module.exports.loadBriefing()
  assert.equal(result.complete, false)
  assert.deepEqual(calls.sort(), ['calendar', 'tasks_list'])
  const text = JSON.stringify(result.card)
  assert.match(text, /Heute fertig/)
  assert.match(text, /Weiterarbeiten/)
  assert.match(text, /Noch nicht geladen/)
})
