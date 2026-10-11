import { it } from 'node:test'
import assert from 'node:assert/strict'
import { sendDiagnosticReport } from '../src/main/providers/diagnosticSender'
import { diagnosticReport } from '@shared/diagnosticReport'

const config = { enabled: true, url: 'https://reports.example/api/error-report' }
const report = diagnosticReport('1.2.16', 'win32', 1, 0)

it('sendet den Token nur im Header und den anonymisierten Vier-Felder-Bericht im Body', async () => {
  const request: typeof fetch = async (url, options) => {
    assert.equal(String(url), config.url)
    assert.equal(options?.redirect, 'error')
    assert.equal(options?.method, 'POST')
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer test-secret')
    assert.deepEqual(JSON.parse(String(options?.body)), report)
    assert.ok(options?.signal)
    assert.doesNotMatch(String(options?.body), /test-secret/)
    return new Response('{}', { status: 201 })
  }
  assert.equal((await sendDiagnosticReport(config, ' test-secret ', report, request)).ok, true)
})

it('sendet deaktivierte oder ungültige Empfänger nicht an das Netzwerk', async () => {
  const request: typeof fetch = async () => { assert.fail('Netzwerk darf nicht aufgerufen werden') }
  assert.equal((await sendDiagnosticReport({ ...config, enabled: false }, 'secret', report, request)).ok, false)
  for (const url of ['http://reports.example', 'https://user:pass@reports.example', 'https://reports.example/#fragment', 'invalid']) {
    assert.equal((await sendDiagnosticReport({ ...config, url }, 'secret', report, request)).ok, false)
  }
})

it('lässt bei ungeschütztem Server den Authorization-Header weg', async () => {
  const request: typeof fetch = async (_url, options) => {
    assert.equal(new Headers(options?.headers).has('Authorization'), false)
    return new Response('{}', { status: 201 })
  }
  assert.equal((await sendDiagnosticReport(config, null, report, request)).ok, true)
})

it('erklärt API-, Zugangs-, Kontingent- und Speicherfehler ohne Servertext zu übernehmen', async () => {
  for (const [status, pattern] of [[404, /API-Route fehlt/], [401, /Token/], [403, /Token/], [429, /später/], [503, /Speicher/]] as const) {
    const result = await sendDiagnosticReport(config, null, report, async () => new Response('private-server-secret', { status }))
    assert.equal(result.ok, false)
    assert.match(result.detail, pattern)
    assert.doesNotMatch(result.detail, /private-server-secret/)
  }
})

it('behandelt Netzwerkfehler ohne interne Fehlermeldungen offenzulegen', async () => {
  const result = await sendDiagnosticReport(config, null, report, async () => { throw new Error('private-token') })
  assert.equal(result.ok, false)
  assert.match(result.detail, /10 Sekunden/)
  assert.doesNotMatch(result.detail, /private-token/)
})
