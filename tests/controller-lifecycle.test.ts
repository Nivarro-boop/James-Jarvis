import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { DEFAULT_SETTINGS } from '@shared/config/defaults'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function harness() {
  const engines: any[] = []
  const errors: (string | null)[] = []
  const wishes: any[] = []
  const captions: any[] = []
  const state = {
    setError: (message: string | null) => errors.push(message),
    setWish: (...args: any[]) => wishes.push(args),
    addCaption: (...args: any[]) => captions.push(args),
    setEngineLabel() {}, setWakeAvailable() {}
  }
  class Engine {
    connected = false
    starts = 0
    sent: string[] = []
    constructor(_settings: any, public events: any) { engines.push(this) }
    async start() { this.starts++; this.connected = true; this.events.onStateChange('listening') }
    isConnected() { return this.connected }
    isStarting() { return false }
    isAcceptingAudio() { return this.connected }
    async stop() { this.connected = false; this.events.onClosed() }
    async dispose() { await this.stop() }
    interrupt() {}
    sendText(text: string) { this.sent.push(text) }
    updateSettings() {}
    async refreshConfig() {}
  }
  const fixtures: Record<string, string> = {
    '../audio/capture': 'export const startCapture=async()=>({stop:async()=>{}})',
    '../wake/wakeword': 'export const createWakeWord=async()=>({available:false,setEnabled(){},setThreshold(){},destroy(){}})',
    './LiveSession': 'export const LiveSession=Engine',
    './CascadeSession': 'export const CascadeSession=Engine',
    './RealtimeSession': 'export const RealtimeSession=Engine',
    '../store/crystalStore': 'export const useCrystal={getState:()=>state};export const amplitude={input:0}'
  }
  const bundle = await build({ entryPoints: [resolve('src/renderer/live/controller.ts')], bundle: true,
    write: false, platform: 'node', format: 'cjs', alias: { '@shared': resolve('src/shared') },
    plugins: [{ name: 'controller-lifecycle', setup(b) {
      b.onResolve({ filter: /.*/ }, args => args.path in fixtures ? { path: args.path, namespace: 'fixture' } : undefined)
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: fixtures[args.path] }))
    } }] })
  const module = { exports: {} as any }
  const listeners = new Map<string, Set<() => void>>()
  const window = {
    jarvis: { invoke: async () => {} }, setInterval: () => 1, clearInterval() {},
    addEventListener: (name: string, callback: () => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name)!.add(callback)
    },
    removeEventListener: (name: string, callback: () => void) => listeners.get(name)?.delete(callback)
  }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, console, Engine, state,
    window, navigator: { onLine: true, mediaDevices: { addEventListener() {}, removeEventListener() {} } },
    setTimeout, clearTimeout })
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.speech.provider = 'gemini'
  const controller = new module.exports.JarvisController(settings)
  return { controller, engines, errors, wishes, captions, settings, listeners }
}

it('wartet bei gleichzeitigen Texteingaben auf denselben Verbindungsaufbau', async () => {
  const h = await harness()
  const opening = deferred()
  h.controller.session = h.controller.buildSession()
  const engine = h.engines[0]
  engine.start = async () => { engine.starts++; await opening.promise; engine.connected = true }
  const first = h.controller.sendTyped('Erste Frage')
  const second = h.controller.sendTyped('Zweite Frage')
  await Promise.resolve()
  assert.equal(engine.starts, 1)
  opening.resolve()
  assert.equal(await first, true)
  assert.equal(await second, true)
  assert.deepEqual(engine.sent, ['Erste Frage', 'Zweite Frage'])
  assert.equal(h.controller.starting, false)
})

it('ignoriert Zustände und Mikrofonsperren einer abgelösten Sitzung', async () => {
  const h = await harness()
  const old = h.controller.buildSession()
  const current = h.controller.buildSession()
  current.onUploadGate(false)
  h.wishes.length = 0
  old.onUploadGate(true)
  old.events.onStateChange('thinking')
  old.events.onError('Veralteter Fehler')
  old.events.onClosed()
  assert.equal(h.controller.uploadMuted, false)
  assert.equal(h.wishes.length, 0)
  assert.equal(h.errors.length, 0)
  current.events.onStateChange('listening')
  assert.equal(h.wishes.at(-1)[1], 'listening')
})

it('meldet Sendefehler und nimmt danach die nächste Nachricht an', async () => {
  const h = await harness()
  await h.controller.wakeUp()
  const engine = h.engines[0]
  engine.sendText = () => { throw new Error('Verbindung getrennt') }
  assert.equal(await h.controller.sendTyped('Frage'), false)
  assert.match(h.errors.at(-1)!, /Verbindung getrennt/)
  engine.sendText = (text: string) => engine.sent.push(text)
  assert.equal(await h.controller.sendTyped('Erneut'), true)
  assert.deepEqual(engine.sent, ['Erneut'])
})

it('meldet eine vom Motor abgewiesene Texteingabe als fehlgeschlagen', async () => {
  const h = await harness()
  await h.controller.wakeUp()
  h.engines[0].sendText = () => false
  assert.equal(await h.controller.sendTyped('Frage'), false)
})

it('wartet nach einer Pause auf den neuen Aufbau und ignoriert den alten Abschluss', async () => {
  const h = await harness()
  h.controller.session = h.controller.buildSession()
  const engine = h.engines[0]
  const old = deferred(), current = deferred()
  engine.start = async () => {
    engine.starts++
    await (engine.starts === 1 ? old.promise : current.promise)
  }
  const first = h.controller.wakeUp()
  await Promise.resolve()
  await h.controller.setPaused(true)
  await h.controller.setPaused(false)
  const second = h.controller.wakeUp()
  await Promise.resolve()
  assert.equal(engine.starts, 2)
  old.resolve()
  await first
  assert.equal(h.controller.starting, true)
  current.resolve()
  await second
  assert.equal(h.controller.starting, false)
})

it('lässt eine verspätete Mikrofon-Abschaltung keine neuere Wiederaufnahme stoppen', async () => {
  const h = await harness()
  await h.controller.wakeUp()
  const closing = deferred()
  h.controller.capture = { stop: () => closing.promise }
  const changes: boolean[] = []
  h.controller.onPauseChange = (paused: boolean) => changes.push(paused)
  const pausing = h.controller.setPaused(true)
  assert.equal(h.engines[0].connected, false)
  await h.controller.setPaused(false)
  assert.equal(await h.controller.sendTyped('Weiter'), true)
  closing.resolve()
  await pausing
  assert.equal(h.controller.paused, false)
  assert.equal(h.engines[0].connected, true)
  assert.deepEqual(changes, [false])
  assert.notEqual(h.wishes.at(-1)[1], 'paused')
  await h.controller.dispose()
})

it('lässt Texteingaben aus der Pause zu, während eine Mikrofonfreigabe aussteht', async () => {
  const h = await harness()
  const microphone = deferred()
  h.controller.paused = true
  h.controller.captureStarting = microphone.promise
  assert.equal(await h.controller.sendTyped('Hallo'), true)
  assert.equal(h.controller.paused, false)
  assert.deepEqual(h.engines[0].sent, ['Hallo'])
  await h.controller.dispose()
  microphone.resolve()
})

it('räumt Netzhorcher auf und startet nach dem Schließen keine Sitzung mehr', async () => {
  const h = await harness()
  await h.controller.init()
  assert.equal(h.listeners.get('online')!.size, 1)
  await h.controller.dispose()
  assert.equal(h.listeners.get('online')!.size, 0)
  assert.equal(h.listeners.get('offline')!.size, 0)
  await h.controller.wakeUp()
  assert.equal(h.engines.length, 0)
})

it('startet nach einem sofortigen Schlafbefehl keinen bereits vorgemerkten Aufbau', async () => {
  const h = await harness()
  const waking = h.controller.wakeUp()
  await h.controller.sleep()
  await waking
  assert.equal(h.engines[0].starts, 0)
  assert.equal(h.engines[0].connected, false)
})

it('lässt den Abschluss eines alten Schlafbefehls den neuen Verbindungszustand bestehen', async () => {
  const h = await harness()
  await h.controller.wakeUp()
  const engine = h.engines[0]
  const closing = deferred()
  engine.stop = () => { engine.connected = false; return closing.promise }
  const sleeping = h.controller.sleep()
  await h.controller.wakeUp()
  closing.resolve()
  await sleeping
  assert.equal(h.wishes.at(-1)[1], 'listening')
})


it('öffnet das Fernmikrofon nach Loslassen während des Aufweckens nicht erneut', async () => {
  const h = await harness()
  const opening = deferred()
  h.controller.paused = true
  h.controller.setPaused = async () => { await opening.promise; h.controller.paused = false }
  const pressing = h.controller.setRemoteMic(true)
  await h.controller.setRemoteMic(false)
  opening.resolve()
  await pressing
  assert.equal(h.controller.remoteMicOpen, false)
})
