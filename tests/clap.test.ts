import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ClapDetector } from '@shared/audio/clap'

const RATE = 16
function silence(ms: number): Int16Array {
  const a = new Int16Array(ms * RATE)
  for (let i = 0; i < a.length; i++) a[i] = Math.round((Math.random() - 0.5) * 200)
  return a
}
function loud(ms: number): Int16Array {
  const a = new Int16Array(ms * RATE)
  for (let i = 0; i < a.length; i++) a[i] = (i % 2 ? 1 : -1) * 20000
  return a
}
function run(parts: Int16Array[]): number {
  let hits = 0
  const d = new ClapDetector(() => hits++)
  for (const p of parts) d.feed(p)
  return hits
}

describe('ClapDetector', () => {
  it('erkennt kurze leise Impulse auch bei niedriger Mikrofonverstärkung', () => {
    const impulse = new Int16Array(160)
    for (let i = 0; i < 4; i++) impulse[10 + i] = i % 2 ? 6500 : -6500
    assert.equal(run([silence(100), impulse, silence(250), impulse, silence(300)]), 1)
  })
  it('setzt beim Schlafen auch die Sperrzeit zurück', () => {
    let hits = 0
    const detector = new ClapDetector(() => hits++)
    const pair = [silence(100), loud(30), silence(250), loud(30), silence(300)]
    pair.forEach(p => detector.feed(p))
    detector.reset()
    pair.forEach(p => detector.feed(p))
    assert.equal(hits, 2)
  })
  it('erkennt zweimal Klatschen', () => {
    assert.equal(run([silence(500), loud(30), silence(300), loud(30), silence(300)]), 1)
  })
  it('ignoriert ein einzelnes Klatschen', () => {
    assert.equal(run([silence(500), loud(30), silence(1500)]), 0)
  })
  it('ignoriert lange laute Geräusche', () => {
    assert.equal(run([silence(500), loud(600), silence(200), loud(600), silence(300)]), 0)
  })
  it('ignoriert zu weit auseinanderliegende Klatscher', () => {
    assert.equal(run([silence(500), loud(30), silence(1200), loud(30), silence(300)]), 0)
  })
})
