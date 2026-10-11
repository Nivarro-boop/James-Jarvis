import assert from 'node:assert/strict'
import { it } from 'node:test'
import { SettingsWriteQueue } from '@shared/settingsQueue'
import { DEFAULT_SETTINGS } from '@shared/config/defaults'
import type { Settings } from '@shared/types'

it('speichert schnelle Änderungen in Reihenfolge und arbeitet nach einem Schreibfehler weiter', async () => {
  const calls:number[]=[]
  let release:(()=>void) | undefined
  const queue=new SettingsWriteQueue(async patch=>{
    const value=patch.dailyCostLimitUsd!
    calls.push(value)
    if(value===1) await new Promise<void>(resolve=>{release=resolve})
    if(value===2) throw new Error('Platte voll')
    return {...structuredClone(DEFAULT_SETTINGS),dailyCostLimitUsd:value} as Settings
  })
  const one=queue.enqueue({dailyCostLimitUsd:1})
  const two=queue.enqueue({dailyCostLimitUsd:2})
  const rejected=assert.rejects(two,/Platte voll/)
  const three=queue.enqueue({dailyCostLimitUsd:3})
  await Promise.resolve()
  assert.deepEqual(calls,[1])
  release!()
  await one;await rejected
  assert.equal((await three).dailyCostLimitUsd,3)
  assert.deepEqual(calls,[1,2,3])
})
