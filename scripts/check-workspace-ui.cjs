// Exercise the built app in an isolated profile. Text requests are intercepted;
// no model account, real microphone, or external action is used.
const { _electron } = require('playwright-core')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve, dirname } = require('node:path')
const assert = require('node:assert/strict')

;(async () => {
  const profile = mkdtempSync(join(tmpdir(), 'james-workspace-ui-'))
  const userData = join(profile, 'void-jarvis')
  const wrapper = resolve('out/workspace-ui-wrapper.cjs')
  mkdirSync(userData, { recursive: true })
  mkdirSync(resolve('out/audit'), { recursive: true })
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ setupDone: true, wake: { enabled: false, clap: false }, automaticBackups: false }))
  writeFileSync(wrapper, `const {app}=require('electron');app.setPath('appData',${JSON.stringify(profile)});app.setPath('userData',${JSON.stringify(userData)});require('./main/index.js')`)
  let app
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: [wrapper, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], timeout: 30000 })
    await app.firstWindow()
    const page = await (async () => {
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        const home = app.windows().find(p => p.url().includes('crystal.html'))
        if (home) return home
        await new Promise(done => setTimeout(done, 100))
      }
      throw new Error('Home window did not appear')
    })()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const field = page.getByRole('textbox', { name: 'Nachricht an James', exact: true })
    await field.waitFor()
    await page.waitForFunction(() => !document.querySelector('.home-ask-field').disabled)
    await page.evaluate(() => {
      window.uiRequests = []
      window.uiInterrupts = 0
      const dispatch = window.dispatchEvent.bind(window)
      window.dispatchEvent = event => {
        if (event.type === 'jarvis:text') { window.uiRequests.push(event.detail); return true }
        if (event.type === 'jarvis:interrupt') { window.uiInterrupts++; return true }
        return dispatch(event)
      }
    })
    await page.screenshot({ path: resolve('out/audit/workspace-ready.png') })
    await field.fill('Erste Zeile')
    await field.press('End')
    await field.press('Shift+Enter')
    await field.press('Z')
    assert.equal(await field.inputValue(), 'Erste Zeile\nZ')
    assert.equal(await page.evaluate(() => window.uiRequests.length), 0)
    await field.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })))
    assert.equal(await page.evaluate(() => window.uiRequests.length), 0, 'IME confirmation must not submit')
    await field.press('Enter')
    assert.equal(await page.locator('.home-ask').getAttribute('aria-busy'), 'true')
    assert.equal(await field.inputValue(), 'Erste Zeile\nZ', 'Pending draft should remain available')
    await field.press('Enter')
    assert.equal(await page.evaluate(() => window.uiRequests.length), 1, 'Duplicate submit must be blocked')
    await page.evaluate(() => window.uiRequests.at(-1).onResult(false))
    await page.getByRole('status').filter({ hasText: 'Senden fehlgeschlagen' }).waitFor()
    await page.locator('.home-ask[aria-busy="false"]').waitFor()
    assert.equal(await field.inputValue(), 'Erste Zeile\nZ')
    await field.press('Enter')
    await field.fill('Nächster Entwurf')
    await page.evaluate(() => window.uiRequests.at(-1).onResult(true))
    await page.locator('.home-ask[aria-busy="false"]').waitFor()
    assert.equal(await field.inputValue(), 'Nächster Entwurf', 'Success must preserve a newer draft')
    await field.press('Enter')
    await page.evaluate(() => window.uiRequests.at(-1).onResult(true))
    await page.waitForFunction(() => document.querySelector('.home-ask-field').value === '')
    await page.getByRole('button', { name: 'Fertigkeiten', exact: true }).focus()
    await page.keyboard.press('Control+l')
    assert.equal(await field.evaluate(element => element === document.activeElement), true)
    await field.fill('/skills')
    await field.press('Enter')
    await page.getByRole('region', { name: 'Fertigkeiten-Bibliothek' }).waitFor()
    await page.getByRole('button', { name: 'Fertigkeiten schließen' }).click()
    const log = page.getByRole('button', { name: /Aktionslog/ })
    await log.click()
    await page.getByRole('complementary', { name: 'Aktionslog', exact: true }).waitFor()
    await log.click()
    await app.evaluate(({ BrowserWindow }) => {
      const home = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('crystal.html'))
      home.webContents.send('activity:update', { items: [
        { id: 'new', source: 'tool', label: 'Aktueller Arbeitsschritt', status: 'running', startedAt: Date.now() },
        { id: 'earlier', source: 'tool', label: 'Früher begonnener Arbeitsschritt', status: 'running', startedAt: Date.now() - 5000 },
        ...Array.from({ length: 6 }, (_, i) => ({ id: `old-${i}`, source: 'tool', label: 'Älterer Arbeitsschritt', status: 'ok', startedAt: Date.now() - 10000, durationMs: 100 }))
      ], plan: null })
    })
    await page.locator('.home-dock').getByText('Aktueller Arbeitsschritt', { exact: true }).waitFor()
    await page.locator('.home-status').getByText('Aktueller Arbeitsschritt', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Stoppen', exact: true }).click()
    assert.equal(await page.evaluate(() => window.uiInterrupts), 1)
    await app.evaluate(({ BrowserWindow }) => {
      const home = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('crystal.html'))
      home.webContents.send('activity:update', { items: [], plan: null })
      home.webContents.send('display:card', { kind: 'agenda', id: 'ui-answer', at: Date.now(), source: 'test', range: 'Dein Tag · Testdaten', events: [{ title: 'Projekt fertigstellen', start: '2026-10-16T15:00:00+02:00', end: '2026-10-16T16:00:00+02:00' }] })
    })
    await page.locator('.answer-card').waitFor()
    assert.equal(await page.locator('.home').getAttribute('data-compact'), 'true')
    for (const [width, height] of [[900, 640], [520, 480], [1400, 900]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('crystal.html')).setSize(...size), [width, height])
      await page.waitForFunction(() => !document.documentElement.scrollWidth || document.documentElement.scrollWidth <= innerWidth)
      const dock = await page.locator('.home-dock').boundingBox()
      assert.ok(dock && dock.y >= 0 && dock.y + dock.height <= await page.evaluate(() => innerHeight) + 1, `Composer fits ${width}×${height}`)
      for (const button of await page.locator('.home-bar button').all()) {
        const box = await button.boundingBox()
        assert.ok(box && box.x >= 0 && box.x + box.width <= await page.evaluate(() => innerWidth), 'Toolbar control is clipped')
      }
      await page.screenshot({ path: resolve(`out/audit/workspace-${width}x${height}.png`) })
    }
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      ipcMain.removeHandler('research:list')
      ipcMain.handle('research:list', () => [{ id: 'ui-finished-research', query: 'Fertige Recherche · Testdaten', status: 'completed', startedAt: Date.now() - 60000, finishedAt: Date.now() }])
      BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('crystal.html')).webContents.send('research:progress', { id: 'ui-finished-research', thought: 'Ergebnis ist bereit' })
    })
    await page.getByRole('button', { name: 'Bericht lesen', exact: true }).click()
    assert.equal(await page.locator('.home-card-research').count(), 0, 'Completed result can be opened and dismissed')
    await page.getByRole('button', { name: 'Einstellungen', exact: true }).click()
    let settings
    for (let i = 0; i < 100 && !settings; i++) {
      settings = app.windows().find(p => p.url().includes('settings.html'))
      if (!settings) await new Promise(done => setTimeout(done, 100))
    }
    assert.ok(settings, 'Settings window should open')
    settings.on('pageerror', error => errors.push(error.message))
    await settings.getByRole('navigation', { name: 'Einstellungen', exact: true }).getByRole('button', { name: 'Übersicht', exact: true }).click()
    await settings.getByRole('heading', { name: 'Mach es dir einfach.', exact: true }).waitFor()
    await settings.keyboard.press('Control+k')
    const search = settings.locator('#settings-search')
    assert.equal(await search.evaluate(element => element === document.activeElement), true)
    await search.fill('Mikrofon')
    await search.press('Enter')
    await settings.locator('.settings-main[aria-label="Audio"]').waitFor()
    assert.equal(new URL(settings.url()).hash, '#audio')
    await settings.keyboard.press('Control+k')
    await search.fill('plugins')
    await settings.locator('.settings-search-results').getByRole('button', { name: /Konnektoren/ }).click()
    await settings.locator('.settings-main[aria-label="Konnektoren"]').waitFor()
    await settings.keyboard.press('Control+k')
    await search.fill('xyz-kein-treffer')
    await settings.getByRole('status').filter({ hasText: '0 Bereiche gefunden' }).waitFor()
    await search.press('Escape')
    assert.equal(await search.inputValue(), '')
    await settings.screenshot({ path: resolve('out/audit/workspace-settings.png') })
    assert.deepEqual(errors, [], 'No renderer errors')
    console.log('PASS: multiline/IME-safe composer, duplicate protection, failed/new draft retention, shortcuts, skills, activity/stop, completed research, compact cards, 3 window sizes, searchable deep settings, no renderer errors')
  } finally {
    if (app) await app.close()
    rmSync(wrapper, { force: true })
    assert.equal(dirname(profile), tmpdir())
    assert.ok(profile.startsWith(join(tmpdir(), 'james-workspace-ui-')))
    rmSync(profile, { recursive: true, force: true })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
