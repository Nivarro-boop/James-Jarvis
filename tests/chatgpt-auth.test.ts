import assert from 'node:assert/strict'
import { it, type TestContext } from 'node:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app, safeStorage, shell } from 'electron'
import {
  cancelChatGptSignIn, chatGptAccessToken, chatGptHostId, chatGptStatus,
  connectChatGpt, disconnectChatGpt
} from '@main/providers/chatgptAuth'

const realFetch = globalThis.fetch
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'james-auth-test', alg: 'RS256', use: 'sig' }
const issuer = 'https://auth.openai.com'
const scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const client = 'oaiapp_james_test'

function idToken(nonce: string, subject = 'account-test', aud = client): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  const data = `${part({ alg: 'RS256', kid: jwk.kid })}.${part({
    iss: issuer, aud, nonce, sub: subject, email: 'test@example.invalid', exp: Math.floor(Date.now() / 1000) + 3600
  })}`
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`
}

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'james-chatgpt-auth-'))
  t.mock.method(app, 'getPath', () => root)
  t.mock.method(safeStorage, 'isEncryptionAvailable', () => true)
  let authorize: URL | undefined
  const urls: URL[] = []
  const exchanges: URLSearchParams[] = []
  let browser: (url: URL) => Promise<void> = async url => {
    const callback = new URL(url.searchParams.get('redirect_uri')!)
    callback.search = new URLSearchParams({ code: 'test-code', state: url.searchParams.get('state')!, client_id: client }).toString()
    const response = await realFetch(callback, { signal: AbortSignal.timeout(2000) })
    assert.equal(response.status, 200)
    await response.text()
  }
  let tokens: (body: URLSearchParams, signal?: AbortSignal) => Promise<Response> = async body => new Response(JSON.stringify({
    access_token: body.get('grant_type') === 'refresh_token' ? 'renewed-test-access' : 'test-access',
    refresh_token: 'test-refresh', expires_in: 3600, scope,
    id_token: idToken(authorize!.searchParams.get('nonce')!)
  }))
  t.mock.method(shell, 'openExternal', async (raw: string) => {
    authorize = new URL(raw)
    urls.push(authorize)
    await browser(authorize)
  })
  t.mock.method(globalThis, 'fetch', async (raw: string | URL | Request, init?: RequestInit) => {
    const url = String(raw)
    if (url.endsWith('/.well-known/openid-configuration')) return new Response(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }))
    if (url.endsWith('/jwks')) return new Response(JSON.stringify({ keys: [jwk] }))
    assert.equal(url, `${issuer}/api/accounts/oauth/token`)
    const body = new URLSearchParams(String(init?.body))
    assert.equal(body.get('client_id'), client)
    assert.equal(body.get('resource'), 'https://api.openai.com/v1')
    if (body.get('grant_type') === 'authorization_code') {
      assert.equal(body.get('redirect_uri'), authorize!.searchParams.get('redirect_uri'))
      assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'), authorize!.searchParams.get('code_challenge'))
    }
    exchanges.push(body)
    return tokens(body, init?.signal ?? undefined)
  })
  t.after(async () => {
    await disconnectChatGpt()
    assert.ok(root.startsWith(join(tmpdir(), 'james-chatgpt-auth-')))
    rmSync(root, { recursive: true, force: true })
  })
  return {
    urls, exchanges,
    browser: (fn: typeof browser) => { browser = fn },
    tokens: (fn: typeof tokens) => { tokens = fn }
  }
}

it('meldet sich über echten lokalen Callback an, prüft PKCE und erneuert Zugangsdaten', async t => {
  const h = await fixture(t)
  assert.deepEqual(await connectChatGpt(), { email: 'test@example.invalid' })
  assert.equal(h.urls[0].searchParams.get('client_id'), 'dynamic_agent_client')
  assert.equal(h.urls[0].searchParams.get('agent_name_hint'), 'James-Jarvis')
  assert.equal(chatGptStatus().connected, true)
  assert.equal(await chatGptAccessToken(), 'test-access')
  assert.equal(await chatGptAccessToken(true), 'renewed-test-access')
  assert.equal(h.exchanges.length, 2)
  const host = chatGptHostId()
  await disconnectChatGpt()
  assert.equal(chatGptStatus().connected, false)
  assert.equal(chatGptHostId(), host)
  await connectChatGpt()
  assert.equal(h.urls[1].searchParams.get('client_id'), client)
  assert.equal(h.urls[1].searchParams.has('agent_name_hint'), false)
  assert.equal(h.urls[1].searchParams.get('ext_agent_host_id'), host)
})

it('erneuert einen abgelaufenen Code einmal mit der ausgestellten Client-ID', async t => {
  const h = await fixture(t)
  let calls = 0
  h.tokens(async () => ++calls === 1
    ? new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    : new Response(JSON.stringify({ access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600, scope,
      id_token: idToken(h.urls.at(-1)!.searchParams.get('nonce')!) })))
  await connectChatGpt()
  assert.equal(h.urls.length, 2)
  assert.equal(h.urls[1].searchParams.get('client_id'), client)
  assert.equal(h.urls[1].searchParams.has('agent_name_hint'), false)
  for (const key of ['state', 'nonce', 'code_challenge']) {
    assert.notEqual(h.urls[0].searchParams.get(key), h.urls[1].searchParams.get(key))
  }
  assert.equal(h.urls[0].searchParams.get('ext_agent_host_id'), h.urls[1].searchParams.get('ext_agent_host_id'))
})

it('begrenzt wiederholte ungültige Codes auf zwei Versuche', async t => {
  const h = await fixture(t)
  h.tokens(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }))
  await assert.rejects(connectChatGpt(), /Anmeldecode/)
  assert.equal(h.urls.length, 2)
  assert.equal(chatGptStatus().connected, false)
})

it('ignoriert einen falschen State und akzeptiert danach die richtige Rückleitung', async t => {
  const h = await fixture(t)
  h.browser(async url => {
    const callback = new URL(url.searchParams.get('redirect_uri')!)
    callback.search = new URLSearchParams({ code: 'test-code', state: 'wrong', client_id: client }).toString()
    const wrong = await realFetch(callback)
    assert.equal(wrong.status, 400)
    await wrong.text()
    callback.searchParams.set('state', url.searchParams.get('state')!)
    const correct = await realFetch(callback)
    assert.equal(correct.status, 200)
    await correct.text()
  })
  await connectChatGpt()
  assert.equal(h.exchanges.length, 1)
})

it('tauscht bei verweigerter Freigabe keinen Code aus', async t => {
  const h = await fixture(t)
  h.browser(async url => {
    const callback = new URL(url.searchParams.get('redirect_uri')!)
    callback.search = new URLSearchParams({ error: 'access_denied', state: url.searchParams.get('state')! }).toString()
    const response = await realFetch(callback)
    await response.text()
  })
  await assert.rejects(connectChatGpt(), /nicht erlaubt/)
  assert.equal(h.exchanges.length, 0)
})

it('bricht die Browserwartezeit ab und ermöglicht direkt danach eine neue Anmeldung', async t => {
  const h = await fixture(t)
  let opened!: () => void
  const ready = new Promise<void>(resolve => { opened = resolve })
  h.browser(async () => opened())
  const login = connectChatGpt()
  await ready
  cancelChatGptSignIn()
  await assert.rejects(login, /abgebrochen/)
  assert.equal(chatGptStatus().connected, false)
  h.browser(async url => {
    const callback = new URL(url.searchParams.get('redirect_uri')!)
    callback.search = new URLSearchParams({ code: 'fresh', state: url.searchParams.get('state')!, client_id: client }).toString()
    await (await realFetch(callback)).text()
  })
  await connectChatGpt()
  assert.equal(chatGptStatus().connected, true)
})

it('behält das aktive Konto bei einem falschen Konto im neuen ID-Token', async t => {
  const h = await fixture(t)
  await connectChatGpt()
  h.tokens(async () => new Response(JSON.stringify({ access_token: 'wrong-access', refresh_token: 'wrong-refresh', expires_in: 3600, scope,
    id_token: idToken(h.urls.at(-1)!.searchParams.get('nonce')!, 'another-account') })))
  await assert.rejects(connectChatGpt(), /anderen ChatGPT-Konto/)
  assert.equal(await chatGptAccessToken(), 'test-access')
})

it('bricht auch einen laufenden Codeaustausch ab und speichert keine verspäteten Tokens', async t => {
  const h = await fixture(t)
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  h.tokens(async (_body, signal) => {
    assert.ok(signal)
    started()
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })
  const pending = connectChatGpt()
  await ready
  cancelChatGptSignIn()
  await assert.rejects(pending, /abgebrochen/)
  assert.equal(chatGptStatus().connected, false)
})

it('lehnt ein gültig signiertes ID-Token aus einer anderen Anmeldung ab', async t => {
  const h = await fixture(t)
  h.tokens(async () => new Response(JSON.stringify({ access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600, scope,
    id_token: idToken('wrong-nonce') })))
  await assert.rejects(connectChatGpt(), /gehört nicht zu dieser Anmeldung/)
  assert.equal(chatGptStatus().connected, false)
})

it('speichert keine Anmeldung ohne ChatGPT-Plan-Freigabe', async t => {
  const h = await fixture(t)
  h.tokens(async () => new Response(JSON.stringify({ access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600,
    scope: 'openid email', id_token: idToken(h.urls.at(-1)!.searchParams.get('nonce')!) })))
  await assert.rejects(connectChatGpt(), /nicht erlaubt/)
  assert.equal(chatGptStatus().connected, false)
})
