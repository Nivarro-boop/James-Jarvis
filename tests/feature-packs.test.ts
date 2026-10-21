import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareSemver, FeaturePackValidationError, parseFeaturePackManifest } from '../src/shared/featurePacks'
import { FeaturePackService } from '../src/main/packs/service'

const tempDirs: string[] = []
async function service(): Promise<FeaturePackService> {
  const dir = await mkdtemp(join(tmpdir(), 'jj-feature-packs-'))
  tempDirs.push(dir)
  return new FeaturePackService(dir)
}
function manifest(version = '1.0.0', checklist = false): string {
  const widgets = checklist
    ? [{ id: 'tasks', type: 'checklist', title: 'Aufgaben', items: [{ id: 'one', text: 'Erster Punkt' }, { id: 'two', text: 'Zweiter Punkt' }] }]
    : [{ id: 'note', type: 'note', title: 'Hinweis', text: 'Nur eine lokale statische Notiz.' }]
  return JSON.stringify({ format: 'jarvis-feature-pack', schemaVersion: 1, id: 'test-pack', name: 'Test Pack', version, permissions: checklist ? ['local-widget-state'] : [], widgets })
}
function digest(json: string): string { return require('node:crypto').createHash('sha256').update(json).digest('hex') }
async function install(s: FeaturePackService, json: string, consent = true, acceptedPermissions: ('local-widget-state')[] = []): Promise<unknown> {
  return s.install({ json, sha256: digest(json), acceptTrust: consent, acceptedPermissions })
}
async function rejectsCode(run: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => error instanceof FeaturePackValidationError && error.code === code)
}
afterEach(async () => { await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

describe('declarative feature packs', () => {
  it('validates schema, size, field limits, IDs, duplicate IDs/keys, and forbids executable/remote fields', () => {
    const good = manifest()
    assert.equal(parseFeaturePackManifest(good).id, 'test-pack')
    assert.throws(() => parseFeaturePackManifest(good.replace('"schemaVersion":1', '"schemaVersion":2')), /Schema-Version/)
    assert.throws(() => parseFeaturePackManifest(good.replace('"text":"Nur eine lokale statische Notiz."', '"text":"<script>x</script>"')), /Markup/)
    assert.throws(() => parseFeaturePackManifest(good.replace('"text":"Nur eine lokale statische Notiz."', '"text":"https://example.org"')), /URL/)
    assert.throws(() => parseFeaturePackManifest(good.replace('"widgets":[', '"widgets":[{"id":"x","type":"note","title":"A","text":"B","script":"alert(1)"},')), /unbekannte Felder/)
    assert.throws(() => parseFeaturePackManifest(good.replace('"schemaVersion":1,', '"schemaVersion":1,"schemaVersion":1,')), (e: unknown) => e instanceof FeaturePackValidationError && e.code === 'duplicate-field')
    const duplicatedWidgets = JSON.parse(good) as { widgets: Array<Record<string, unknown>> }
    duplicatedWidgets.widgets.push({ ...duplicatedWidgets.widgets[0] })
    assert.throws(() => parseFeaturePackManifest(JSON.stringify({ ...JSON.parse(good), widgets: duplicatedWidgets.widgets })), /Doppelte Widget-ID/)
    assert.throws(() => parseFeaturePackManifest(good.replace('"id":"test-pack"', '"id":"constructor"')), /sichere ID/)
    assert.throws(() => parseFeaturePackManifest(' '.repeat(65537)), /64 KiB/)
  })
  it('only accepts local-widget-state for a checklist and rejects unknown/executable permissions', () => {
    assert.throws(() => parseFeaturePackManifest(manifest().replace('"permissions":[]', '"permissions":["network"]')), (e: unknown) => e instanceof FeaturePackValidationError && e.code === 'unknown-permission')
    assert.throws(() => parseFeaturePackManifest(manifest().replace('"permissions":[]', '"permissions":["execute"]')), /Nicht unterstützte Berechtigung/)
    assert.throws(() => parseFeaturePackManifest(manifest().replace('"permissions":[]', '"permissions":["local-widget-state"]')), /reine Notizen benötigen keine Berechtigung/)
    assert.throws(() => parseFeaturePackManifest(manifest('1.0.0', true).replace('"local-widget-state"', '"local-widget-state","local-widget-state"')), /Doppelte Berechtigung/)
  })
  it('compares SemVer prereleases, build metadata, and arbitrarily large numeric components', () => {
    assert.equal(compareSemver('1.2.3+build.5', '1.2.3+build.99'), 0)
    assert.equal(compareSemver('1.2.3-alpha.10', '1.2.3-alpha.9'), 1)
    assert.equal(compareSemver('1.2.3-alpha', '1.2.3'), -1)
    assert.equal(compareSemver('999999999999999999999999999999999.0.0', '999999999999999999999999999999998.9.9'), 1)
    assert.equal(compareSemver('1.0.0-alpha.9999999999999999999999', '1.0.0-alpha.9999999999999999999998'), 1)
    assert.throws(() => compareSemver('01.0.0', '1.0.0'), /SemVer/)
  })
  it('requires explicit consent on each install/update, binds install to preview digest, and rejects downgrade', async () => {
    const store = await service(), v1 = manifest()
    const preview = await store.preview(v1)
    await rejectsCode(() => store.install({ json: v1, sha256: preview.sha256, acceptTrust: false, acceptedPermissions: [] }), 'consent-required')
    await rejectsCode(() => store.install({ json: v1 + ' ', sha256: preview.sha256, acceptTrust: true, acceptedPermissions: [] }), 'digest-mismatch')
    await install(store, v1)
    const v2 = manifest('2.0.0')
    await rejectsCode(() => install(store, v2, false), 'consent-required')
    await install(store, v2)
    await rejectsCode(() => install(store, manifest('1.9.9')), 'downgrade-rejected')
    await rejectsCode(() => install(store, manifest('2.0.0')), 'version-not-newer')
  })
  it('requires new permission consent on update and persists only that pack checklist state atomically', async () => {
    const store = await service()
    await install(store, manifest())
    const checklist = manifest('2.0.0', true)
    await rejectsCode(() => install(store, checklist), 'consent-required')
    await install(store, checklist, true, ['local-widget-state'])
    const state = await store.toggle({ packId: 'test-pack', widgetId: 'tasks', itemId: 'one', checked: true })
    assert.equal(state[0]?.checked?.one, true)
    assert.equal(state[0]?.checked?.two, undefined)
    const reopened = new FeaturePackService(tempDirs[tempDirs.length - 1])
    const persisted = await reopened.widgets()
    assert.equal(persisted[0]?.checked?.one, true)
    await rejectsCode(() => reopened.toggle({ packId: 'test-pack', widgetId: 'tasks', itemId: 'unknown', checked: true }), 'invalid-widget-state')
    const disabled = await reopened.setEnabled('test-pack', false)
    assert.equal(disabled.enabled, false)
    await rejectsCode(() => reopened.toggle({ packId: 'test-pack', widgetId: 'tasks', itemId: 'one', checked: false }), 'pack-disabled')
    await reopened.remove('test-pack')
    assert.deepEqual(await reopened.list(), [])
  })
  it('serializes concurrent update, remove-adjacent, and checklist mutations across service instances', async () => {
    const store = await service()
    const root = tempDirs[tempDirs.length - 1]
    const secondInstance = new FeaturePackService(root)
    await install(store, manifest())
    await Promise.all([install(store, manifest('2.0.0')), install(secondInstance, manifest('3.0.0'))])
    assert.equal((await secondInstance.list())[0]?.version, '3.0.0')
    const list = manifest('4.0.0', true)
    await install(secondInstance, list, true, ['local-widget-state'])
    await Promise.all([
      store.toggle({ packId: 'test-pack', widgetId: 'tasks', itemId: 'one', checked: true }),
      secondInstance.toggle({ packId: 'test-pack', widgetId: 'tasks', itemId: 'two', checked: true })
    ])
    const state = await store.widgets()
    assert.equal(state[0]?.checked?.one, true)
    assert.equal(state[0]?.checked?.two, true)
  })
  it('rejects symlink pack records rather than following them', async () => {
    const store = await service()
    await install(store, manifest())
    const root = join(tempDirs[tempDirs.length - 1], 'feature-packs')
    const source = join(root, 'test-pack.json'), target = join(tempDirs[tempDirs.length - 1], 'outside.json')
    const { rename } = await import('node:fs/promises')
    await rename(source, target)
    await symlink(target, source)
    await rejectsCode(() => store.list(), 'unsafe-path')
  })
})
