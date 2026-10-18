import assert from 'node:assert/strict'
import { it } from 'node:test'
import { budgetCompletedHistory, budgetConversation } from '@shared/conversationBudget'

it('retains the newest user constraints and full tool pairing when text exceeds the saving budget', () => {
  const history = [
    { role: 'user', content: 'Nur lokal arbeiten. ' + 'Details '.repeat(2000) + ' Nichts hochladen.' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', content: 'Ergebnis '.repeat(2000), tool_call_id: 'call-1' },
    { role: 'assistant', content: 'Fertig geprüft.' }
  ]
  const original = JSON.stringify(history)
  const result = budgetCompletedHistory(history, true)
  assert.equal(result.length, 4)
  assert.match(result[0].content, /Nur lokal arbeiten/)
  assert.match(result[0].content, /Nichts hochladen/)
  assert.deepEqual(result[1].tool_calls, history[1].tool_calls)
  assert.equal(result[2].tool_call_id, 'call-1')
  assert.ok(JSON.stringify(result).length <= 6000)
  assert.equal(JSON.stringify(history), original)
})

it('uses an explicit text summary when oversized call arguments or many tool steps cannot fit', () => {
  const history = [{ role: 'user', content: 'Nur lokale Dateien verwenden.' }, { role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'test', arguments: JSON.stringify({ value: '"'.repeat(20000) }) } }] }, { role: 'tool', content: 'result', tool_call_id: 'a' }]
  const result = budgetCompletedHistory(history, true)
  assert.equal(result.length, 1)
  assert.match(String(result[0].content), /Nur lokale Dateien/)
  assert.match(String(result[0].content), /Werkzeugdetails ausgelassen/)
  assert.ok(JSON.stringify(result).length <= 6000)
})

it('bounds escaped text and earlier digests without silently dropping the current request', () => {
  for (const text of ['x', '"', '\\', '\n']) {
    const history = [{ role: 'user', content: '[Früher im Gespräch]\n' + '"'.repeat(900) }, { role: 'user', content: 'Vorgabe: offline. ' + text.repeat(20000) + ' Keine E-Mail senden.' }, { role: 'assistant', content: 'Bestätigt. ' + text.repeat(10000) }]
    const result = budgetConversation(history, true)
    assert.ok(result.length > 0)
    assert.match(JSON.stringify(result), /Vorgabe: offline/)
    assert.match(JSON.stringify(result), /Keine E-Mail senden/)
    assert.ok(JSON.stringify(result).length <= 6000)
  }
})

it('preserves Gemini call/response metadata while clipping the large response payload', () => {
  const result = budgetCompletedHistory([
    { role: 'user', parts: [{ text: 'Nur lesen, nichts ändern.' }] },
    { role: 'model', parts: [{ functionCall: { name: 'read', args: {} } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'read', response: { output: 'x'.repeat(20000) } } }] },
    { role: 'model', parts: [{ text: 'Gelesen.' }] }
  ], true)
  assert.equal(result.length, 4)
  assert.equal(((result[1].parts![0] as Record<string, unknown>).functionCall as { name: string }).name, 'read')
  assert.equal(((result[2].parts![0] as Record<string, unknown>).functionResponse as { name: string }).name, 'read')
  assert.ok(JSON.stringify(result).length <= 6000)
})
