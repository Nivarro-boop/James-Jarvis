import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { build } from 'esbuild'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

async function fixture(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const events: { channel: string; payload: any }[] = []
  const pending: (() => void)[] = []
  let failRename = false
  const bundle = await build({
    stdin: { contents: `export * from './src/main/agent/workingContext'; export * from './src/main/agent/activity'`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', logLevel: 'silent', alias: { '@shared': resolve('src/shared') },
    plugins: [{ name: 'context-fixture', setup(b) {
      const fixtures: Record<string, string> = {
        electron: 'export const app = { getPath: () => "/context-fixture" }',
        'node:fs': 'export const {mkdirSync, readFileSync, renameSync, writeFileSync} = fixtureFS',
        '../ipc/emit': 'export const broadcast = (channel, payload) => events.push({channel, payload})'
      }
      b.onResolve({ filter: /.*/ }, args => args.path in fixtures ? { path: args.path, namespace: 'fixture' } : undefined)
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: fixtures[args.path] }))
    } }]
  })
  const key = (path: string): string => path.replaceAll('\\', '/').split('/').at(-1)!
  const module = { exports: {} as any }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, structuredClone,
    require: (name: string) => {
      if (name === 'node:path') return { join: (...parts: string[]) => parts.join('/') }
      throw new Error(`Unexpected dependency: ${name}`)
    },
    events, setTimeout: (callback: () => void) => { pending.push(callback); return pending.length },
    fixtureFS: {
      mkdirSync() {},
      readFileSync(path: string) { if (!files.has(key(path))) throw new Error('ENOENT'); return files.get(key(path)) },
      writeFileSync(path: string, value: string) { files.set(key(path), value) },
      renameSync(from: string, to: string) {
        if (failRename) throw new Error('rename failed')
        files.set(key(to), files.get(key(from))!); files.delete(key(from))
      }
    }
  })
  return { api: module.exports, files, events, failSave: () => { failRename = true }, flush: () => { while (pending.length) pending.shift()!() } }
}

const notes = (goal: string) => ({ goal, decisions: ['Nur lokal arbeiten'], completed: [], next: ['Datei prüfen'], blockers: [], status: 'active' })

describe('Persistenter Arbeitsstand und sichtbarer Plan', () => {
  it('behält Entscheidungen und Plan bei gleichbleibendem normalisiertem Ziel', async () => {
    const { api } = await fixture()
    api.checkpoint(notes('Projekt'))
    api.setPlan('  Projekt  ', [{ text: 'Datei prüfen', status: 'offen' }])
    assert.deepEqual(api.workingContext().decisions, ['Nur lokal arbeiten'])
    api.checkpoint(notes('  Projekt  '))
    assert.equal(api.currentPlan().title, 'Projekt')
    assert.equal(api.activitySnapshot().plan.title, 'Projekt')
  })

  it('entfernt einen alten Plan bei Zielkorrekturen sofort auch aus der Aktivitätsanzeige', async () => {
    const { api, events, flush } = await fixture()
    api.setPlan('Altes Ziel', [{ text: 'Alte Aktion', status: 'läuft' }])
    flush(); events.length = 0
    api.checkpoint(notes('Korrigiertes Ziel'))
    assert.equal(api.workingContext().goal, 'Korrigiertes Ziel')
    assert.equal(api.currentPlan(), null)
    assert.equal(api.activitySnapshot().plan, null)
    flush()
    assert.ok(events.some(e => e.channel === 'activity:update' && e.payload.plan === null))
    api.setPlan('Korrigiertes Ziel', [{ text: 'Prüfen', status: 'offen' }])
    api.clearWorkingContext()
    assert.equal(api.currentPlan(), null)
    assert.equal(api.activitySnapshot().plan, null)
  })

  it('gibt normalisierte Kopien zurück und verhindert stille Zustandsänderungen durch Aufrufer', async () => {
    const { api, files } = await fixture()
    const steps = Array.from({ length: 23 }, (_, i) => ({ text: `Schritt ${i}`, status: 'offen' }))
    const returned = api.setPlan('  Projekt  ', steps)
    assert.equal(returned.steps.length, 20)
    steps[0].text = 'Von außen verändert'
    returned.steps[0].status = 'erledigt'
    const snapshot = api.activitySnapshot()
    snapshot.plan.steps[0].text = 'Im Snapshot verändert'
    assert.equal(api.currentPlan().steps[0].text, 'Schritt 0')
    assert.equal(api.currentPlan().steps[0].status, 'offen')
    assert.deepEqual(api.currentPlan(), JSON.parse(files.get('working-context.json')!).plan)
    api.activityStart({ id: 'one', label: 'Prüfen', source: 'jarvis' })
    api.activitySnapshot().items[0].status = 'ok'
    assert.equal(api.activitySnapshot().items[0].status, 'running')
    assert.throws(() => api.setPlan(' ', [{ text: ' ', status: 'offen' }]), /gültigen Schritt/)
    assert.equal(api.currentPlan().title, 'Projekt')
  })

  it('stellt einen vollständig geschriebenen Zwischenstand nach unterbrochenem Speichern pausiert wieder her', async () => {
    const saved = JSON.stringify({ ...notes('Wiederaufnehmen'), plan: { title: 'Wiederaufnehmen', steps: [{ text: 'Datei prüfen', status: 'läuft' }] } })
    const interrupted: Record<string, string>[] = [{ 'working-context.json.tmp': saved }, { 'working-context.json': '{broken', 'working-context.json.tmp': saved }, { 'working-context.json': '{"goal":null}', 'working-context.json.tmp': saved }]
    for (const initial of interrupted) {
      const { api, events } = await fixture(initial)
      const restored = api.workingContext()
      assert.equal(restored.goal, 'Wiederaufnehmen')
      assert.equal(restored.status, 'paused')
      assert.equal(restored.plan.steps[0].status, 'offen')
      assert.deepEqual(events, [])
    }
  })

  it('behält bei einem Schreibfehler den bestätigten Stand und bevorzugt ihn beim Neustart', async () => {
    const f = await fixture()
    f.api.checkpoint(notes('Bestätigtes Ziel'))
    f.flush(); f.events.length = 0
    f.failSave()
    assert.throws(() => f.api.checkpoint(notes('Nicht gespeichert')), /rename failed/)
    assert.equal(f.api.workingContext().goal, 'Bestätigtes Ziel')
    assert.deepEqual(f.events, [])
    const restored = await fixture(Object.fromEntries(f.files))
    assert.equal(restored.api.workingContext().goal, 'Bestätigtes Ziel')
    assert.equal(restored.api.workingContext().status, 'paused')
  })
})
