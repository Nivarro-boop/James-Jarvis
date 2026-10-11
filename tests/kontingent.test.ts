import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { GEMINI_TEXT_FALLBACKS, isQuotaError, quotaBackoffUntil } from '@main/providers/gemini'

describe('Gemini-Kontingent', () => {
  it('erkennt ein leeres Kontingent an der Meldung', () => {
    assert.ok(isQuotaError(new Error('got status: 429 Too Many Requests')))
    assert.ok(isQuotaError(new Error('RESOURCE_EXHAUSTED: You exceeded your current quota')))
    assert.ok(!isQuotaError(new Error('API key not valid')))
  })

  it('sperrt ein Minutenlimit für eine Minute', () => {
    const now = Date.UTC(2026, 9, 3, 14, 0, 0)
    const err = new Error('Quota exceeded for metric: generate_content_free_tier_requests, limit: 10 per minute')
    assert.equal(quotaBackoffUntil(err, now), now + 60_000)
  })

  it('sperrt ein Tageslimit bis Mitternacht in Kalifornien', () => {
    // 3. Oktober, 16 Uhr in Wien = 7 Uhr in Kalifornien (Sommerzeit, UTC−7).
    const now = Date.UTC(2026, 9, 3, 14, 0, 0)
    const err = new Error('quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier')
    assert.equal(new Date(quotaBackoffUntil(err, now)).toISOString(), '2026-10-04T07:00:00.000Z')
  })

  it('hat Ausweichmodelle ohne Doppelte', () => {
    assert.equal(new Set(GEMINI_TEXT_FALLBACKS).size, GEMINI_TEXT_FALLBACKS.length)
    assert.ok(GEMINI_TEXT_FALLBACKS.length >= 2)
  })
})
