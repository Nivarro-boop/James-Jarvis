import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildSupportReport, supportIssueUrl, supportMailto } from '@shared/supportReport'

describe('Support-Meldung', () => {
  const diag = { version: '1.3.7', platform: 'win32 10.0', arch: 'x64', healed: 2, problems: [{ area: 'Stimme', code: 'zugang-fehlt', count: 3 }] }

  it('nimmt Beschreibung und nur Kennungen der Störungen', () => {
    const r = buildSupportReport('Mikro geht nicht\nseit gestern', diag)
    assert.match(r.subject, /^James-Jarvis: Mikro geht nicht seit gestern$/)
    assert.match(r.body, /Stimme \/ zugang-fehlt \(3×\)/)
    assert.match(r.body, /Version: 1\.3\.7/)
  })

  it('lässt technische Angaben weg, wenn abgewählt', () => {
    const r = buildSupportReport('', null)
    assert.match(r.body, /noch keine Beschreibung/)
    assert.doesNotMatch(r.body, /Technische Angaben/)
  })

  it('baut mailto und Issue-Link mit kodiertem Text', () => {
    const r = buildSupportReport('a & b', diag)
    assert.ok(supportMailto(r).startsWith('mailto:?subject='))
    const u = new URL(supportIssueUrl(r))
    assert.equal(u.hostname, 'github.com')
    assert.equal(u.searchParams.get('body'), r.body)
  })
})
