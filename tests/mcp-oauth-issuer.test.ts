import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { app, safeStorage } from 'electron'
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { getMcpOAuth, setMcpOAuth } from '../src/main/secrets/keystore'
import { hasMcpLogin, JarvisOAuthProvider } from '../src/main/mcp/oauth'

test('MCP OAuth Credentials ohne gültigen Issuer werden verworfen; gültige bleiben erhalten', (t) => {
  const userData = mkdtempSync(join(tmpdir(), 'jarvis-mcp-oauth-'))
  t.mock.method(app, 'getPath', () => userData)
  t.mock.method(safeStorage, 'isEncryptionAvailable', () => true)
  t.mock.method(safeStorage, 'encryptString', (text: string) => Buffer.from(text))
  t.mock.method(safeStorage, 'decryptString', (blob: Buffer) => blob.toString())
  t.after(() => rmSync(userData, { recursive: true, force: true }))

  const issuer = 'https://auth.example.invalid/tenant'
  const legacyClient = {
    client_id: 'synthetic-legacy-client',
    token_endpoint_auth_method: 'none'
  } as unknown as OAuthClientInformationMixed
  const legacyTokens = {
    access_token: 'synthetic-legacy-access-token',
    refresh_token: 'synthetic-legacy-refresh-token',
    token_type: 'Bearer'
  } satisfies OAuthTokens

  // SDK 1.30-era data had no issuer. It must never be returned to the SDK,
  // including its refresh token, and must not appear as an existing login.
  setMcpOAuth('legacy', { client: legacyClient, tokens: legacyTokens })
  const legacyProvider = new JarvisOAuthProvider('legacy', 'Legacy server', false)
  strictEqual(legacyProvider.clientInformation(), undefined)
  strictEqual(legacyProvider.tokens(), undefined)
  strictEqual(hasMcpLogin('legacy'), false)

  // A present but malformed/non-HTTP issuer is not a binding either.
  setMcpOAuth('invalid-issuer', {
    client: { ...legacyClient, issuer: 'not-a-url' },
    tokens: { ...legacyTokens, issuer: 'file:///tmp/issuer' }
  })
  const invalidProvider = new JarvisOAuthProvider('invalid-issuer', 'Invalid server', false)
  strictEqual(invalidProvider.clientInformation(), undefined)
  strictEqual(invalidProvider.tokens(), undefined)
  strictEqual(hasMcpLogin('invalid-issuer'), false)

  const validClient = {
    client_id: 'synthetic-bound-client',
    token_endpoint_auth_method: 'none',
    issuer
  } as unknown as OAuthClientInformationMixed
  const validTokens = {
    access_token: 'synthetic-bound-access-token',
    refresh_token: 'synthetic-bound-refresh-token',
    token_type: 'Bearer',
    issuer
  } as OAuthTokens
  setMcpOAuth('valid', { client: validClient, tokens: validTokens })
  const validProvider = new JarvisOAuthProvider('valid', 'Valid server', false)
  deepStrictEqual(validProvider.clientInformation(), validClient)
  deepStrictEqual(validProvider.tokens(), validTokens)
  strictEqual(hasMcpLogin('valid'), true)

  // Save methods retain SDK issuer fields verbatim and preserve the other half
  // of the stored OAuth record.
  const writeProvider = new JarvisOAuthProvider('write-roundtrip', 'Write server', false)
  writeProvider.saveClientInformation(validClient)
  writeProvider.saveTokens(validTokens)
  deepStrictEqual(getMcpOAuth('write-roundtrip'), { client: validClient, tokens: validTokens })
  deepStrictEqual(writeProvider.clientInformation(), validClient)
  deepStrictEqual(writeProvider.tokens(), validTokens)
})
