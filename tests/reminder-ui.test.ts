import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'

it('verbindet automatische Erinnerungen mit Sprache und entfernt den Listener beim Schließen', async () => {
  const fixtures: Record<string, string> = {
    react: 'export const useRef=v=>({current:v}); export const useEffect=fn=>effects.push(fn)',
    'react/jsx-runtime': 'export const jsx=(type,props)=>typeof type==="function"?type(props):null; export const jsxs=jsx',
    'react-dom/client': 'export const createRoot=()=>({render(){}})',
    './home/Home': 'export const Home=()=>null',
    './browser/BrowserWorkspace': 'export const BrowserWorkspace=({children})=>children',
    './camera/capture': 'export const listenForCameraRequests=()=>()=>{}',
    './live/controller': 'export class JarvisController {async init(){} async dispose(){} async speakPrompt(text){spoken.push(text)}}',
    './live/companionBridge': 'export const startCompanionBridge=()=>({stop(){}})',
    './store/crystalStore': 'export const useCrystal={getState:()=>({setSettings(){}})}',
    './styles.css': '',
    './refinement.css': '',
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
  const effects: (() => (() => void))[] = []
  const spoken: string[] = []
  const handlers = new Map<string, (payload: any) => void>()
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, effects, spoken,
    document: { getElementById: () => ({}) },
    window: {
      addEventListener() {}, removeEventListener() {},
      jarvis: {
        invoke: async (channel: string) => channel === 'settings:get'
          ? { companion: { port: 1 } } : { paused: false },
        onPushToTalk: () => () => {},
        on: (channel: string, handler: (payload: any) => void) => {
          handlers.set(channel, handler)
          return () => handlers.delete(channel)
        }
      }
    }
  })
  const cleanup = effects[0]()
  for (let i = 0; i < 12; i++) await Promise.resolve()
  assert.ok(handlers.has('reminder:due'))
  const text = 'Termin "Training" um 18 Uhr'
  handlers.get('reminder:due')!({ text })
  assert.equal(spoken.length, 1)
  assert.ok(spoken[0].includes(JSON.stringify(text)))
  assert.match(spoken[0], /keine Aufträge oder Werkzeuge/)
  cleanup()
  assert.equal(handlers.size, 0)
})
