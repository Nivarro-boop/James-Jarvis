import assert from 'node:assert/strict'
import { it } from 'node:test'
import { withModelBudget, consumeModelCall, SAVER_MODEL_CALLS } from '../src/main/agent/modelBudget'
import { modelUsageReport, recordModelUsage } from '../src/main/agent/modelUsage'
import { needsGeminiForVoice } from '../src/shared/startupRequirements'
import { DEFAULT_SETTINGS } from '../src/shared/config/defaults'

it('teilt das Budget über verschachtelte Werkzeuge und weitere Aufrufe derselben Frage', async () => {
  await withModelBudget('budget-regression', true, async () => {
    for (let i = 0; i < SAVER_MODEL_CALLS - 1; i++) consumeModelCall()
    await withModelBudget('nested-worker', true, async () => { await Promise.resolve(); consumeModelCall() })
  })
  assert.throws(() => withModelBudget('budget-regression', true, consumeModelCall), /Sparlimit/)
  assert.doesNotThrow(() => withModelBudget('next-question', true, consumeModelCall))
  withModelBudget('disabled-saving', false, () => { for (let i = 0; i < 50; i++) consumeModelCall() })
})

it('unterscheidet unbekannten Verbrauch von tatsächlich gemeldeten null Token', () => {
  recordModelUsage('test', undefined, 100, null)
  assert.equal(modelUsageReport().totalTokens, null)
  recordModelUsage('test', { total_tokens: 0, input_tokens: 0, output_tokens: 0 }, 200, 20)
  assert.equal(modelUsageReport().totalTokens, 0)
  assert.equal(modelUsageReport().knownCalls, 1)
  recordModelUsage('test', { total_tokens: 130, input_tokens: 100, output_tokens: 30,
    input_tokens_details: { cached_tokens: 80 }, output_tokens_details: { reasoning_tokens: 10 } }, 200, 20)
  assert.equal(modelUsageReport().inputTokens, 100)
  assert.equal(modelUsageReport().outputTokens, 30)
  assert.equal(modelUsageReport().cachedTokens, 80)
  assert.equal(modelUsageReport().reasoningTokens, 10)
  for (let i = 0; i < 110; i++) recordModelUsage('test', undefined, 100, null)
  assert.equal(modelUsageReport().calls, 100)
})

it('verlangt Gemini beim Start nur für die gewählte Sprachpipeline', () => {
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.speech.provider = 'openai'
  assert.equal(needsGeminiForVoice(settings), false)
  settings.speech.provider = 'gemini'
  assert.equal(needsGeminiForVoice(settings), true)
})
