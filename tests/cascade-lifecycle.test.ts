import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'
import { DEFAULT_SETTINGS } from '@shared/config/defaults'

const source = build({ entryPoints: [resolve('src/renderer/live/CascadeSession.ts')], bundle: true,
  write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
  alias: { '@shared': resolve('src/shared') }, plugins: [{ name: 'cascade-lifecycle-fixture', setup(b) {
    const fixtures: Record<string, string> = {
      './brain': 'export const createBrain=()=>window.testBrain; export class GeminiBrain {}',
      '../audio/player': 'export const createPlayer=()=>window.createTestPlayer()',
      '../audio/piperVoice': 'export const planPiperVoice=async()=>({voice:"test",backend:"local",sampleRate:16000}); export const createPiperStream=()=>window.testVoice',
      '../audio/elevenVoice': 'export const planVoice=()=>{}; export const createVoiceStream=()=>{}',
    }
    b.onResolve({ filter: /.*/ }, args => args.path in fixtures ? { path: args.path, namespace: 'fixture' } : undefined)
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: fixtures[args.path] }))
  } }] }).then(result => result.outputFiles[0].text)

async function flush(): Promise<void> { for (let i = 0; i < 20; i++) await Promise.resolve() }

async function fixture() {
  let timerId = 0, playerDestroyed = 0, voiceAborted = 0
  const timers = new Map<number, { fn: () => void; ms: number }>()
  const states: string[] = [], errors: string[] = [], transcripts: string[] = []
  const player = { push() {}, flush() {}, async destroy() { playerDestroyed++ } }
  const window = {
    setTimeout: (fn: () => void, ms: number) => { const id = ++timerId; timers.set(id, { fn: () => { timers.delete(id); fn() }, ms }); return id },
    clearTimeout: (id: number) => timers.delete(id), setInterval: () => ++timerId, clearInterval() {},
    testBrain: { needsText: true, label: 'Test', prepare: async () => {}, reset() {},
      run: async (_input: unknown, hooks: any) => { hooks.onText('Antwort'); return true } },
    createTestPlayer: async () => player,
    testVoice: { prewarm() {}, speak() {}, finish() {}, close() {}, abort() { voiceAborted++ } },
    jarvis: { invoke: async () => '' }
  }
  const module = { exports: {} as any }
  runInNewContext(await source, { module, exports: module.exports, require, console, window, AbortSignal, AbortController, btoa,
    crypto: { randomUUID: () => 'request' } })
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.speech.provider = 'piper'; settings.speech.hearProvider = 'whisper'
  const session = new module.exports.CascadeSession(settings, {
    onStateChange: (state: string) => states.push(state), onError: (error: string) => errors.push(error),
    onUserTranscript: (text: string) => transcripts.push(text), onModelTranscript() {}
  })
  return { session, window, timers, states, errors, transcripts, player,
    get playerDestroyed() { return playerDestroyed }, get voiceAborted() { return voiceAborted } }
}

it('begrenzt einen hängenden Aufbau und erlaubt anschließend einen neuen Versuch', async () => {
  const f = await fixture()
  let ready!: () => void
  f.window.testBrain.prepare = () => new Promise<void>(resolve => { ready = resolve })
  const pending = f.session.start()
  const failed = assert.rejects(pending, /zu lange gedauert/)
  await flush()
  const timeout = [...f.timers.values()].find(timer => timer.ms === 60_000)
  assert.ok(timeout)
  timeout.fn()
  await failed
  assert.equal(f.session.isStarting(), false)
  assert.equal(f.session.isConnected(), false)
  assert.equal(f.states.at(-1), 'idle')
  ready()
  await flush()
  assert.equal(f.session.player, null)
  f.window.testBrain.prepare = async () => {}
  await f.session.start()
  assert.equal(f.session.isConnected(), true)
  await f.session.stop()
  assert.equal(f.timers.size, 0)
})

it('löst einen gestoppten Aufbau sofort und schützt die neue Sitzung vor dessen spätem Abschluss', async () => {
  const f = await fixture()
  let ready!: () => void
  f.window.testBrain.prepare = () => new Promise<void>(resolve => { ready = resolve })
  const old = f.session.start()
  await flush()
  await f.session.stop()
  f.window.testBrain.prepare = async () => {}
  await f.session.start()
  await old
  ready()
  await flush()
  assert.equal(f.session.isConnected(), true)
  assert.equal(f.session.isStarting(), false)
  assert.equal(f.session.player, f.player)
  assert.equal(f.playerDestroyed, 0)
  await f.session.stop()
  assert.equal(f.playerDestroyed, 1)
})

it('zerstört einen verspätet aufgebauten Player, ohne den Player der neuen Sitzung zu ersetzen', async () => {
  const f = await fixture()
  let complete!: (player: any) => void
  let oldDestroyed = 0
  f.window.createTestPlayer = () => new Promise<any>(resolve => { complete = resolve })
  const old = f.session.start()
  await flush()
  assert.ok(complete)
  await f.session.stop()
  f.window.createTestPlayer = async () => f.player
  await f.session.start()
  complete({ async destroy() { oldDestroyed++ } })
  await old
  await flush()
  assert.equal(oldDestroyed, 1)
  assert.equal(f.session.player, f.player)
  assert.equal(f.playerDestroyed, 0)
  await f.session.stop()
})

it('setzt die neue Sitzung nicht zurück, wenn der alte Player noch abgebaut wird', async () => {
  const f = await fixture()
  await f.session.start()
  let destroyed!: () => void
  f.player.destroy = () => new Promise<void>(resolve => { destroyed = resolve })
  const stopping = f.session.stop()
  const freshPlayer = { push() {}, flush() {}, async destroy() {} }
  f.window.createTestPlayer = async () => freshPlayer
  await f.session.start()
  destroyed()
  await stopping
  assert.equal(f.session.player, freshPlayer)
  assert.equal(f.session.isConnected(), true)
  assert.equal(f.states.at(-1), 'listening')
  await f.session.stop()
})

it('gibt das Mikrofon frei, wenn die lokale Stimme kein Abschlussereignis mehr sendet', async () => {
  const f = await fixture()
  const gates: boolean[] = []
  f.session.onUploadGate = (muted: boolean) => gates.push(muted)
  await f.session.start()
  await f.session.ask({ text: 'Frage' }, null)
  assert.equal(f.session.thinking, false)
  assert.equal(f.session.outputBusy, true)
  assert.equal(gates.at(-1), true)
  const timeout = [...f.timers.values()].find(timer => timer.ms === 60_000)
  assert.ok(timeout)
  timeout.fn()
  assert.equal(f.voiceAborted, 1)
  assert.equal(f.session.outputBusy, false)
  assert.equal(f.session.voiceActive, false)
  assert.equal(gates.at(-1), false)
  assert.equal(f.states.at(-1), 'listening')
  assert.equal(f.errors.length, 1)
  await f.session.ask({ text: 'Nächste Frage' }, null)
  assert.equal(f.session.thinking, false)
  await f.session.stop()
  assert.equal(f.timers.size, 0)
})

it('lässt eine lange laufende Audiowiedergabe zu und räumt den Ausgabewächter beim Stoppen ab', async () => {
  const f = await fixture()
  await f.session.start()
  await f.session.ask({ text: 'Längere Antwort' }, null)
  f.session.onPlayerSpeaking(true)
  const timeout = [...f.timers.values()].find(timer => timer.ms === 60_000)
  assert.ok(timeout)
  timeout.fn()
  assert.equal(f.voiceAborted, 0)
  assert.equal(f.session.outputBusy, true)
  await f.session.stop()
  assert.equal(f.timers.size, 0)
})

it('verwirft eine verspätete Abschrift nach Unterbrechung', async () => {
  const f = await fixture()
  let complete!: (text: string) => void
  f.window.testBrain.run = async (_input: unknown, hooks: any) => {
    void hooks.transcript().catch(() => undefined)
    hooks.onText('Antwort')
    return true
  }
  f.session.transcribe = () => new Promise<string>(resolve => { complete = resolve })
  await f.session.start()
  f.window.testBrain.needsText = false
  await f.session.ask({ wavBase64: 'audio' }, [new Int16Array(320)])
  f.session.interrupt()
  complete('Veralteter Satz')
  await flush()
  assert.deepEqual(f.transcripts, [])
  assert.deepEqual(f.errors, [])
  await f.session.stop()
})
