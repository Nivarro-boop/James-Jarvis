const assert = require('node:assert/strict')
const { build } = require('esbuild')
const { chromium } = require('playwright-core')
const { readFileSync, mkdirSync } = require('node:fs')
const { resolve, join } = require('node:path')

// Component-only fixture: no controller, microphone, persisted settings or services.
;(async () => {
  const root = resolve('.')
  const output = await build({
    stdin: { contents: `
      import React from 'react'
      import { createRoot } from 'react-dom/client'
      import { Conversation } from './src/renderer/home/Conversation'
      import { useCrystal } from './src/renderer/store/crystalStore'
      window.fixture = useCrystal
      useCrystal.setState({ settings: {}, state: 'idle' })
      createRoot(document.getElementById('root')).render(<div className="home"><Conversation snapshot={{ items: [], plan: null }} /></div>)
    `, loader: 'tsx', resolveDir: root },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    outdir: resolve('out/conversation-check'), logLevel: 'silent', alias: { '@shared': join(root, 'src/shared') }
  })
  const js = output.outputFiles.find(file => file.path.endsWith('.js')).text
  const css = output.outputFiles.find(file => file.path.endsWith('.css')).text
  const globalCSS = readFileSync(resolve('src/renderer/styles.css'), 'utf8')
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 720 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => route.abort())
    await page.setContent(`<html><head><style>${globalCSS}\n${css}\nhtml,body{margin:0;padding:0;background:#111618}.home{height:100vh;padding:24px;display:block;font-family:system-ui}</style></head><body><div id="root"></div><script>${js}</script></body></html>`)
    assert.equal(await page.locator('.chat-suggestions button').count(), 3)
    await page.evaluate(() => {
      window.sent = []
      window.addEventListener('jarvis:text', event => window.sent.push(event.detail))
    })
    await page.getByRole('button', { name: 'Plane meinen Tag', exact: false }).click()
    assert.deepEqual(await page.evaluate(() => window.sent), ['Plane meinen Tag'])
    await page.evaluate(() => {
      window.fixture.setState({ captions: Array.from({ length: 18 }, (_, i) => ({ id: i + 1, who: i % 2 ? 'james' : 'user', text: `Nachricht ${i + 1}: ` + 'Ein lesbarer Gesprächsbeitrag. '.repeat(6), at: Date.now() })) })
    })
    await page.locator('.chat-message').last().waitFor()
    const scroller = page.locator('.conversation-scroll')
    const distanceToBottom = () => scroller.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)
    await page.waitForFunction(() => { const el = document.querySelector('.conversation-scroll'); return el.scrollHeight - el.scrollTop - el.clientHeight < 2 })
    await page.evaluate(() => window.fixture.getState().addCaption('james', ' Eine neue Textpassage während des Antwortens. '.repeat(10)))
    await page.waitForFunction(() => { const el = document.querySelector('.conversation-scroll'); return el.scrollHeight - el.scrollTop - el.clientHeight < 2 })
    assert.ok(await distanceToBottom() < 2, 'Streaming response stopped following the bottom')

    await scroller.evaluate(el => { el.scrollTop = el.scrollHeight / 3; el.dispatchEvent(new Event('scroll')) })
    await page.getByRole('button', { name: 'Zur neuesten Nachricht', exact: false }).waitFor()
    const anchorBefore = await scroller.evaluate(el => {
      const top = el.getBoundingClientRect().top
      const message = [...el.querySelectorAll('[data-caption-id]')].find(message => message.getBoundingClientRect().bottom > top)
      return { id: message.dataset.captionId, offset: message.getBoundingClientRect().top - top }
    })
    await page.evaluate(() => window.fixture.setState(state => ({ captions: [...state.captions.slice(1), { id: 19, who: 'james', text: 'Neue Antwort beim Lesen des Verlaufs. '.repeat(8), at: Date.now() }] })))
    await page.getByRole('button', { name: 'Neue Nachrichten', exact: false }).waitFor()
    const anchorOffset = await scroller.evaluate((el, id) => el.querySelector(`[data-caption-id="${id}"]`).getBoundingClientRect().top - el.getBoundingClientRect().top, anchorBefore.id)
    assert.ok(Math.abs(anchorOffset - anchorBefore.offset) < 2, 'Reading position moved when an old message was removed')
    await page.getByRole('button', { name: 'Neue Nachrichten', exact: false }).click()
    assert.ok(await distanceToBottom() < 2, 'Jump-to-latest did not reach the bottom')
    assert.equal(await page.locator('.conversation-jump').count(), 0)

    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copied = text } } }))
    const latestCopy = page.locator('.chat-copy').last()
    await latestCopy.click()
    await page.getByRole('button', { name: 'Antwort kopiert', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.copied), await page.locator('.chat-message p').last().innerText())
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Permission denied') } } }))
    await latestCopy.click()
    await page.getByRole('alert').filter({ hasText: 'Kopieren fehlgeschlagen' }).waitFor()
    assert.equal(await latestCopy.isEnabled(), true, 'Copy failure prevented a retry')

    await page.evaluate(() => window.fixture.setState({ state: 'thinking' }))
    assert.equal(await page.locator('.chat-suggestions button:not(:disabled)').count(), 0)
    await page.getByRole('status').filter({ hasText: 'James denkt nach' }).waitFor()
    await page.setViewportSize({ width: 520, height: 480 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Conversation overflows a narrow window')
    mkdirSync(resolve('out/audit'), { recursive: true })
    await page.screenshot({ path: resolve('out/audit/conversation-small.png') })
    assert.deepEqual(errors, [])
    console.log('PASS: suggestions, status, stream following, retained reading position after history trim, jump-to-latest, copy success/failure and 520px layout')
  } finally {
    await browser.close()
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
