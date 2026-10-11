import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ElevenError, explain, isDefinitiveRefusal, parseElevenError } from '@main/providers/elevenlabs'

describe('ElevenLabs-Fehler', () => {
  it('liest den Grund aus dem Rumpf', () => {
    const err = parseElevenError(
      401,
      JSON.stringify({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } })
    )
    assert.equal(err.code, 'invalid_api_key')
    assert.equal(err.detail, 'Invalid API key')
    assert.match(explain(err), /nimmt den Schlüssel nicht an/)
  })

  it('verkraftet einen Rumpf, der kein JSON ist', () => {
    const err = parseElevenError(400, '<html>Bad Request</html>')
    assert.equal(err.code, '')
    assert.match(explain(err), /400/)
  })

  it('hält einen falschen Schlüssel für endgültig', () => {
    assert.ok(isDefinitiveRefusal(new ElevenError(401, 'invalid_api_key', '')))
    assert.ok(isDefinitiveRefusal(new ElevenError(401, 'detected_unusual_activity', '')))
    assert.ok(isDefinitiveRefusal(new Error('kein-schluessel')))
  })

  it('erkennt eine Schlüssel-Kennung statt des Schlüssels', () => {
    const err = parseElevenError(400, JSON.stringify({ detail: { status: 'api_key_id_used_as_api_key', message: 'API key ID used as API key' } }))
    assert.match(explain(err), /sk_/)
    assert.ok(isDefinitiveRefusal(err))
  })

  it('lässt sprechen, wenn nur eine Berechtigung oder das Netz fehlt', () => {
    assert.ok(!isDefinitiveRefusal(new ElevenError(401, 'missing_permissions', '')))
    assert.ok(!isDefinitiveRefusal(new ElevenError(500, '', '')))
    assert.ok(!isDefinitiveRefusal(new ElevenError(400, '', '')))
    assert.ok(!isDefinitiveRefusal(new Error('fetch failed')))
  })
})
