import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'
import { DEFAULT_SETTINGS } from '@shared/config/defaults'
import { abortable } from '@shared/async'
import { EventEmitter } from 'node:events'

async function load(file: string, fixtures: Record<string, string>, globals: Record<string, unknown>) {
  const bundle = await build({ entryPoints: [resolve(file)], bundle: true, write: false,
    platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
    alias: { '@shared': resolve('src/shared') }, plugins: [{ name: 'fixture', setup(b) {
      b.onResolve({ filter: /.*/ }, args => args.path in fixtures ? { path: args.path, namespace: 'fixture' } : undefined)
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: fixtures[args.path] }))
    } }] })
  const module = { exports: {} as any }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require, console,
    AbortSignal, AbortController, ...globals })
  return module.exports
}

it('bereinigt Mikrofon und Audioausgabe nach einem fehlgeschlagenen Worklet-Aufbau', async () => {
  let closed = 0, stopped = 0
  class Context {
    audioWorklet = { addModule: async () => { throw new Error('Worklet kaputt') } }
    async close() { closed++ }
  }
  const fixtures = {
    '../worklets/capture-worklet.js?url': 'export default "capture"',
    '../worklets/player-worklet.js?url': 'export default "player"',
    '../store/crystalStore': 'export const amplitude={}'
  }
  const globals = { AudioContext: Context, navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped++ }] }) } } }
  const capture = await load('src/renderer/audio/capture.ts', fixtures, globals)
  await assert.rejects(capture.startCapture({ settings: DEFAULT_SETTINGS.audio, onChunk: () => {} }), /Worklet kaputt/)
  assert.equal(stopped, 1)
  assert.equal(closed, 1)
  const player = await load('src/renderer/audio/player.ts', fixtures, globals)
  await assert.rejects(player.createPlayer(DEFAULT_SETTINGS.audio), /Worklet kaputt/)
  assert.equal(closed, 2)
})

it('löst wartende Operationen bei Abbruch und ignoriert verspätete Ergebnisse', async () => {
  const abort = new AbortController()
  let resolve!: (value: string) => void
  const operation = new Promise<string>(r => { resolve = r })
  const waiting = abortable(operation, abort.signal)
  abort.abort(new Error('Gestoppt'))
  await assert.rejects(waiting, /Gestoppt/)
  resolve('zu spät')
  assert.equal(await abortable(Promise.resolve('ok'), new AbortController().signal), 'ok')
})

it('Klatschen weckt auch nach einer beendeten Sitzung mit bestehendem Sitzungsobjekt', async () => {
  const fixtures: Record<string, string> = {
    '../audio/capture': 'export const startCapture=()=>{}',
    '../wake/wakeword': 'export const createWakeWord=()=>{}',
    '../store/crystalStore': 'export const amplitude={};export const useCrystal={getState:()=>({})}',
    './LiveSession': 'export class LiveSession {}', './CascadeSession': 'export class CascadeSession {}',
    './RealtimeSession': 'export class RealtimeSession {}'
  }
  const { JarvisController } = await load('src/renderer/live/controller.ts', fixtures, {})
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.wake.clap = true
  const controller = new JarvisController(settings)
  controller.session = { isConnected: () => false, isStarting: () => false, isAcceptingAudio: () => false }
  let wakes = 0
  controller.wakeUp = async () => { wakes++ }
  const silence = new Int16Array(160 * 20), impulse = new Int16Array(160)
  for (let i = 0; i < 4; i++) impulse[10 + i] = i % 2 ? 6500 : -6500
  for (const pcm of [silence, impulse, silence, impulse, silence]) controller.onChunk(pcm)
  assert.equal(wakes, 1)
})

it('gibt das Mikrofon nach einem Fehler mitten in der Ausgabe wieder frei und beantwortet die nächste Frage', async () => {
  const fixtures: Record<string, string> = {
    './brain': 'export const createBrain=()=>window.testBrain;export class GeminiBrain {}',
    '../audio/player': 'export const createPlayer=()=>{}',
    '../audio/elevenVoice': 'export const createVoiceStream=()=>{};export const planVoice=()=>{}',
    '../audio/piperVoice': 'export const createPiperStream=()=>{};export const planPiperVoice=()=>{}',
    '../audio/vibeVoice': 'export const createVibeVoiceStream=()=>{};export const planVibeVoice=()=>{}'
  }
  let fail = true, voiceAborts = 0
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let timerId = 0
  const errors: string[] = [], text: string[] = []
  const window = { setTimeout: (fn: () => void, ms: number) => { timers.set(++timerId, {fn, ms}); return timerId },
    clearTimeout: (id: number) => timers.delete(id), testBrain: { needsText: true,
      run: async (_input: unknown, hooks: any) => { hooks.onText('Antwort'); if (fail) throw new Error('Verbindung abgerissen'); return true }
    } }
  const { CascadeSession } = await load('src/renderer/live/CascadeSession.ts', fixtures, { window })
  const session = new CascadeSession(structuredClone(DEFAULT_SETTINGS), {
    onStateChange() {}, onError: (message: string) => errors.push(message), onModelTranscript: (chunk: string) => text.push(chunk)
  })
  session.awake = true
  session.voiceKind = 'piper'
  session.voice = { prewarm() {}, speak() {}, abort() { voiceAborts++ }, finish() { session.voiceActive = false } }
  await session.ask({ text: 'Frage eins' }, null)
  assert.equal(voiceAborts, 1)
  assert.equal(session.thinking, false)
  assert.equal(session.voiceActive, false)
  for (const { fn, ms } of [...timers.values()]) if (ms < 1000) fn()
  assert.equal(session.outputBusy, false)
  fail = false
  await session.ask({ text: 'Frage zwei' }, null)
  assert.equal(errors.length, 1)
  assert.equal(text.length, 2)
  assert.equal(session.thinking, false)
})

it('meldet einen fehlgeschlagenen Live-Werkzeugaufruf ans Modell statt die Antwortschleife hängen zu lassen', async () => {
  const sent: any[] = []
  const fixtures = { '../audio/player': 'export const createPlayer=()=>{}',
    '../store/crystalStore': 'export const useCrystal={getState:()=>({})}' }
  const { LiveSession } = await load('src/renderer/live/LiveSession.ts', fixtures,
    { window: { setTimeout: () => 1, clearTimeout() {}, jarvis: { invoke: async (channel: string) => { if (channel === 'tools:call') throw new Error('IPC ausgefallen') } } } })
  const session = new LiveSession(structuredClone(DEFAULT_SETTINGS), { onStateChange() {} })
  session.stopped = false
  session.conn = { closing: false, session: { sendToolResponse: (response: any) => sent.push(response) } }
  await session.handleToolCalls([{ id: 'call-1', name: 'weather' }])
  assert.equal(session.busyTools, 0)
  assert.equal(sent.length, 1)
  assert.match(sent[0].functionResponses[0].response.error, /IPC ausgefallen/)
})

for (const service of ['inputServer', 'uia']) it(`${service}: ersetzt einen hängenden Helfer; dessen verspätetes Ende beschädigt den neuen Helfer nicht`, async () => {
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let timerId = 0
  const processes: any[] = []
  const mockSpawn = () => {
    const proc: any = new EventEmitter()
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter()
    proc.stdout.setEncoding = proc.stderr.setEncoding = () => {}
    proc.kill = () => { proc.killed = true }
    proc.stdin = { write: (line: string, callback: (error?: Error) => void) => {
      callback()
      if (processes.length > 1) queueMicrotask(() => {
        processes[0].emit('exit', 0)
        const { id } = JSON.parse(line)
        proc.stdout.emit('data', `${JSON.stringify({ id, ok: true, data: {} })}\n`)
      })
    } }
    processes.push(proc)
    queueMicrotask(() => proc.stdout.emit('data', '{"ready":true}\n'))
    return proc
  }
  const exports = await load(`src/main/automation/${service}.ts`, {
    'node:child_process': 'export const spawn=(...args)=>mockSpawn(...args)',
    '../resources': 'export const resourceFile=()=>"test-helper.ps1"'
  }, { mockSpawn, setTimeout: (fn: () => void, ms: number) => { timers.set(++timerId, {fn, ms}); return timerId },
    clearTimeout: (id: number) => timers.delete(id) })
  const available = () => service === 'uia' ? exports.uiaAvailable() : exports.powershellInput.available()
  const first = available()
  for (let i = 0; i < 5; i++) await Promise.resolve()
  const timeout = [...timers.values()].find(t => t.ms === 20000)
  assert.ok(timeout)
  timeout.fn()
  assert.equal(await first, false)
  assert.equal(processes[0].killed, true)
  assert.equal(await available(), true)
  assert.equal(await available(), true)
  assert.equal(processes.length, 2)
})

it('puffert den Satzanfang während des Aufbaus und reicht ihn nach dem Aufwachen unverändert weiter', async () => {
  let ready!: () => void
  const preparing = new Promise<void>(resolve => { ready = resolve })
  const fixtures: Record<string, string> = {
    './brain': 'export const createBrain=()=>window.testBrain;export class GeminiBrain {}',
    '../audio/player': 'export const createPlayer=()=>{}',
    '../audio/elevenVoice': 'export const createVoiceStream=()=>{};export const planVoice=()=>{}',
    '../audio/piperVoice': 'export const createPiperStream=()=>{};export const planPiperVoice=async()=>({voice:"test",backend:"local",sampleRate:16000})',
    '../audio/vibeVoice': 'export const createVibeVoiceStream=()=>{};export const planVibeVoice=()=>{}'
  }
  const window = { setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, testBrain: { needsText: true, prepare: () => preparing },
    jarvis: { invoke: async () => '' } }
  const { CascadeSession } = await load('src/renderer/live/CascadeSession.ts', fixtures, { window })
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.speech.provider = 'piper'; settings.speech.hearProvider = 'whisper'
  const session = new CascadeSession(settings, { onStateChange() {}, onError(message: string) { throw new Error(message) } })
  session.ensurePlayer = async () => true
  session.openPiper = () => { session.voice = { prewarm() {} } }
  const received: Int16Array[] = []
  const original = session.pushAudio.bind(session)
  session.pushAudio = (pcm: Int16Array) => session.awake ? received.push(pcm) : original(pcm)
  const starting = session.start()
  assert.equal(session.isAcceptingAudio(), true)
  const pcm = new Int16Array(320).fill(9000)
  session.pushAudio(pcm)
  pcm.fill(0)
  ready()
  await starting
  assert.equal(received.length, 1)
  assert.equal(received[0][0], 9000)
})

it('nutzt Bildsteuerung bei fehlendem Bedienbaum oder ungültigem Plan, wiederholt aber keinen Kontingentfehler', async () => {
  const control = { mode: 'tree' }
  const tree = { fenster: 'Testprogramm', gefunden: 3, gezeigt: 3, elemente: [1,2,3].map(ref => ({ ref, name: `Knopf ${ref}`, rolle: 'Button', kann: ['Invoke'] })) }
  const fixtures: Record<string, string> = {
    electron: 'export const app={getPath:()=>"fixture"}',
    'node:fs': 'export const existsSync=()=>false;export const readFileSync=()=>"{}";export const writeFileSync=()=>{}',
    '../providers/text': 'export const thinkText=async()=>{if(control.mode==="quota")throw new Error("Kontingent leer");return {text:control.mode==="invalid"?"{broken}":"{}"}}',
    '../automation/uia': 'export const uiaRead=async()=>{if(control.mode==="tree")throw new Error("Bedienbaum hängt");return tree};export const uiaExpand=()=>{};export const uiaFocus=()=>{};export const uiaInvoke=()=>{};export const uiaSetValue=()=>{};export const uiaToggle=()=>{}',
    '../automation/desktop': 'export const focusWindow=()=>{};export const pressHotkey=()=>{};export const typeText=()=>{}',
    '../tools/impl/computer': 'export const BLOCKED_INPUT=[];export const BLOCKED_PATTERNS=[]',
    './activity': 'export const activityStart=()=>{};export const activityEnd=()=>{}'
  }
  const { runDesktopTask, parseDesktopActions } = await load('src/main/agent/desktopAgent.ts', fixtures, { control, tree })
  for (const actions of [null, 'click', [{ do: 'press', ref: -1 }], [{ do: 'wait', seconds: 999 }], [{ do: 'unknown' }]]) {
    // Missing/null actions means an empty plan; all other malformed structures must fail.
    if (actions !== null) assert.throws(() => parseDesktopActions(JSON.stringify({ actions })), /Plan|Aktion/)
  }
  assert.equal(parseDesktopActions(JSON.stringify({ actions: Array(10).fill({ do: 'press', ref: 1 }) })).length, 6)
  let fallback = 0
  const vision = async () => { fallback++; return { ok: true, summary: 'Bild erfolgreich', mode: 'vision', steps: 1, modelCalls: 1 } }
  for (const mode of ['tree', 'invalid', 'empty']) {
    control.mode = mode
    assert.equal((await runDesktopTask('Auftrag', undefined, new AbortController().signal, vision)).mode, 'vision')
  }
  control.mode = 'quota'
  const result = await runDesktopTask('Auftrag', undefined, new AbortController().signal, vision)
  assert.equal(result.ok, false)
  assert.match(result.summary, /Kontingent/)
  assert.equal(fallback, 3)
})

it('beendet eine hängende Realtime-Werkzeugwartezeit nach Abbruch ohne alte Antwort', async () => {
  const cancelled: string[] = []
  const { RealtimeSession } = await load('src/renderer/live/RealtimeSession.ts', {
    '../audio/player': 'export const createPlayer=()=>{}'
  }, { window: { jarvis: { invoke: async (channel: string, payload: any) => {
    if (channel === 'tools:call') return new Promise(() => {})
    if (channel === 'tools:cancel') cancelled.push(payload.id)
  } } } })
  const session = new RealtimeSession(DEFAULT_SETTINGS, { onStateChange() {} })
  session.ready = true
  session.ws = {}
  const sent: unknown[] = []
  session.send = (value: unknown) => sent.push(value)
  const pending = session.handleToolCalls([{ call_id: 'hanging', name: 'test', arguments: '{}' }])
  session.cancelRunningTools()
  await pending
  assert.equal(session.busyTools, 0)
  assert.equal(sent.length, 0)
  assert.ok(cancelled.includes('hanging'))
})
