import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'

type Node = { type: string; props: Record<string, any> }
const text = (n: any): string => n == null || typeof n === 'boolean' ? '' : typeof n === 'string' || typeof n === 'number' ? String(n) : Array.isArray(n) ? n.map(text).join('') : text(n.props?.children)
function all(tree: any, test: (node: Node) => boolean): Node[] { const out: Node[] = []; const visit = (n: any): void => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(visit); if (typeof n.type === 'string' && test(n)) out.push(n); visit(n.props?.children) }; visit(tree); return out }
const status = (configured = true) => ({ telephony: { running: false, publicUrl: null, source: null }, phoneConfigured: configured, conversationEnabled: true, incomingEnabled: false, computer: { name: 'Mein PC' } })

async function setup(reply: any = status()) {
  const built = await build({ entryPoints: [resolve('src/renderer/home/ControlCenter.tsx')], bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent', plugins: [{ name: 'fixtures', setup(b) {
    b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'fixture' })); b.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'jsx-runtime', namespace: 'fixture' })); b.onResolve({ filter: /\.css$/ }, () => ({ path: 'css', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: args.path === 'react' ? 'export const useState=(v)=>harness.useState(v);export const useRef=(v)=>harness.useRef(v);export const useEffect=(f,d)=>harness.useEffect(f,d);export const useCallback=(f,d)=>harness.useCallback(f,d);' : args.path === 'jsx-runtime' ? 'export const jsx=(type,props)=>({type,props});export const jsxs=jsx;export const Fragment=0;' : '' }))
  } }] })
  const states: any[] = [], refs: any[] = [], effects: any[] = [], callbacks: any[] = []; let cursor = 0, effectCursor = 0, tree: any; let pending: (() => void)[] = []
  const invocations: string[] = [], sent: any[] = [], listeners = new Map<string, Function>(), closes: number[] = []
  const document: any = { activeElement: null, addEventListener: (k: string, fn: Function) => listeners.set(k, fn), removeEventListener: (k: string) => listeners.delete(k), querySelectorAll: () => [] }
  const win: any = { jarvis: { invoke: (channel: string) => { invocations.push(channel); if (channel !== 'control:status') throw Error(`unexpected IPC ${channel}`); return typeof reply === 'function' ? reply() : reply } }, dispatchEvent: (event: any) => { sent.push(event); return true }, setTimeout: () => 1, clearTimeout() {} }
  const harness = {
    useState(initial: any) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], (v: any) => { states[i] = typeof v === 'function' ? v(states[i]) : v; render(); flush() }] },
    useRef(initial: any) { const i = cursor++; return refs[i] ?? (refs[i] = { current: initial }) },
    useCallback(fn: Function, deps: any[]) { const i = cursor++, old = callbacks[i]; if (!old || deps.some((v, j) => !Object.is(v, old.deps[j]))) callbacks[i] = { fn, deps }; return callbacks[i].fn },
    useEffect(fn: Function, deps: any[]) { const i = effectCursor++, old = effects[i]; if (!old || deps.some((v, j) => !Object.is(v, old.deps[j]))) { effects[i] = { deps }; pending.push(fn as () => void) } }
  }
  const mod: any = { exports: {} }
  runInNewContext(built.outputFiles[0].text, { module: mod, exports: mod.exports, harness, window: win, document, HTMLElement: class HTMLElement {}, CustomEvent: class CustomEvent { type: string; detail: any; constructor(type: string, init: any) { this.type = type; this.detail = init.detail } } })
  function render() { cursor = 0; effectCursor = 0; tree = mod.exports.ControlCenter({ onClose: () => closes.push(1) }) }
  function flush() { while (pending.length) pending.shift()!() }
  render(); flush()
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); await new Promise<void>(r => setImmediate(r)) }
  const find = (pred: (n: Node) => boolean) => all(tree, pred)
  const button = (label: string) => { const b = find(n => n.type === 'button' && (text(n).trim() === label || n.props['aria-label'] === label))[0]; assert.ok(b, `missing button ${label}: ${find(n => n.type === 'button').map(text)}`); return b }
  const input = (id: string) => { const n = find(x => (x.type === 'input' || x.type === 'textarea') && x.props.id === id)[0]; assert.ok(n); return n }
  return { settle, find, button, input, get tree() { return tree }, sent, invocations, closes, listeners }
}

it('fragt den passiven Status nur einmal ab, behandelt Fehler und Retry ohne Dienste zu starten', async () => {
  const ui = await setup(() => Promise.reject(new Error('offline'))); await ui.settle()
  assert.deepEqual(ui.invocations, ['control:status']); assert.match(text(ui.tree), /Status konnte nicht geladen werden/)
  ui.button('Erneut versuchen').props.onClick(); assert.deepEqual(ui.invocations, ['control:status', 'control:status'])
})
it('sperrt Telefon ohne Zugang und zeigt den Verbindungsweg', async () => {
  const ui = await setup(status(false)); await ui.settle()
  assert.match(text(ui.tree), /Telefonzugänge fehlen/)
  const form = ui.find(n => n.type === 'form')[0]; let prevented = false; form.props.onSubmit({ preventDefault() { prevented = true } })
  assert.equal(prevented, true); assert.equal(ui.sent.length, 0)
})
it('übergibt Telefonauftrag exakt erst nach Prüfung und verhindert Doppelauftrag während busy', async () => {
  const ui = await setup(); await ui.settle()
  ui.input('cc-target').props.onChange({ target: { value: '  Alex  ' } }); ui.input('cc-brief').props.onChange({ target: { value: '  nach dem Termin fragen  ' } })
  const submit = () => ui.find(n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} })
  submit(); assert.equal(ui.sent.length, 0); assert.match(text(ui.tree), /Bitte genau prüfen/)
  submit(); submit(); assert.equal(ui.sent.length, 1); assert.equal(ui.sent[0].detail.text, 'Rufe Alex an und nach dem Termin fragen')
  ui.sent[0].detail.onResult(true); assert.match(text(ui.tree), /Auftrag an James übergeben/)
  submit(); assert.equal(ui.sent.length, 1)
})
it('übergibt Computerauftrag über das normale jarvis:text Ereignis und schließt per Escape', async () => {
  const ui = await setup(); await ui.settle(); ui.button('Computer').props.onClick()
  ui.input('cc-computer-task').props.onChange({ target: { value: 'Bitte Systemstatus prüfen' } }); ui.button('Auftrag übergeben').props.onClick()
  assert.equal(ui.sent[0].detail.text, 'Bitte Systemstatus prüfen'); assert.equal(ui.sent[0].type, 'jarvis:text')
  ui.listeners.get('keydown')!({ key: 'Escape', preventDefault() {} }); assert.equal(ui.closes.length, 1)
})

it('übergibt ohne eingeschaltete Gespräche auch mit vorhandenen Telefonzugängen keinen Anruf', async () => {
  const ui = await setup({ ...status(), conversationEnabled: false }); await ui.settle()
  ui.input('cc-target').props.onChange({ target: { value: 'Testkontakt' } })
  ui.input('cc-brief').props.onChange({ target: { value: 'Frage nach dem Termin' } })
  assert.match(text(ui.tree), /Zweiweg-Gespräche sind ausgeschaltet/)
  assert.equal(ui.button('Auftrag prüfen').props.disabled, true)
  ui.find(n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} })
  assert.equal(ui.sent.length, 0)
})

it('zeigt ein nicht verfügbares Computerbackend nicht als grün an', async () => {
  const ui = await setup({ ...status(), computer: { name: 'nicht verfügbar', grund: 'Kein Eingabe-Backend' } }); await ui.settle()
  ui.button('Computer').props.onClick()
  const card = ui.find(n => n.props.className === 'cc-computer')[0]
  assert.match(text(card), /Kein Eingabe-Backend/)
  assert.equal(all(card, n => n.type === 'span' && /is-on/.test(n.props.className || '')).length, 0)
})
