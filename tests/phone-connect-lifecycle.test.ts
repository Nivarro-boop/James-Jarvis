import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'

async function harness(connect: (params: any) => Promise<any>) {
  const fixtures: Record<string, string> = {
    '@google/genai': `export const EndSensitivity={END_SENSITIVITY_LOW:1}; export const StartSensitivity={START_SENSITIVITY_LOW:1}; export const Modality={AUDIO:'AUDIO'}; export class GoogleGenAI { constructor(){this.live={connect:(p)=>window.testConnect(p)}} }`,
    '../secrets/keystore': `export const getSecret=()=> 'test-key'`,
    '../store/settings': `export const getSettings=()=>({liveModel:'test',voice:'test',language:'en'})`,
    '../agent/prompt': `export const buildSystemPrompt=()=> 'prompt'`,
    '../tools/runner': `export const runTool=async()=>({ok:true})`,
    '../agent/capabilityGaps': `export const withoutGapReports=fn=>fn()`,
    './phoneTools': `export const hasPhoneTools=()=>false; export const phoneToolDeclarations=()=>[]; export const phoneToolNames=()=>[]`,
    './audio': `export const bytesToPcm=x=>x; export class Downsampler24kTo8k {push(x){return x} reset(){}}; export const muLawToPcm8k=x=>x; export class OutboundPacer {constructor(){} push(){} clear(){} stop(){} pendingMs(){return 0}}; export const pcmToBytes=x=>x; export const upsample8kTo16k=x=>({out:x,last:0})`
  }
  const bundle = await build({ entryPoints: [resolve('src/main/telephony/liveCall.ts')], bundle: true,
    write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
    plugins: [{ name: 'test-fixtures', setup(b) {
      b.onResolve({ filter: /.*/ }, args => args.path in fixtures ? { path: args.path, namespace: 'fixture' } : undefined)
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: fixtures[args.path] }))
    } }] })
  let next = 1
  const timers = new Map<number, { fn: () => void; ms: number }>()
  const window = { testConnect: connect }
  const module = { exports: {} as any }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require, Buffer, console, window,
    setTimeout: (fn: () => void, ms: number) => { const id = next++; timers.set(id, { fn, ms }); return id as any },
    clearTimeout: (id: number) => timers.delete(id) })
  const closed: string[] = []
  const greetings: any[] = []
  const call = new module.exports.LiveCall({ onAudio() {}, onClear() {}, onTranscript() {}, onClosed: (r: string) => closed.push(r) }, 'Hallo')
  return { call, timers, closed, greetings }
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const session = (closed: { count: number }, greetings: any[]) => ({ close() { closed.count++ }, sendClientContent(x: any) { greetings.push(x) }, sendRealtimeInput() {}, sendToolResponse() {} })

it('begrenzt einen hängenden Handschlag auf 20 Sekunden und räumt den Timer auf', async () => {
  const h = await harness(() => new Promise(() => {}))
  const start = h.call.start()
  const timer = [...h.timers.entries()].find(([, t]) => t.ms === 20_000)!
  timer[1].fn()
  await assert.rejects(start, /Zeitüberschreitung/)
  assert.equal(h.timers.has(timer[0]), false)
  assert.match(h.closed[0], /Verbindungsaufbau/)
})

it('beendet start sofort bei Close während des Handshakes und schließt eine späte Sitzung', async () => {
  let resolve!: (s: any) => void
  const counts = { count: 0 }, greetings: any[] = []
  const h = await harness(() => new Promise(r => { resolve = r }))
  const starting = h.call.start()
  h.call.stop()
  await starting
  resolve(session(counts, greetings))
  await settle()
  assert.equal(counts.count, 1)
  assert.equal(greetings.length, 0)
  assert.equal([...h.timers.values()].some(t => t.ms === 20_000), false)
})

it('konsumiert verspätete Ablehnung nach Close ohne unhandled rejection', async () => {
  let reject!: (e: unknown) => void
  const h = await harness(() => new Promise((_r, r) => { reject = r }))
  const starting = h.call.start()
  h.call.stop()
  await starting
  reject(new Error('late failure'))
  await settle()
})

it('schließt verspätete Sitzung nach Connect-Timeout und konsumiert den Connect-Fehlerpfad', async () => {
  let resolve!: (s: any) => void
  const counts = { count: 0 }, greetings: any[] = []
  const h = await harness(() => new Promise(r => { resolve = r }))
  const starting = h.call.start()
  ;[...h.timers.values()].find(t => t.ms === 20_000)!.fn()
  await assert.rejects(starting, /Zeitüberschreitung/)
  resolve(session(counts, greetings))
  await settle()
  assert.equal(counts.count, 1)
  assert.equal(greetings.length, 0)
})

it('sendet genau eine Begrüßung nach Erfolg und räumt Connect- und Hardstop-Timer beim Stop auf', async () => {
  const counts = { count: 0 }, greetings: any[] = []
  const h = await harness(async () => session(counts, greetings))
  const first = h.call.start(), second = h.call.start()
  assert.equal(first, second)
  await first
  assert.equal(greetings.length, 1)
  assert.equal([...h.timers.values()].some(t => t.ms === 20_000), false)
  assert.equal([...h.timers.values()].some(t => t.ms === 10 * 60 * 1000), true)
  h.call.stop()
  assert.equal(counts.count, 1)
  assert.equal(h.timers.size, 0)
})

it('reicht einen fehlgeschlagenen Connect unverändert weiter und räumt die Deadline auf', async () => {
  const h = await harness(async () => { throw new Error('connect failed') })
  await assert.rejects(h.call.start(), /connect failed/)
  assert.equal([...h.timers.values()].some(t => t.ms === 20_000), false)
})

it('verbindet nach einem bereits erfolgten Stop nicht mehr mit dem Provider', async () => {
  let connects = 0
  const h = await harness(async () => { connects++; throw new Error('Darf nicht verbinden') })
  h.call.stop()
  await h.call.start()
  assert.equal(connects, 0)
  assert.equal(h.timers.size, 0)
})
