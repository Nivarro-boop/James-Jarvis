import assert from 'node:assert/strict'
import { it } from 'node:test'
import { isTransientNetworkError } from '@shared/transientError'

it('erkennt abgerissene Verbindungen, aber keine echten Programmfehler', () => {
  assert.equal(isTransientNetworkError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), true)
  assert.equal(isTransientNetworkError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })), true)
  assert.equal(isTransientNetworkError(new TypeError('x is undefined')), false)
  assert.equal(isTransientNetworkError(Object.assign(new Error('listen'), { code: 'EADDRINUSE' })), false)
  assert.equal(isTransientNetworkError(null), false)
  assert.equal(isTransientNetworkError('ECONNRESET'), false)
})
