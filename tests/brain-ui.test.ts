import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

type ElementNode = { type: string; props: Record<string, any> }
function elementText(node: any): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(elementText).join('')
  return elementText(node.props?.children)
}
function findAll(tree: any, predicate: (node: ElementNode) => boolean): ElementNode[] {
  const found: ElementNode[] = []
  const visit = (node: any): void => {
    if (node == null || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (typeof node.type === 'string' && predicate(node)) found.push(node)
    visit(node.props?.children)
  }
  visit(tree)
  return found
}

async function setup() {
  const bundle = await build({
    entryPoints: [resolve('src/renderer/home/BrainMap.tsx')], bundle: true, write: false,
    platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent', alias: { '@shared': resolve('src/shared') },
    plugins: [{ name: 'brain-ui-fixtures', setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'brain-fixture' }))
      build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'jsx-runtime', namespace: 'brain-fixture' }))
      build.onResolve({ filter: /\.css$/ }, () => ({ path: 'css', namespace: 'brain-fixture' }))
      build.onLoad({ filter: /.*/, namespace: 'brain-fixture' }, (args) => ({
        loader: 'js', contents: args.path === 'react'
          ? 'export const useState=(v)=>harness.useState(v); export const useRef=(v)=>harness.useRef(v); export const useEffect=(f,d)=>harness.useEffect(f,d);'
          : args.path === 'jsx-runtime'
            ? 'export const jsx=(type,props)=>({type,props}); export const jsxs=jsx;'
            : ''
      }))
    } }]
  })

  const state: any[] = []
  const refs: any[] = []
  const effectSlots: { deps?: unknown[]; cleanup?: () => void }[] = []
  let cursor = 0
  let effectCursor = 0
  let currentTree: any
  let renderingEffects = false
  let pendingEffects: (() => void)[] = []
  const canvasListeners = new Map<string, (event: any) => void>()
  const windowListeners = new Map<string, (event: any) => void>()
  const canvas: any = {
    width: 600, height: 400,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 400 }),
    addEventListener: (name: string, handler: (event: any) => void) => canvasListeners.set(name, handler),
    removeEventListener: (name: string) => canvasListeners.delete(name),
    getContext: () => ({
      setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {}, fillText() {},
      set strokeStyle(_value: string) {}, set lineWidth(_value: number) {}, set globalAlpha(_value: number) {},
      set fillStyle(_value: string) {}, set font(_value: string) {}
    })
  }
  const raf = new Map<number, FrameRequestCallback>()
  let rafId = 0
  const graphRequests: Deferred<any>[] = []
  const noteRequests: { file: string; result: Deferred<any> }[] = []
  const closeCalls: number[] = []
  const windowObject: any = {
    devicePixelRatio: 1,
    addEventListener: (name: string, handler: (event: any) => void) => windowListeners.set(name, handler),
    removeEventListener: (name: string) => windowListeners.delete(name),
    setInterval: () => 1, clearInterval() {},
    jarvis: { invoke: (channel: string, payload?: any) => {
      if (channel === 'brain:graph') { const request = deferred<any>(); graphRequests.push(request); return request.promise }
      if (channel === 'brain:note') { const result = deferred<any>(); noteRequests.push({ file: payload.file, result }); return result.promise }
      throw new Error(`Unexpected invoke: ${channel}`)
    } }
  }
  const harness: any = {
    useState(initial: any) {
      const i = cursor++
      if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial
      return [state[i], (value: any) => {
        const next = typeof value === 'function' ? value(state[i]) : value
        if (Object.is(next, state[i])) return
        state[i] = next
        render()
        if (!renderingEffects) flushEffects()
      }]
    },
    useRef(initial: any) {
      const i = cursor++
      if (!(i in refs)) refs[i] = { current: initial }
      return refs[i]
    },
    useEffect(effect: () => void | (() => void), deps?: unknown[]) {
      const i = effectCursor++
      const previous = effectSlots[i]
      const changed = !previous || !deps || !previous.deps || deps.length !== previous.deps.length || deps.some((dep, n) => !Object.is(dep, previous.deps![n]))
      if (!changed) return
      effectSlots[i] = { deps }
      pendingEffects.push(() => {
        previous?.cleanup?.()
        const cleanup = effect()
        effectSlots[i].cleanup = typeof cleanup === 'function' ? cleanup : undefined
      })
    }
  }
  function render(): void {
    cursor = 0; effectCursor = 0
    currentTree = module.exports.BrainMap({ onClose: () => closeCalls.push(1) })
  }
  function flushEffects(): void {
    if (renderingEffects) return
    renderingEffects = true
    try {
      while (pendingEffects.length) pendingEffects.shift()!()
    } finally { renderingEffects = false }
  }
  const module = { exports: {} as any }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, harness,
    window: windowObject,
    document: { createElement: (tag: string) => tag === 'canvas' ? { width: 0, height: 0, getContext: () => null } : { play: async () => {}, readyState: 0 } },
    navigator: { mediaDevices: { getUserMedia: async () => { throw new Error('unused') } } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: (callback: FrameRequestCallback) => { const id = ++rafId; raf.set(id, callback); return id },
    cancelAnimationFrame: (id: number) => raf.delete(id)
  })
  refs[0] = { current: canvas }
  render(); flushEffects()
  const settle = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); await new Promise<void>((done) => setImmediate(done)) }
  const buttons = (): ElementNode[] => findAll(currentTree, (node) => node.type === 'button')
  const button = (label: string): ElementNode => {
    const found = buttons().find((node) => node.props['aria-label'] === label || elementText(node).trim() === label)
    assert.ok(found, `button not found: ${label}; available: ${buttons().map(elementText).join(', ')}`)
    return found!
  }
  const changeSearch = (value: string): void => {
    const input = findAll(currentTree, (node) => node.type === 'input' && node.props.id === 'brain-search')[0]
    assert.ok(input)
    input.props.onChange({ target: { value } })
  }
  return { graphRequests, noteRequests, closeCalls, windowListeners, canvasListeners, canvas, raf, settle, buttons, button, changeSearch, tree: () => currentTree }
}

it('filtert Suchtreffer, öffnet Einträge, retryt Ladefehler und ignoriert veraltete Notizantworten', async () => {
  const ui = await setup()
  assert.match(elementText(ui.tree()), /Einträge werden geladen/)
  ui.graphRequests[0].reject(new Error('offline'))
  await ui.settle()
  assert.match(elementText(ui.tree()), /offline/)
  ui.button('Erneut versuchen').props.onClick()
  assert.equal(ui.graphRequests.length, 2)
  ui.graphRequests[1].resolve({ nodes: [
    { id: 'projekte/Garten.md', label: 'Gartenplanung', kind: 'projekt' },
    { id: 'notizen/Rezept.md', label: 'Brotrezept', kind: 'notiz' },
    { id: 'notizen/Reise.md', label: 'Reiseideen', kind: 'notiz' }
  ], links: [] })
  await ui.settle()
  assert.match(elementText(ui.tree()), /3 Treffer/)
  ui.changeSearch('REZEPT')
  assert.match(elementText(ui.tree()), /1 Treffer/)
  assert.equal(ui.buttons().filter((b) => b.props['aria-label']?.includes('öffnen')).length, 1)
  ui.changeSearch('notizen/Reise')
  assert.match(elementText(ui.tree()), /Reiseideen/)
  ui.button('Projekte').props.onClick()
  assert.match(elementText(ui.tree()), /0 Treffer/)
  const projectFilter = findAll(ui.tree(), (node) => node.type === 'button' && elementText(node).trim() === 'Projekte')[0]
  assert.equal(projectFilter.props['aria-pressed'], true)
  ui.button('Alle').props.onClick()
  ui.changeSearch('')

  ui.button('Gartenplanung öffnen (Projekt)').props.onClick()
  ui.button('Brotrezept öffnen (Notiz)').props.onClick()
  assert.deepEqual(ui.noteRequests.map((request) => request.file), ['projekte/Garten.md', 'notizen/Rezept.md'])
  ui.noteRequests[1].result.resolve('aktueller Inhalt')
  await ui.settle()
  ui.noteRequests[0].result.resolve('veralteter Inhalt')
  await ui.settle()
  assert.match(elementText(ui.tree()), /aktueller Inhalt/)
  assert.doesNotMatch(elementText(ui.tree()), /veralteter Inhalt/)

  ui.windowListeners.get('keydown')!({ key: 'Escape' })
  assert.doesNotMatch(elementText(ui.tree()), /aktueller Inhalt/)
  ui.windowListeners.get('keydown')!({ key: 'Escape' })
  assert.equal(ui.closeCalls.length, 1)
})

it('zeigt Notiz-Ladefehler und öffnet keinen Treffer nach einem Ziehen mit kleinem pointerup-Restweg', async () => {
  const ui = await setup()
  ui.graphRequests[0].resolve({ nodes: [{ id: 'notizen/Test.md', label: 'Testnotiz', kind: 'notiz' }], links: [] })
  await ui.settle()
  const canvasDraw = [...ui.raf.values()][0]
  assert.ok(canvasDraw)
  canvasDraw(0)
  const start = { clientX: 422, clientY: 200 }
  ui.canvasListeners.get('pointerdown')!(start)
  ui.windowListeners.get('pointermove')!({ clientX: 310, clientY: 72 })
  ui.windowListeners.get('pointerup')!({ clientX: 310.5, clientY: 72 })
  assert.equal(ui.noteRequests.length, 0)

  // An ordinary click still opens the sphere node; a rejected read is rendered accessibly.
  ui.canvasListeners.get('pointerdown')!(start)
  ui.windowListeners.get('pointerup')!(start)
  assert.equal(ui.noteRequests.length, 1)
  ui.noteRequests[0].result.reject(new Error('Datei gesperrt'))
  await ui.settle()
  assert.match(elementText(ui.tree()), /Datei gesperrt/)
})
