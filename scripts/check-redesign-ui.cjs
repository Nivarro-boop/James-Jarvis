const { _electron } = require('playwright-core')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const assert = require('node:assert/strict')

;(async () => {
  const profile = mkdtempSync(join(tmpdir(), 'james-redesign-'))
  const data = join(profile, 'void-jarvis'); mkdirSync(data)
  const audit = resolve('out/audit/redesign'); mkdirSync(audit, { recursive: true })
  const wrapper = resolve('out/redesign-wrapper.cjs')
  writeFileSync(join(data, 'settings.json'), JSON.stringify({ setupDone: true, gamingMode: true,
    pcProfile: false, dailyBriefing: false, automaticBackups: false, useDeviceLocation: false,
    wake: { enabled: false, clap: false }, diagnosticReporting: { enabled: false, automatic: false, capabilityGaps: false, url: '' },
    speech: { provider: 'gemini', hearProvider: 'gemini', thinkProvider: 'gemini' }
  }))
  writeFileSync(join(data, 'study.json'), JSON.stringify({ version: 1, decks: [{ id: 'demo', title: 'Eine kleine Wissenspause', created: 0,
    cards: [{ id: 'one', question: 'Welche Stadt ist die Hauptstadt von Portugal?', answer: 'Lissabon', options: ['Porto', 'Lissabon', 'Faro', 'Braga'], box: 0, due: 0, right: 0, wrong: 0 }]
  }] }))
  writeFileSync(wrapper, `const {app}=require('electron');app.setPath('appData',${JSON.stringify(profile)});app.setPath('userData',${JSON.stringify(data)});require('./main/index.js')`)
  let app
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: [wrapper, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], timeout: 30000 })
    const errors = []
    app.on('window', page => page.on('pageerror', e => errors.push(e.message)))
    await app.firstWindow()
    let page
    for (let i = 0; i < 100 && !page; i++) { page = app.windows().find(p => p.url().includes('crystal.html')); if (!page) await new Promise(r => setTimeout(r, 100)) }
    assert.ok(page)
    page.on('pageerror', e => errors.push(e.message))
    await page.locator('.command-form').waitFor()
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      ipcMain.removeHandler('local:assets'); ipcMain.handle('local:assets', () => [])
      const home = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('crystal.html'))
      home.setSize(1100, 820)
    })
    await page.reload(); await page.locator('.command-form').waitFor()
    await page.screenshot({ path: join(audit, 'home.png') })
    // Synthetic acknowledgement exercises the composer without sending an account request.
    await page.evaluate(() => {
      const original = window.dispatchEvent.bind(window)
      window.dispatchEvent = event => {
        if (event.type !== 'jarvis:text') return original(event)
        window.dispatchEvent = original
        setTimeout(() => event.detail.onResult?.(false), 60)
        return true
      }
    })
    const composer = page.getByRole('textbox', { name: 'Nachricht an James', exact: true })
    await composer.fill('Plane meinen Nachmittag.')
    await page.getByRole('button', { name: 'Nachricht senden' }).click()
    await page.getByRole('alert').filter({ hasText: 'Nicht gesendet' }).waitFor()
    assert.equal(await composer.inputValue(), 'Plane meinen Nachmittag.')
    await page.reload(); await composer.waitFor()
    assert.equal(await composer.inputValue(), 'Plane meinen Nachmittag.')
    await page.evaluate(() => {
      const original = window.dispatchEvent.bind(window)
      window.dispatchEvent = event => {
        if (event.type !== 'jarvis:text') return original(event)
        window.dispatchEvent = original
        event.detail.onResult?.(true)
        return true
      }
    })
    await page.getByRole('button', { name: 'Nachricht senden' }).click()
    assert.equal(await composer.inputValue(), '', 'successful acknowledgement clears the submitted draft')
    await composer.fill('')
    const menu = page.getByRole('button', { name: 'Menü', exact: true })
    await menu.click()
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem')
    await page.keyboard.press('End')
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Lizenzen')
    await page.keyboard.press('Escape')
    assert.equal(await menu.getAttribute('aria-expanded'), 'false')
    assert.equal(await menu.evaluate(el => el === document.activeElement), true)
    await page.getByRole('navigation', { name: 'Schnellzugriff' }).getByRole('button', { name: /Lernen/ }).click()
    await page.getByRole('button', { name: /Eine kleine Wissenspause/ }).click()
    await page.getByRole('heading', { name: 'Welche Stadt ist die Hauptstadt von Portugal?' }).waitFor()
    await page.screenshot({ path: join(audit, 'quiz.png') })
    await page.getByRole('button', { name: /B.*Lissabon/ }).click({ clickCount: 2 })
    await page.getByRole('status').filter({ hasText: 'Richtig.' }).waitFor()
    const decks = await page.evaluate(() => window.jarvis.invoke('study:decks'))
    assert.equal(decks[0].stats.right, 1, 'double click grades once')
    await page.getByRole('button', { name: 'Quiz schließen' }).click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('crystal.html')).setSize(520, 480))
    await page.screenshot({ path: join(audit, 'home-small.png') })
    const field = await composer.boundingBox()
    assert.ok(field && field.y >= 0 && field.y + field.height <= await page.evaluate(() => innerHeight), 'composer remains visible')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.evaluate(() => window.jarvis.invoke('app:openSettings', { section: 'overview' }))
    let settings
    for (let i = 0; i < 100 && !settings; i++) { settings = app.windows().find(p => p.url().includes('settings.html')); if (!settings) await new Promise(r => setTimeout(r, 100)) }
    assert.ok(settings)
    await settings.locator('.settings-shell').waitFor()
    await settings.screenshot({ path: join(audit, 'settings.png') })
    await settings.getByRole('searchbox').fill('Mikrofon')
    await settings.locator('.settings-search-results .nav-item').first().click()
    await settings.getByRole('main', { name: /Mikrofon/ }).waitFor()
    await settings.screenshot({ path: join(audit, 'audio-settings.png') })
    assert.deepEqual(errors, [])
    console.log('PASS: home, small window, draft preservation/reload, keyboard menu, quiz double click, settings search; isolated profile, no real account requests.')
  } catch (error) {
    if (app) for (const [i, page] of app.windows().entries()) {
      console.log(page.url(), (await page.locator('body').innerText().catch(() => '')).slice(0, 1300))
      await page.screenshot({ path: join(audit, `failure-${i}.png`) }).catch(() => {})
    }
    throw error
  } finally {
    if (app) await app.close()
    rmSync(wrapper, { force: true })
    assert.ok(profile.startsWith(join(tmpdir(), 'james-redesign-')))
    rmSync(profile, { recursive: true, force: true })
  }
})().catch(e => { console.error(e); process.exitCode = 1 })
