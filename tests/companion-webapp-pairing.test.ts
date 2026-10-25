import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { JAMES_WEB_APP, jamesWebAppPairing, parseJamesWebAppInfo } from '@shared/companion'
import { forgetJamesWebApp, jamesWebApp } from '../src/main/companion/webapp'

describe('Kopplungslink für die James-App', () => {
  it('führt Adresse und Marke ins Fragment der App', () => {
    const link = jamesWebAppPairing('https://192.168.1.20:8788/', 'abcDEF123-_x')
    assert.equal(link, `${JAMES_WEB_APP}#pc=192.168.1.20:8788&token=abcDEF123-_x`)
    const params = new URLSearchParams(new URL(link!).hash.slice(1))
    assert.equal(params.get('pc'), '192.168.1.20:8788')
    assert.equal(params.get('token'), 'abcDEF123-_x')
  })

  it('nimmt Tailscale-Namen und kodiert Sonderzeichen der Marke', () => {
    const link = jamesWebAppPairing('https://James-PC.tail1234.ts.net:8788', 'a+b/c=d&e#f12')!
    const params = new URLSearchParams(new URL(link).hash.slice(1))
    assert.equal(params.get('pc'), 'james-pc.tail1234.ts.net:8788')
    assert.equal(params.get('token'), 'a+b/c=d&e#f12')
  })

  it('gibt ohne gültige Adresse oder Marke keinen Link', () => {
    assert.equal(jamesWebAppPairing('https://192.168.1.20:8788', 'kurz'), null)
    assert.equal(jamesWebAppPairing('https://evil.invalid@x:8788', 'abcdefgh123'), null)
    assert.equal(jamesWebAppPairing('', 'abcdefgh123'), null)
  })
})

describe('Adresse der James-App aus GitHub', () => {
  it('übernimmt Version und Adresse aus version.json', () => {
    const info = parseJamesWebAppInfo({ version: '0.2.41', date: '2026-10-25T09:28:41Z', app: 'https://james-marktplatz.netlify.app/jarvis-iphone/' })
    assert.deepEqual(info, { url: 'https://james-marktplatz.netlify.app/jarvis-iphone/', version: '0.2.41', date: '2026-10-25T09:28:41Z', fromGitHub: true })
  })

  it('lenkt die Marke nie an eine fremde Adresse', () => {
    for (const app of ['https://evil.invalid/', 'http://nivarro-boop.github.io/jarvis-iphone/', 'https://nivarro-boop.github.io.evil.invalid/', 'https://x@nivarro-boop.github.io/']) {
      assert.equal(parseJamesWebAppInfo({ version: '0.2.1', app }).url, JAMES_WEB_APP, app)
      assert.ok(jamesWebAppPairing('https://192.168.1.20:8788', 'abcdefgh123', app)!.startsWith(JAMES_WEB_APP), app)
    }
  })

  it('holt version.json, merkt sie sich und fällt ohne Netz auf die eingebaute Adresse zurück', async () => {
    forgetJamesWebApp()
    let calls = 0
    const ok = (async () => {
      calls++
      return new Response(JSON.stringify({ version: '0.2.42', date: '2026-10-25T10:00:00Z', app: JAMES_WEB_APP }))
    }) as typeof fetch
    assert.equal((await jamesWebApp(ok, 1_000)).version, '0.2.42')
    assert.equal((await jamesWebApp(ok, 2_000)).version, '0.2.42')
    assert.equal(calls, 1)

    forgetJamesWebApp()
    const down = (async () => {
      throw new Error('offline')
    }) as typeof fetch
    assert.deepEqual(await jamesWebApp(down, 3_000), { url: JAMES_WEB_APP, version: null, date: null, fromGitHub: false })
  })
})
