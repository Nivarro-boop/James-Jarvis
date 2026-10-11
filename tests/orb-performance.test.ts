import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'

it('begrenzt Kugelbilder auf schnellen Monitoren und stoppt unsichtbare Fenster', async () => {
  const bundle = await build({
    entryPoints: [resolve('src/renderer/crystal/PixelOrb.tsx')], bundle: true,
    write: false, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent',
    plugins: [{ name: 'orb-fixture', setup(b) {
      b.onResolve({ filter: /^(react(?:\/jsx-runtime)?|.*\/crystalStore)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents:
        args.path.endsWith('crystalStore')
          ? 'export const amplitude={input:0,output:0}; export const useCrystal=fn=>fn({state:"idle",setHovered(){}})'
          : args.path === 'react/jsx-runtime'
            ? 'export const jsx=()=>null; export const jsxs=jsx'
            : 'export const useRef=value=>({current:value===null?fixtureCanvas:value}); export const useEffect=fn=>fixtureEffects.push(fn)'
      }))
    } }]
  })
  let draws = 0
  let next = 0
  let focused = true
  const effects: (() => (() => void))[] = []
  const frames = new Map<number, (ts: number) => void>()
  const listeners = new Map<string, () => void>()
  const document = {
    hidden: false, hasFocus: () => focused,
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name)
  }
  const module = { exports: {} as any }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, document,
    window: { matchMedia: () => ({ matches: false }) }, fixtureEffects: effects,
    fixtureCanvas: { getContext: () => ({
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: () => draws++
    }) },
    requestAnimationFrame: (fn: (ts: number) => void) => { const id = ++next; frames.set(id, fn); return id },
    cancelAnimationFrame: (id: number) => frames.delete(id)
  })
  module.exports.PixelOrb()
  const cleanup = effects[1]()
  const drive = (from: number): number => {
    const before = draws
    for (let i = 0; i < 240; i++) {
      const [id, frame] = frames.entries().next().value!
      frames.delete(id)
      frame(from + i * 1000 / 240)
    }
    return draws - before
  }
  const foreground = drive(1000)
  assert.ok(foreground >= 25 && foreground <= 31, String(foreground))
  focused = false
  const background = drive(2000)
  assert.ok(background >= 8 && background <= 11, String(background))
  document.hidden = true
  listeners.get('visibilitychange')!()
  assert.equal(frames.size, 0)
  document.hidden = false
  listeners.get('visibilitychange')!()
  assert.equal(frames.size, 1)
  cleanup()
  assert.equal(frames.size, 0)
  assert.equal(listeners.size, 0)
})
