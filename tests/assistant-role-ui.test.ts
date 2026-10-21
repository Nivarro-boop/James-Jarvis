import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'
import { DEFAULT_SETTINGS } from '../src/shared/config/defaults'
import type { Settings } from '../src/shared/types'

type ElementNode = { type: any; props: Record<string, any> }
const settings = (assistantRole: Settings['assistantRole'] = 'personal'): Settings => ({ ...DEFAULT_SETTINGS, assistantRole })

function renderChildren(node: any, visit: (node: ElementNode) => void): void {
  if (node == null || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return
  if (Array.isArray(node)) { node.forEach(child => renderChildren(child, visit)); return }
  if (typeof node !== 'object') return
  if (typeof node.type === 'function') {
    renderChildren(node.type(node.props), visit)
    return
  }
  if (typeof node.type === 'string') visit(node)
  renderChildren(node.props?.children, visit)
}
const allText = (node: any): string => {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(allText).join('')
  if (node && typeof node.type === 'function') return allText(node.type(node.props))
  return allText(node?.props?.children)
}

async function setup(view: 'step' | 'settings', initialRole: Settings['assistantRole'] = 'personal', patchImpl?: (value: Partial<Settings>) => Promise<Settings>) {
  const entry = resolve('src/renderer/settings/AssistantRoleChoice.tsx')
  const built = await build({
    entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent',
    alias: { '@shared': resolve('src/shared') },
    plugins: [{ name: 'react-hook-harness', setup(buildApi) {
      buildApi.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'role-test' }))
      buildApi.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'jsx-runtime', namespace: 'role-test' }))
      buildApi.onResolve({ filter: /\.css$/ }, () => ({ path: 'css', namespace: 'role-test' }))
      buildApi.onLoad({ filter: /.*/, namespace: 'role-test' }, args => ({
        loader: 'js',
        contents: args.path === 'react'
          ? 'export const useState=(v)=>harness.useState(v);export const useRef=(v)=>harness.useRef(v);export const useEffect=(f,d)=>harness.useEffect(f,d);'
          : args.path === 'jsx-runtime'
            ? 'export const jsx=(type,props)=>({type,props});export const jsxs=jsx;export const Fragment=Symbol.for("react.fragment");'
            : ''
      }))
    } }]
  })

  const states: any[] = [], refs: any[] = [], effects: any[] = [], pendingEffects: Array<() => void> = []
  let stateCursor = 0, effectCursor = 0, tree: any, currentSettings = settings(initialRole), mounted = true
  const patchCalls: Array<Partial<Settings>> = []
  const patch = patchImpl ?? (async (value: Partial<Settings>) => { patchCalls.push(value); return { ...currentSettings, ...value } })
  const harness = {
    useState(initial: any) {
      const index = stateCursor++
      if (!(index in states)) states[index] = initial
      return [states[index], (value: any) => {
        const next = typeof value === 'function' ? value(states[index]) : value
        if (Object.is(states[index], next)) return
        states[index] = next
        render()
        flushEffects()
      }]
    },
    useRef(initial: any) {
      const index = stateCursor++
      return refs[index] ?? (refs[index] = { current: initial })
    },
    useEffect(effect: () => void | (() => void), deps?: any[]) {
      const index = effectCursor++, old = effects[index]
      if (!old || !deps || deps.some((value, i) => !Object.is(value, old.deps?.[i]))) {
        pendingEffects.push(() => {
          old?.cleanup?.()
          const cleanup = effect()
          effects[index] = { deps: deps ? [...deps] : undefined, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
        })
      }
    }
  }
  const moduleObject: any = { exports: {} }
  runInNewContext(built.outputFiles[0].text, { module: moduleObject, exports: moduleObject.exports, harness, Error })
  const component = view === 'step' ? moduleObject.exports.AssistantRoleStep : moduleObject.exports.AssistantRoleSettings
  const calls: { next: number; back: number } = { next: 0, back: 0 }
  function render() {
    if (!mounted) return
    stateCursor = 0; effectCursor = 0
    tree = component({ settings: currentSettings, patch, onNext: () => { calls.next++ }, onBack: () => { calls.back++ } })
  }
  function flushEffects() {
    while (pendingEffects.length) pendingEffects.shift()!()
  }
  render(); flushEffects()
  const find = (predicate: (node: ElementNode) => boolean): ElementNode[] => {
    const found: ElementNode[] = []
    renderChildren(tree, node => { if (predicate(node)) found.push(node) })
    return found
  }
  const button = (label: string): ElementNode => {
    const found = find(node => node.type === 'button' && allText(node).trim() === label)[0]
    assert.ok(found, `Schaltfläche fehlt: ${label}; vorhanden: ${find(node => node.type === 'button').map(allText).join(' | ')}`)
    return found
  }
  const radios = () => find(node => node.type === 'input' && node.props.type === 'radio')
  const choose = (role: Settings['assistantRole']) => {
    const radio = radios().find(node => node.props.value === role)
    assert.ok(radio, `Radio fehlt: ${role}`)
    radio.props.onChange()
  }
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); await new Promise<void>(resolveNow => setImmediate(resolveNow)) }
  return {
    find, button, radios, choose, settle, patchCalls, calls,
    get tree() { return tree },
    updateSettings(role: Settings['assistantRole']) { currentSettings = settings(role); render(); flushEffects() },
    unmount() { mounted = false; for (const effect of effects) effect?.cleanup?.(); effects.length = 0 }
  }
}

it('zeigt im Setup drei native Radios mit Personal als Voreinstellung; Auswahl allein speichert nichts', async () => {
  const ui = await setup('step')
  const radios = ui.radios()
  assert.equal(radios.length, 3)
  assert.deepEqual(radios.map(radio => radio.props.value), ['personal', 'calendar', 'focus'])
  assert.equal(radios.filter(radio => radio.props.checked).length, 1)
  assert.equal(radios.find(radio => radio.props.checked)?.props.value, 'personal')
  ui.choose('calendar')
  assert.equal(ui.radios().find(radio => radio.props.value === 'calendar')?.props.checked, true)
  assert.deepEqual(ui.patchCalls, [])
  assert.equal(ui.calls.next, 0)
  assert.equal(ui.calls.back, 0)
})

it('speichert im Setup erst per Klick exakt die Rolle und navigiert erst nach erfolgreichem Promise', async () => {
  let resolvePatch!: (value: Settings) => void
  const ui = await setup('step', 'personal', async value => {
    ui.patchCalls.push(value)
    return await new Promise<Settings>(resolveNow => { resolvePatch = resolveNow })
  })
  ui.choose('calendar')
  assert.equal(ui.patchCalls.length, 0)
  ui.button('Speichern und weiter').props.onClick()
  assert.deepEqual(ui.patchCalls.map(value => ({ ...value })), [{ assistantRole: 'calendar' }])
  assert.equal(ui.calls.next, 0)
  resolvePatch(settings('calendar'))
  await ui.settle()
  assert.equal(ui.calls.next, 1)
})

it('verhindert doppeltes Speichern während des laufenden Setup-Patches', async () => {
  let resolvePatch!: (value: Settings) => void
  const ui = await setup('step', 'personal', async value => {
    ui.patchCalls.push(value)
    return await new Promise<Settings>(resolveNow => { resolvePatch = resolveNow })
  })
  ui.choose('focus')
  const save = ui.button('Speichern und weiter').props.onClick
  save(); save()
  assert.equal(ui.patchCalls.length, 1)
  assert.equal(ui.button('Wird gespeichert …').props.disabled, true)
  resolvePatch(settings('focus'))
  await ui.settle()
  assert.equal(ui.calls.next, 1)
})

it('zeigt Setup-Patchfehler als Alert, behält Auswahl und erlaubt Retry', async () => {
  let attempts = 0
  const ui = await setup('step', 'personal', async value => {
    ui.patchCalls.push(value); attempts++
    if (attempts === 1) throw new Error('Speichern fehlgeschlagen')
    return settings(value.assistantRole)
  })
  ui.choose('calendar')
  ui.button('Speichern und weiter').props.onClick()
  await ui.settle()
  assert.match(allText(ui.tree), /Speichern fehlgeschlagen/)
  assert.equal(ui.find(node => node.props.role === 'alert').length, 1)
  assert.equal(ui.radios().find(radio => radio.props.value === 'calendar')?.props.checked, true)
  assert.equal(ui.calls.next, 0)
  ui.button('Speichern und weiter').props.onClick()
  await ui.settle()
  assert.equal(attempts, 2)
  assert.deepEqual(ui.patchCalls.map(value => ({ ...value })), [{ assistantRole: 'calendar' }, { assistantRole: 'calendar' }])
  assert.equal(ui.calls.next, 1)
})

it('navigiert nach Unmount nicht wegen eines verspätet erfolgreichen Patches weiter', async () => {
  let resolvePatch!: (value: Settings) => void
  const ui = await setup('step', 'personal', async value => {
    ui.patchCalls.push(value)
    return await new Promise<Settings>(resolveNow => { resolvePatch = resolveNow })
  })
  ui.choose('focus'); ui.button('Speichern und weiter').props.onClick()
  ui.unmount()
  resolvePatch(settings('focus'))
  await ui.settle()
  assert.equal(ui.calls.next, 0)
})

it('Zurück ruft nur die Rücknavigation auf und speichert nicht', async () => {
  const ui = await setup('step')
  ui.choose('calendar')
  ui.button('Zurück').props.onClick()
  assert.equal(ui.calls.back, 1)
  assert.deepEqual(ui.patchCalls, [])
  assert.equal(ui.calls.next, 0)
})

it('Settings-Auswahl wird erst explizit gespeichert; Erfolgsmeldung erst nach Patch-Erfolg', async () => {
  let resolvePatch!: (value: Settings) => void
  const ui = await setup('settings', 'personal', async value => {
    ui.patchCalls.push(value)
    return await new Promise<Settings>(resolveNow => { resolvePatch = resolveNow })
  })
  ui.choose('calendar')
  assert.equal(ui.patchCalls.length, 0)
  assert.equal(ui.button('Schwerpunkt speichern').props.disabled, false)
  ui.button('Schwerpunkt speichern').props.onClick()
  assert.deepEqual(ui.patchCalls.map(value => ({ ...value })), [{ assistantRole: 'calendar' }])
  assert.equal(ui.find(node => node.props.role === 'status').length, 0)
  resolvePatch(settings('calendar'))
  await ui.settle()
  assert.match(allText(ui.tree), /Schwerpunkt gespeichert: Kalender-Assistent/)
  assert.equal(ui.find(node => node.props.role === 'status').length, 1)
})

it('zeigt Settings-Patchfehler statt Erfolg an und belässt die Auswahl änderbar', async () => {
  const ui = await setup('settings', 'personal', async value => {
    ui.patchCalls.push(value)
    throw new Error('Settings nicht gespeichert')
  })
  ui.choose('focus')
  ui.button('Schwerpunkt speichern').props.onClick()
  await ui.settle()
  assert.equal(ui.find(node => node.props.role === 'alert').length, 1)
  assert.match(allText(ui.tree), /Settings nicht gespeichert/)
  assert.equal(ui.find(node => node.props.role === 'status').length, 0)
  assert.equal(ui.radios().find(radio => radio.props.value === 'focus')?.props.checked, true)
  assert.equal(ui.button('Schwerpunkt speichern').props.disabled, false)
})

it('persistiert die unveränderte Settings-Rolle nicht erneut und synchronisiert neue Props', async () => {
  const ui = await setup('settings', 'personal')
  assert.equal(ui.button('Schwerpunkt speichern').props.disabled, true)
  ui.button('Schwerpunkt speichern').props.onClick()
  assert.deepEqual(ui.patchCalls, [])
  ui.updateSettings('calendar')
  assert.equal(ui.radios().find(radio => radio.props.value === 'calendar')?.props.checked, true)
  assert.equal(ui.button('Schwerpunkt speichern').props.disabled, true)
})
