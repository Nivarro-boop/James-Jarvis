import assert from 'node:assert/strict'
import { it } from 'node:test'
import { app } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { closeDb, appendTranscript, searchTranscript, listReminders, listDueReminders } from '@main/db'
import { createReminder, completeReminder, reminderDueAt, snoozeReminder, tickReminders, nextReminderDue } from '@main/scheduler/reminders'
import { getSettings, setSettings } from '@main/store/settings'
import { permissionFor } from '@main/tools/permissions'
import { defineTool, register } from '@main/tools/registry'
import { runSubagent } from '@main/agent/subagent'
import { runCancellableTool, cancelToolCall } from '@main/tools/runner'

it('validiert Zeitpunkt und lokale Kalenderwiederholung', () => {
  const now = Date.parse('2026-10-03T12:00:00Z')
  assert.equal(reminderDueAt({ inMinutes: 10 }, now), now + 600_000)
  assert.equal(reminderDueAt({ at: '2026-10-04T09:00:00+02:00' }, now), Date.parse('2026-10-04T07:00:00Z'))
  for (const input of [{}, { inMinutes: -1 }, { inMinutes: NaN }, { inMinutes: Infinity },
    { at: 'tomorrow' }, { at: '2027-02-30T09:00:00Z' }, { at: '2026-10-04T09:00:00' }, { at: '2026-10-04T09:00:00Z', inMinutes: 3 }]) {
    assert.throws(() => reminderDueAt(input, now))
  }
  const date = new Date(2026, 9, 3, 9)
  const later = nextReminderDue(date.getTime(), 'daily', new Date(2026, 9, 7, 12).getTime())
  assert.equal(new Date(later).getDate(), 8)
  assert.equal(new Date(later).getHours(), 9)
})

it('behält Erinnerungen bei Nichtzustellung und Neustart, unterstützt Snooze, autonome Rechte und lokale Unteragenten', async t => {
  const root = mkdtempSync(join(tmpdir(), 'james-reminders-'))
  t.mock.method(app, 'getPath', () => root)
  t.after(() => { closeDb(); assert.ok(root.startsWith(join(tmpdir(), 'james-reminders-'))); rmSync(root, { recursive: true, force: true }) })
  const one = createReminder({ text: 'Termin prüfen', inMinutes: 1 })
  closeDb()
  assert.equal(listReminders()[0].id, one.id)
  const now = one.dueAt + 1
  assert.deepEqual(listDueReminders(one.dueAt - 1), [])
  assert.equal(listDueReminders(one.dueAt)[0].id, one.id)
  tickReminders(now, () => false)
  assert.equal(listReminders()[0].state, 'pending')
  let deliveries = 0
  tickReminders(now, () => { deliveries++; return true })
  tickReminders(now + 1000, () => { deliveries++; return true })
  assert.equal(deliveries, 1)
  assert.equal(listReminders()[0].state, 'notified')
  assert.deepEqual(listDueReminders(now), [])
  snoozeReminder(one.id, 10)
  assert.equal(listReminders()[0].state, 'pending')
  assert.ok(listReminders()[0].dueAt > Date.now() + 590_000)
  assert.deepEqual(listDueReminders(now), [])
  completeReminder(one.id)
  assert.equal(listReminders().length, 0)
  const recurring = createReminder({ text: 'Wöchentlich', inMinutes: 1, repeat: 'weekly' })
  tickReminders(recurring.dueAt + 1, () => true)
  assert.equal(listReminders()[0].state, 'pending')
  assert.ok(listReminders()[0].dueAt > recurring.dueAt + 6 * 86_400_000)

  appendTranscript('user', 'Wir wählen Produkt 100%_literal und Wien.')
  appendTranscript('assistant', 'Das ist die Entscheidung.')
  appendTranscript('user', 'Wir wählen Produkt 100xxliteral.')
  assert.equal(searchTranscript('100%_literal')[0].role, 'user')
  assert.equal(searchTranscript('100%_literal').length, 1)
  assert.equal(searchTranscript('Produkt Wien').length, 1)
  assert.throws(() => searchTranscript(' '))

  setSettings({ confirmActions: true, permissions: { denied_tool: 'deny' } })
  assert.equal(permissionFor('gmail_send'), 'ask')
  setSettings({ confirmActions: false })
  assert.equal(permissionFor('gmail_send'), 'allow')
  assert.equal(permissionFor('denied_tool'), 'deny')
  assert.equal(permissionFor('amazon_place_order'), 'deny')
  assert.equal(getSettings().confirmActions, false)

  let used = 0
  register(defineTool({ name: 'test_agent_read', group: 'web', description: 'Test', schema: z.object({}),
    async execute() { used++; return 'Wien' } }))
  setSettings({ speech: { ...getSettings().speech, thinkProvider: 'ollama' },
    ollama: { ...getSettings().ollama, model: 'test-local' } })
  let requests = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    assert.equal(body.model, 'test-local')
    requests++
    return new Response(JSON.stringify({ message: requests === 1
      ? { role: 'assistant', content: '', tool_calls: [{ function: { name: 'test_agent_read', arguments: {} } }] }
      : { role: 'assistant', content: 'Wien gefunden.' } }), { status: 200 })
  })
  const result = await runSubagent('Ort nachsehen', undefined)
  assert.equal(result.ok, true)
  assert.equal(result.summary, 'Wien gefunden.')
  assert.equal(used, 1)
  assert.equal(requests, 2)
  let toolSignal: AbortSignal | undefined
  register(defineTool({ name: 'test_agent_wait', group: 'web', description: 'Testabbruch', schema: z.object({}),
    async execute(_args, ctx) {
      toolSignal = ctx.signal
      await new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('abort')), { once: true }))
      return 'Darf nicht fertig werden'
    } }))
  const pending = runCancellableTool({ id: 'cancel-test', name: 'test_agent_wait', args: {} })
  assert.equal(toolSignal?.aborted, false)
  cancelToolCall('cancel-test')
  const outcome = await pending
  assert.equal(toolSignal?.aborted, true)
  assert.equal(outcome.ok, false)
  assert.match(outcome.error ?? '', /abgebrochen/)
  const abort = new AbortController(); abort.abort()
  const cancelled = await runSubagent('Nicht starten', undefined, abort.signal)
  assert.equal(cancelled.ok, false)
  assert.equal(requests, 2)
})
