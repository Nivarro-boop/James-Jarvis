import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'

type Node = { type: unknown; props: Record<string, any> }

it('rendert Bearbeitung, lokale Uhrzeit, Snooze und Abbruch ohne Verlust vorhandener Einträge bei Ladefehlern', async () => {
  const fixtures: Record<string, string> = {
    react: `export const useState=initial=>hooks.state(initial); export const useRef=initial=>hooks.ref(initial); export const useEffect=(fn,deps)=>hooks.effect(fn,deps)`,
    'react/jsx-runtime': `export const Fragment=Symbol.for('fixture.fragment'); export const jsx=(type,props,key)=>({type,props:{...props,key}}); export const jsxs=jsx`
  }
  const bundle = await build({
    entryPoints: [resolve('src/renderer/home/ReminderPanel.tsx')], bundle: true, write: false,
    platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent',
    alias: { '@shared': resolve('src/shared') },
    plugins: [{ name: 'reminder-panel-fixture', setup(b) {
      b.onResolve({ filter: /.*/ }, args => args.path in fixtures ? { path: args.path, namespace: 'fixture' } : undefined)
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: fixtures[args.path] }))
    } }]
  })

  const values: unknown[] = []
  let cursor = 0
  const effectFns: Array<() => unknown> = []
  const hooks = {
    state(initial: unknown) {
      const slot = cursor++
      if (!(slot in values)) values[slot] = typeof initial === 'function' ? (initial as () => unknown)() : initial
      return [values[slot], (next: unknown) => { values[slot] = typeof next === 'function' ? (next as (current: unknown) => unknown)(values[slot]) : next }] as const
    },
    ref(initial: unknown) {
      const slot = cursor++
      if (!(slot in values)) values[slot] = { current: initial }
      return values[slot]
    },
    effect(fn: () => unknown) { if (effectFns.length === 0) effectFns.push(fn) }
  }
  let reminders: any[] = [{ id: 41, text: 'Alte Aufgabe', dueAt: Date.now() + 60 * 60_000, repeat: 'none', state: 'pending', createdAt: Date.now(), lastNotifiedAt: null }]
  let failList = false
  let delayUpdate = false
  let resolveUpdate: ((result: any) => void) | undefined
  const calls: Array<{ channel: string; payload: any }> = []
  const jarvis = {
    invoke(channel: string, payload?: any): Promise<any> {
      calls.push({ channel, payload })
      if (channel === 'reminder:list') return failList ? Promise.reject(new Error('Laden fehlgeschlagen')) : Promise.resolve(reminders)
      if (channel === 'reminder:update') {
        const result = { ...reminders[0], ...payload,
          ...(payload.at ? { dueAt: Date.parse(payload.at), state: 'pending' } : {}) }
        reminders = [result]
        if (delayUpdate) return new Promise(resolve => { resolveUpdate = resolve })
        return Promise.resolve(result)
      }
      if (channel === 'reminder:snooze' || channel === 'reminder:done') return Promise.resolve(undefined)
      if (channel === 'reminder:create') return Promise.resolve({ id: 42, ...payload })
      throw new Error(`Unexpected invoke channel ${channel}`)
    },
    on() { return () => {} }
  }
  const module = { exports: {} as Record<string, any> }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, hooks, window: { jarvis, setInterval: () => 1, clearInterval() {} }
  })
  const component = module.exports.ReminderPanel as () => Node
  const render = (): Node => { cursor = 0; return component() }
  const settle = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  const allNodes = (root: any): Node[] => {
    if (Array.isArray(root)) return root.flatMap(allNodes)
    if (!root || typeof root !== 'object' || !('type' in root)) return []
    const node = root as Node
    return [node, ...allNodes(node.props.children)]
  }
  const find = (root: Node, predicate: (node: Node) => boolean): Node => {
    const found = allNodes(root).find(predicate)
    assert.ok(found, 'expected UI control not found')
    return found
  }
  const label = (name: string) => (node: Node) => node.props['aria-label'] === name
  const button = (root: Node, text: string) => find(root, node => node.type === 'button' && node.props.children === text)

  let tree = render()
  effectFns[0]()
  await settle()
  tree = render()
  assert.ok(allNodes(tree).some(node => node.type === 'strong' && node.props.children === 'Alte Aufgabe'))

  button(tree, 'Bearbeiten').props.onClick()
  tree = render()
  const editTime = find(tree, label('Zeitpunkt bearbeiten'))
  assert.equal(editTime.props.value, (() => {
    const t = reminders[0].dueAt
    return new Date(t - new Date(t).getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
  })())
  const changedAt = new Date(Date.now() + 3 * 60 * 60_000)
  const localValue = new Date(changedAt.getTime() - changedAt.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
  find(tree, label('Erinnerungstext bearbeiten')).props.onChange({ target: { value: 'Termin geändert' } })
  editTime.props.onChange({ target: { value: localValue } })
  tree = render()
  const submit = find(tree, node => node.type === 'form' && typeof node.props.onSubmit === 'function')
  delayUpdate = true
  const event = { preventDefault() {} }
  submit.props.onSubmit(event)
  submit.props.onSubmit(event)
  assert.equal(calls.filter(call => call.channel === 'reminder:update').length, 1, 'busy guard must reject the duplicate submission')
  const sent = calls.find(call => call.channel === 'reminder:update')!.payload
  assert.equal(sent.text, 'Termin geändert')
  assert.equal(Date.parse(sent.at), Date.parse(localValue), 'datetime-local must be interpreted as local time, not UTC')
  resolveUpdate!(reminders[0])
  await settle()
  tree = render()
  assert.ok(allNodes(tree).some(node => node.type === 'strong' && node.props.children === 'Termin geändert'))

  button(tree, '+30 Min.').props.onClick()
  await settle()
  assert.ok(calls.some(call => call.channel === 'reminder:snooze' && call.payload.minutes === 30))

  // Text-only edits preserve a notified reminder's overdue date and do not rearm it.
  delayUpdate = false
  reminders[0] = { ...reminders[0], dueAt: Date.now() - 60_123, state: 'notified' }
  const overdueAt = reminders[0].dueAt
  effectFns[0]()
  await settle()
  tree = render()
  button(tree, 'Bearbeiten').props.onClick()
  tree = render()
  find(tree, label('Erinnerungstext bearbeiten')).props.onChange({ target: { value: 'Text ohne neue Fälligkeit' } })
  tree = render()
  find(tree, node => node.type === 'form').props.onSubmit(event)
  await settle()
  const textOnly = calls.filter(call => call.channel === 'reminder:update').at(-1)!.payload
  assert.equal('at' in textOnly, false, 'unchanged dates must not be resubmitted or truncated to minutes')
  assert.equal(reminders[0].dueAt, overdueAt)
  assert.equal(reminders[0].state, 'notified')

  tree = render()
  button(tree, 'Bearbeiten').props.onClick()
  tree = render()
  find(tree, label('Erinnerungstext bearbeiten')).props.onChange({ target: { value: 'Nicht speichern' } })
  tree = render()
  const writesBeforeCancel = calls.filter(call => call.channel !== 'reminder:list').length
  button(tree, 'Abbrechen').props.onClick()
  assert.equal(calls.filter(call => call.channel !== 'reminder:list').length, writesBeforeCancel)
  tree = render()
  assert.ok(allNodes(tree).some(node => node.type === 'strong' && node.props.children === 'Text ohne neue Fälligkeit'))
  button(tree, 'Erledigt').props.onClick()
  await settle()
  assert.ok(calls.some(call => call.channel === 'reminder:done' && call.payload.id === 41))

  failList = true
  effectFns[0]()
  await settle()
  tree = render()
  assert.ok(allNodes(tree).some(node => node.type === 'strong' && node.props.children === 'Text ohne neue Fälligkeit'), 'list failure must not clear known reminders')
  assert.equal(find(tree, node => node.props.role === 'alert').props.children, 'Laden fehlgeschlagen')
  assert.ok(allNodes(tree).some(node => node.type === 'summary' && node.props.children === 'Erinnerung hinzufügen'))
})
