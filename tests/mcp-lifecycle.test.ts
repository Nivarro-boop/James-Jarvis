import assert from 'node:assert/strict'
import { it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { z } from 'zod'
import { McpLifecycle } from '@main/mcp/lifecycle'
import { serverToolDefinitions } from '@main/mcp/client'
import { abortable } from '@shared/async'
import { mcpEnvironment, mcpToolName } from '@main/mcp/configuration'
import type { McpServerConfig } from '@shared/types'
import type { ToolDefinition } from '@main/tools/registry'

const config = (id: string): McpServerConfig => ({ id, name: id, enabled: true, command: 'node', args: [] })
const tool = (name: string) => ({ name, inputSchema: { type: 'object' as const } })
class FakeClient {
  onclose?: () => void
  changed?: () => void
  closed = 0
  pages: Record<string, { tools: ReturnType<typeof tool>[]; nextCursor?: string }> = { first: { tools: [tool('first')], nextCursor: 'second' }, second: { tools: [tool('second')] } }
  async listTools(input?: { cursor?: string }) { return this.pages[input?.cursor ?? 'first'] }
  setNotificationHandler(_schema: unknown, handler: () => void) { this.changed = handler }
  async close() { this.closed++; this.onclose?.() }
}
function harness(configs = [config('one')]) {
  const clients = new Map<string, FakeClient>()
  const registered = new Map<string, ToolDefinition>()
  let changes = 0
  const lifecycle = new McpLifecycle({
    configs: () => configs, fingerprint: () => JSON.stringify(configs), missingSecrets: c => c.secretEnv ?? [],
    connect: async c => { const client = new FakeClient(); clients.set(c.id, client); return client as unknown as Client },
    definitions: (c, _client, tools) => tools.map(t => ({ name: `mcp_${c.id}_${t.name}`, group: 'mcp', description: t.name, schema: z.object({}), execute: async () => 'ok' })),
    register: definition => { if (registered.has(definition.name)) throw new Error('Duplicate'); registered.set(definition.name, definition) },
    unregister: definition => { if (registered.get(definition.name) === definition) registered.delete(definition.name) },
    onToolsChanged: () => { changes++ }
  })
  return { lifecycle, clients, registered, changes: () => changes }
}

it('coalesces simultaneous reloads, loads all pages, reflects notifications and removes disconnected tools', async t => {
  const h = harness()
  t.after(() => h.lifecycle.shutdown())
  const first = h.lifecycle.reload(), duplicate = h.lifecycle.reload()
  assert.equal(first, duplicate)
  await first
  assert.equal(h.lifecycle.status().one.tools, 2)
  assert.equal(h.changes(), 0)
  const client = h.clients.get('one')!
  client.pages = { first: { tools: [tool('replacement')] } }
  client.changed?.(); client.changed?.()
  await delay(230)
  assert.deepEqual([...h.registered.keys()], ['mcp_one_replacement'])
  assert.equal(h.changes(), 1)
  client.onclose?.()
  assert.equal(h.registered.size, 0)
  assert.equal(h.lifecycle.status().one.state, 'error')
  const snapshot = h.lifecycle.status()
  snapshot.one.state = 'ok'
  assert.equal(h.lifecycle.status().one.state, 'error')
})

it('rejects cyclic pagination and closes a partially connected server', async t => {
  const h = harness()
  t.after(() => h.lifecycle.shutdown())
  const originalConnect = (h.lifecycle as any).options.connect
  ;(h.lifecycle as any).options.connect = async (c: McpServerConfig) => {
    const client = await originalConnect(c)
    client.pages.second.nextCursor = 'second'
    return client
  }
  await h.lifecycle.reload()
  assert.equal(h.lifecycle.status().one.state, 'error')
  assert.equal(h.registered.size, 0)
  assert.equal(h.clients.get('one')!.closed, 1)
})

it('starts at most three servers together and does not start disabled or key-blocked entries', async t => {
  const configs = Array.from({ length: 7 }, (_, i) => config(`server${i}`))
  configs.push({ ...config('off'), enabled: false }, { ...config('key'), secretEnv: ['TOKEN'] })
  const h = harness(configs)
  t.after(() => h.lifecycle.shutdown())
  let active = 0, max = 0, started = 0
  const options = (h.lifecycle as any).options
  const connect = options.connect
  options.connect = async (c: McpServerConfig) => {
    active++; started++; max = Math.max(max, active)
    await delay(10)
    active--
    return connect(c)
  }
  await h.lifecycle.reload()
  assert.equal(started, 7)
  assert.equal(max, 3)
  assert.equal(h.lifecycle.status().off.state, 'off')
  assert.equal(h.lifecycle.status().key.state, 'key')
})

it('isolates inherited process secrets, expands explicit paths and avoids tool-name collisions', () => {
  const env = mcpEnvironment({ ...config('test'), env: { PATH: 'custom', ROOT: '%USERPROFILE%/notes' }, secretEnv: ['OWN_TOKEN'] }, { Path: 'old', USERPROFILE: 'C:/User' }, () => 'selected', true)
  assert.equal(env.PATH, 'custom')
  assert.equal(env.Path, undefined)
  assert.equal(env.ROOT, 'C:/User/notes')
  assert.equal(env.OWN_TOKEN, 'selected')
  assert.notEqual(mcpToolName('test', 'a-b'), mcpToolName('test', 'a_b'))
  assert.notEqual(mcpToolName('test', 'long'.repeat(30) + 'a'), mcpToolName('test', 'long'.repeat(30) + 'b'))
  assert.ok(mcpToolName('test', 'long'.repeat(30)).length <= 63)
})

it('preserves cancellation/timeouts and does not trust a read-only label on destructive tool names', async () => {
  const signal = new AbortController()
  const calls: any[][] = []
  let error = false
  const client = { callTool: async (...args: any[]) => {
    calls.push(args)
    return { content: [{ type: 'text', text: error ? 'Provider rejected request' : 'read result' }], isError: error }
  } } as unknown as Client
  const definitions = serverToolDefinitions(config('test'), client, [
    { ...tool('delete_file'), annotations: { readOnlyHint: true } },
    { ...tool('read_note'), annotations: { readOnlyHint: true } }
  ])
  assert.equal(definitions[0].readOnly, false)
  assert.equal(definitions[0].alwaysAsk, true)
  assert.equal(definitions[1].readOnly, true)
  const context = { signal: signal.signal } as any
  assert.deepEqual(await definitions[1].execute({}, context), [{ type: 'text', text: 'read result' }])
  assert.equal(calls[0][2].signal, signal.signal)
  assert.equal(calls[0][2].maxTotalTimeout, 60000)
  error = true
  await assert.rejects(definitions[1].execute({}, context), /Provider rejected/)
  signal.abort(new Error('Stopped'))
  await assert.rejects(definitions[1].execute({}, context), /Stopped/)
  assert.equal(calls.length, 2)
})

it('shutdown closes active transports and cancels an interactive wait', async () => {
  const h = harness()
  await h.lifecycle.reload()
  const pending = h.lifecycle.exclusive(() => abortable(new Promise<void>(() => {}), h.lifecycle.signal))
  const rejected = assert.rejects(pending, /abort/i)
  await delay(0)
  await h.lifecycle.shutdown()
  await rejected
  assert.equal(h.registered.size, 0)
  assert.equal(h.clients.get('one')!.closed, 1)
})
