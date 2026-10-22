import { strictEqual, ok } from 'node:assert/strict'
import { describe, it } from 'node:test'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ActivityItem, ActivitySnapshot } from '../src/shared/types'

async function loadActivityPanel(): Promise<(props: { snapshot: ActivitySnapshot }) => React.JSX.Element> {
  const project = process.cwd()
  const output = await build({
    entryPoints: [join(project, 'src/renderer/home/ActivityPanel.tsx')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    jsx: 'automatic',
    packages: 'external',
    loader: { '.css': 'empty' },
    alias: { '@shared': join(project, 'src/shared') }
  })
  const outputDir = join(project, 'out/tests')
  await mkdir(outputDir, { recursive: true })
  const outputPath = join(outputDir, 'activity-filter-panel.cjs')
  await writeFile(outputPath, output.outputFiles[0].text)
  const requireFromProject = createRequire(join(outputDir, 'activity-filter.test.cjs'))
  return requireFromProject(outputPath).ActivityPanel as (props: { snapshot: ActivitySnapshot }) => React.JSX.Element
}

/** Kleiner DOM-Host für ReactDOM: die Tests feuern echte delegierte DOM-Events. */
class TestEvent {
  type: string
  bubbles: boolean
  cancelable: boolean
  defaultPrevented = false
  target: TestNode | null = null
  currentTarget: TestNode | null = null
  private stopped = false
  constructor(type: string, init: { bubbles?: boolean; cancelable?: boolean } = {}) {
    this.type = type
    this.bubbles = init.bubbles ?? false
    this.cancelable = init.cancelable ?? false
  }
  preventDefault(): void { if (this.cancelable) this.defaultPrevented = true }
  stopPropagation(): void { this.stopped = true }
  isPropagationStopped(): boolean { return this.stopped }
}

type Listener = (event: TestEvent) => void
class TestNode {
  readonly nodeType: number
  readonly nodeName: string
  ownerDocument: TestDocument | null
  parentNode: TestNode | null = null
  childNodes: TestNode[] = []
  private listeners = new Map<string, Listener[]>()
  constructor(nodeType: number, nodeName: string, ownerDocument: TestDocument | null) {
    this.nodeType = nodeType
    this.nodeName = nodeName
    this.ownerDocument = ownerDocument
  }
  get firstChild(): TestNode | null { return this.childNodes[0] ?? null }
  get lastChild(): TestNode | null { return this.childNodes.at(-1) ?? null }
  get nextSibling(): TestNode | null {
    if (!this.parentNode) return null
    const siblings = this.parentNode.childNodes
    return siblings[siblings.indexOf(this) + 1] ?? null
  }
  get parentElement(): TestElement | null { return this.parentNode instanceof TestElement ? this.parentNode : null }
  get textContent(): string { return this.nodeType === 3 ? (this as unknown as TestText).data : this.childNodes.map((child) => child.textContent).join('') }
  set textContent(value: string) {
    this.childNodes = []
    if (value) this.appendChild(new TestText(value, this.ownerDocument))
  }
  appendChild<T extends TestNode>(child: T): T {
    if (child.nodeType === 11) {
      for (const nested of [...child.childNodes]) this.appendChild(nested)
      return child
    }
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    child.ownerDocument = this.nodeType === 9 ? this as unknown as TestDocument : this.ownerDocument
    this.childNodes.push(child)
    return child
  }
  insertBefore<T extends TestNode>(child: T, before: TestNode | null): T {
    if (before === null) return this.appendChild(child)
    if (child.parentNode) child.parentNode.removeChild(child)
    const index = this.childNodes.indexOf(before)
    if (index < 0) throw new Error('before node not found')
    child.parentNode = this
    child.ownerDocument = this.ownerDocument
    this.childNodes.splice(index, 0, child)
    return child
  }
  removeChild<T extends TestNode>(child: T): T {
    const index = this.childNodes.indexOf(child)
    if (index < 0) throw new Error('child not found')
    this.childNodes.splice(index, 1)
    child.parentNode = null
    return child
  }
  contains(node: TestNode): boolean { return node === this || this.childNodes.some((child) => child.contains(node)) }
  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener))
  }
  dispatchEvent(event: TestEvent): boolean {
    event.target = this
    let node: TestNode | null = this
    while (node) {
      event.currentTarget = node
      for (const listener of [...(node.listeners.get(event.type) ?? [])]) listener(event)
      if (!event.bubbles || event.isPropagationStopped()) break
      node = node.parentNode
    }
    return !event.defaultPrevented
  }
  getRootNode(): TestNode { let node: TestNode = this; while (node.parentNode) node = node.parentNode; return node }
}

class TestText extends TestNode {
  data: string
  constructor(data: string, ownerDocument: TestDocument | null) { super(3, '#text', ownerDocument); this.data = data }
  get nodeValue(): string { return this.data }
  set nodeValue(value: string) { this.data = value }
  override get textContent(): string { return this.data }
  override set textContent(value: string) { this.data = value }
}

class TestStyle {
  [key: string]: unknown
  setProperty(name: string, value: string): void { this[name] = value }
  removeProperty(name: string): void { delete this[name] }
  getPropertyValue(name: string): string { return String(this[name] ?? '') }
}

class TestElement extends TestNode {
  readonly tagName: string
  readonly localName: string
  readonly namespaceURI = 'http://www.w3.org/1999/xhtml'
  readonly style = new TestStyle()
  private attrs = new Map<string, string>()
  private _value = ''
  get value(): string { return this._value }
  set value(value: string) { this._value = value }
  checked = false
  disabled = false
  type = ''
  id = ''
  className = ''
  htmlFor = ''
  tabIndex = 0
  name = ''
  placeholder = ''
  constructor(tag: string, ownerDocument: TestDocument) {
    super(1, tag.toUpperCase(), ownerDocument)
    this.tagName = tag.toUpperCase()
    this.localName = tag.toLowerCase()
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value))
    if (name === 'id') this.id = String(value)
    if (name === 'class') this.className = String(value)
    if (name === 'value') this.value = String(value)
    if (name === 'type') this.type = String(value)
    if (name === 'name') this.name = String(value)
  }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null }
  removeAttribute(name: string): void { this.attrs.delete(name) }
  focus(): void { if (this.ownerDocument) this.ownerDocument.activeElement = this }
  blur(): void { if (this.ownerDocument) this.ownerDocument.activeElement = this.ownerDocument.body }
  querySelectorAll(selector: string): TestElement[] {
    const result: TestElement[] = []
    const visit = (node: TestNode): void => {
      for (const child of node.childNodes) {
        if (child instanceof TestElement && (selector === '*' || selector === child.localName || (selector.startsWith('#') && child.id === selector.slice(1)))) result.push(child)
        visit(child)
      }
    }
    visit(this)
    return result
  }
}

class TestDocument extends TestNode {
  readonly documentElement: TestElement
  readonly body: TestElement
  activeElement: TestElement
  defaultView: unknown
  constructor() {
    super(9, '#document', null)
    this.documentElement = new TestElement('html', this)
    this.body = new TestElement('body', this)
    this.activeElement = this.body
    this.appendChild(this.documentElement)
    this.documentElement.appendChild(this.body)
  }
  createElement(tag: string): TestElement { return new TestElement(tag, this) }
  createElementNS(_namespace: string, tag: string): TestElement { return this.createElement(tag) }
  createTextNode(value: string): TestText { return new TestText(value, this) }
  createComment(value: string): TestText { return new TestText(value, this) }
  createDocumentFragment(): TestNode { return new TestNode(11, '#document-fragment', this) }
  getElementById(id: string): TestElement | null { return this.documentElement.querySelectorAll('*').find((el) => el.id === id) ?? null }
}

function installDom(): { container: TestElement; dispose: () => void } {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Node: globalThis.Node,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    actEnvironment: (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  }
  const document = new TestDocument()
  const window = {
    document,
    Event: TestEvent,
    HTMLElement: TestElement,
    HTMLIFrameElement: class TestIFrameElement extends TestElement {},
    setInterval: () => 1,
    clearInterval: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getComputedStyle: () => ({ getPropertyValue: () => '' })
  }
  document.defaultView = window
  Object.assign(globalThis, { window, document, Node: TestNode, Element: TestElement, HTMLElement: TestElement, Event: TestEvent, IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'test' } })
  const container = document.createElement('div')
  document.body.appendChild(container)
  return {
    container,
    dispose: () => {
      container.parentNode?.removeChild(container)
      Object.assign(globalThis, { window: previous.window, document: previous.document, Node: previous.Node, Element: previous.Element, HTMLElement: previous.HTMLElement, Event: previous.Event })
      ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previous.actEnvironment
      if (previous.navigator) Object.defineProperty(globalThis, 'navigator', previous.navigator)
    }
  }
}

function allElements(container: TestElement): TestElement[] { return container.querySelectorAll('*') }
function getByText(container: TestElement, text: string): TestElement | undefined {
  return allElements(container).find((element) => element.textContent === text)
}
function reactProps(node: TestElement): Record<string, (event: { currentTarget: TestElement; target: TestElement; preventDefault: () => void }) => void> {
  const key = Object.keys(node).find((name) => name.startsWith('__reactProps$'))
  return key ? (node as unknown as Record<string, unknown>)[key] as Record<string, (event: { currentTarget: TestElement; target: TestElement; preventDefault: () => void }) => void> : {}
}
function fire(node: TestElement, type: string): void {
  node.dispatchEvent(new TestEvent(type, { bubbles: true, cancelable: true }))
  const handler = reactProps(node)[`on${type[0].toUpperCase()}${type.slice(1)}`]
  handler?.({ currentTarget: node, target: node, preventDefault: () => undefined })
}
function setInput(input: TestElement, value: string): void {
  const nativeSetter = Object.getOwnPropertyDescriptor(TestElement.prototype, 'value')?.set
  if (nativeSetter) nativeSetter.call(input, value)
  else input.value = value
  fire(input, 'input')
  fire(input, 'change')
  reactProps(input).onChange?.({ currentTarget: input, target: input, preventDefault: () => undefined })
}

const action = (overrides: Partial<ActivityItem> & Pick<ActivityItem, 'id' | 'label'>): ActivityItem => ({
  status: 'ok', startedAt: 1_700_000_000_000, source: 'jarvis', ...overrides
})

const fixture: ActivitySnapshot = {
  plan: { title: 'Laufender Plan', updatedAt: 1_700_000_000_000, steps: [{ text: 'Erster Schritt', status: 'läuft' }, { text: 'Zweiter Schritt', status: 'offen' }] },
  items: [
    action({ id: 'parent', label: 'Gesamtaufgabe ohne Suchwort', source: 'agent', status: 'running' }),
    action({ id: 'child', label: 'Unteragentenaktion', detail: 'Spezielle Zusammenfassung', tool: 'deep_tool', source: 'agent', parentId: 'parent' }),
    ...Array.from({ length: 18 }, (_, i) => action({ id: `old-${i}`, label: `Aktion ${i + 1}`, status: i === 17 ? 'error' : 'ok' }))
  ]
}

describe('Aktionslog-Filter (React-DOM)', () => {
  it('filtert den ganzen Snapshot per Such-/Status-Event und zeigt passende Unteragenten mit Parent-Kontext', async () => {
    const dom = installDom()
    let root: Root | undefined
    try {
      const ActivityPanel = await loadActivityPanel()
      await act(async () => {
        root = createRoot(dom.container as unknown as Element)
        root.render(React.createElement(ActivityPanel, { snapshot: fixture }))
      })
      ok(getByText(dom.container, 'Laufender Plan'), 'der Plan bleibt sichtbar')
      ok(getByText(dom.container, 'Aktion 18'), 'Einträge jenseits der früheren 14er-Grenze werden dargestellt')

      const input = allElements(dom.container).find((el) => el.id === 'act-search')
      ok(input, 'Suchfeld ist vorhanden')
      await act(async () => setInput(input!, 'deep_tool'))
      ok(getByText(dom.container, 'Unteragentenaktion'), 'Suche findet das Kind über seinen Toolnamen')
      ok(getByText(dom.container, 'Gesamtaufgabe ohne Suchwort'), 'nicht passender Parent bleibt als Kontext sichtbar')
      ok(getByText(dom.container, 'Elternaktion als Kontext'))
      ok(getByText(dom.container, '1 Treffer'), `Trefferzahl zählt nur das passende Kind, nicht den Parent-Kontext: ${dom.container.textContent}`)

      const failed = allElements(dom.container).find((el) => el.textContent === 'Fehlgeschlagen' && el.getAttribute('aria-pressed') === 'false')
      ok(failed, 'Statusfilter ist vorhanden')
      await act(async () => fire(failed!, 'click'))
      ok(getByText(dom.container, 'Kein Treffer für die aktuellen Filter.'), 'zeigt Kein Treffer statt Noch nichts')
      ok(getByText(dom.container, 'Laufender Plan'), 'Plan bleibt auch bei leerem Filterergebnis sichtbar')

      const reset = allElements(dom.container).find((el) => el.textContent === 'Filter zurücksetzen')
      ok(reset)
      await act(async () => fire(reset!, 'click'))
      ok(getByText(dom.container, 'Unteragentenaktion'), 'Reset zeigt die volle Liste wieder')
      ok(getByText(dom.container, 'Aktion 18'))
      ok(!getByText(dom.container, 'Kein Treffer für die aktuellen Filter.'))
    } finally {
      if (root) await act(async () => root?.unmount())
      dom.dispose()
    }
  })

  it('unterscheidet einen wirklich leeren Verlauf von einer Suche ohne Treffer', async () => {
    const dom = installDom()
    let root: Root | undefined
    try {
      const ActivityPanel = await loadActivityPanel()
      await act(async () => {
        root = createRoot(dom.container as unknown as Element)
        root.render(React.createElement(ActivityPanel, { snapshot: { items: [], plan: null } }))
      })
      ok(getByText(dom.container, 'Noch nichts zu tun. Sobald James ein Werkzeug benutzt, steht es hier.'))
      const input = allElements(dom.container).find((el) => el.id === 'act-search')
      ok(input)
      await act(async () => setInput(input!, 'fehlendes Werkzeug'))
      ok(getByText(dom.container, 'Kein Treffer für die aktuellen Filter.'))
      ok(!getByText(dom.container, 'Noch nichts zu tun. Sobald James ein Werkzeug benutzt, steht es hier.'))
    } finally {
      if (root) await act(async () => root?.unmount())
      dom.dispose()
    }
  })
})
