import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { resolve, join } from 'node:path'

const fixtureRequire = createRequire(join(process.cwd(), 'package.json'))
const bundled = build({ entryPoints: [resolve('src/main/providers/chatgptResponses.ts')], bundle: true,
  write: false, format: 'cjs', platform: 'node', packages: 'external', logLevel: 'silent',
  alias: { '@shared': resolve('src/shared') }, plugins: [{ name: 'auth-fixture', setup(b) {
    b.onResolve({ filter: /\/chatgptAuth$/ }, () => ({ path: 'auth', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents:
      'export const CHATGPT_RESOURCE="https://test.invalid/v1";export const chatGptAccessToken=async()=>"test-access";export const chatGptSessionGeneration=()=>auth.generation'
    }))
  } }] })

async function provider(fetch: typeof globalThis.fetch) {
  const auth = { generation: 0 }
  const module = { exports: {} as typeof import('../src/main/providers/chatgptResponses') }
  runInNewContext((await bundled).outputFiles[0].text, { module, exports: module.exports,
    require: fixtureRequire, auth, fetch, AbortSignal, TextDecoder, console })
  return { api: module.exports, auth }
}

const models = (id: string) => new Response(JSON.stringify({ models: [{ slug: id, display_name: id, visibility: 'list' }] }))

it('coalesces simultaneous model-list requests and refreshes automatic selection after an account change', async () => {
  let requests = 0
  const { api, auth } = await provider(async () => models(`model-${++requests}`))
  const [first, second] = await Promise.all([api.chatGptModels(), api.chatGptModels()])
  assert.equal(requests, 1)
  assert.equal(first[0].id, second[0].id)
  assert.equal(await api.resolveChatGptModel('auto'), 'model-2')
  assert.equal(await api.resolveChatGptModel('auto'), 'model-2')
  assert.equal(requests, 2)
  auth.generation++
  assert.equal(await api.resolveChatGptModel('auto'), 'model-3')
  assert.equal(await api.resolveChatGptModel('chosen-by-user'), 'chosen-by-user')
  assert.equal(requests, 3)
})

it('cancels the waiting response without cancelling another caller’s model-list read', async () => {
  let release!: (response: Response) => void
  const pending = new Promise<Response>(resolve => { release = resolve })
  let requests = 0
  const { api } = await provider(async () => { requests++; return pending })
  const active = api.chatGptModels()
  const controller = new AbortController()
  const response = api.chatGptResponse('auto', 'system', [], { signal: controller.signal })
  controller.abort(new Error('stop-now'))
  await assert.rejects(response, /stop-now/)
  release(models('mini-test'))
  assert.equal((await active)[0].id, 'mini-test')
  assert.equal(requests, 1)
})

it('rejects a model list belonging to an account that changed while it was loading', async () => {
  let release!: (response: Response) => void
  const { api, auth } = await provider(() => new Promise(resolve => { release = resolve }))
  const active = api.chatGptModels()
  // Let authorization and fetch begin before switching the local account.
  await new Promise(resolve => setImmediate(resolve))
  auth.generation++
  release(models('old-account-model'))
  await assert.rejects(active, /Anmeldung wurde inzwischen geändert/)
})
