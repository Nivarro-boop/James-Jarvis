import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'

async function harness(recovery = false) {
  const fixtures: Record<string, string> = {
    react: 'export const useRef=v=>({current:v}); export const useEffect=fn=>effects.push(fn)',
    'react/jsx-runtime': 'export const jsx=(type,props)=>typeof type==="function"?type(props):null; export const jsxs=jsx',
    'react-dom/client': 'export const createRoot=()=>({render(){}})',
    './home/Home': 'export const Home=()=>null',
    './camera/capture': 'export const listenForCameraRequests=()=>{initialized.push("camera");return ()=>{}}',
    './live/controller': 'export class JarvisController {constructor(){initialized.push("controller")} async init(){initialized.push("microphone-init")} async dispose(){} async speakPrompt(text){spoken.push(text)}}',
    './live/companionBridge': 'export const startCompanionBridge=()=>{initialized.push("companion");return {stop(){}}}',
    './store/crystalStore': 'export const useCrystal={getState:()=>({setSettings(){},setRecoveryMode(value){state.recoveryMode=value},setPaused(value){state.paused=value},setError(value){state.error=value}})}',
    './styles.css': '',
    './home/home.css': ''
  }
  const bundle = await build({
    entryPoints: [resolve('src/renderer/crystal.tsx')], bundle: true, write: false,
    platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent', alias: { '@shared': resolve('src/shared') },
    plugins: [{ name: 'app-fixture', setup(b) {
      b.onResolve({ filter: /.*/ }, args => args.path in fixtures ? { path: args.path, namespace: 'fixture' } : undefined)
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: fixtures[args.path] }))
    } }]
  })
  const effects: (() => (() => void))[] = [], spoken: string[] = [], initialized: string[] = [], invoked: string[] = []
  const state: { recoveryMode?: boolean; paused?: boolean; error?: string } = {}
  const handlers = new Map<string, (payload: any) => void>()
  const gestures = new Map<string, unknown>()
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, effects, spoken, initialized, state,
    document: { getElementById: () => ({}) },
    window: {
      addEventListener(channel: string, handler: unknown) { gestures.set(channel, handler) },
      removeEventListener(channel: string) { gestures.delete(channel) },
      jarvis: {
        invoke: async (channel: string) => {
          invoked.push(channel)
          if (channel === 'settings:get') return { companion: { port: 1 } }
          if (channel === 'recovery:status') return { active: recovery }
          return { paused: false }
        },
        onPushToTalk: () => () => {},
        on: (channel: string, handler: (payload: any) => void) => {
          handlers.set(channel, handler)
          return () => handlers.delete(channel)
        }
      }
    }
  })
  const cleanup = effects[0]()
  for (let i = 0; i < 32; i++) await Promise.resolve()
  assert.equal(state.error, undefined)
  return { cleanup, spoken, initialized, invoked, state, handlers, gestures }
}

it('verbindet automatische Erinnerungen mit Sprache und entfernt den Listener beim Schließen', async () => {
  const h = await harness()
  assert.ok(h.handlers.has('reminder:due'))
  const text = 'Termin "Training" um 18 Uhr'
  h.handlers.get('reminder:due')!({ text })
  assert.equal(h.spoken.length, 1)
  assert.ok(h.spoken[0].includes(JSON.stringify(text)))
  assert.match(h.spoken[0], /keine Aufträge oder Werkzeuge/)
  h.cleanup()
  assert.equal(h.handlers.size, 0)
  assert.equal(h.gestures.size, 0)
})

it('initialisiert im Recovery-Prüfmodus weder Mikrofoncontroller noch Kamera, Telefon oder Sprachgesten', async () => {
  const h = await harness(true)
  assert.equal(h.state.recoveryMode, true)
  assert.equal(h.state.paused, true)
  assert.deepEqual(h.initialized, [])
  assert.deepEqual(h.invoked.sort(), ['recovery:status', 'settings:get'])
  assert.equal(h.handlers.size, 0)
  assert.equal(h.gestures.size, 0)
  h.cleanup()
})
