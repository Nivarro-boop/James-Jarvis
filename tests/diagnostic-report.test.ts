import { it } from 'node:test'
import assert from 'node:assert/strict'
import { diagnosticReport } from '@shared/diagnosticReport'

it('verwendet den Vier-Felder-Vertrag der JARVIS-Fehlerwebsite', () => {
  const report = diagnosticReport('1.2.15', 'win32', 2, 1)
  assert.deepEqual(Object.keys(report), ['level', 'message', 'source', 'details'])
  assert.equal(report.level, 'error')
  assert.equal(report.source, 'JARVIS')
  assert.deepEqual(JSON.parse(report.details), { appVersion: '1.2.15', platform: 'win32', problems: 2, healed: 1 })
  assert.equal(diagnosticReport('1.2.15', 'win32', 0, 0).level, 'info')
})

it('übernimmt keine zusätzlichen rohen Fehlermeldungen aus dem Diagnoseobjekt', () => {
  const dashboard = { problems: 1, healed: 0, message: 'user@example.com', details: 'sk-secret', location: 'Privatadresse' }
  const serialized = JSON.stringify(diagnosticReport('1.2.15', 'win32', dashboard.problems, dashboard.healed))
  assert.doesNotMatch(serialized, /user@example|sk-secret|Privatadresse/)
})
