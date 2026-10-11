import assert from 'node:assert/strict'
import { it } from 'node:test'
import { realtimeAccess } from '../src/main/providers/realtimeAccess'

it('prüft Realtime selbst und gibt nur den kurzlebigen Zugang zurück', async () => {
  let payload: any
  const result = await realtimeAccess(' sk-test ', 'gpt-realtime', (async (_url: unknown, init: RequestInit) => {
    payload = JSON.parse(String(init.body))
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer sk-test')
    return new Response(JSON.stringify({ value: 'ek-short' }))
  }) as typeof fetch)
  assert.deepEqual(result, { ok: true, value: 'ek-short' })
  assert.equal(payload.session.type, 'realtime')
  assert.equal(payload.session.model, 'gpt-realtime')
})

it('zeigt Guthaben- und Modellprobleme ohne rohe Anbieterantwort oder Schlüssel', async () => {
  for (const [status, code, expected] of [[429, 'insufficient_quota', /Guthaben/], [404, 'model_not_found', /Modell/], [401, 'invalid_api_key', /abgelehnt/]] as const) {
    const result = await realtimeAccess('sk-secret', 'test-model', (async () => new Response(JSON.stringify({ error: { code, message: 'sk-secret' } }), { status })) as typeof fetch)
    assert.equal(result.ok, false)
    if (!result.ok) { assert.match(result.error, expected); assert.doesNotMatch(result.error, /sk-secret/) }
  }
})

it('ruft bei fehlenden oder ungültigen Schlüsseln keinen Anbieter auf', async () => {
  const request = (async () => { throw new Error('Unexpected request') }) as typeof fetch
  assert.equal((await realtimeAccess(null, 'model', request)).ok, false)
  const result = await realtimeAccess('sk-\u200bkey', 'model', request)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /unsichtbare/)
})
