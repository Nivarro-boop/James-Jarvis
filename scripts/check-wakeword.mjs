import * as ort from 'onnxruntime-web/wasm'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Exercise the shipped models rather than merely checking filenames.
ort.env.wasm.numThreads = 1
const sessions = []
try {
  const load = async name => {
    const session = await ort.InferenceSession.create(new Uint8Array(await readFile(resolve('src/renderer/public/wakeword', name))))
    sessions.push(session)
    return session
  }
  const mel = await load('melspectrogram.onnx')
  const embedding = await load('embedding_model.onnx')
  const wake = await load('jarvis.onnx')
  const audio = new Float32Array(1760)
  const result = await mel.run({ [mel.inputNames[0]]: new ort.Tensor('float32', audio, [1, 1760]) })
  const frames = result[mel.outputNames[0]]
  if (frames.data.length !== 8 * 32) throw new Error(`Unexpected mel shape: ${frames.dims}`)
  const spec = new Float32Array(76 * 32).fill(2)
  const features = await embedding.run({ [embedding.inputNames[0]]: new ort.Tensor('float32', spec, [1, 76, 32, 1]) })
  const vector = features[embedding.outputNames[0]].data
  if (vector.length !== 96 || !Array.from(vector).every(Number.isFinite)) throw new Error('Invalid embedding')
  const input = new Float32Array(16 * 96)
  for (let i = 0; i < 16; i++) input.set(vector, i * 96)
  const prediction = await wake.run({ [wake.inputNames[0]]: new ort.Tensor('float32', input, [1, 16, 96]) })
  const score = prediction[wake.outputNames[0]].data[0]
  if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error('Invalid classifier score')
  console.log(JSON.stringify({ melFrames: 8, embeddingDimensions: 96, classifier: 'Hey Jarvis', score, passed: true }))
} finally {
  for (const session of sessions) await session.release()
}
