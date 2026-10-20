import assert from 'node:assert/strict'
import { it, type TestContext } from 'node:test'
import http, { type RequestListener, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { EventEmitter } from 'node:events'
import { waitForCallback } from '@main/mcp/oauth'

function callbackFixture(t: TestContext) {
  let listener!: RequestListener
  let closed = 0
  const server = new EventEmitter() as Server
  server.listen = (() => server) as typeof server.listen
  server.close = (() => { closed++; return server }) as typeof server.close
  t.mock.method(http, 'createServer', (handler: RequestListener) => { listener = handler; return server })
  const pending = waitForCallback('expected-state')
  // Avoid an unhandled rejection when testing provider errors.
  pending.code.catch(() => undefined)
  t.after(() => pending.close())
  return {
    pending,
    closed: () => closed,
    request(url: string): number {
      let status = 0
      const response = {
        writeHead(value: number) { status = value; return this },
        end() { return this }
      }
      listener({ url } as IncomingMessage, response as unknown as ServerResponse)
      return status
    }
  }
}

it('ignores missing and incorrect callback states until the genuine callback arrives', async t => {
  const f = callbackFixture(t)
  let settled = false
  f.pending.code.then(() => { settled = true }, () => { settled = true })
  for (const url of ['/callback?code=foreign', '/callback?state=wrong&code=foreign', '/callback?state=wrong&error=access_denied']) {
    assert.equal(f.request(url), 400)
    await Promise.resolve()
    assert.equal(settled, false)
    assert.equal(f.closed(), 0)
  }
  assert.equal(f.request('/callback?state=expected-state&code=genuine'), 200)
  assert.equal(await f.pending.code, 'genuine')
  assert.equal(f.closed(), 1)
})

it('still rejects an authorization error with the correct state', async t => {
  const f = callbackFixture(t)
  assert.equal(f.request('/callback?state=expected-state&error=access_denied'), 400)
  await assert.rejects(f.pending.code, /Anmeldung abgelehnt/)
  assert.equal(f.closed(), 1)
})
