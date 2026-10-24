import assert from 'node:assert/strict'
import { describe, it, type TestContext } from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app, safeStorage } from 'electron'
import { clearSecret, setSecret } from '@main/secrets/keystore'
import { geminiClient, generateWithFallback } from '@main/providers/gemini'
import { chatGptResponse, readResponseStream } from '@main/providers/chatgptResponses'
import { ollamaThink } from '@main/providers/ollama'

function credentials(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'james-provider-reliability-'))
  t.mock.method(app, 'getPath', () => root)
  t.mock.method(safeStorage, 'isEncryptionAvailable', () => true)
  setSecret('gemini', 'isolated-test-key')
  t.after(() => {
    clearSecret('gemini')
    assert.ok(root.startsWith(join(tmpdir(), 'james-provider-reliability-')))
    rmSync(root, { recursive: true, force: true })
  })
  return root
}

describe('Provider recovery from stalled operations', () => {
  it('releases a cancelled Gemini call even when the SDK never settles', async t => {
    credentials(t)
    const models = geminiClient().models
    let attempt = 0
    const expected = { text: 'Wieder bereit.' }
    t.mock.method(models, 'generateContent', () => ++attempt === 1
      ? new Promise(() => undefined) : Promise.resolve(expected))
    const controller = new AbortController()
    const reason = new Error('Test cancellation')
    const first = generateWithFallback({ model: 'test-cancel', contents: 'Test', config: { abortSignal: controller.signal } })
    controller.abort(reason)
    await assert.rejects(first, error => error === reason)
    assert.equal(await generateWithFallback({ model: 'test-cancel', contents: 'Test' }), expected)
    assert.equal(attempt, 2)
  })

  it('applies a finite deadline and releases a stalled Gemini round', async t => {
    credentials(t)
    const controller = new AbortController()
    let requestedTimeout = 0
    t.mock.method(AbortSignal, 'timeout', (ms: number) => { requestedTimeout = ms; return controller.signal })
    t.mock.method(geminiClient().models, 'generateContent', (params: { config?: { httpOptions?: { timeout?: number; retryOptions?: unknown } } }) => {
      assert.equal(params.config?.httpOptions?.timeout, 60_000)
      assert.equal(params.config?.httpOptions?.retryOptions, undefined)
      return new Promise(() => undefined)
    })
    const pending = generateWithFallback({ model: 'test-deadline', contents: 'Test' })
    assert.equal(requestedTimeout, 60_000)
    const reason = new DOMException('Deadline exceeded', 'TimeoutError')
    controller.abort(reason)
    await assert.rejects(pending, error => error === reason)
  })

  it('honors an explicit Gemini deadline and preserves HTTP options and retry policy', async t => {
    credentials(t)
    const controller = new AbortController()
    let requestedTimeout = 0
    t.mock.method(AbortSignal, 'timeout', (ms: number) => { requestedTimeout = ms; return controller.signal })
    const httpOptions = { timeout: 300_000, headers: { 'X-Test': 'test' }, retryOptions: { attempts: 2 } }
    const expected = { text: 'Fertig.' }
    t.mock.method(geminiClient().models, 'generateContent', (params: { config?: { httpOptions?: unknown } }) => {
      assert.deepEqual(params.config?.httpOptions, httpOptions)
      return Promise.resolve(expected)
    })
    assert.equal(await generateWithFallback({ model: 'test-explicit-options', contents: 'Test', config: { httpOptions } }), expected)
    assert.equal(requestedTimeout, 300_000)
  })

  it('does not consume a model request after cancellation', async t => {
    credentials(t)
    const call = t.mock.method(geminiClient().models, 'generateContent', () => new Promise(() => undefined))
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(generateWithFallback({ model: 'test-pre-abort', contents: 'Test', config: { abortSignal: controller.signal } }))
    assert.equal(call.mock.callCount(), 0)
  })

  it('keeps one deadline across a Gemini quota fallback', async t => {
    credentials(t)
    const controller = new AbortController()
    t.mock.method(AbortSignal, 'timeout', () => controller.signal)
    let attempt = 0
    const deadline = new DOMException('Deadline exceeded', 'TimeoutError')
    t.mock.method(geminiClient().models, 'generateContent', () => {
      if (++attempt === 1) return Promise.reject(new Error('429 quota exhausted'))
      controller.abort(deadline)
      return new Promise(() => undefined)
    })
    await assert.rejects(generateWithFallback({ model: 'test-quota-deadline', contents: 'Test' }), error => error === deadline)
    assert.equal(attempt, 2)
  })

  it('times out an Ollama response that sends headers and then stalls; the next call works', { timeout: 5000 }, async t => {
    let stalled = true
    let headersSent = false
    const server = createServer((req, res) => {
      assert.equal(req.url, '/api/chat')
      res.setHeader('Content-Type', 'application/json')
      if (stalled) { headersSent = true; res.write('{"message":'); return }
      res.end(JSON.stringify({ message: { content: 'Wieder bereit.' } }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => { server.closeAllConnections(); server.close() })
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    await assert.rejects(ollamaThink('test-local', 'Test', 'Test', { baseUrl, timeoutMs: 250 }), error => error instanceof Error && /abort|timeout/i.test(error.name))
    assert.equal(headersSent, true)
    stalled = false
    assert.equal(await ollamaThink('test-local', 'Test', 'Test', { baseUrl, timeoutMs: 1000 }), 'Wieder bereit.')
  })

  it('finishes ChatGPT completion without waiting for stuck stream cleanup', { timeout: 1000 }, async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"Fertig."}]}]}}\n\n'))
      },
      cancel: () => new Promise(() => undefined)
    })
    const result = await readResponseStream(body)
    assert.equal(result.text, 'Fertig.')
    assert.equal(body.locked, false)
  })

  it('releases a stuck ChatGPT stream on Stop, including stuck cleanup', async () => {
    const controller = new AbortController()
    const body = new ReadableStream<Uint8Array>({ cancel: () => new Promise(() => undefined) })
    const reason = new Error('Test stop')
    const pending = readResponseStream(body, undefined, controller.signal)
    controller.abort(reason)
    await assert.rejects(pending, error => error === reason)
    assert.equal(body.locked, false)
  })

  it('recovers once from ChatGPT 401 without waiting for stuck rejected-body cleanup', { timeout: 1000 }, async t => {
    const root = credentials(t)
    writeFileSync(join(root, 'secure', 'chatgpt-login.bin'), JSON.stringify({
      clientId: 'oaiapp_test', accessToken: 'isolated-test-access', refreshToken: 'isolated-test-refresh', expiresAt: Date.now() + 600_000,
      scope: 'resource.invoke chatgpt.tokens.use.direct'
    }))
    let responseCalls = 0
    let refreshCalls = 0
    t.mock.method(globalThis, 'fetch', async (raw: string | URL | Request) => {
      if (String(raw).includes('/oauth/token')) {
        refreshCalls++
        return new Response(JSON.stringify({ access_token: 'isolated-renewed-access', expires_in: 3600 }))
      }
      assert.ok(String(raw).endsWith('/responses'))
      if (++responseCalls === 1) return new Response(new ReadableStream({ cancel: () => new Promise(() => undefined) }), { status: 401 })
      return new Response('data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"Wieder bereit."}]}]}}\n\n')
    })
    assert.equal((await chatGptResponse('test', 'Test', [])).text, 'Wieder bereit.')
    assert.equal(responseCalls, 2)
    assert.equal(refreshCalls, 1)
  })

  it('releases ChatGPT cancellation while a shared credential refresh is stuck', async t => {
    const root = credentials(t)
    writeFileSync(join(root, 'secure', 'chatgpt-login.bin'), JSON.stringify({
      clientId: 'oaiapp_test', accessToken: 'isolated-test-access', refreshToken: 'isolated-test-refresh', expiresAt: 0,
      scope: 'resource.invoke chatgpt.tokens.use.direct'
    }))
    const request = t.mock.method(globalThis, 'fetch', () => new Promise(() => undefined))
    const controller = new AbortController()
    const reason = new Error('Test stop while refreshing')
    const pending = chatGptResponse('test', 'Test', [], { signal: controller.signal })
    controller.abort(reason)
    await assert.rejects(pending, error => error === reason)
    assert.equal(request.mock.callCount(), 1)
  })
})
