const { _electron } = require('playwright-core')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { createServer } = require('node:http')
const assert = require('node:assert/strict')

;(async () => {
  const profile = mkdtempSync(join(tmpdir(), 'james-browser-ui-'))
  const data = join(profile, 'void-jarvis'); mkdirSync(data)
  const audit = resolve('out/audit/browser'); mkdirSync(audit, { recursive: true })
  const wrapper = resolve('out/browser-ui-wrapper.cjs')
  writeFileSync(join(data, 'settings.json'), JSON.stringify({ setupDone: true, gamingMode: true,
    pcProfile: false, dailyBriefing: false, automaticBackups: false, useDeviceLocation: false,
    wake: { enabled: false, clap: false }, diagnosticReporting: { enabled: false, automatic: false, capabilityGaps: false, url: '' }
  }))
  writeFileSync(wrapper, `const {app}=require('electron');app.setPath('appData',${JSON.stringify(profile)});app.setPath('userData',${JSON.stringify(data)});require('./main/index.js')`)
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (req.url === '/second') return res.end('<title>Zweite Seite</title><h1>Navigation funktioniert</h1>')
    res.end(`<title>Browser-Test</title><style>body{font:20px sans-serif;background:#edf4ef;color:#163930;padding:40px}button,a{padding:12px;display:block}</style><h1>Webseite direkt in James</h1><p>Isolierter Browser-Test ohne echte Kontodaten.</p><a href="/second">Zweite Seite</a><button onclick="window.open('/popup','auth')">Popup öffnen</button><button onclick="location.href='file:///C:/Windows/win.ini'">Unsicherer Link</button>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/`
  let app
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: [wrapper, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], timeout: 30000 })
    await app.firstWindow()
    let page
    for (let i = 0; i < 100 && !page; i++) { page = app.windows().find(p => p.url().includes('crystal.html')); if (!page) await new Promise(r => setTimeout(r, 100)) }
    assert.ok(page)
    page.setDefaultTimeout(15000)
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    await page.locator('.home-bar').waitFor()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('crystal.html')).setSize(1400, 850))
    await page.getByRole('button', { name: 'Browser', exact: true }).click()
    await page.getByRole('heading', { name: 'Alles neben deinem Gespräch.' }).waitFor()
    assert.equal(await page.getByRole('textbox', { name: 'Nachricht an James' }).isVisible(), false)
    const panelBefore = await page.getByLabel('Integrierter Browser', { exact: true }).boundingBox()
    const handle = page.getByRole('button', { name: 'Browser verschieben', exact: true })
    await handle.focus()
    await handle.press('ArrowRight')
    const panelAfter = await page.getByLabel('Integrierter Browser', { exact: true }).boundingBox()
    assert.equal(panelAfter.x, panelBefore.x + 20)
    await page.screenshot({ path: join(audit, 'browser-start.png') })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.getByRole('textbox', { name: 'Webadresse' }).fill(url)
    await page.getByRole('button', { name: 'Webseite öffnen', exact: true }).click()
    await page.getByRole('tab', { name: /Browser-Test/ }).waitFor()
    const inspect = () => app.evaluate(({ BrowserWindow }) => {
      const host = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('crystal.html'))
      const views = host.contentView.children.filter(v => v.webContents && v.webContents !== host.webContents)
      return views.map(v => ({ id: v.webContents.id, url: v.webContents.getURL(), bounds: v.getBounds(), visible: v.getVisible(), preferences: v.webContents.getLastWebPreferences() }))
    })
    let views = await inspect()
    assert.equal(views.length, 1)
    assert.ok(views[0].visible)
    assert.ok(views[0].bounds.x >= panelAfter.x && views[0].bounds.y > 90)
    const grip = await handle.boundingBox()
    await page.mouse.move(grip.x + 40, grip.y + 15)
    await page.mouse.down()
    await page.mouse.move(grip.x + 130, grip.y + 45, { steps: 5 })
    await page.mouse.up()
    await page.waitForTimeout(100)
    const moved = await page.getByLabel('Integrierter Browser', { exact: true }).boundingBox()
    assert.equal(moved.x, panelAfter.x + 90)
    assert.ok((await inspect())[0].bounds.x >= moved.x)
    assert.equal(views[0].preferences.nodeIntegration, false)
    assert.equal(views[0].preferences.contextIsolation, true)
    assert.equal(views[0].preferences.sandbox, true)
    assert.ok(!views[0].preferences.preload)
    await page.evaluate(() => { const dialog = document.createElement('div'); dialog.id = 'browser-test-dialog'; dialog.setAttribute('role', 'dialog'); document.body.appendChild(dialog) })
    await page.waitForTimeout(100)
    assert.ok((await inspect()).every(v => !v.visible), 'native websites must not cover application dialogs')
    await page.evaluate(() => document.getElementById('browser-test-dialog').remove())
    await page.waitForTimeout(100)
    assert.ok((await inspect()).some(v => v.visible))
    const guestId = views[0].id
    const windowCount = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    assert.deepEqual(await app.evaluate(async ({ webContents }, id) => webContents.fromId(id).executeJavaScript('({node:typeof require,bridge:typeof window.jarvis})'), guestId), { node: 'undefined', bridge: 'undefined' })
    await page.waitForFunction(async () => !(await window.jarvis.invoke('browser:status')).tabs.some(t => t.loading))
    await app.evaluate(async ({ webContents }, id) => webContents.fromId(id).executeJavaScript("document.querySelector('a').click()", true), guestId)
    await page.getByRole('tab', { name: /Zweite Seite/ }).waitFor()
    await page.getByRole('button', { name: 'Zurück', exact: true }).click()
    await page.getByRole('tab', { name: /Browser-Test/ }).waitFor()
    await app.evaluate(async ({ webContents }, id) => webContents.fromId(id).executeJavaScript("document.querySelector('button').click()", true), guestId)
    await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 2)
    views = await inspect()
    assert.equal(views.length, 2)
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), windowCount, 'popup must be a tab, not another native window')
    await page.waitForFunction(async () => (await window.jarvis.invoke('browser:status')).tabs.every(t => t.url && !t.loading), { timeout: 15000 })
    assert.equal(await app.evaluate(async ({ webContents }, id) => webContents.fromId(id).executeJavaScript('Boolean(window.opener)'), views[1].id), true)
    await page.getByRole('button', { name: /Tab schließen:/ }).last().click()
    await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 1)
    await page.getByRole('button', { name: 'Browser ausblenden' }).click()
    await page.waitForFunction(() => !document.querySelector('.browser-panel'))
    assert.ok((await inspect()).every(v => !v.visible))
    await page.getByRole('button', { name: 'Browser', exact: true }).click()
    await page.getByRole('tab', { name: /Browser-Test/ }).waitFor()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('crystal.html')).setSize(540, 700))
    await page.waitForFunction(() => innerWidth < 760)
    await page.screenshot({ path: join(audit, 'browser-narrow.png') })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.getByRole('button', { name: 'Browser ausblenden' }).click()
    await page.getByRole('button', { name: 'Browser', exact: true }).waitFor()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('crystal.html')).setSize(1400, 850))
    await page.getByRole('button', { name: 'Browser', exact: true }).click()
    await page.getByRole('button', { name: 'Neuer Tab' }).click()
    await page.getByRole('heading', { name: 'Alles neben deinem Gespräch.' }).waitFor()
    // API and Electron both reject non-web protocols; the existing tab must survive.
    assert.equal(await page.evaluate(async () => { try { await window.jarvis.invoke('browser:open', { url: 'file:///C:/Windows/win.ini' }); return false } catch { return true } }), true)
    await page.screenshot({ path: join(audit, 'browser-final.png') })
    assert.deepEqual(errors, [])
    await app.evaluate(async ({ webContents }, { id, url }) => {
      const session = webContents.fromId(id).session
      await session.cookies.set({ url, name: 'browser-test-session', value: 'fixture-only', expirationDate: Date.now() / 1000 + 3600 })
      await session.cookies.flushStore()
    }, { id: guestId, url })
    await app.close(); app = null
    app = await _electron.launch({ executablePath: require('electron'), args: [wrapper, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], timeout: 30000 })
    await app.firstWindow()
    page = undefined
    for (let i = 0; i < 100 && !page; i++) { page = app.windows().find(p => p.url().includes('crystal.html')); if (!page) await new Promise(r => setTimeout(r, 100)) }
    assert.ok(page); page.setDefaultTimeout(15000)
    await page.locator('.home-bar').waitFor()
    await page.evaluate(url => window.jarvis.invoke('browser:open', { url }), url)
    await page.getByRole('tab', { name: /Browser-Test/ }).waitFor()
    const persisted = await app.evaluate(async ({ session }, url) => session.fromPartition('persist:james-browser').cookies.get({ url, name: 'browser-test-session' }), url)
    assert.equal(persisted[0]?.value, 'fixture-only', 'browser login cookies must survive an app restart')
    if (process.argv.includes('--apple')) {
      await page.evaluate(() => window.jarvis.invoke('browser:open', { url: 'https://www.icloud.com/' }))
      await page.getByRole('tab', { name: /iCloud/i }).waitFor({ timeout: 30000 })
      const apple = await app.evaluate(async ({ webContents }) => {
        const guest = webContents.getAllWebContents().find(w => w.getURL().startsWith('https://www.icloud.com/'))
        return { title: guest.getTitle(), url: guest.getURL(), text: await guest.executeJavaScript('(document.body?.innerText || "").slice(0, 1200)') }
      })
      assert.match(apple.url, /^https:\/\/www\.icloud\.com\//)
      writeFileSync(join(audit, 'apple-smoke.json'), JSON.stringify(apple, null, 2))
      console.log('PASS: public iCloud page loads in the embedded browser; no credentials entered.')
    }
    console.log('PASS: native view, hidden composer, movable panel, tabs, history, popup opener, isolated session, no Node/preload, modal protection, hide/reopen, narrow layout, protocol restrictions, cookies survive restart.')
  } catch (error) {
    if (app) {
      const home = app.windows().find(p => p.url().includes('crystal.html'))
      if (home) {
        console.log('Browser state:', await home.evaluate(() => window.jarvis.invoke('browser:status')).catch(() => null))
        await home.screenshot({ path: join(audit, 'failure.png') }).catch(() => {})
      }
    }
    throw error
  } finally {
    if (app) await app.close()
    await new Promise(resolve => server.close(resolve))
    // Verify the exact test root before recursively removing the isolated profile.
    assert.equal(resolve(profile).startsWith(resolve(tmpdir()) + require('node:path').sep), true)
    assert.ok(require('node:path').basename(profile).startsWith('james-browser-ui-'))
    rmSync(profile, { recursive: true, force: true })
    rmSync(wrapper, { force: true })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
