import assert from 'node:assert/strict'
import { it } from 'node:test'
import { allowedBrowserNavigation, browserUrl, clampBrowserBounds } from '@shared/browser'

it('accepts web addresses without allowing file access, script URLs or embedded credentials', () => {
  assert.equal(browserUrl('www.icloud.com/mail/'), 'https://www.icloud.com/mail/')
  assert.equal(browserUrl('https://www.icloud.com/'), 'https://www.icloud.com/')
  assert.equal(allowedBrowserNavigation('about:blank'), true)
  for (const input of ['file:///C:/secret', 'javascript:alert(1)', 'data:text/html,x', 'ms-settings:privacy',
    'https://user:password@icloud.com/', '', 'hello world', 'https://ic\nloud.com/']) {
    assert.throws(() => browserUrl(input))
    assert.equal(allowedBrowserNavigation(input), false)
  }
  assert.equal(allowedBrowserNavigation('icloud.com'), false)
  assert.equal(allowedBrowserNavigation('https://www.icloud.com'), true)
})

it('clamps native website bounds to the host and rejects malformed geometry', () => {
  assert.deepEqual(clampBrowserBounds({ x: 600, y: 130, width: 800, height: 900 }, 1000, 640),
    { x: 600, y: 130, width: 400, height: 510 })
  assert.deepEqual(clampBrowserBounds({ x: -10, y: -20, width: 200, height: 300 }, 1000, 640),
    { x: 0, y: 0, width: 200, height: 300 })
  for (const input of [null, {}, { x: 0, y: 0, width: Infinity, height: 5 },
    { x: 0, y: 0, width: -1, height: 5 }, { x: 0, y: 800, width: 200, height: 5 }]) {
    assert.equal(clampBrowserBounds(input, 1000, 640), null)
  }
})

it('keeps the browser window to a stated purpose with safe text', async () => {
  const { cleanPurpose, browserHost, DEFAULT_PURPOSE } = await import('@shared/browser')
  assert.deepEqual(cleanPurpose(null), DEFAULT_PURPOSE)
  assert.deepEqual(cleanPurpose({ kind: 'login', title: 'Bei Apple anmelden', hint: 'Anmelden', watch: 'icloud' }),
    { kind: 'login', title: 'Bei Apple anmelden', hint: 'Anmelden', watch: 'icloud' })
  const odd = cleanPurpose({ kind: 'evil', title: 'x'.repeat(200) + '\u0000', hint: '', watch: 'other' })
  assert.equal(odd.kind, 'choice')
  assert.equal(odd.title.length, 80)
  assert.equal(odd.hint, DEFAULT_PURPOSE.hint)
  assert.equal('watch' in odd, false)
  assert.equal(browserHost('https://idmsa.apple.com/appleauth'), 'idmsa.apple.com')
  assert.equal(browserHost('about:blank'), '')
})
