const { _electron } = require('playwright-core')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { createServer } = require('node:http')
const assert = require('node:assert/strict')

/**
 * Anmeldefenster und Konten-Ansicht im echten Electron-Fenster.
 *
 * Isoliertes Profil und eine lokale Testseite; keine echten Konten. Der
 * Browser erscheint nur mit Zweck (Titel, Anleitung), zeigt den Rechnernamen,
 * hält Webseiten in einer Sandbox, macht Pop-ups zu Tabs, erkennt eine
 * iCloud-Anmeldung über das Cookie und behält Anmeldungen nach einem Neustart.
 * `--apple` lädt zusätzlich die öffentliche iCloud-Seite. Voraussetzung: `npm run build`.
 */
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
    res.end(`<title>Browser-Test</title><style>body{font:20px sans-serif;background:#edf4ef;color:#163930;padding:40px}button,a{padding:12px;display:block}</style><h1>Anmeldung im Test</h1><p>Isolierter Browser-Test ohne echte Kontodaten.</p><a href="/second">Zweite Seite</a><button onclick="window.open('/popup','auth')">Popup öffnen</button><button onclick="location.href='file:///C:/Windows/win.ini'">Unsicherer Link</button>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/`
  const purpose = { kind: 'login', title: 'Beim Testdienst anmelden', hint: 'Testanleitung: anmelden und danach Fertig.' }
  const launch = async () => {
    const app = await _electron.launch({ executablePath: require('electron'), args: [wrapper, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], timeout: 30000 })
    await app.firstWindow()
    let page
    for (let i = 0; i < 100 && !page; i++) { page = app.windows().find(p => p.url().includes('crystal.html')); if (!page) await new Promise(r => setTimeout(r, 100)) }
    assert.ok(page)
    page.setDefaultTimeout(15000)
    await page.locator('.home-bar').waitFor()
    return { app, page }
  }
  let app
  try {
    let page
    ;({ app, page } = await launch())
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('crystal.html')).setSize(1400, 850))
    // Kein allgemeiner Browser-Knopf mehr, dafür Konten.
    assert.equal(await page.getByRole('button', { name: 'Browser', exact: true }).count(), 0)
    await page.getByRole('button', { name: 'Konten', exact: true }).waitFor()

    await page.evaluate(({ url, purpose }) => window.jarvis.invoke('browser:open', { url, purpose }), { url, purpose })
    const dialog = page.getByRole('dialog', { name: 'Anmeldefenster' })
    await dialog.waitFor()
    await dialog.getByRole('heading', { name: purpose.title }).waitFor()
    await dialog.getByText(purpose.hint).waitFor()
    await dialog.getByText('127.0.0.1', { exact: true }).waitFor()
    await dialog.getByText('nicht verschlüsselt').waitFor()
    assert.equal(await page.getByRole('textbox', { name: 'Webadresse' }).count(), 0, 'no free address bar')
    assert.equal(await page.getByRole('button', { name: 'Neuer Tab' }).count(), 0, 'no general new tab')
    const inspect = () => app.evaluate(({ BrowserWindow }) => {
      const host = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('crystal.html'))
      const views = host.contentView.children.filter(v => v.webContents && v.webContents !== host.webContents)
      return views.map(v => ({ id: v.webContents.id, url: v.webContents.getURL(), bounds: v.getBounds(), visible: v.getVisible(), preferences: v.webContents.getLastWebPreferences() }))
    })
    await page.waitForFunction(async () => !(await window.jarvis.invoke('browser:status')).tabs.some(t => t.loading))
    let views = await inspect()
    assert.equal(views.length, 1)
    const panel = await dialog.boundingBox()
    await page.waitForFunction(() => true)
    for (let i = 0; i < 20 && !(await inspect())[0].visible; i++) await page.waitForTimeout(100)
    views = await inspect()
    assert.ok(views[0].visible)
    assert.ok(views[0].bounds.x >= panel.x && views[0].bounds.y > panel.y + 80 && views[0].bounds.x + views[0].bounds.width <= panel.x + panel.width + 1)
    assert.equal(views[0].preferences.nodeIntegration, false)
    assert.equal(views[0].preferences.contextIsolation, true)
    assert.equal(views[0].preferences.sandbox, true)
    assert.ok(!views[0].preferences.preload)
    await page.screenshot({ path: join(audit, 'login-window.png') })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)

    await page.evaluate(() => { const d = document.createElement('div'); d.id = 'browser-test-dialog'; d.setAttribute('role', 'dialog'); document.body.appendChild(d) })
    await page.waitForTimeout(150)
    assert.ok((await inspect()).every(v => !v.visible), 'native websites must not cover application dialogs')
    await page.evaluate(() => document.getElementById('browser-test-dialog').remove())
    await page.waitForTimeout(150)
    assert.ok((await inspect()).some(v => v.visible))

    const guestId = views[0].id
    const windowCount = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    assert.deepEqual(await app.evaluate(async ({ webContents }, id) => webContents.fromId(id).executeJavaScript('({node:typeof require,bridge:typeof window.jarvis})'), guestId), { node: 'undefined', bridge: 'undefined' })
    await app.evaluate(async ({ webContents }, id) => webContents.fromId(id).executeJavaScript("document.querySelector('a').click()", true), guestId)
    await page.waitForFunction(async () => (await window.jarvis.invoke('browser:status')).tabs[0]?.title === 'Zweite Seite')
    await dialog.getByRole('button', { name: 'Zurück', exact: true }).click()
    await page.waitForFunction(async () => (await window.jarvis.invoke('browser:status')).tabs[0]?.title === 'Browser-Test')
    await page.waitForFunction(async () => !(await window.jarvis.invoke('browser:status')).tabs.some(t => t.loading))
    await app.evaluate(async ({ webContents }, id) => webContents.fromId(id).executeJavaScript("document.querySelector('button').click()", true), guestId)
    await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 2)
    views = await inspect()
    assert.equal(views.length, 2)
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), windowCount, 'popup must be a tab, not another native window')
    await page.waitForFunction(async () => (await window.jarvis.invoke('browser:status')).tabs.every(t => t.url && !t.loading), { timeout: 15000 })
    assert.equal(await app.evaluate(async ({ webContents }, id) => webContents.fromId(id).executeJavaScript('Boolean(window.opener)'), views[1].id), true)
    await page.getByRole('button', { name: /Tab schließen:/ }).last().click()
    await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 0)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.browser-panel'))
    assert.ok((await inspect()).every(v => !v.visible))

    // Kleines Fenster: das Anmeldefenster füllt den Platz, ohne seitlich zu scrollen.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('crystal.html')).setSize(540, 700))
    await page.waitForFunction(() => innerWidth < 640)
    await page.evaluate(({ url, purpose }) => window.jarvis.invoke('browser:open', { url, purpose }), { url, purpose })
    await dialog.waitFor()
    await page.screenshot({ path: join(audit, 'login-narrow.png') })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await dialog.getByRole('button', { name: 'Fertig', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.browser-panel'))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('crystal.html')).setSize(1400, 850))
    assert.equal(await page.evaluate(async () => { try { await window.jarvis.invoke('browser:open', { url: 'file:///C:/Windows/win.ini' }); return false } catch { return true } }), true)

    // Anmeldung erkennen: ein iCloud-Anmeldecookie (nur Testwert) schließt das Fenster von selbst.
    await page.evaluate(({ url }) => window.jarvis.invoke('browser:open', { url, purpose: { kind: 'login', title: 'Bei Apple anmelden', hint: 'Test', watch: 'icloud' } }), { url })
    await dialog.waitFor()
    await app.evaluate(async ({ session }) => {
      await session.fromPartition('persist:james-browser').cookies.set({ url: 'https://www.icloud.com/', domain: '.icloud.com', name: 'X-APPLE-WEBAUTH-TOKEN', value: 'fixture-only', secure: true, expirationDate: Date.now() / 1000 + 3600 })
    })
    await dialog.getByText('Angemeldet', { exact: true }).waitFor({ timeout: 8000 })
    await page.screenshot({ path: join(audit, 'login-detected.png') })
    await page.waitForFunction(() => !document.querySelector('.browser-panel'), null, { timeout: 8000 })

    // Konten-Ansicht: Apple gilt als angemeldet, Mail/Drive/Health zeigen ihre Einrichtung in James.
    await page.getByRole('button', { name: 'Konten', exact: true }).click()
    const accounts = page.getByRole('region', { name: 'Konten' })
    await accounts.waitFor()
    await accounts.getByRole('article', { name: 'Apple Account' }).getByText('Browsersitzung gefunden · Zugriff bei Apple prüfen', { exact: true }).waitFor()
    await page.screenshot({ path: join(audit, 'accounts-overview.png') })
    const nav = accounts.getByRole('navigation', { name: 'Kontobereiche' })
    await nav.getByRole('button', { name: 'iCloud Mail' }).click()
    await accounts.getByRole('button', { name: 'Bei Apple erstellen' }).waitFor()
    await page.screenshot({ path: join(audit, 'accounts-mail-setup.png') })
    await nav.getByRole('button', { name: 'iCloud Drive' }).click()
    await accounts.getByRole('button', { name: 'Microsoft Store öffnen' }).or(accounts.getByRole('list', { name: 'Dateien' })).first().waitFor()
    await nav.getByRole('button', { name: 'Apple Health' }).click()
    await accounts.getByRole('button', { name: 'Health-Export einlesen' }).waitFor()
    await accounts.getByText(/Geprüft um/).waitFor()
    await page.screenshot({ path: join(audit, 'accounts-health.png') })
    await accounts.getByRole('button', { name: 'Konten schließen' }).click()
    await page.waitForFunction(() => !document.querySelector('.accounts-view'))
    assert.deepEqual(errors, [])

    await app.evaluate(async ({ webContents }, { id, url }) => {
      const session = webContents.fromId(id).session
      await session.cookies.set({ url, name: 'browser-test-session', value: 'fixture-only', expirationDate: Date.now() / 1000 + 3600 })
      await session.cookies.flushStore()
    }, { id: guestId, url })
    await app.close(); app = null
    ;({ app, page } = await launch())
    const persisted = await app.evaluate(async ({ session }, url) => session.fromPartition('persist:james-browser').cookies.get({ url, name: 'browser-test-session' }), url)
    assert.equal(persisted[0]?.value, 'fixture-only', 'browser login cookies must survive an app restart')
    if (process.argv.includes('--apple')) {
      await page.evaluate(() => window.jarvis.invoke('connect:login', { target: 'icloud' }))
      await page.waitForFunction(async () => (await window.jarvis.invoke('browser:status')).tabs.some(t => t.url.startsWith('https://www.icloud.com/') && !t.loading), null, { timeout: 30000 })
      const apple = await app.evaluate(async ({ webContents }) => {
        const guest = webContents.getAllWebContents().find(w => w.getURL().startsWith('https://www.icloud.com/'))
        return { title: guest.getTitle(), url: guest.getURL(), text: await guest.executeJavaScript('(document.body?.innerText || "").slice(0, 1200)') }
      })
      assert.match(apple.url, /^https:\/\/www\.icloud\.com\//)
      writeFileSync(join(audit, 'apple-smoke.json'), JSON.stringify(apple, null, 2))
      console.log('PASS: public iCloud page loads in the login window; no credentials entered.')
    }
    console.log('PASS: login window with purpose and host, no free browsing, sandboxed view, dialog protection, history, popup as tab, Esc/Fertig, narrow layout, protocol restrictions, iCloud login detection, accounts view, cookies survive restart.')
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
