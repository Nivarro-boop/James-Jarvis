import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { evaluateSystem, type SystemFacts } from '@shared/systemCheck'

const GB = 1024 ** 3
const good: SystemFacts = {
  totalMemBytes: 32 * GB,
  freeMemBytes: 16 * GB,
  cpuModel: 'Test',
  cpuCores: 8,
  arch: 'x64',
  freeDiskBytes: 200 * GB,
  internetMs: 40,
  microphones: 1,
  speakers: 2
}

describe('evaluateSystem', () => {
  it('meldet einen starken PC als ok', () => {
    const r = evaluateSystem(good)
    assert.equal(r.gesamt, 'ok')
    assert.ok(r.punkte.every((p) => p.level === 'ok'))
  })

  it('nennt fehlendes Mikrofon und Internet als Problem mit Handlung', () => {
    const r = evaluateSystem({ ...good, microphones: 0, internetMs: null })
    assert.equal(r.gesamt, 'problem')
    const probs = r.punkte.filter((p) => p.level === 'problem')
    assert.deepEqual(probs.map((p) => p.id).sort(), ['internet', 'mikrofon'])
    assert.ok(probs.every((p) => p.tun))
    assert.match(r.satz, /^2 Sachen/)
  })

  it('wertet wenig RAM und knappe Platte', () => {
    const r = evaluateSystem({ ...good, totalMemBytes: 4 * GB, freeDiskBytes: 5 * GB })
    assert.equal(r.punkte.find((p) => p.id === 'ram')?.level, 'problem')
    assert.equal(r.punkte.find((p) => p.id === 'disk')?.level, 'hinweis')
  })

  it('bleibt bei unbekannten Audiogeräten beim Hinweis', () => {
    const r = evaluateSystem({ ...good, microphones: null, speakers: null })
    assert.equal(r.gesamt, 'hinweis')
  })
})
