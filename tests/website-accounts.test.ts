import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app, safeStorage } from 'electron'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { sameLoginOrigin, websiteLoginUrl } from '@shared/websiteAccounts'
import { websiteAccounts, websiteAccount, saveWebsiteAccount, removeWebsiteAccount } from '@main/secrets/keystore'

it('akzeptiert nur HTTPS-Adressen ohne Zugangsdaten oder Token-Parameter', () => {
  assert.equal(websiteLoginUrl('https://EXAMPLE.test/login').origin, 'https://example.test')
  for (const url of ['http://example.test', 'https://user:secret@example.test', 'https://example.test?token=secret', 'https://example.test#token', 'example.test']) assert.throws(() => websiteLoginUrl(url))
})
it('bindet Kontodaten an die genaue Herkunft einschließlich Port', () => {
  assert.equal(sameLoginOrigin('https://example.test/login', 'https://example.test'), true)
  for (const url of ['http://example.test', 'https://example.test.evil.test', 'https://sub.example.test', 'https://example.test:8443', 'invalid']) assert.equal(sameLoginOrigin(url, 'https://example.test'), false)
})
it('speichert Konten verschlüsselt, meldet nur Metadaten und erhält Passwort-Leerzeichen', t => {
  const root = mkdtempSync(join(tmpdir(), 'james-account-vault-'))
  t.mock.method(app, 'getPath', () => root)
  const key = randomBytes(32)
  t.mock.method(safeStorage, 'isEncryptionAvailable', () => true)
  t.mock.method(safeStorage, 'encryptString', (text: string) => {
    const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv)
    const data = Buffer.concat([c.update(text, 'utf8'), c.final()])
    return Buffer.concat([iv, c.getAuthTag(), data])
  })
  t.mock.method(safeStorage, 'decryptString', (data: Buffer) => {
    const d = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); d.setAuthTag(data.subarray(12, 28))
    return Buffer.concat([d.update(data.subarray(28)), d.final()]).toString('utf8')
  })
  t.after(() => { assert.ok(root.startsWith(join(tmpdir(), 'james-account-vault-'))); rmSync(root, { recursive: true, force: true }) })
  saveWebsiteAccount({ loginUrl: 'https://example.test/login', username: 'fixture@example.test', password: ' fixture-secret-with-spaces ' })
  assert.deepEqual(websiteAccounts(), [{ origin: 'https://example.test', loginUrl: 'https://example.test/login' }])
  assert.equal(websiteAccount('https://example.test')?.password, ' fixture-secret-with-spaces ')
  assert.equal(websiteAccount('https://other.test'), null)
  const bytes = readFileSync(join(root, 'secure', 'secrets.bin'))
  assert.equal(bytes.includes(Buffer.from('fixture-secret-with-spaces')), false)
  removeWebsiteAccount('https://example.test')
  assert.deepEqual(websiteAccounts(), [])
  t.mock.method(safeStorage, 'isEncryptionAvailable', () => false)
  assert.throws(() => saveWebsiteAccount({ loginUrl: 'https://example.test', username: 'fixture', password: 'fixture' }), /Verschlüsselter Speicher/)
  assert.deepEqual(websiteAccounts(), [])
})
