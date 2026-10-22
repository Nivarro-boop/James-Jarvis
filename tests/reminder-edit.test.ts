import assert from 'node:assert/strict'
import { it } from 'node:test'
import { app } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { closeDb, listReminders } from '@main/db'
import { createReminder, editReminder, completeReminder } from '@main/scheduler/reminders'
import { reminderTools } from '@main/tools/impl/reminders'
import { permissionFor } from '@main/tools/permissions'
import { register, unregisterTool } from '@main/tools/registry'

it('bearbeitet aktive Erinnerungen validiert, veröffentlicht Updates und stellt reminder_update als Timer-Werkzeug bereit', async t => {
  const root = mkdtempSync(join(tmpdir(), 'james-reminder-edit-'))
  t.mock.method(app, 'getPath', () => root)
  const tool = reminderTools.find(candidate => candidate.name === 'reminder_update')!
  register(tool)
  t.after(() => {
    unregisterTool(tool.name, tool)
    closeDb()
    rmSync(root, { recursive: true, force: true })
  })

  const original = createReminder({ text: '  Zahnarzt  ', inMinutes: 15, repeat: 'none' })
  const iso = new Date(Date.now() + 90 * 60_000).toISOString()
  const updated = editReminder({ id: original.id, text: 'Kontrolltermin', at: iso, repeat: 'weekly' })
  assert.equal(updated.text, 'Kontrolltermin')
  assert.equal(updated.repeat, 'weekly')
  assert.equal(updated.dueAt, Date.parse(iso))
  assert.equal(updated.state, 'pending')

  assert.equal(tool.group, 'timer')
  assert.equal(tool.readOnly, undefined)
  assert.equal(permissionFor('reminder_update'), 'allow')
  assert.equal(tool.schema.safeParse({ id: original.id }).success, false)
  assert.equal(tool.schema.safeParse({ id: original.id, text: 'Neue Beschreibung' }).success, true)
  const result = await tool.execute({ id: original.id, text: 'Per Sprache geändert' }, {} as any)
  assert.equal((result as { text: string }).text, 'Per Sprache geändert')

  for (const invalid of [null, {}, { id: 0, text: 'x' }, { id: original.id },
    { id: original.id, text: '   ' }, { id: original.id, text: 'x'.repeat(2001) },
    { id: original.id, repeat: 'monthly' }, { id: original.id, at: '2027-02-30T09:00:00Z' },
    { id: original.id, at: iso, inMinutes: 30 }]) {
    assert.throws(() => editReminder(invalid))
  }

  completeReminder(original.id)
  assert.throws(() => editReminder({ id: original.id, text: 'Wiederbelebt?' }), /aktive Erinnerung/)
  assert.equal(listReminders().length, 0)
  assert.throws(() => editReminder({ id: 99_999, text: 'Nicht vorhanden' }), /aktive Erinnerung/)
})
