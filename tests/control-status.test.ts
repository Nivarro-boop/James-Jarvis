import assert from 'node:assert/strict'
import { it } from 'node:test'
import { controlStatus } from '@main/control/status'
import { IPC_INVOKE_CHANNELS } from '@shared/ipc'

it('liefert Konfiguration ohne Telefonie zu starten und ohne Schlüsselwerte zu übertragen', async () => {
  const reads: string[] = []
  const result = await controlStatus({
    phoneConfigured() { reads.push('configured'); return true },
    settings() { reads.push('settings'); return { conversation: false, incoming: true } },
    telephony() { reads.push('telephony'); return { running: false, publicUrl: null, source: null } },
    async computer() { reads.push('computer'); return { name: 'powershell' } }
  })
  assert.deepEqual(reads, ['settings', 'configured', 'telephony', 'computer'])
  assert.equal(result.phoneConfigured, true)
  assert.equal(result.conversationEnabled, false)
  assert.equal(result.incomingEnabled, true)
  assert.equal(result.telephony.running, false)
  assert.deepEqual(result.computer, { name: 'powershell' })
  assert.equal(IPC_INVOKE_CHANNELS.filter(name => name === 'control:status').length, 1)
  assert.deepEqual(Object.keys(result).sort(), ['computer', 'conversationEnabled', 'incomingEnabled', 'phoneConfigured', 'telephony'])
})

it('erhält Telefonstatus und zeigt einen ehrlichen Computerfehler statt Gesamtausfall', async () => {
  const result = await controlStatus({
    phoneConfigured: () => false,
    settings: () => ({ conversation: true, incoming: false }),
    telephony: () => ({ running: true, publicUrl: 'https://phone.example.test', source: 'manuell' }),
    computer: async () => { throw new Error('Kein Eingabe-Backend verfügbar') }
  })
  assert.equal(result.phoneConfigured, false)
  assert.equal(result.telephony.running, true)
  assert.equal(result.computer.name, 'nicht verfügbar')
  assert.match(result.computer.grund!, /Kein Eingabe-Backend/)
})
