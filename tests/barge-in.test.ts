import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'
import { DEFAULT_SETTINGS } from '@shared/config/defaults'
import { BargeInDetector } from '@shared/audio/bargeIn'

it('ignoriert kurze Geräusche, erhält den Sprechbeginn und setzt sich zurück', () => {
  const detector = new BargeInDetector()
  const block = new Int16Array(320)
  for (let i = 0; i < 7; i++) assert.equal(detector.feed(block, 0.8, 0.5), null)
  assert.equal(detector.feed(block, 0.1, 0.5), null)
  for (let i = 0; i < 7; i++) assert.equal(detector.feed(block, 0.8, 0.5), null)
  assert.equal(detector.feed(block, 0.8, 0.5)?.length, 15)
  assert.equal(detector.feed(block, 0.8, 0.5), null)
})

it('leitet im echten Controller eine Unterbrechung trotz Half-Duplex-Sperre weiter', async () => {
  const bundle = await build({ entryPoints: [resolve('src/renderer/live/controller.ts')], bundle: true,
    write: false, platform: 'node', format: 'cjs', logLevel: 'silent',
    alias: { '@shared': resolve('src/shared') },
    plugins: [{ name: 'controller-fixture', setup(b) {
      b.onResolve({ filter: /\/(?:LiveSession|CascadeSession|RealtimeSession|capture|wakeword|crystalStore)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents:
        args.path.endsWith('crystalStore') ? 'export const amplitude={input:0,output:0}; export const useCrystal={getState:()=>({setWish(){},setError(){}})}'
        : args.path.endsWith('capture') ? 'export async function startCapture(){return {stop(){}}}'
        : args.path.endsWith('wakeword') ? 'export async function createWakeWord(){return {feed(){},setEnabled(){}}}'
        : `export class ${args.path.split('/').at(-1)} {}` }))
    } }] })
  const module = { exports: {} as any }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, console })
  const controller = new module.exports.JarvisController(structuredClone(DEFAULT_SETTINGS))
  let interrupted = 0
  const received: Int16Array[] = []
  controller.session = { isConnected: () => true, isStarting: () => false, isAcceptingAudio: () => true, interrupt: () => interrupted++, pushAudio: (pcm: Int16Array) => received.push(pcm) }
  controller.uploadMuted = true
  const speech = new Int16Array(320).fill(20_000)
  for (let i = 0; i < 7; i++) controller.onChunk(speech)
  assert.equal(interrupted, 0)
  assert.equal(received.length, 0)
  controller.onChunk(speech)
  assert.equal(interrupted, 1)
  assert.equal(received.length, 8)
  assert.equal(controller.uploadMuted, false)
  controller.paused = true
  controller.onChunk(speech)
  assert.equal(received.length, 8)
})

it('bricht den laufenden Denkzug ab und verarbeitet den neuen Satz ohne alte Aktionen', async () => {
  const bundle = await build({ entryPoints: [resolve('src/renderer/live/CascadeSession.ts')], bundle: true,
    write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
    alias: { '@shared': resolve('src/shared') },
    plugins: [{ name: 'cascade-fixture', setup(b) {
      b.onResolve({ filter: /(?:\.\/brain|audio\/(?:player|elevenVoice|piperVoice|vibeVoice))$/ }, args => ({ path: args.path, namespace: 'fixture' }))
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents:
        args.path.endsWith('brain') ? 'export const createBrain=()=>window.testBrain; export class GeminiBrain {}'
        : 'export const createPlayer=()=>{}; export const createVoiceStream=()=>{}; export const planVoice=()=>{}; export const createPiperStream=()=>{}; export const planPiperVoice=()=>{}; export const createVibeVoiceStream=()=>{}; export const planVibeVoice=()=>{}' }))
    } }] })
  let firstHooks: any
  const inputs: string[] = []
  const window = { setTimeout, clearTimeout, testBrain: {
    needsText: true, run: async (input: {text: string}, hooks: any) => {
      inputs.push(input.text)
      if (inputs.length > 1) { hooks.onText('Neue Antwort'); return true }
      firstHooks = hooks
      await new Promise((_resolve, reject) => hooks.signal.addEventListener('abort', () => reject(new Error('abort')), {once:true}))
      return false
    }
  }, jarvis: { invoke: async () => { throw new Error('Ein abgebrochener Zug darf keine Aktion ausführen.') } } }
  const module = { exports: {} as any }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require, window, console, AbortController, AbortSignal })
  const errors: string[] = []
  const session = new module.exports.CascadeSession(structuredClone(DEFAULT_SETTINGS), {
    onStateChange() {}, onModelTranscript() {}, onError: (message: string) => errors.push(message)
  })
  session.awake = true
  session.sendText('Alte Frage')
  assert.equal(firstHooks.signal.aborted, false)
  session.interrupt()
  session.sendText('Neue Frage')
  assert.equal(firstHooks.signal.aborted, true)
  assert.equal((await firstHooks.callTool('reminder_set', {text:'veraltet'})).ok, false)
  for (let i = 0; i < 15; i++) await Promise.resolve()
  assert.deepEqual(inputs, ['Alte Frage', 'Neue Frage'])
  assert.deepEqual(errors, [])
})
