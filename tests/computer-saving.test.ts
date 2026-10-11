import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { resolve, join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { budgetConversation } from '@shared/conversationBudget'
import { visionJsonSchema } from '@main/providers/chatgptVision'
import { trimHistory } from '@main/tools/impl/computer'
import { compactResult } from '@main/agent/tokenSaver'
import { closeDb } from '@main/db'
import { getSettings, setSettings } from '@main/store/settings'

const fixtureRequire = createRequire(join(process.cwd(), 'package.json'))

it('begrenzt numerische Werkzeuglisten statt sie vollständig erneut mitzusenden', t => {
  const root = mkdtempSync(join(tmpdir(), 'james-saving-'))
  t.mock.method(app, 'getPath', () => root)
  t.after(() => { closeDb(); assert.ok(root.startsWith(join(tmpdir(), 'james-saving-'))); rmSync(root, { recursive: true, force: true }) })
  setSettings({ tokenSaver: { ...getSettings().tokenSaver, enabled: true, maxResultChars: 1400 } })
  const result = compactResult('test_numbers', Array.from({ length: 10000 }, (_, i) => i)) as unknown[]
  assert.ok(result.length < 400)
  assert.ok(JSON.stringify(result).length < 1500)
})

it('begrenzt ältere ChatGPT-Antworten und erhält vollständige aktuelle Dialogpaare', () => {
  const history = Array.from({ length: 6 }, (_, i) => [
    { role: 'user', content: `Frage ${i}` }, { role: 'assistant', content: 'x'.repeat(12000) }
  ]).flat()
  const kept = budgetConversation(history, true)
  assert.ok(JSON.stringify(kept).length <= 6000)
  assert.equal(kept[0].role, 'user')
  assert.equal(kept.at(-2)!.content, 'Frage 5')
  assert.match(String(kept.at(-1)!.content), /gekürzt/)
  assert.equal(String(history[1].content).length, 12000)
  assert.equal(budgetConversation(history, false).length, 12)
})

it('kürzt Bildverläufe paarweise und entfernt verwaiste Werkzeugantworten', () => {
  const history: any[] = Array.from({ length: 8 }, (_, i) => [
    { role: 'user', parts: [{ functionResponse: { name: 'computer', response: {} } }, { text: `Schritt ${i}` }] },
    { role: 'model', parts: [{ functionCall: { name: 'computer', args: {} }, thoughtSignature: `signature-${i}` }] }
  ]).flat()
  trimHistory(history, 6)
  assert.equal(history.length, 6)
  assert.equal(history[0].role, 'user')
  assert.equal(history[0].parts.some((p: any) => p.functionResponse), false)
  assert.equal(history.at(-1).parts[0].thoughtSignature, 'signature-7')
})

it('wandelt verschachtelte Bildaktions-Schemas ohne Änderung der Enums um', () => {
  const schema = visionJsonSchema({ type: 'OBJECT', properties: { actions: { type: 'ARRAY', items: {
    type: 'OBJECT', properties: { action: { type: 'STRING', enum: ['TYPE', 'done'] } }
  } } } })
  assert.deepEqual(schema, { type: 'object', properties: { actions: { type: 'array', items: {
    type: 'object', properties: { action: { type: 'string', enum: ['TYPE', 'done'] } }
  } } } })
})

it('sendet das aktuelle Bild über den normalen ChatGPT-Responses-Weg mit lokalen Funktionen', async () => {
  const bundle = await build({ entryPoints: [resolve('src/main/providers/chatgptVision.ts')], bundle: true,
    write: false, format: 'cjs', platform: 'node', logLevel: 'silent', alias: { '@shared': resolve('src/shared') }, plugins: [{ name: 'auth-fixture', setup(b) {
      b.onResolve({ filter: /\/chatgptAuth$/ }, () => ({ path: 'auth', namespace: 'fixture' }))
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents:
        'export const CHATGPT_RESOURCE="https://test.invalid/v1";export const chatGptAccessToken=async()=>"test-access"'
      }))
    } }] })
  let body: any
  const module = { exports: {} as any }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: fixtureRequire,
    AbortSignal, TextDecoder, fetch: async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body))
      return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{
        type: 'function_call', name: 'jarvis.computer', arguments: '{"action":"done"}'
      }] } })}\n\n`)
    }
  })
  const result = await module.exports.chatGptVision('account-model', 'Test', 'Aktuelle Aufgabe',
    [{ mimeType: 'image/png', base64: 'test-image' }], [{ name: 'computer', parameters: { type: 'OBJECT', properties: {} } }])
  assert.equal(body.store, false)
  assert.equal(body.stream, true)
  assert.equal(body.model, 'account-model')
  assert.equal(body.input[0].content.filter((p: any) => p.type === 'input_image').length, 1)
  assert.equal(body.tools[0].type, 'namespace')
  assert.equal(body.tools[0].tools[0].parameters.type, 'object')
  assert.equal(result.output[0].name, 'jarvis.computer')
})

it('führt die echte Computer-Schleife mit ChatGPT statt Gemini aus und stapelt Aktionen', async () => {
  const calls: string[] = []
  const shots: number[] = []
  const fixtures: Record<string, string> = {
    electron: 'export const clipboard={readText:()=>"",writeText(){}}',
    '../registry': 'export const defineTool=def=>def',
    '../../providers/gemini': 'export const geminiClient=()=>{throw Error("Unerwarteter Gemini-Aufruf")};export const friendlyGeminiError=e=>e.message',
    '../../store/settings': 'export const getSettings=()=>({brainProvider:"chatgpt",speech:{thinkProvider:"chatgpt"},chatGptModel:"account-model",tokenSaver:{enabled:true}})',
    '../../automation/desktop': `export const activeDisplay=()=>({label:"Testmonitor"});
      export const inputBackendStatus=async()=>({name:"test"});export const listWindows=async()=>[];
      export const captureScreen=async options=>{shots.push(options.maxTiles);return {base64:"test-image",mimeType:"image/png",tokens:10,display:{label:"Testmonitor"}}};
      export const typeText=async text=>calls.push(text);export const focusWindow=async()=>({});
      export const captureRegion=()=>{};export const click=()=>{};export const cursorPosition=()=>{};
      export const displayForWindow=()=>{};export const displayPoint=()=>{};export const drag=()=>{};
      export const mouseDown=()=>{};export const mouseUp=()=>{};export const moveMouse=()=>{};
      export const pressHotkey=()=>{};export const scroll=()=>{};`,
    '../../db': 'export const logAction=()=>{};export const recordSaving=()=>{}',
    '../../providers/chatgptVision': `export const chatGptVision=async()=>({output:[{type:"function_call",name:"jarvis.computer_batch",arguments:JSON.stringify({actions:[
      {action:"type",text:"Hallo",intent:"Textfeld ausfüllen"},{action:"done",success:true,summary:"Erledigt"}
    ]})}]})`
  }
  const bundle = await build({ entryPoints: [resolve('src/main/tools/impl/computer.ts')], bundle: true,
    write: false, format: 'cjs', platform: 'node', packages: 'external', logLevel: 'silent',
    plugins: [{ name: 'computer-fixture', setup(b) {
      b.onResolve({ filter: /.*/ }, args => args.path in fixtures ? { path: args.path, namespace: 'fixture' } : undefined)
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: fixtures[args.path] }))
    } }] })
  const module = { exports: {} as any }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: fixtureRequire, calls, shots,
    setTimeout: (fn: () => void) => { fn(); return 0 } })
  const result = await module.exports.computerTools[0].execute({ goal: 'Testfeld ausfüllen' }, { signal: new AbortController().signal })
  assert.equal(result.fertig, true)
  assert.deepEqual(calls, ['Hallo'])
  assert.deepEqual(shots, [2])
})

it('plant über den eingestellten Textanbieter und spielt gelernte Bedienbaumabläufe ohne Modell ab', async t => {
  const root = mkdtempSync(join(tmpdir(), 'james-desktop-saving-'))
  t.after(() => { assert.ok(root.startsWith(join(tmpdir(), 'james-desktop-saving-'))); rmSync(root, { recursive: true, force: true }) })
  const requests: any[] = []
  const writes: unknown[] = []
  const fixtures: Record<string, string> = {
    electron: 'export const app={getPath:()=>fixtureRoot}',
    '../providers/text': 'export const thinkText=async request=>{requests.push(request);return {text:JSON.stringify({actions:[{do:"write",ref:1,text:"Hallo"},{do:"done",success:true,summary:"Erledigt"}]})}}',
    '../automation/uia': `export const uiaRead=async()=>({fenster:"Testfenster - Editor",gezeigt:3,gefunden:3,elemente:[
      {ref:1,rolle:"Edit",name:"Text",kann:["Value"]},{ref:2,rolle:"Button",name:"Speichern",kann:["Invoke"]},{ref:3,rolle:"Button",name:"Öffnen",kann:["Invoke"]}
    ]});export const uiaSetValue=async(ref,text)=>writes.push({ref,text});export const uiaExpand=()=>{};
      export const uiaFocus=()=>{};export const uiaInvoke=()=>{};export const uiaToggle=()=>{};`,
    '../automation/desktop': 'export const focusWindow=()=>{};export const pressHotkey=()=>{};export const typeText=()=>{}',
    '../tools/impl/computer': 'export const BLOCKED_INPUT=/kennwort/i;export const BLOCKED_PATTERNS=[]',
    './activity': 'export const activityStart=()=>{};export const activityEnd=()=>{}'
  }
  const bundle = await build({ entryPoints: [resolve('src/main/agent/desktopAgent.ts')], bundle: true,
    write: false, format: 'cjs', platform: 'node', packages: 'external', logLevel: 'silent',
    plugins: [{ name: 'desktop-fixture', setup(b) {
      b.onResolve({ filter: /.*/ }, args => args.path in fixtures ? { path: args.path, namespace: 'fixture' } : undefined)
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: fixtures[args.path] }))
    } }] })
  const module = { exports: {} as any }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports,
    require: fixtureRequire, fixtureRoot: root, requests, writes, setTimeout: (fn: () => void) => { fn(); return 0 } })
  const signal = new AbortController().signal
  const vision = async () => { throw new Error('Unnötiges Bildschirmfoto') }
  const first = await module.exports.runDesktopTask('Text Hallo eingeben', undefined, signal, vision)
  assert.equal(first.ok, true)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].signal, signal)
  assert.equal(requests[0].maxTokens, 600)
  const second = await module.exports.runDesktopTask('Text Hallo eingeben', undefined, signal, vision)
  assert.equal(second.mode, 'replay')
  assert.equal(second.modelCalls, 0)
  assert.equal(requests.length, 1)
  assert.equal(writes.length, 2)
})

it('gibt Abbruch und Sparlimit im Bild-Rückfall nicht als erfolgreichen Auftrag aus', async () => {
  const fixture: Record<string, string> = {
    '../registry': 'export const defineTool=def=>def',
    '../runner': 'export const runTool=async(_request,signal)=>{seen.push(signal);return {ok:true,result:{abgebrochen:true,grund:"Sparlimit erreicht"}}}',
    '../../agent/desktopAgent': 'export const forgetRoutines=()=>0;export const runDesktopTask=async(_goal,_app,_signal,vision)=>vision()'
  }
  const bundle = await build({ entryPoints: [resolve('src/main/tools/impl/desktop.ts')], bundle: true,
    write: false, format: 'cjs', platform: 'node', packages: 'external', logLevel: 'silent',
    plugins: [{ name: 'fallback-fixture', setup(b) {
      b.onResolve({ filter: /.*/ }, args => args.path in fixture ? { path: args.path, namespace: 'fixture' } : undefined)
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: fixture[args.path] }))
    } }] })
  const seen: AbortSignal[] = []
  const module = { exports: {} as any }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: fixtureRequire, seen })
  const signal = new AbortController().signal
  const result = await module.exports.desktopTools[0].execute({ goal: 'Test' }, { signal })
  assert.equal(result.erledigt, false)
  assert.equal(result.zusammenfassung, 'Sparlimit erreicht')
  assert.equal(seen[0], signal)
})
