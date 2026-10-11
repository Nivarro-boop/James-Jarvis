import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'

describe('Weckwort-Pipeline', () => {
  it('übergibt echte PCM-Amplituden, STFT-Überlappung und endliche Features an die Weckwortmodelle', async () => {
    const inputs: Float32Array[] = []
    let classifications = 0
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
                export const env = {wasm:{}};
                export class Tensor { constructor(type,data,dims){this.data=data;this.dims=dims;} }
                export const InferenceSession = {create: async path => window.session(path)};
              `
            }))
          }
        }
      ]
    })
    const module = { exports: {} as any }
    const window = {
      jarvis: { invoke: async () => ({ installed: true, model: 'jarvis.onnx' }) },
      session: (path: string) => ({
        inputNames: ['input'],
        outputNames: ['output'],
        release: async () => {},
        run: async ({ input }: { input: { data: Float32Array; dims: number[] } }) => {
          if (path.includes('melspectrogram')) {
            assert.deepEqual(Array.from(input.dims), [1, 1760])
            inputs.push(new Float32Array(input.data))
            return { output: { data: new Float32Array(256) } }
          }
          assert.ok(Array.from(input.data).every(Number.isFinite))
          if (path.includes('embedding')) return { output: { data: new Float32Array(96).fill(0.1) } }
          classifications++
          return { output: { data: new Float32Array([0]) } }
        }
      })
    }
    runInNewContext(bundle.outputFiles[0].text, {
      module,
      exports: module.exports,
      window,
      console,
      Float32Array,
      Int16Array,
      Date
    })
    const wake = await module.exports.createWakeWord({
      threshold: 0.5,
      onDetected: () => assert.fail('silence fired')
    })
    const settle = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve()
    }
    for (let i = 0; i < 30; i++) {
      wake.feed(new Int16Array(1280).fill(i === 0 ? 1000 : 2000))
      await settle()
    }
    assert.equal(inputs[0][0], 0)
    assert.equal(inputs[0][480], 1000)
    assert.equal(inputs[1][0], 1000)
    assert.equal(inputs[1][480], 2000)
    assert.ok(classifications > 0)
    wake.setEnabled(false)
    wake.setEnabled(true)
    wake.feed(new Int16Array(1280).fill(3000))
    await settle()
    assert.equal(inputs.at(-1)![0], 0)
    wake.destroy()
  })
})
