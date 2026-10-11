import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { smoothPcmBoundary } from '@shared/pcm'

describe('VibeVoice-Audioübergänge', () => {
  it('blendet einen Sprung kurz statt ihn als Knackser durchzureichen', () => {
    const source = Int16Array.from([10_000, 10_000, 10_000, 10_000])
    const result = smoothPcmBoundary(source, -10_000, 4)

    assert.deepEqual([...result.pcm], [-5_000, 0, 5_000, 10_000])
    assert.equal(result.last, 10_000)
  })

  it('verändert nach der kurzen Blende den restlichen Ton nicht', () => {
    const source = Int16Array.from([100, 200, 300, 400, 500])
    const result = smoothPcmBoundary(source, 0, 2)
    assert.deepEqual([...result.pcm], [50, 200, 300, 400, 500])
  })

  it('behält bei einem leeren Block den vorigen Endwert', () => {
    const result = smoothPcmBoundary(new Int16Array(0), 1234)
    assert.equal(result.pcm.length, 0)
    assert.equal(result.last, 1234)
  })
})
