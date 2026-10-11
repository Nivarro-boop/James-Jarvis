import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { app } from 'electron'
import { build } from 'esbuild'
import { readWakeAsset } from '@main/providers/wakeStatus'
import { report } from '@main/selfheal'
import { registerAllRemedies } from '@main/selfheal/remedies'
import { closeDb, initDb } from '@main/db'
import { getSettings, setSettings } from '@main/store/settings'

/** Das Weckwort-Modul so gebaut wie in wake-pipeline.test.ts, mit Fenster- und Konsolenersatz. */
async function loadWakeModule(window: any, log: Record<'info' | 'warn' | 'error', unknown[][]>, location?: object) {
  const bundle = await build({
    entryPoints: [resolve('src/renderer/wake/wakeword.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
    plugins: [
      {
        name: 'wake-models',
        setup(b) {
          b.onResolve({ filter: /onnxruntime-web/ }, (args) => ({
            path: args.path.endsWith('?url') ? 'asset' : 'runtime',
            namespace: 'test'
          }))
          b.onLoad({ filter: /.*/, namespace: 'test' }, (args) => ({
            loader: 'js',
            contents:
              args.path === 'asset'
                ? 'export default "fake.wasm"'
                : `
              export const env = window.ortEnv;
              export class Tensor { constructor(type,data,dims){this.data=data;this.dims=dims;} }
              export const InferenceSession = {create: async (source) => window.session(source)};
            `
          }))
        }
      }
    ]
  })
  const module = { exports: {} as any }
  const console = {
    info: (...args: unknown[]) => log.info.push(args),
    warn: (...args: unknown[]) => log.warn.push(args),
    error: (...args: unknown[]) => log.error.push(args)
  }
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    window,
    location,
    console,
    Float32Array,
    Int16Array,
    Date
  })
  return module.exports as { createWakeWord(opts: any): Promise<any> }
}

/** Die reinen Hilfen aus assets.ts, einzeln gebaut: Das Hauptprozess-Projekt kennt src/renderer nicht. */
async function loadAssets(): Promise<any> {
  const bundle = await build({
    entryPoints: [resolve('src/renderer/wake/assets.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
  const module = { exports: {} as any }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports })
  return module.exports
}

const newLog = () => ({ info: [] as unknown[][], warn: [] as unknown[][], error: [] as unknown[][] })

/** Fenster, das auf `wake:status`/`wake:asset` antwortet und jede Quelle der Sitzungen festhält. */
function fakeWindow(status: object, opts: { failOn?: string; run?: (path: string) => Promise<unknown> } = {}) {
  const created: Array<{ kind: 'url' | 'bytes'; name: string }> = []
  const assetCalls: string[] = []
  const window = {
    ortEnv: { wasm: {} as any },
    jarvis: {
      invoke: async (channel: string, payload?: { name: string }): Promise<object | null> => {
        if (channel === 'wake:status') return status
        assetCalls.push(payload!.name)
        return new Uint8Array(Buffer.from(payload!.name))
      }
    },
    session: async (source: string | Uint8Array) => {
      const kind = typeof source === 'string' ? 'url' : 'bytes'
      const name = typeof source === 'string' ? source : Buffer.from(source).toString()
      if (opts.failOn && name.includes(opts.failOn)) {
        throw Object.assign(new Error('Failed to fetch'), { name: 'TypeError' })
      }
      created.push({ kind, name })
      return {
        inputNames: ['input'],
        outputNames: ['output'],
        release: async () => {},
        run: async () => {
          if (opts.run) return opts.run(name)
          return { output: { data: new Float32Array(256) } }
        }
      }
    }
  }
  return { window, created, assetCalls }
}

describe('Weckwort: Dateien lesen (Hauptprozess)', () => {
  it('liefert Modelle als Bytes und weist Pfade, fremde Endungen und Fehlendes ab', t => {
    const root = mkdtempSync(join(tmpdir(), 'james-wake-asset-'))
    t.mock.method(app, 'getAppPath', () => root)
    t.after(() => { assert.ok(root.startsWith(join(tmpdir(), 'james-wake-asset-'))); rmSync(root, { recursive: true, force: true }) })
    const dir = join(root, 'src', 'renderer', 'public', 'wakeword')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'jarvis.onnx'), 'modell-bytes')
    writeFileSync(join(root, 'geheim.onnx'), 'darf nicht raus')
    writeFileSync(join(dir, 'notizen.txt'), 'keine Modelldatei')

    assert.equal(Buffer.from(readWakeAsset('jarvis.onnx')!).toString(), 'modell-bytes')
    assert.equal(readWakeAsset('hey_james.onnx'), null)
    assert.equal(readWakeAsset('notizen.txt'), null)
    assert.equal(readWakeAsset('../../../../geheim.onnx'), null)
    assert.equal(readWakeAsset('..\\..\\..\\..\\geheim.onnx'), null)
    assert.equal(readWakeAsset(''), null)
  })

  it('findet die WASM-Laufzeit von onnxruntime', t => {
    t.mock.method(app, 'getAppPath', () => process.cwd())
    const wasm = readWakeAsset('runtime')
    assert.ok(wasm && wasm.byteLength > 1_000_000, 'WASM-Datei gelesen')
    assert.deepEqual(Array.from(wasm.subarray(0, 4)), [0, 0x61, 0x73, 0x6d], 'WebAssembly-Kennung')
  })
})

describe('Weckwort: Hilfen im Fenster', () => {
  it('meldet jede Zeile nur einmal, einen anderen Grund aber wieder', async () => {
    const { createOnce } = await loadAssets()
    const lines: unknown[][] = []
    const once = createOnce((level: string, ...args: unknown[]) => lines.push([level, ...args]))
    assert.equal(once('warn', '[wakeword] Modelldateien fehlen:', 'a.onnx'), true)
    assert.equal(once('warn', '[wakeword] Modelldateien fehlen:', 'a.onnx'), false)
    assert.equal(once('warn', '[wakeword] Modelldateien fehlen:', 'b.onnx'), true)
    assert.equal(once('info', '[wakeword] Modelldateien fehlen:', 'a.onnx'), true)
    assert.equal(lines.length, 3)
  })

  it('nimmt im file://-Fenster Bytes statt einer Adresse und benennt fehlende Dateien', async () => {
    const { hasBytes, modelSource } = await loadAssets()
    const read = async (name: string) => (name === 'da.onnx' ? new Uint8Array([1, 2, 3]) : null)
    assert.equal(await modelSource('da.onnx', './wakeword/da.onnx', { fromFile: false, read }), './wakeword/da.onnx')
    const bytes = await modelSource('da.onnx', './wakeword/da.onnx', { fromFile: true, read })
    assert.deepEqual(Array.from(bytes as Uint8Array), [1, 2, 3])
    await assert.rejects(modelSource('weg.onnx', './wakeword/weg.onnx', { fromFile: true, read }), /weg\.onnx ist im Programmordner nicht lesbar/)
    assert.equal(hasBytes(new Uint8Array(0)), false)
    assert.equal(hasBytes(null), false)
    assert.equal(hasBytes({ byteLength: 3 }), false)
  })

  it('schreibt den Fehlertyp mit', async () => {
    const { errorText } = await loadAssets()
    assert.equal(errorText(Object.assign(new Error('Failed to fetch'), { name: 'TypeError' })), 'TypeError: Failed to fetch')
    assert.equal(errorText(new Error('kaputt')), 'kaputt')
    assert.equal(errorText('Text'), 'Text')
  })
})

describe('Weckwort: Fehlschläge sind leise genug', () => {
  it('fehlendes Modell bei eingeschaltetem Weckwort: eine Warnung, auch beim zweiten Bauen', async () => {
    const log = newLog()
    const { window } = fakeWindow({ installed: false, missing: ['hey_james.onnx'], model: 'hey_james.onnx' })
    const wake = await loadWakeModule(window, log)
    const first = await wake.createWakeWord({ threshold: 0.5, enabled: true, onDetected() {} })
    const second = await wake.createWakeWord({ threshold: 0.5, enabled: true, onDetected() {} })
    assert.equal(first.available, false)
    assert.equal(second.available, false)
    assert.equal(log.warn.length, 1)
    assert.match(String(log.warn[0]), /Modelldateien fehlen:.*hey_james\.onnx/)
    // Der Handle tut nichts und wirft nichts.
    first.feed(new Int16Array(1280))
    first.setEnabled(true)
    first.destroy()
  })

  it('fehlendes Modell bei ausgeschaltetem Weckwort: keine Warnung, nur eine Info', async () => {
    const log = newLog()
    const { window } = fakeWindow({ installed: false, missing: ['hey_james.onnx'], model: 'hey_james.onnx' })
    const wake = await loadWakeModule(window, log)
    await wake.createWakeWord({ threshold: 0.5, enabled: false, onDetected() {} })
    await wake.createWakeWord({ threshold: 0.5, enabled: false, onDetected() {} })
    assert.equal(log.warn.length, 0)
    assert.equal(log.error.length, 0)
    assert.equal(log.info.length, 1)
  })

  it('Status aus dem Hauptprozess nicht lesbar: kein Wurf, eine Warnung', async () => {
    const log = newLog()
    const { window } = fakeWindow({})
    window.jarvis.invoke = async () => { throw new Error('IPC-Aufruf nicht erlaubt.') }
    const wake = await loadWakeModule(window, log)
    const handle = await wake.createWakeWord({ threshold: 0.5, onDetected() {} })
    assert.equal(handle.available, false)
    assert.equal(log.warn.length, 1)
    assert.match(String(log.warn[0]), /IPC-Aufruf nicht erlaubt/)
  })

  it('Laden scheitert: eine Warnung mit Dateiname und Fehlertyp, nicht eine je Aufbau', async () => {
    const log = newLog()
    const { window } = fakeWindow({ installed: true, missing: [], model: 'jarvis.onnx' }, { failOn: 'embedding_model' })
    const wake = await loadWakeModule(window, log)
    const first = await wake.createWakeWord({ threshold: 0.5, enabled: true, onDetected() {} })
    await wake.createWakeWord({ threshold: 0.5, enabled: true, onDetected() {} })
    assert.equal(first.available, false)
    assert.equal(log.warn.length, 1)
    assert.match(String(log.warn[0]), /Modelle nicht geladen/)
    assert.match(String(log.warn[0]), /embedding_model\.onnx: TypeError: Failed to fetch/)
  })

  it('Erkennung scheitert wiederholt: ein Fehlerprotokoll, dann gibt sie auf', async () => {
    const log = newLog()
    let runs = 0
    const { window } = fakeWindow(
      { installed: true, missing: [], model: 'jarvis.onnx' },
      { run: async () => { runs++; throw new Error('boom') } }
    )
    const wake = await loadWakeModule(window, log)
    const handle = await wake.createWakeWord({ threshold: 0.5, enabled: true, onDetected() {} })
    assert.equal(handle.available, true)
    for (let i = 0; i < 12; i++) {
      handle.feed(new Int16Array(1280))
      for (let j = 0; j < 20; j++) await Promise.resolve()
    }
    assert.equal(log.error.length, 1)
    assert.match(String(log.error[0]), /Erkennung fehlgeschlagen:.*boom/)
    assert.equal(runs, 5, 'nach fünf Fehlern am Stück wird nicht weiter gerechnet')
  })
})

describe('Weckwort: file://-Fenster', () => {
  it('holt WASM und Modelle als Bytes über den Hauptprozess statt per fetch', async () => {
    const log = newLog()
    const { window, created, assetCalls } = fakeWindow({ installed: true, missing: [], model: 'jarvis.onnx' })
    const wake = await loadWakeModule(window, log, { protocol: 'file:' })
    const handle = await wake.createWakeWord({ threshold: 0.5, enabled: true, onDetected() {} })
    assert.equal(handle.available, true)
    assert.deepEqual(assetCalls.sort(), ['embedding_model.onnx', 'jarvis.onnx', 'melspectrogram.onnx', 'runtime'])
    assert.ok(created.length === 3 && created.every(item => item.kind === 'bytes'), 'Modelle als Bytes')
    assert.ok(window.ortEnv.wasm.wasmBinary, 'WASM-Binärdatei gesetzt')
    assert.equal(window.ortEnv.wasm.wasmPaths, undefined)
    assert.equal(log.warn.length + log.error.length, 0)
  })

  it('im Dev-Server (http) bleibt es bei Adressen', async () => {
    const log = newLog()
    const { window, created, assetCalls } = fakeWindow({ installed: true, missing: [], model: 'jarvis.onnx' })
    const wake = await loadWakeModule(window, log, { protocol: 'http:' })
    const handle = await wake.createWakeWord({ threshold: 0.5, enabled: true, onDetected() {} })
    assert.equal(handle.available, true)
    assert.deepEqual(assetCalls, [])
    assert.ok(created.every(item => item.kind === 'url' && item.name.startsWith('./wakeword/')))
    assert.equal(window.ortEnv.wasm.wasmPaths.wasm, 'fake.wasm')
    assert.equal(window.ortEnv.wasm.wasmBinary, undefined)
  })

  it('WASM-Datei im Programmordner unlesbar: eine Warnung, kein Wurf', async () => {
    const log = newLog()
    const { window } = fakeWindow({ installed: true, missing: [], model: 'jarvis.onnx' })
    const invoke = window.jarvis.invoke
    window.jarvis.invoke = async (channel: string, payload?: { name: string }): Promise<object | null> =>
      payload?.name === 'runtime' ? null : invoke(channel, payload)
    const wake = await loadWakeModule(window, log, { protocol: 'file:' })
    const handle = await wake.createWakeWord({ threshold: 0.5, enabled: true, onDetected() {} })
    assert.equal(handle.available, false)
    assert.equal(log.warn.length, 1)
    assert.match(String(log.warn[0]), /onnxruntime: WASM-Datei im Programmordner nicht lesbar/)
  })
})

describe('Weckwort: Selbstheilung', () => {
  const dir = mkdtempSync(join(tmpdir(), 'void-jarvis-wake-heal-'))
  const previousTemp = process.env.TEMP
  process.env.TEMP = dir
  initDb()
  after(() => {
    closeDb()
    process.env.TEMP = previousTemp
    rmSync(dir, { recursive: true, force: true })
  })

  it('stellt auf Klatschen um und lädt die Oberfläche nur beim ersten Mal neu', async () => {
    let reloads = 0
    registerAllRemedies({ reloadRenderer: async () => { reloads++; return true } })
    setSettings({ wake: { ...getSettings().wake, enabled: true, clap: false } })
    const incident = { area: 'live' as const, code: 'wakeword-fehler', message: '[wakeword] Modelldateien fehlen: hey_james.onnx' }

    assert.equal(await report(incident), true)
    assert.equal(getSettings().wake.enabled, false)
    assert.equal(getSettings().wake.clap, true)
    assert.equal(reloads, 1)

    // Meldet das Fenster es noch einmal (späte Zeile, zweites Fenster), ist
    // nichts mehr zu tun — und eine laufende Sitzung bleibt unberührt.
    assert.equal(await report(incident), true)
    assert.equal(reloads, 1)
  })
})

describe('Weckwort: Bytes aus der anderen Welt', () => {
  it('macht daraus ein Uint8Array des Fensters, ohne zu kopieren', async () => {
    const { asBytes } = await loadAssets()
    // `loadAssets` läuft in einem eigenen Kontext: Das Array hier stammt aus einer anderen Welt,
    // wie es beim Weg über die Brücke zwischen Preload und Seite sein kann.
    const foreign = new Uint8Array([0, 1, 2, 3, 4]).subarray(1, 4)
    const local = asBytes(foreign)
    assert.deepEqual(Array.from(local), [1, 2, 3])
    assert.equal(local.buffer, foreign.buffer)
    assert.notEqual(Object.getPrototypeOf(local), Uint8Array.prototype)
  })
})
