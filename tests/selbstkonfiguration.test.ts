import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { registerAllTools } from '@main/tools'
import { getTool, type ToolContext } from '@main/tools/registry'
import { getSettings } from '@main/store/settings'

const ctx = { signal: new AbortController().signal } as unknown as ToolContext

describe('James stellt sich selbst ein', () => {
  registerAllTools()
  const change = getTool('settings_change')!

  it('ändert einen bestehenden Wert desselben Typs', async () => {
    const before = getSettings().wake.threshold
    await change.execute({ path: 'wake.threshold', value_json: String(before === 0.5 ? 0.6 : 0.5) }, ctx)
    assert.notEqual(getSettings().wake.threshold, before)
  })

  it('lehnt einen falschen Typ ab', async () => {
    await assert.rejects(change.execute({ path: 'wake.threshold', value_json: '"hoch"' }, ctx), /erwartet/)
  })

  it('lehnt erfundene Pfade ab', async () => {
    await assert.rejects(change.execute({ path: 'wake.gibtsnicht', value_json: '1' }, ctx), /gibt es nicht/)
  })

  it('lässt Werkzeugrechte nicht anfassen', async () => {
    await assert.rejects(change.execute({ path: 'permissions.run_command', value_json: '"allow"' }, ctx), /gesperrt/)
  })

  it('lässt Programmpfade und Adressen nicht umbiegen', async () => {
    await assert.rejects(change.execute({ path: 'piper.pythonPath', value_json: '"C:/x.exe"' }, ctx), /gesperrt/)
    await assert.rejects(change.execute({ path: 'telephony.publicUrl', value_json: '"https://x"' }, ctx), /gesperrt/)
  })

  it('lässt die Zustimmung zu Gesprächsausschnitten nur von Hand geben', async () => {
    await assert.rejects(change.execute({ path: 'diagnosticReporting.capabilityGaps', value_json: 'true' }, ctx), /gesperrt/)
  })

  it('fragt vor jeder Änderung nach', () => {
    assert.equal(change.alwaysAsk, true)
  })
})
