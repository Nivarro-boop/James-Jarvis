import assert from 'node:assert/strict'
import { it } from 'node:test'
import { singleFlight } from '@shared/singleFlight'

it('shares concurrent reads per key without returning stale results on later checks', async () => {
  let calls = 0
  const read = singleFlight(async (key: boolean) => ({ key, call: ++calls }))
  const first = read(false)
  assert.equal(read(false), first)
  const explicit = read(true)
  assert.notEqual(explicit, first)
  assert.deepEqual(await Promise.all([first, explicit]), [{ key: false, call: 1 }, { key: true, call: 2 }])
  assert.deepEqual(await read(false), { key: false, call: 3 })
})

it('releases failed reads so that a later retry can recover', async () => {
  let calls = 0
  const read = singleFlight(async () => { if (++calls === 1) throw new Error('offline'); return 'online' })
  await assert.rejects(read(undefined), /offline/)
  assert.equal(await read(undefined), 'online')
})
