import assert from 'node:assert/strict'
import { it } from 'node:test'
import { limitedResponseText, limitedNodeStreamText } from '@main/providers/httpBody'
import { Readable } from 'node:stream'

it('limits declared and streamed bodies and releases oversized streams', async () => {
  await assert.rejects(limitedResponseText(new Response('small', { headers: { 'content-length': '1000' } }), 20), /zu groß/)
  let cancelled = false
  const stream = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(10)) }, cancel() { cancelled = true } })
  await assert.rejects(limitedResponseText(new Response(stream), 15), /zu groß/)
  assert.equal(cancelled, true)
  assert.equal(await limitedResponseText(new Response('Grüße'), 20), 'Grüße')
})

it('limits Google export streams and propagates cancellation without retaining the download', async () => {
  const huge = Readable.from([Buffer.alloc(10), Buffer.alloc(10)])
  await assert.rejects(limitedNodeStreamText(huge, 15), /zu groß/)
  assert.equal(huge.destroyed, true)
  const controller = new AbortController(); controller.abort(new Error('Gestoppt'))
  const stream = Readable.from(['text'])
  await assert.rejects(limitedNodeStreamText(stream, 100, controller.signal), /Gestoppt/)
  assert.equal(stream.destroyed, true)
})
