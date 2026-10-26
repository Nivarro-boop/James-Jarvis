// Regression checks for account UI defects using mocked IPC; no real accounts.
const { build } = require('esbuild')
const { chromium } = require('playwright-core')
const { resolve } = require('node:path')
const assert = require('node:assert/strict')
const { readFileSync, mkdirSync } = require('node:fs')
;(async () => {
  const output = await build({ stdin: { resolveDir: resolve('.'), loader: 'tsx', contents: `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { AccountsView } from './src/renderer/accounts/AccountsView'
    window.pending = []
    window.sends = []
    window.jarvis = { on: () => () => {}, invoke: async (channel, args) => {
      if (channel === 'icloud:status') return { web: false, mailConfigured: true, mailAddress: 'audit@example.invalid' }
      if (channel === 'icloud:mailList') return await new Promise(resolve => window.pending.push({ folder: args.folder, resolve }))
      if (channel === 'icloud:mailRead') return { uid: args.uid, von: 'sender@example.invalid', an: 'audit@example.invalid', betreff: 'Test', text: 'Synthetic', anhaenge: [] }
      if (channel === 'icloud:mailSend') { window.sends.push(args); return await new Promise(resolve => { window.finishMail = resolve }) }
      if (channel === 'icloud:events') return []
      if (channel === 'health:status') return { takenAt: null }
      if (channel === 'accounts:list') return []
      return { connected: false }
    } }
    createRoot(document.getElementById('root')).render(<AccountsView />)
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', outdir: resolve('out/audit/frontend'), logLevel: 'silent', alias: { '@shared': resolve('src/shared') } })
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } })
    page.on('pageerror', error => console.error(error.message))
    await page.setContent('<div id="root"></div>')
    await page.addStyleTag({ content: readFileSync('src/renderer/styles.css', 'utf8') + readFileSync('src/renderer/accounts/accounts.css', 'utf8') })
    await page.addScriptTag({ content: output.outputFiles.find(f => f.path.endsWith('.js')).text })
    await page.waitForFunction(() => window.jarvis)
    // React effects must be mounted before sending the application event.
    await page.waitForTimeout(100)
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('jarvis:accounts', { detail: 'mail' })))
    await page.waitForFunction(() => window.pending.length === 1)
    await page.getByLabel('Ordner', { exact: true }).selectOption('Archive')
    await page.waitForFunction(() => window.pending.length === 2)
    await page.evaluate(() => window.pending[1].resolve([{ uid: 2, von: 'archive@example.invalid', betreff: 'NEUES ARCHIV', gelesen: true }]))
    await page.getByText('NEUES ARCHIV', { exact: true }).waitFor()
    await page.evaluate(() => window.pending[0].resolve([{ uid: 1, von: 'inbox@example.invalid', betreff: 'ALTER POSTEINGANG', gelesen: true }]))
    await page.waitForTimeout(100)
    assert.equal(await page.getByText('ALTER POSTEINGANG', { exact: true }).count(), 0)
    await page.getByText('NEUES ARCHIV', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('Ordner', { exact: true }).inputValue(), 'Archive')
    console.log('PASS: late INBOX response cannot overwrite Archive')
    await page.getByRole('button', { name: 'Neue Mail', exact: true }).click()
    await page.getByLabel('An', { exact: true }).fill('draft@example.invalid')
    await page.getByLabel('Text', { exact: true }).fill('Entwurf behalten')
    await page.getByRole('button', { name: 'Kalender', exact: true }).click()
    await page.getByRole('button', { name: 'iCloud Mail', exact: true }).click()
    await page.getByRole('button', { name: 'Entwurf fortsetzen', exact: true }).click()
    await page.getByLabel('Text', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('Text', { exact: true }).inputValue(), 'Entwurf behalten')
    assert.equal(await page.getByLabel('An', { exact: true }).inputValue(), 'draft@example.invalid')
    console.log('PASS: mail draft survives account navigation')
    mkdirSync(resolve('out/audit/accounts'), { recursive: true })
    await page.screenshot({ path: resolve('out/audit/accounts/draft-preserved.png') })
    await page.getByRole('button', { name: 'Senden', exact: true }).click()
    await page.getByRole('button', { name: 'Ja, senden', exact: true }).evaluate(button => { button.click(); button.click() })
    await page.waitForFunction(() => window.sends.length === 1)
    await page.getByRole('button', { name: 'Kalender', exact: true }).click()
    await page.getByRole('button', { name: 'iCloud Mail', exact: true }).click()
    assert.equal(await page.getByLabel('Text', { exact: true }).isDisabled(), true)
    await page.evaluate(() => window.finishMail({ verschickt: true, an: 'draft@example.invalid' }))
    await page.getByRole('button', { name: 'Neue Mail', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.sends.length), 1)
    console.log('PASS: double-click sends once; navigation preserves the active send lock')
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
