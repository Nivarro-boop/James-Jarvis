import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registerRemedy, retryOpenIncidents } from '@main/selfheal'
import { closeDb, initDb, insertIncident, openIncidents } from '@main/db'

describe('Reparieren von Hand', () => {
  const dir = mkdtempSync(join(tmpdir(), 'void-jarvis-retry-'))
  const previousTemp = process.env.TEMP
  process.env.TEMP = dir
  initDb()
  after(() => {
    closeDb()
    process.env.TEMP = previousTemp
    rmSync(dir, { recursive: true, force: true })
  })

  it('versucht ausgesetzte Gegenmittel trotz Stundengrenze erneut', async () => {
    let tried = 0
    registerRemedy({
      name: 'test-mittel',
      maxPerHour: 0,
      applies: (i) => i.code === 'test-stoerung',
      apply: async () => (++tried, true),
      describe: () => 'test'
    })
    insertIncident({
      area: 'system',
      code: 'test-stoerung',
      fingerprint: 'system:test-stoerung',
      message: 'kaputt',
      context: null,
      remedy: 'test-mittel (ausgesetzt)',
      healed: false
    })
    await retryOpenIncidents()
    assert.equal(tried, 1)
    assert.equal(openIncidents(0).some((i) => i.code === 'test-stoerung'), false)
  })
})
