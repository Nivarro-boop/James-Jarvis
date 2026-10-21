/**
 * Feature Packs sind ausschließlich deklarative, versionierte JSON-Daten.
 * Es gibt absichtlich keine Felder für Code, Markup, Styles, URLs oder Plugins.
 */
export const FEATURE_PACK_FORMAT = 'jarvis-feature-pack' as const
export const FEATURE_PACK_SCHEMA_VERSION = 1 as const
export const FEATURE_PACK_PERMISSION = 'local-widget-state' as const
export type FeaturePackPermission = typeof FEATURE_PACK_PERMISSION
export type FeaturePackWidget =
  | { id: string; type: 'note'; title: string; text: string }
  | { id: string; type: 'checklist'; title: string; items: Array<{ id: string; text: string }> }
export interface FeaturePackManifest {
  format: typeof FEATURE_PACK_FORMAT
  schemaVersion: typeof FEATURE_PACK_SCHEMA_VERSION
  id: string
  name: string
  version: string
  permissions: FeaturePackPermission[]
  widgets: FeaturePackWidget[]
}
export interface FeaturePackPreview {
  manifest: FeaturePackManifest
  sha256: string
  installedVersion: string | null
  update: boolean
}
export interface FeaturePackInstalled {
  id: string
  name: string
  version: string
  enabled: boolean
  permissions: FeaturePackPermission[]
  widgets: FeaturePackWidget[]
}
export interface FeaturePackWidgetView {
  packId: string
  packName: string
  widget: FeaturePackWidget
  checked?: Record<string, boolean>
}
export interface FeaturePackError { code: string; message: string }

/**
 * CHANNEL-CONTRACT: Parent integriert `IpcInvokeMap extends FeaturePackIpcMap`
 * und fügt alle Schlüssel dieses Interfaces zu IPC_INVOKE_CHANNELS hinzu.
 * `createFeaturePackHandlers(userDataPath)` aus `src/main/packs/ipc.ts` liefert
 * Handler; Parent muss jeden Kanal über seine trustedSender-guarded `handle()`
 * registrieren. Dieser Vertrag registriert selbst keine IPC-Handler.
 */
export interface FeaturePackIpcMap {
  'packs:preview': { req: { json: string }; res: FeaturePackPreview }
  'packs:install': { req: { json: string; sha256: string; acceptTrust: boolean; acceptedPermissions: FeaturePackPermission[] }; res: FeaturePackInstalled }
  'packs:list': { req: void; res: FeaturePackInstalled[] }
  'packs:setEnabled': { req: { id: string; enabled: boolean }; res: FeaturePackInstalled }
  'packs:remove': { req: { id: string }; res: void }
  'packs:widgets': { req: void; res: FeaturePackWidgetView[] }
  'packs:toggle': { req: { packId: string; widgetId: string; itemId: string; checked: boolean }; res: FeaturePackWidgetView[] }
}

export class FeaturePackValidationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'FeaturePackValidationError' }
}
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const URL_OR_MARKUP = /(?:https?:\/\/|ftp:\/\/|www\.|javascript:|data:|file:|<|>)/i
const ownKeys = (value: object): string[] => Object.keys(value)
function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new FeaturePackValidationError('invalid-shape', `${label} muss ein JSON-Objekt sein.`)
  return value as Record<string, unknown>
}
function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const keys = ownKeys(value)
  if (keys.some((key) => !allowed.includes(key)) || allowed.some((key) => !keys.includes(key))) throw new FeaturePackValidationError('invalid-fields', `${label} enthält fehlende oder unbekannte Felder.`)
}
function text(value: unknown, label: string, max: number, min = 1): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || value.trim() !== value || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || URL_OR_MARKUP.test(value)) throw new FeaturePackValidationError('invalid-text', `${label}: Text muss zwischen ${min} und ${max} Zeichen haben und darf keine Markup- oder URL-Inhalte enthalten.`)
  return value
}
function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value) || new Set(['constructor', 'prototype', 'toString', 'valueOf', 'hasownproperty']).has(value.toLowerCase())) throw new FeaturePackValidationError('invalid-id', `${label} ist keine gültige sichere ID.`)
  return value
}
function compareIdentifiers(a: string, b: string): number {
  const an = /^\d+$/.test(a), bn = /^\d+$/.test(b)
  if (an && bn) return a.length === b.length ? (a < b ? -1 : a > b ? 1 : 0) : a.length < b.length ? -1 : 1
  if (an !== bn) return an ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}
export function compareSemver(a: string, b: string): number {
  if (!SEMVER.test(a) || !SEMVER.test(b)) throw new FeaturePackValidationError('invalid-version', 'Version muss gültiges SemVer sein.')
  const parse = (value: string): { core: string[]; pre: string[] | null } => {
    const withoutBuild = value.split('+', 1)[0]
    const separator = withoutBuild.indexOf('-')
    const core = separator < 0 ? withoutBuild : withoutBuild.slice(0, separator)
    const pre = separator < 0 ? null : withoutBuild.slice(separator + 1).split('.')
    return { core: core.split('.'), pre }
  }
  const left = parse(a), right = parse(b)
  for (let i = 0; i < 3; i++) { const order = compareIdentifiers(left.core[i], right.core[i]); if (order) return order }
  if (left.pre === null || right.pre === null) return left.pre === right.pre ? 0 : left.pre === null ? 1 : -1
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    if (left.pre[i] === undefined || right.pre[i] === undefined) return left.pre[i] === right.pre[i] ? 0 : left.pre[i] === undefined ? -1 : 1
    const order = compareIdentifiers(left.pre[i], right.pre[i]); if (order) return order
  }
  return 0
}
/** JSON.parse silently keeps the last duplicate key; reject it before validation. */
function rejectDuplicateJsonKeys(source: string): void {
  let offset = 0
  const whitespace = (): void => { while (/\s/.test(source[offset] ?? '')) offset++ }
  const stringToken = (): string => {
    const start = offset++
    while (offset < source.length) {
      if (source[offset] === '\\') { offset += 2; continue }
      if (source[offset++] === '"') return JSON.parse(source.slice(start, offset)) as string
    }
    throw new Error('Invalid JSON string')
  }
  const value = (): void => {
    whitespace()
    if (source[offset] === '{') {
      offset++; whitespace(); const keys = new Set<string>()
      if (source[offset] === '}') { offset++; return }
      while (offset < source.length) {
        whitespace(); const key = stringToken()
        if (keys.has(key)) throw new FeaturePackValidationError('duplicate-field', `Doppeltes JSON-Feld: ${key}`)
        keys.add(key); whitespace(); offset++; value(); whitespace()
        if (source[offset] === '}') { offset++; return }
        offset++
      }
      return
    }
    if (source[offset] === '[') {
      offset++; whitespace(); if (source[offset] === ']') { offset++; return }
      while (offset < source.length) { value(); whitespace(); if (source[offset] === ']') { offset++; return } offset++ }
      return
    }
    if (source[offset] === '"') { stringToken(); return }
    while (offset < source.length && !/[\s,}\]]/.test(source[offset])) offset++
  }
  value()
}
export function parseFeaturePackManifest(input: string): FeaturePackManifest {
  if (typeof input !== 'string' || new TextEncoder().encode(input).length > 64 * 1024) throw new FeaturePackValidationError('too-large', 'JSON darf höchstens 64 KiB groß sein.')
  let parsed: unknown
  try { parsed = JSON.parse(input) } catch { throw new FeaturePackValidationError('invalid-json', 'Ungültiges JSON.') }
  rejectDuplicateJsonKeys(input)
  const root = record(parsed, 'Manifest')
  exactKeys(root, ['format', 'schemaVersion', 'id', 'name', 'version', 'permissions', 'widgets'], 'Manifest')
  if (root.format !== FEATURE_PACK_FORMAT || root.schemaVersion !== FEATURE_PACK_SCHEMA_VERSION) throw new FeaturePackValidationError('unsupported-schema', 'Unbekanntes Manifestformat oder nicht unterstützte Schema-Version.')
  const packId = id(root.id, 'Pack-ID')
  const name = text(root.name, 'Name', 80)
  if (typeof root.version !== 'string' || !SEMVER.test(root.version)) throw new FeaturePackValidationError('invalid-version', 'Version muss gültiges SemVer sein.')
  if (!Array.isArray(root.permissions) || root.permissions.length > 8) throw new FeaturePackValidationError('invalid-permissions', 'Berechtigungen müssen eine begrenzte Liste sein.')
  const permissions: FeaturePackPermission[] = []
  for (const permission of root.permissions) {
    if (permission !== FEATURE_PACK_PERMISSION) throw new FeaturePackValidationError('unknown-permission', `Nicht unterstützte Berechtigung: ${String(permission)}`)
    if (permissions.includes(permission)) throw new FeaturePackValidationError('duplicate-permission', 'Doppelte Berechtigung.')
    permissions.push(permission)
  }
  if (!Array.isArray(root.widgets) || root.widgets.length < 1 || root.widgets.length > 12) throw new FeaturePackValidationError('invalid-widgets', 'Ein Pack braucht 1 bis 12 Widgets.')
  const widgetIds = new Set<string>()
  let itemCount = 0, totalText = 0
  const widgets: FeaturePackWidget[] = root.widgets.map((raw, index) => {
    const widget = record(raw, `Widget ${index + 1}`)
    if (widget.type === 'note') {
      exactKeys(widget, ['id', 'type', 'title', 'text'], 'Notiz-Widget')
      const widgetId = id(widget.id, 'Widget-ID'); if (widgetIds.has(widgetId)) throw new FeaturePackValidationError('duplicate-id', 'Doppelte Widget-ID.'); widgetIds.add(widgetId)
      const title = text(widget.title, 'Widget-Titel', 80), body = text(widget.text, 'Notiz', 2000)
      totalText += title.length + body.length
      return { id: widgetId, type: 'note', title, text: body }
    }
    if (widget.type === 'checklist') {
      exactKeys(widget, ['id', 'type', 'title', 'items'], 'Checklisten-Widget')
      const widgetId = id(widget.id, 'Widget-ID'); if (widgetIds.has(widgetId)) throw new FeaturePackValidationError('duplicate-id', 'Doppelte Widget-ID.'); widgetIds.add(widgetId)
      const title = text(widget.title, 'Widget-Titel', 80)
      if (!Array.isArray(widget.items) || widget.items.length < 1 || widget.items.length > 30) throw new FeaturePackValidationError('invalid-list', 'Eine Checkliste darf 1 bis 30 Einträge enthalten.')
      const itemIds = new Set<string>()
      const items = widget.items.map((rawItem) => {
        const item = record(rawItem, 'Checklisten-Eintrag'); exactKeys(item, ['id', 'text'], 'Checklisten-Eintrag')
        const itemId = id(item.id, 'Eintrags-ID'); if (itemIds.has(itemId)) throw new FeaturePackValidationError('duplicate-id', 'Doppelte Eintrags-ID.'); itemIds.add(itemId)
        itemCount++; const itemText = text(item.text, 'Eintrag', 160); totalText += itemText.length
        return { id: itemId, text: itemText }
      })
      totalText += title.length
      return { id: widgetId, type: 'checklist', title, items }
    }
    throw new FeaturePackValidationError('unknown-widget', 'Nur lokale Notiz- und Checklisten-Widgets sind zulässig.')
  })
  if (itemCount > 120 || totalText > 12000) throw new FeaturePackValidationError('limits-exceeded', 'Pack überschreitet die maximale Feld- oder Textmenge.')
  const needsState = widgets.some((widget) => widget.type === 'checklist')
  if (needsState !== permissions.includes(FEATURE_PACK_PERMISSION)) throw new FeaturePackValidationError('permission-mismatch', 'Checklisten benötigen local-widget-state; reine Notizen benötigen keine Berechtigung.')
  return { format: FEATURE_PACK_FORMAT, schemaVersion: FEATURE_PACK_SCHEMA_VERSION, id: packId, name, version: root.version, permissions, widgets }
}
