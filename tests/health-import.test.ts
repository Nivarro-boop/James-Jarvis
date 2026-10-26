import assert from 'node:assert/strict'
import { it } from 'node:test'
import { HealthImportSession } from '@main/health/importSession'

it('serializes Health imports and rejects late results after clearing or cancellation', async () => {
  const session = new HealthImportSession()
  let done!: (value: string) => void
  const pending = session.run(() => new Promise<string>(resolve => { done = resolve }))
  await assert.rejects(session.run(async () => 'second'), /bereits/)
  session.cancel()
  done('old snapshot')
  await assert.rejects(pending, /abgebrochen/)
  assert.equal(await session.run(async () => 'fresh snapshot'), 'fresh snapshot')
})
