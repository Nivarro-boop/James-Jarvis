const assert = require('node:assert/strict')
const { build } = require('esbuild')
const { chromium } = require('playwright-core')
const { readFileSync, mkdirSync } = require('node:fs')
const { resolve } = require('node:path')

// UI contract only: mocked transports, no account login, installation or model calls.
;(async () => {
  const output = await build({ stdin: { resolveDir: resolve('.'), loader: 'tsx', contents: `
    import React, { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import { McpSection } from './src/renderer/settings/Connectors'
    import { DEFAULT_SETTINGS } from './src/shared/config/defaults'
    let saved = structuredClone(DEFAULT_SETTINGS)
    const vault = new Map()
    window.navigation = []; window.reloads = 0; window.failReload = false
    window.getConfig = () => saved
    const secretStatus = id => Object.fromEntries((saved.mcpServers.find(s => s.id === id)?.secretEnv ?? []).map(name => [name, !!vault.get(id + ':' + name)]))
    const statuses = () => Object.fromEntries(saved.mcpServers.map(s => [s.id, !s.enabled ? { state: 'off', tools: 0 } : Object.values(secretStatus(s.id)).some(x => !x) ? { state: 'key', tools: 0 } : s.url && !Object.keys(s.headers ?? {}).length ? { state: 'login', tools: 0 } : { state: 'ok', tools: 2 }]))
    window.jarvis = { invoke: async (channel, args) => {
      if (channel === 'mcp:status') return statuses()
      if (channel === 'mcp:reload') { window.reloads++; if (window.failReload) throw new Error('Verbindungstest fehlgeschlagen'); return [] }
      if (channel === 'mcp:secretStatus') return secretStatus(args.id)
      if (channel === 'mcp:setSecret') { vault.set(args.id + ':' + args.name, args.value); return secretStatus(args.id) }
      if (channel === 'mcp:clearSecrets') return
      throw new Error('Unexpected mock channel: ' + channel)
    } }
    function App() {
      const [settings, setSettings] = useState(saved)
      const patch = async change => { saved = { ...saved, ...change }; setSettings(saved); return saved }
      return <div className="settings-shell"><nav className="settings-nav">James · Konnektoren</nav><main className="settings-main"><McpSection settings={settings} patch={patch} onNavigate={section => window.navigation.push(section)} /></main></div>
    }
    createRoot(document.getElementById('root')).render(<App />)
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', outdir: resolve('out/connectors-check'), logLevel: 'silent', alias: { '@shared': resolve('src/shared') } })
  const js = output.outputFiles.find(file => file.path.endsWith('.js')).text
  const css = [readFileSync('src/renderer/styles.css', 'utf8'), readFileSync('src/renderer/settings/settings.css', 'utf8'), output.outputFiles.find(file => file.path.endsWith('.css')).text].join('\n')
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1040, height: 760 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => route.abort())
    await page.setContent(`<html><head><style>${css}</style></head><body class="settings-body"><div id="root"></div><script>${js}</script></body></html>`)
    const search = page.getByRole('searchbox', { name: 'Konnektor finden' })
    await search.fill('Kalender')
    await page.getByRole('button', { name: /Google Kalender/ }).click()
    assert.deepEqual(await page.evaluate(() => window.navigation), ['keys'])
    await search.fill('Home Assistant')
    await page.getByRole('button', { name: /Home Assistant/ }).click()
    assert.deepEqual(await page.evaluate(() => window.navigation), ['keys', 'smarthome'])
    await search.fill('GitHub')
    await page.getByRole('button', { name: /^GitHub/ }).click()
    const github = page.locator('.mcp-card').filter({ has: page.locator('strong', { hasText: /^GitHub$/ }) })
    await github.waitFor()
    assert.equal(await github.getByRole('button', { name: 'Anmelden', exact: true }).count(), 0)
    const field = github.getByRole('textbox', { name: 'GitHub GITHUB_PERSONAL_ACCESS_TOKEN' })
    await field.fill('private-ui-test-token')
    await github.getByRole('button', { name: 'Speichern', exact: true }).click()
    await github.getByText('2 Werkzeuge', { exact: true }).waitFor()
    assert.equal(await field.inputValue(), '')
    assert.equal(await page.evaluate(() => window.getConfig().mcpServers[0].headers.Authorization), 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}')
    assert.doesNotMatch(await page.evaluate(() => JSON.stringify(window.getConfig().mcpServers)), /private-ui-test-token/)
    const json = page.getByRole('textbox', { name: 'Konnektor-Konfiguration' })
    await json.fill(JSON.stringify({ mcpServers: { Custom: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer imported-private-token' } } } }))
    await page.getByRole('button', { name: 'Konfiguration prüfen', exact: true }).click()
    await page.getByRole('region', { name: 'Import-Vorschau' }).waitFor()
    assert.equal(await page.evaluate(() => window.getConfig().mcpServers.length), 1, 'Preview must not connect')
    assert.doesNotMatch(await page.getByRole('region', { name: 'Import-Vorschau' }).innerText(), /imported-private-token/)
    await page.getByRole('button', { name: '1 Konnektor übernehmen', exact: true }).click()
    await page.waitForFunction(() => window.getConfig().mcpServers.length === 2)
    await page.waitForFunction(() => document.querySelector('[aria-label="Konnektor-Konfiguration"]').value === '')
    await page.getByRole('button', { name: 'Vorlage ohne Schlüssel exportieren', exact: true }).click()
    const exported = await page.getByRole('textbox', { name: 'Vorlage ohne Schlüssel', exact: true }).inputValue()
    assert.doesNotMatch(exported, /private-ui-test-token|imported-private-token/)
    assert.match(exported, /MCP_HEADER_AUTHORIZATION/)
    await search.fill('')
    await page.locator('summary').filter({ hasText: 'Eigenen Konnektor per Adresse verbinden' }).click()
    await page.getByRole('textbox', { name: 'Serveradresse', exact: true }).fill('ftp://localhost/mcp')
    await page.getByRole('button', { name: 'Konnektor hinzufügen', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: /https/ }).waitFor()
    assert.equal(await page.evaluate(() => window.getConfig().mcpServers.length), 2)
    await page.evaluate(() => { window.failReload = true })
    await page.getByRole('button', { name: 'Alle neu laden', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'Verbindungstest fehlgeschlagen' }).waitFor()
    await page.evaluate(() => { window.failReload = false })
    await page.getByRole('button', { name: 'Alle neu laden', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[role="alert"]'))
    mkdirSync(resolve('out/audit'), { recursive: true })
    await page.locator('.settings-main').evaluate(element => element.scrollTop = 0)
    await page.screenshot({ path: resolve('out/audit/connectors-library.png') })
    await page.setViewportSize({ width: 680, height: 620 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.screenshot({ path: resolve('out/audit/connectors-narrow.png') })
    assert.deepEqual(errors, [])
    console.log('PASS: built-in connector navigation, catalog search, protected GitHub header setup, import preview, secret-free export, invalid URL rejection, reload errors and narrow layout')
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
