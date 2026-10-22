import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import {
  compareSemver, FeaturePackValidationError, parseFeaturePackManifest,
  FEATURE_PACK_PERMISSION, type FeaturePackInstalled, type FeaturePackManifest,
  type FeaturePackPermission, type FeaturePackPreview, type FeaturePackWidgetView
} from '@shared/featurePacks'

interface StoredPack { manifest: FeaturePackManifest; enabled: boolean; checked: Record<string, Record<string, boolean>> }
const ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const MAX_JSON_BYTES = 64 * 1024
const MAX_INSTALLED_PACKS = 32
function failure(code: string, message: string): never { throw new FeaturePackValidationError(code, message) }
function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
function digestMatches(a: string, b: string): boolean {
  return /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}
function plainObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }

/** A disk-only store. It never loads modules, markup, executable files, or network content. */
export class FeaturePackService {
  private static readonly mutationQueues = new Map<string, Promise<void>>()
  private readonly root: string
  private readonly userData: string
  constructor(userDataPath: string) {
    if (!userDataPath || typeof userDataPath !== 'string') failure('invalid-path', 'UserData-Pfad fehlt.')
    this.userData = resolve(userDataPath)
    this.root = resolve(this.userData, 'feature-packs')
    if (!this.root.startsWith(this.userData + sep)) failure('invalid-path', 'Ungültiger Pack-Speicherpfad.')
  }
  /** Serializes mutations even when the central handler/test made fresh service instances. */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const prior = FeaturePackService.mutationQueues.get(this.root) ?? Promise.resolve()
    const current = prior.then(operation, operation)
    const tail = current.then(() => undefined, () => undefined)
    FeaturePackService.mutationQueues.set(this.root, tail)
    void tail.then(() => { if (FeaturePackService.mutationQueues.get(this.root) === tail) FeaturePackService.mutationQueues.delete(this.root) })
    return current
  }
  private async safeRoot(create = true): Promise<void> {
    if (create) await mkdir(this.userData, { recursive: true })
    const base = await lstat(this.userData).catch(() => null)
    if (!base || base.isSymbolicLink() || !base.isDirectory()) failure('unsafe-path', 'UserData-Pfad ist kein sicherer Ordner.')
    if (create) await mkdir(this.root, { recursive: false }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
    const rootStat = await lstat(this.root).catch(() => null)
    if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) failure('unsafe-path', 'Feature-Pack-Ordner ist kein sicherer Ordner.')
  }
  private file(id: string): string {
    if (!ID.test(id)) failure('invalid-id', 'Ungültige Pack-ID.')
    const path = resolve(this.root, `${id}.json`)
    if (!path.startsWith(this.root + sep) || dirname(path) !== this.root) failure('unsafe-path', 'Ungültiger Pack-Pfad.')
    return path
  }
  private async read(id: string): Promise<StoredPack | null> {
    const path = this.file(id)
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (!stat) return null
    if (stat.isSymbolicLink() || !stat.isFile()) failure('unsafe-path', 'Pack-Datei ist kein regulärer lokaler Datensatz.')
    if (stat.size > 128 * 1024) failure('corrupt-store', 'Gespeichertes Pack ist zu groß.')
    const raw = await readFile(path, 'utf8')
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { failure('corrupt-store', 'Gespeichertes Pack ist beschädigt.') }
    if (!plainObject(parsed) || !plainObject(parsed.manifest) || typeof parsed.enabled !== 'boolean' || !plainObject(parsed.checked)) failure('corrupt-store', 'Gespeichertes Pack hat ein ungültiges Format.')
    const manifest = parseFeaturePackManifest(JSON.stringify(parsed.manifest))
    if (manifest.id !== id) failure('corrupt-store', 'Pack-ID und Dateiname stimmen nicht überein.')
    const checked: StoredPack['checked'] = {}
    for (const widget of manifest.widgets) {
      if (widget.type !== 'checklist') continue
      const candidate = parsed.checked[widget.id]
      const byItem: Record<string, boolean> = {}
      if (candidate !== undefined) {
        if (!plainObject(candidate)) failure('corrupt-store', 'Checklistenstatus ist ungültig.')
        for (const [itemId, value] of Object.entries(candidate)) {
          if (!widget.items.some((item) => item.id === itemId) || typeof value !== 'boolean') failure('corrupt-store', 'Checklistenstatus enthält unbekannte Werte.')
          byItem[itemId] = value
        }
      }
      checked[widget.id] = byItem
    }
    if (Object.keys(parsed.checked).some((widgetId) => !manifest.widgets.some((widget) => widget.type === 'checklist' && widget.id === widgetId))) failure('corrupt-store', 'Checklistenstatus enthält unbekannte Widgets.')
    return { manifest, enabled: parsed.enabled, checked }
  }
  private async write(id: string, data: StoredPack): Promise<void> {
    await this.safeRoot()
    const target = this.file(id)
    const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) failure('unsafe-path', 'Pack-Zieldatei ist kein regulärer Datensatz.')
    const temp = join(this.root, `.${id}.${randomUUID()}.tmp`)
    try {
      await writeFile(temp, JSON.stringify(data), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      const tempStat = await lstat(temp)
      if (tempStat.isSymbolicLink() || !tempStat.isFile()) failure('unsafe-path', 'Temporäre Datei ist unsicher.')
      await rename(temp, target)
    } catch (error) {
      await unlink(temp).catch(() => undefined)
      throw error
    }
  }
  async preview(json: string): Promise<FeaturePackPreview> {
    if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_JSON_BYTES) failure('too-large', 'JSON darf höchstens 64 KiB groß sein.')
    const manifest = parseFeaturePackManifest(json)
    await this.safeRoot()
    const current = await this.read(manifest.id)
    return { manifest, sha256: digest(json), installedVersion: current?.manifest.version ?? null, update: current !== null }
  }
  install(input: { json: string; sha256: string; acceptTrust: boolean; acceptedPermissions: FeaturePackPermission[] }): Promise<FeaturePackInstalled> {
    return this.serialize(() => this.installExclusive(input))
  }
  private async installExclusive(input: { json: string; sha256: string; acceptTrust: boolean; acceptedPermissions: FeaturePackPermission[] }): Promise<FeaturePackInstalled> {
    if (typeof input?.json !== 'string' || Buffer.byteLength(input.json, 'utf8') > MAX_JSON_BYTES) failure('too-large', 'JSON darf höchstens 64 KiB groß sein.')
    const manifest = parseFeaturePackManifest(input.json)
    if (!digestMatches(digest(input.json), String(input.sha256 ?? ''))) failure('digest-mismatch', 'Das JSON hat sich seit der Vorschau geändert. Bitte erneut prüfen.')
    if (input.acceptTrust !== true) failure('consent-required', 'Installation oder Aktualisierung benötigt eine ausdrückliche Vertrauensbestätigung.')
    if (!Array.isArray(input.acceptedPermissions) || input.acceptedPermissions.some((permission) => permission !== FEATURE_PACK_PERMISSION) || new Set(input.acceptedPermissions).size !== input.acceptedPermissions.length) failure('consent-required', 'Berechtigungsbestätigung ist ungültig.')
    const accepted = new Set(input.acceptedPermissions)
    if (manifest.permissions.some((permission) => !accepted.has(permission)) || [...accepted].some((permission) => !manifest.permissions.includes(permission))) failure('consent-required', 'Alle angeforderten Berechtigungen müssen für diese Version ausdrücklich bestätigt werden.')
    await this.safeRoot()
    const previous = await this.read(manifest.id)
    if (previous) {
      const versionOrder = compareSemver(manifest.version, previous.manifest.version)
      if (versionOrder < 0) failure('downgrade-rejected', 'Ein Downgrade ist nicht zulässig.')
      if (versionOrder === 0) failure('version-not-newer', 'Die installierte Version ist bereits gleich oder neuer.')
    } else if ((await this.list()).length >= MAX_INSTALLED_PACKS) {
      failure('pack-limit', `Es können höchstens ${MAX_INSTALLED_PACKS} Packs installiert sein.`)
    }
    const checked: StoredPack['checked'] = {}
    for (const widget of manifest.widgets) {
      if (widget.type !== 'checklist') continue
      const old = previous?.checked[widget.id] ?? {}
      checked[widget.id] = Object.fromEntries(widget.items.filter((item) => old[item.id] !== undefined).map((item) => [item.id, old[item.id]]))
    }
    const stored = { manifest, enabled: previous?.enabled ?? true, checked }
    await this.write(manifest.id, stored)
    return this.toInstalled(stored)
  }
  private toInstalled(pack: StoredPack): FeaturePackInstalled {
    return { id: pack.manifest.id, name: pack.manifest.name, version: pack.manifest.version, enabled: pack.enabled, permissions: [...pack.manifest.permissions], widgets: pack.manifest.widgets }
  }
  async list(): Promise<FeaturePackInstalled[]> {
    await this.safeRoot()
    const { readdir } = await import('node:fs/promises')
    const names = await readdir(this.root)
    if (names.filter((name) => !name.startsWith('.')).length > MAX_INSTALLED_PACKS) failure('pack-limit', `Es können höchstens ${MAX_INSTALLED_PACKS} Packs installiert sein.`)
    const result: FeaturePackInstalled[] = []
    for (const name of names) {
      if (name.startsWith('.')) continue
      if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\.json$/.test(name)) failure('unsafe-path', 'Unbekannte Datei im Pack-Ordner.')
      const pack = await this.read(name.slice(0, -5))
      if (pack) result.push(this.toInstalled(pack))
    }
    return result.sort((a, b) => a.name.localeCompare(b.name))
  }
  setEnabled(id: string, enabled: boolean): Promise<FeaturePackInstalled> {
    return this.serialize(async () => {
    if (typeof enabled !== 'boolean') failure('invalid-input', 'Aktivierungsstatus muss boolesch sein.')
    await this.safeRoot(); const pack = await this.read(id)
    if (!pack) failure('not-found', 'Feature-Pack nicht gefunden.')
    pack.enabled = enabled; await this.write(id, pack); return this.toInstalled(pack)
    })
  }
  remove(id: string): Promise<void> {
    return this.serialize(async () => {
    await this.safeRoot(); const path = this.file(id)
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (!stat) return
    if (stat.isSymbolicLink() || !stat.isFile()) failure('unsafe-path', 'Pack-Zieldatei ist kein regulärer Datensatz.')
    await unlink(path)
    })
  }
  async widgets(): Promise<FeaturePackWidgetView[]> {
    await this.safeRoot()
    const views: FeaturePackWidgetView[] = []
    for (const pack of await this.list()) {
      if (!pack.enabled) continue
      const saved = await this.read(pack.id)
      if (!saved) continue
      for (const widget of pack.widgets) views.push({ packId: pack.id, packName: pack.name, widget, ...(widget.type === 'checklist' ? { checked: { ...saved.checked[widget.id] } } : {}) })
    }
    return views
  }
  toggle(input: { packId: string; widgetId: string; itemId: string; checked: boolean }): Promise<FeaturePackWidgetView[]> {
    return this.serialize(async () => {
    if (typeof input?.checked !== 'boolean') failure('invalid-input', 'Checklistenstatus muss boolesch sein.')
    await this.safeRoot(); const pack = await this.read(input.packId)
    if (!pack) failure('not-found', 'Feature-Pack nicht gefunden.')
    if (!pack.enabled) failure('pack-disabled', 'Deaktivierte Packs können nicht geändert werden.')
    if (!pack.manifest.permissions.includes(FEATURE_PACK_PERMISSION)) failure('permission-denied', 'Pack besitzt keine Berechtigung für lokale Checkzustände.')
    const widget = pack.manifest.widgets.find((candidate) => candidate.id === input.widgetId && candidate.type === 'checklist')
    if (!widget || widget.type !== 'checklist' || !widget.items.some((item) => item.id === input.itemId)) failure('invalid-widget-state', 'Unbekanntes Checklisten-Widget oder unbekannter Eintrag.')
    pack.checked[widget.id] ??= {}
    pack.checked[widget.id][input.itemId] = input.checked
    await this.write(pack.manifest.id, pack)
    return this.widgets()
    })
  }
}
