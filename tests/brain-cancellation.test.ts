import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'
import { DEFAULT_SETTINGS } from '@shared/config/defaults'

const source = build({ entryPoints: [resolve('src/renderer/live/brain.ts')], bundle: true,
  write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
  alias: { '@shared': resolve('src/shared') } }).then(result => result.outputFiles[0].text)

async function flush(): Promise<void> { for (let i = 0; i < 20; i++) await Promise.resolve() }

for (const provider of ['chatgpt'] as const) {
  it(`${provider}: beendet eine hängende IPC-Anfrage bei Abbruch und entfernt alle Zuhörer`, async () => {
    let requestId = 0, timerId = 0, hangs = true
    let complete!: (value: any) => void
    const intervals = new Map<number, () => void>()
    const listeners = new Map<string, (payload: any) => void>()
    const cancelled: string[] = [], texts: string[] = []
    const requests: any[] = []
    const result = provider === 'chatgpt'
      ? { ok: true, response: { text: 'Neue Antwort', output: [] } }
      : { ok: true, text: 'Neue Antwort' }
    const window = { jarvis: {
      on: (channel: string, callback: (payload: any) => void) => { listeners.set(channel, callback); return () => listeners.delete(channel) },
      invoke: async (channel: string, payload: any) => {
        if (channel === 'agent:systemPrompt') return 'System'
        if (channel === `${provider}:cancel`) { cancelled.push(payload.requestId); return }
        if (channel === `${provider}:${provider === 'chatgpt' ? 'respond' : 'run'}`) {
          requests.push(payload)
          return hangs ? new Promise(resolve => { complete = resolve }) : result
        }
        throw new Error(`Unerwarteter Aufruf: ${channel}`)
      }
    } }
    const module = { exports: {} as any }
    runInNewContext(await source, { module, exports: module.exports, require, window, console, AbortSignal, AbortController,
      crypto: { randomUUID: () => String(++requestId) },
      setInterval: (fn: () => void) => { intervals.set(++timerId, fn); return timerId },
      clearInterval: (id: number) => intervals.delete(id) })
    const brain = new module.exports[provider === 'chatgpt' ? 'ChatGptBrain' : 'HermesBrain'](structuredClone(DEFAULT_SETTINGS))
    const abort = new AbortController()
    let tools = 0
    const hooks = { signal: abort.signal, cancelled: () => abort.signal.aborted,
      onText: (text: string) => texts.push(text), transcript: async () => '',
      callTool: async () => { tools++; return { ok: true } } }
    const pending = brain.run({ text: 'Erste Frage' }, hooks)
    await flush()
    assert.equal(requests.length, 1)
    const staleDelta = listeners.get(`${provider}:delta`)
    assert.ok(staleDelta)
    abort.abort()
    assert.equal(await pending, false)
    assert.deepEqual(cancelled, [requests[0].requestId])
    assert.equal(intervals.size, 0)
    assert.equal(listeners.size, 0)
    staleDelta({ requestId: requests[0].requestId, text: 'Zu spät' })
    complete(result)
    await flush()
    assert.deepEqual(texts, [])
    assert.equal(tools, 0)
    hangs = false
    const fresh = new AbortController()
    assert.equal(await brain.run({ text: 'Nächste Frage' }, { ...hooks, signal: fresh.signal, cancelled: () => false }), true)
    assert.deepEqual(texts, ['Neue Antwort'])
    assert.equal(intervals.size, 0)
    assert.equal(listeners.size, 0)
  })
}

it('startet keine ChatGPT-Anfrage, wenn der vorher wartende Systemprompt bereits überholt ist', async () => {
  let complete!: (value: string) => void
  const prompt = new Promise<string>(resolve => { complete = resolve })
  const abort = new AbortController()
  const requests: string[] = []
  const module = { exports: {} as any }
  runInNewContext(await source, { module, exports: module.exports, require, console, AbortSignal, AbortController,
    setInterval, clearInterval, crypto: { randomUUID: () => 'request' }, window: { jarvis: {
      invoke: async (channel: string) => { requests.push(channel); return prompt }
    } } })
  const brain = new module.exports.ChatGptBrain(structuredClone(DEFAULT_SETTINGS))
  const pending = brain.run({ text: 'Alte Frage' }, {
    signal: abort.signal, cancelled: () => abort.signal.aborted,
    onText() {}, transcript: async () => '', callTool: async () => ({ ok: true })
  })
  const rejected = assert.rejects(pending)
  abort.abort()
  await rejected
  complete('Veralteter Prompt')
  await flush()
  assert.deepEqual(requests, ['agent:systemPrompt'])
})
