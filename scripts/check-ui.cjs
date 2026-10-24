const { _electron } = require('playwright-core')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const assert = require('node:assert/strict')

;(async () => {
  const profile = mkdtempSync(join(tmpdir(), 'jarvis-ui-'))
  const wrapper = resolve('.jarvis-ui-check.cjs')
  const userData = join(profile, 'void-jarvis')
  mkdirSync(resolve('out/audit'), { recursive: true })
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ setupDone: true, gamingMode: true, pcProfile: false, dailyBriefing: false, speech: { provider: 'gemini', hearProvider: 'gemini', thinkProvider: 'gemini' }, wake: { enabled: false, clap: false }, automaticBackups: false, useDeviceLocation: false, diagnosticReporting: { enabled: false, automatic: false, capabilityGaps: false, url: '' } }))
  writeFileSync(wrapper, `const {app}=require('electron'); app.setPath('appData',${JSON.stringify(profile)}); app.setPath('userData',${JSON.stringify(userData)}); require('./out/main/index.js')`)
  let app
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: [wrapper, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], timeout: 30000 })
    await app.firstWindow()
    let page
    const homeDeadline = Date.now() + 15000
    while (!page && Date.now() < homeDeadline) {
      page = app.windows().find(p => p.url().includes('/crystal.html'))
      if (!page) await new Promise(r => setTimeout(r, 100))
    }
    assert.ok(page, 'Home window did not load')
    for (const other of app.windows()) if (other !== page) await other.close()
    await page.locator('.home-health').waitFor({ timeout: 30000 })
    // Sprache und Texteingabe bleiben gleichwertig erreichbar.
    await page.getByRole('button', { name: 'Menü', exact: true }).click(); await page.getByRole('menuitem', { name: 'Gespräch & Schreiben', exact: true }).click()
    assert.equal(await page.getByRole('textbox', { name: 'Nachricht an James', exact: true }).count(), 1)
    await page.getByRole('button', { name: 'Gespräch schließen' }).click()
    await page.getByRole('button', { name: 'Menü', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Mikrofon pausieren', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.home').dataset.state === 'paused')
    await page.getByRole('button', { name: 'Menü', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Mikrofon aktivieren', exact: true }).click()
    await page.getByRole('button', { name: 'Menü', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Gespräch & Schreiben', exact: true }).click()
    console.log('PASS: home with text fallback, microphone button toggles mute')
    // Startseite: Status, Verbindung, Uhr und Menü; alles Weitere steht im Menü.
    assert.equal(await page.locator('.home-bar button').count(), 3)
    await page.getByRole('timer').waitFor()
    await page.getByRole('button', { name: 'Menü', exact: true }).click()
    for (const item of ['Neues Gespräch', 'Mit James einrichten', 'Deine Fähigkeiten', 'Verbindungen', 'Einstellungen', 'Nach Updates suchen', 'Lizenzen']) {
      await page.getByRole('menuitem', { name: item, exact: true }).waitFor()
    }
    await page.keyboard.press('Escape')
    assert.equal(await page.getByRole('menu').count(), 0)
    for (const gone of ['Gehirn', 'Fertigkeiten']) assert.equal(await page.getByRole('button', { name: gone, exact: true }).count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Recherchen', exact: true }).count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Telefon', exact: true }).count(), 0)
    await page.screenshot({ path: resolve('out/audit/home-clean-1.2.18.png') })
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('crystal.html')).webContents.send('activity:update', { items: [{ id: 'ui-clean', source: 'tool', label: 'Ich suche die passenden Informationen für dich.', status: 'running', startedAt: Date.now() }], plan: null })
    })
    await page.locator('.home-dock').getByText('Ich suche die passenden Informationen für dich.', { exact: true }).waitFor()
    assert.equal(await page.getByRole('complementary', { name: 'Aktionslog', exact: true }).count(), 0, 'Activity should not open the drawer automatically')
    await page.screenshot({ path: resolve('out/audit/home-working-1.2.18.png') })
    await app.evaluate(({ BrowserWindow }) => {
      const home = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('crystal.html'))
      home.webContents.send('activity:update', { items: [], plan: null }); home.setSize(520, 480)
    })
    const dock = await page.locator('.home-dock').boundingBox()
    assert.ok(dock && dock.y >= 0 && dock.y + dock.height <= (await page.evaluate(() => innerHeight)) + 1, 'Bottom bar should fit a small window')
    await page.screenshot({ path: resolve('out/audit/home-small-1.2.18.png') })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('crystal.html')).setSize(900, 640))
    await app.evaluate(({ BrowserWindow }) => {
      const home = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('crystal.html'))
      home.webContents.send('display:card', { kind: 'weather', id: 'weather:test', at: Date.now(), source: 'weather', place: 'Wien · Testdaten', lat: 48.2083, lon: 16.3725, temperature: 22, apparent: 21, humidity: 61, wind: 5, description: 'Überwiegend bewölkt', code: 2,
        hourly: Array.from({ length: 24 }, (_, i) => ({ time: `2026-10-08T${String(i).padStart(2,'0')}:00`, temperature: 14 + Math.sin(i / 4) * 5, rain: i * 2, wind: i + 2, code: 2 })),
        daily: Array.from({ length: 7 }, (_, i) => ({ date: `2026-10-${String(8+i).padStart(2,'0')}`, description: 'teils bewölkt', code: 2, max: 23, min: 10, rain: 8 })) })
    })
    await page.getByRole('region', { name: 'Wetter Wien · Testdaten' }).waitFor()
    await page.getByRole('button', { name: 'Regen', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: 'Regen', exact: true }).getAttribute('aria-pressed'), 'true')
    await page.getByRole('button', { name: 'Wind', exact: true }).click()
    await page.screenshot({ path: resolve('out/audit/weather-1.2.14.png') })
    await page.getByRole('button', { name: 'Wetter schließen', exact: true }).click()
    await page.keyboard.press('Alt')
    assert.ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(w => !w.isMenuBarVisible())), 'Alt revealed the home menu')
    await page.screenshot({ path: resolve('out/audit/ui-1.2.8.png') })
    await page.getByRole('button', { name: 'Menü', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Einstellungen', exact: true }).click()
    const deadline = Date.now() + 10000
    while (app.windows().length < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 100))
    assert.ok(app.windows().length >= 2, 'Settings window did not open')
    const settings = app.windows().find(p => p !== page)
    await settings.getByRole('heading', { name: 'Mach es dir einfach.', exact: true }).waitFor()
    await settings.screenshot({ path: resolve('out/audit/settings-clean-1.2.18.png') })
    await settings.getByRole('button', { name: 'Übersicht', exact: true }).click()
    await settings.keyboard.press('Alt')
    assert.ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(w => !w.isMenuBarVisible())), 'Alt revealed the settings menu')
    await settings.getByRole('button', { name: 'Stimme & Modelle', exact: true }).click()
    await settings.getByRole('button', { name: /OpenAI Realtime.*Schlüssel/ }).click()
    await settings.getByRole('button', { name: 'Gespeicherten Zugang testen', exact: true }).click()
    await settings.getByRole('status').filter({ hasText: /OpenAI API-Schlüssel fehlt/ }).waitFor()
    await settings.getByRole('button', { name: /ElevenLabs.*Kontingent/ }).click()
    await settings.getByRole('region', { name: 'elevenlabs einrichten' }).waitFor()
    assert.equal(await settings.getByRole('button', { name: /^Hermes$/ }).count(), 0)
    await settings.screenshot({ path: resolve('out/audit/voice-1.2.11.png') })
    await settings.evaluate(() => { window.location.hash = 'keys' })
    assert.equal(await settings.getByRole('button', { name: 'Statistik senden', exact: true }).isDisabled(), true)
    // Capability-gap reports carry conversation text: separate opt-in, off by default.
    const gaps = settings.getByRole('checkbox', { name: 'Fähigkeitslücken mit Gesprächsausschnitt senden', exact: true })
    assert.equal(await gaps.count(), 1, 'Capability-gap checkbox missing')
    assert.equal(await gaps.isChecked(), false, 'Capability-gap reports enabled by default')
    const tokenField = settings.locator('.field').filter({ has: settings.locator('label').filter({ hasText: /^Fehlerbericht-Token/ }) })
    await tokenField.locator('input').fill('local-ui-test-token')
    await tokenField.getByRole('button', { name: 'Speichern', exact: true }).click()
    await tokenField.locator('.badge.ok').waitFor()
    assert.equal(await tokenField.locator('input').inputValue(), '')
    await tokenField.getByRole('button', { name: 'Löschen', exact: true }).click()
    await tokenField.locator('.badge.missing').waitFor()
    const disabledReport = await settings.evaluate(() => window.jarvis.invoke('diagnostics:send'))
    assert.equal(disabledReport.ok, false)
    assert.match(disabledReport.detail, /deaktiviert/)
    await settings.screenshot({ path: resolve('out/audit/diagnostics-1.2.16.png') })
    console.log('PASS: encrypted diagnostic token save/delete, disabled reporting, no external report sent')
    await app.evaluate(() => {
      global.__diagnosticUploads = []
      const originalFetch = global.fetch
      global.fetch = async (url, options) => {
        if (String(url).startsWith('https://reports.invalid/')) {
          global.__diagnosticUploads.push(JSON.parse(options.body))
          return new Response('{}', { status: 201 })
        }
        return originalFetch(url, options)
      }
    })
    await settings.getByRole('textbox', { name: 'Empfänger für Fehlerberichte' }).fill('https://reports.invalid/api/error-report')
    const automatic = settings.getByRole('checkbox', { name: 'Neue Fehler automatisch anonymisiert senden', exact: true })
    assert.equal(await automatic.isChecked(), false)
    await automatic.check()
    assert.equal(await gaps.isChecked(), false, 'Automatic reports also enabled capability-gap reports')
    await page.evaluate(() => console.error('[live] Automatischer Testfehler user@example.com sk-private-test-secret Vienna'))
    const uploadDeadline = Date.now() + 40_000
    let uploads = []
    while (!uploads.length && Date.now() < uploadDeadline) {
      await new Promise(r => setTimeout(r, 250))
      uploads = await app.evaluate(() => global.__diagnosticUploads)
    }
    assert.equal(uploads.length, 1, 'Incident did not trigger an automatic upload')
    assert.equal(JSON.parse(uploads[0].details).automatic, true)
    assert.ok(JSON.parse(uploads[0].details).incidents >= 1)
    assert.doesNotMatch(JSON.stringify(uploads), /user@example|sk-private|Vienna|Automatischer Testfehler/)
    await automatic.uncheck()
    await settings.screenshot({ path: resolve('out/audit/automatic-diagnostics-1.2.17.png') })
    console.log('PASS: renderer error -> incident -> automatic anonymized upload (simulated receiver), opt-out')
    console.log('PASS: Home, diagnosis, Alt, OpenAI setup and missing-key test, ElevenLabs setup, no Hermes selector')
  } catch (error) {
    if (app) {
      for (const page of app.windows()) console.log('UI failure:', page.url(), (await page.locator('body').innerText().catch(() => '')).slice(0, 500))
      await app.windows()[0]?.screenshot({ path: resolve('out/audit/ui-failed-1.2.8.png') }).catch(() => {})
    }
    throw error
  } finally {
    if (app) await app.close()
    rmSync(wrapper, { force: true })
    // Only remove the known temporary profile generated above.
    assert.ok(profile.startsWith(join(tmpdir(), 'jarvis-ui-')))
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
