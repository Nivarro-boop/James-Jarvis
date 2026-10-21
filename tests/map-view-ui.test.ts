import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'

const tileBytes = [26, 11, 10, 5, 119, 97, 116, 101, 114, 18, 2, 24, 3]
const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

it('MapView UI controls, no-tabstop mode, load/retry lifecycle and stale responses use live component handlers', async () => {
  const bundle = await build({
    entryPoints: [resolve('src/renderer/map/MapView.tsx')], bundle: true, write: false,
    platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent', alias: { '@shared': resolve('src/shared') },
    plugins: [{ name: 'react-fixture', setup(b) {
      b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'fixture' }))
      b.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'jsx-runtime', namespace: 'fixture' }))
      b.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, namespace: 'fixture' }))
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: args.path.endsWith('.css') ? '' : args.path === 'react'
        ? 'export const useState=(initial)=>harness.useState(initial); export const useRef=(initial)=>harness.useRef(initial); export const useEffect=(fn,deps)=>harness.useEffect(fn,deps); export const useId=()=>"test-map-help";'
        : 'const make=(type,props,key)=>({type,props:{...(props||{}),key}}); export const Fragment="fragment"; export const jsx=make; export const jsxs=make;' }))
    } }]
  })
  const harness: any = {
    hooks: [], hookIndex: 0, effects: [], dirty: false, tree: null, props: {}, requests: [], drawArcs: [],
    useState(initial: any) {
      const index = this.hookIndex++
      if (!(index in this.hooks)) this.hooks[index] = typeof initial === 'function' ? initial() : initial
      const set = (value: any) => { const next = typeof value === 'function' ? value(this.hooks[index]) : value; if (!Object.is(next, this.hooks[index])) { this.hooks[index] = next; this.dirty = true } }
      return [this.hooks[index], set]
    },
    useRef(initial: any) { const index = this.hookIndex++; if (!(index in this.hooks)) this.hooks[index] = { current: initial }; return this.hooks[index] },
    useEffect(fn: () => any, deps?: any[]) { const index = this.hookIndex++; this.effects.push({ index, fn, deps }) },
    render(props?: any) {
      if (props) this.props = props
      let spins = 0
      do {
        this.dirty = false; this.effects = []; this.hookIndex = 0
        this.tree = module.exports.MapView(this.props)
        const visit = (node: any) => {
          if (!node || typeof node !== 'object') return
          if (node.props?.ref) node.props.ref.current = node.type === 'canvas' ? canvas : holder
          const children = node.props?.children
          if (Array.isArray(children)) children.forEach(visit); else visit(children)
        }
        visit(this.tree)
        for (const effect of this.effects) {
          const previous = this.hooks[effect.index]
          const changed = !previous || !effect.deps || !previous.deps || effect.deps.length !== previous.deps.length || effect.deps.some((v: any, i: number) => !Object.is(v, previous.deps[i]))
          if (changed) {
            previous?.cleanup?.()
            const cleanup = effect.fn()
            this.hooks[effect.index] = { deps: effect.deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
          }
        }
        assert.ok(++spins < 30, 'component should settle without a render loop')
      } while (this.dirty)
      return this.tree
    }
  }
  const ctx: any = {
    scale() {}, fillRect() {}, beginPath() {}, arc(...args: any[]) { harness.drawArcs.push(args) }, fill() {}, stroke() {}, moveTo() {}, lineTo() {},
    save() {}, restore() {}, rect() {}, clip() {}, fillText() {}, strokeText() {}, measureText(text: string) { return { width: text.length * 5 } },
  }
  const canvas: any = { getContext: () => ctx, setPointerCapture() { this.captured = true }, hasPointerCapture() { return !!this.captured }, releasePointerCapture() { this.captured = false } }
  const holder: any = {}
  class Observer { observe() {} disconnect() {} }
  const module = { exports: {} as any }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, harness, ResizeObserver: Observer, Uint8Array, TextDecoder,
    window: { devicePixelRatio: 1, jarvis: { invoke: (_channel: string, payload: any) => { const request = deferred<number[] | null>(); (request as any).payload = payload; harness.requests.push(request); return request.promise } } }
  })
  const children = (node: any): any[] => !node || typeof node !== 'object' ? [] : [node, ...(Array.isArray(node.props?.children) ? node.props.children.flatMap(children) : children(node.props?.children))]
  const find = (className: string) => children(harness.tree).find(node => node.props?.className === className)
  const canvasNode = () => children(harness.tree).find(node => node.type === 'canvas')
  const buttons = () => children(harness.tree).filter(node => node.type === 'button')
  const settlePromises = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); harness.render() }
  const resolveRequests = (requests: any[], value: number[] | null) => requests.forEach(request => request.resolve(value))
  const rejectRequests = (requests: any[]) => requests.forEach(request => request.reject(new Error('offline')))

  // Noninteractive maps preserve the static/non-focusable mode and ignore keyboard input.
  harness.render({ interactive: false, zoom: 13, markers: [{ lat: 48, lon: 16, index: 1, label: 'Startpunkt' }] })
  assert.equal(canvasNode().props.tabIndex, -1)
  assert.equal(buttons().length, 0)
  assert.equal(find('map-keyboard-help'), undefined)
  const described = children(harness.tree).find(node => node.type === 'ul')
  assert.ok(described)
  assert.match(JSON.stringify(described), /Startpunkt/)
  const beforeStatic = harness.requests.length
  let prevented = false
  canvasNode().props.onKeyDown({ key: 'ArrowRight', preventDefault() { prevented = true } })
  assert.equal(prevented, false)
  assert.equal(harness.requests.length, beforeStatic)
  resolveRequests(harness.requests.splice(0), tileBytes)
  await settlePromises()

  // Interactive mode exposes named controls; real key/button handlers update and reset view state.
  const stale = harness.requests.splice(0)
  harness.render({ interactive: true, zoom: 13, center: { lat: 48, lon: 16 }, markers: [{ lat: 48, lon: 16, index: 1, label: 'Startpunkt' }] })
  assert.equal(canvasNode().props.tabIndex, 0)
  assert.match(canvasNode().props['aria-describedby'], /test-map-help/)
  assert.ok(find('map-keyboard-help'))
  assert.deepEqual(buttons().map(button => button.props['aria-label']), ['Vergrößern', 'Verkleinern', 'Ansicht zurücksetzen'])
  let moved = false
  canvasNode().props.onKeyDown({ key: 'ArrowRight', preventDefault() { moved = true } })
  assert.equal(moved, true)
  assert.equal(harness.hooks[3].x, -32, 'arrow keys update the live pan state')
  harness.render()
  const afterPan = harness.drawArcs.at(-1)[0]
  const plus = buttons().find(button => button.props['aria-label'] === 'Vergrößern')
  for (let i = 0; i < 20; i++) plus.props.onClick()
  assert.equal(harness.hooks[3].zoom, 5, 'button zoom reaches but does not exceed the absolute maximum')
  harness.render()
  resolveRequests(harness.requests.splice(0), tileBytes)
  await settlePromises()
  const reset = buttons().find(button => button.props['aria-label'] === 'Ansicht zurücksetzen')
  reset.props.onClick()
  assert.deepEqual({ ...harness.hooks[3] }, { x: 0, y: 0, zoom: 0 })
  harness.render()
  const resetArc = harness.drawArcs.at(-1)[0]
  assert.notEqual(afterPan, resetArc, 'Home/reset and panning use different canvas offsets')
  canvasNode().props.onKeyDown({ key: 'Home', preventDefault() {} })
  assert.deepEqual({ ...harness.hooks[3] }, { x: 0, y: 0, zoom: 0 })
  for (let i = 0; i < 30; i++) canvasNode().props.onKeyDown({ key: '-', preventDefault() {} })
  assert.equal(harness.hooks[3].zoom, -13, 'keyboard zoom is clamped at the absolute minimum')
  harness.render()
  resolveRequests(harness.requests.splice(0), tileBytes)
  await settlePromises()
  buttons().find(button => button.props['aria-label'] === 'Verkleinern').props.onClick()
  harness.render()
  assert.equal(harness.hooks[3].zoom, -13, 'zoom-out button also respects the lower bound')
  resolveRequests(harness.requests.splice(0), tileBytes)
  await settlePromises()

  // A changed content cycle stays loading when the disposed cycle resolves late.
  harness.render({ interactive: true, zoom: 13, center: { lat: 40, lon: 40 }, markers: [] })
  const oldBatch = harness.requests.splice(0)
  harness.render({ interactive: true, zoom: 13, center: { lat: -40, lon: -100 }, markers: [] })
  const freshBatch = harness.requests.splice(0)
  assert.ok(oldBatch.length > 0 && freshBatch.length > 0)
  resolveRequests(oldBatch, tileBytes)
  await settlePromises()
  assert.equal(find('map-status')?.props.children, 'Karte lädt …')
  rejectRequests(freshBatch)
  await settlePromises()
  assert.equal(find('map-status')?.props.children, 'Kartengrundlage nicht verfügbar')
  assert.ok(buttons().some(button => button.props['aria-label'] === 'Karte erneut laden'))
  const failedCount = harness.requests.length
  buttons().find(button => button.props['aria-label'] === 'Karte erneut laden').props.onClick()
  harness.render()
  const retryBatch = harness.requests.slice(failedCount)
  assert.ok(retryBatch.length > 0, 'failed cache entries were evicted and retry requested tiles again')
  assert.equal(find('map-status')?.props.children, 'Karte lädt …')
  resolveRequests(retryBatch, tileBytes)
  await settlePromises()
  assert.equal(find('map-status'), undefined)
  assert.equal(buttons().some(button => button.props['aria-label'] === 'Karte erneut laden'), false)

  // Zoom prop changes are a new view cycle; a pointer cancellation ends capture safely.
  canvasNode().props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} })
  assert.notEqual(harness.hooks[3].x, 0)
  harness.render({ interactive: true, zoom: 8, center: { lat: 0, lon: 0 }, markers: [] })
  assert.deepEqual({ ...harness.hooks[3] }, { x: 0, y: 0, zoom: 0 }, 'changing the zoom prop resets the current pan and zoom offsets')
  const pointerCanvas = canvasNode()
  pointerCanvas.props.onPointerDown({ pointerId: 42, clientX: 10, clientY: 20, currentTarget: canvas })
  assert.equal(canvas.captured, true)
  pointerCanvas.props.onPointerCancel({ pointerId: 42 })
  assert.equal(harness.hooks[6].current, null, 'pointercancel clears the active drag')
  canvas.captured = false // Pointer Events releases capture as part of browser pointercancel handling.
  pointerCanvas.props.onLostPointerCapture({ pointerId: 42 })
  const cancelledOffset = { ...harness.hooks[3] }
  pointerCanvas.props.onPointerMove({ pointerId: 42, clientX: 100, clientY: 100 })
  harness.render()
  assert.deepEqual({ ...harness.hooks[3] }, cancelledOffset, 'pointercancel clears drag state')
  pointerCanvas.props.onLostPointerCapture({ pointerId: 42 })
  canvas.captured = false
  assert.equal(harness.requests.length > 0, true)
  // Complete any final requests so this mounted harness has no unfinished work.
  resolveRequests(harness.requests.splice(0), tileBytes)
  await settlePromises()
  for (const cleanup of harness.hooks) cleanup?.cleanup?.()
})
