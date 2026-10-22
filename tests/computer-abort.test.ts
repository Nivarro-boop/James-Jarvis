import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { resolve, join } from 'node:path'

const fixtureRequire = createRequire(join(process.cwd(), 'package.json'))

it('startet nach Nutzerabbruch während des Provider-Awaits keine verspätete Desktop-Aktion', async () => {
  const calls: string[] = []
  const controller = new AbortController()
  const fixtures: Record<string, string> = {
    electron: 'export const clipboard={readText:()=>"",writeText(){}}',
    '../registry': 'export const defineTool=def=>def',
    '../../providers/gemini': 'export const geminiClient=()=>{throw Error("Unerwarteter Gemini-Aufruf")};export const friendlyGeminiError=e=>e.message',
    '../../store/settings': 'export const getSettings=()=>({brainProvider:"chatgpt",speech:{thinkProvider:"chatgpt"},chatGptModel:"mock",tokenSaver:{enabled:true}})',
    '../../automation/desktop': `export const activeDisplay=()=>({label:"Testmonitor"});
      export const inputBackendStatus=async()=>({name:"mock"});export const listWindows=async()=>[];
      export const captureScreen=async()=>({base64:"mock-image",mimeType:"image/png",tokens:1,display:{label:"Testmonitor"}});
      export const typeText=async text=>calls.push(text);export const focusWindow=async()=>({});
      export const captureRegion=async()=>({base64:"mock",mimeType:"image/png",width:1,height:1});
      export const click=async()=>{};export const cursorPosition=async()=>({x:0,y:0});export const displayForWindow=()=>{};
      export const displayPoint=(_d,x,y)=>({x,y});export const drag=async()=>{};export const mouseDown=async()=>{};
      export const mouseUp=async()=>{};export const moveMouse=async()=>{};export const pressHotkey=async()=>{};export const scroll=async()=>{};`,
    '../../db': 'export const logAction=()=>{};export const recordSaving=()=>{}',
    '../../providers/geminiTurn': 'export const modelTurn=(_r,parts)=>({role:"model",parts})',
    '../../providers/chatgptVision': `export const chatGptVision=async()=>{
      controller.abort();
      return {output:[{type:"function_call",name:"jarvis.computer_batch",arguments:JSON.stringify({actions:[
        {action:"type",text:"verspätet",intent:"Text in Testfeld eingeben"},{action:"done",success:true,summary:"fertig"}
      ]})}]}
    }`
  }
  const bundle = await build({ entryPoints: [resolve('src/main/tools/impl/computer.ts')], bundle: true,
    write: false, format: 'cjs', platform: 'node', packages: 'external', logLevel: 'silent',
    plugins: [{ name: 'computer-abort-fixture', setup(b) {
      b.onResolve({ filter: /.*/ }, args => args.path in fixtures ? { path: args.path, namespace: 'fixture' } : undefined)
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: fixtures[args.path] }))
    } }] })
  const module = { exports: {} as any }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports,
    require: fixtureRequire, calls, controller,
    setTimeout: (fn: () => void) => { fn(); return 0 } })
  const result = await module.exports.computerTools[0].execute(
    { goal: 'Mock-Aufgabe' }, { signal: controller.signal })
  assert.equal(result.abgebrochen, true)
  assert.equal(result.grund, 'Vom Nutzer gestoppt.')
  assert.deepEqual(calls, [])
})
