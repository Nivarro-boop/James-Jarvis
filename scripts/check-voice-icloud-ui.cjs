const { _electron } = require('playwright-core')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const assert = require('node:assert/strict')

/**
 * Stimmen-Galerie und iCloud-Karte in den Einstellungen.
 *
 * Isoliertes Profil ohne Schlüssel: Es geht keine Anfrage an Apple, Google,
 * OpenAI oder ElevenLabs. Geprüft werden Darstellung, Auswahl einer Stimme
 * (Einstellung wird gespeichert) und die Ablehnung eines falschen Passworts.
 * Voraussetzung: `npm run build`.
 */
;(async () => {
  const profile = mkdtempSync(join(tmpdir(), 'james-voice-icloud-'))
  const data = join(profile, 'void-jarvis'); mkdirSync(data)
  const audit = resolve('out/audit/voice-icloud'); mkdirSync(audit, { recursive: true })
  const wrapper = resolve('out/voice-icloud-wrapper.cjs')
  writeFileSync(join(data, 'settings.json'), JSON.stringify({ setupDone: true, gamingMode: true,
    pcProfile: false, dailyBriefing: false, automaticBackups: false, useDeviceLocation: false,
    wake: { enabled: false, clap: false }, diagnosticReporting: { enabled: false, automatic: false, capabilityGaps: false, url: '' },
    speech: { provider: 'gemini', hearProvider: 'gemini', thinkProvider: 'gemini' }
  }))
  writeFileSync(wrapper, `const {app}=require('electron');app.setPath('appData',${JSON.stringify(profile)});app.setPath('userData',${JSON.stringify(data)});require('./main/index.js')`)
  let app
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: [wrapper], timeout: 30000 })
    const errors = []
    app.on('window', page => page.on('pageerror', e => errors.push(e.message)))
    await app.firstWindow()
    let home
    for (let i = 0; i < 100 && !home; i++) { home = app.windows().find(p => p.url().includes('crystal.html')); if (!home) await new Promise(r => setTimeout(r, 100)) }
    assert.ok(home)
    await home.getByRole('button', { name: 'Menü', exact: true }).waitFor()

    await home.evaluate(() => window.jarvis.invoke('app:openSettings', { section: 'voice' }))
    let settings
    for (let i = 0; i < 100 && !settings; i++) { settings = app.windows().find(p => p.url().includes('settings.html')); if (!settings) await new Promise(r => setTimeout(r, 100)) }
    assert.ok(settings)
    settings.on('pageerror', e => errors.push(e.message))
    await settings.setViewportSize({ width: 1100, height: 900 }).catch(() => {})
    const gallery = settings.getByRole('region', { name: 'Stimmen-Galerie' })
    await gallery.waitFor()
    const cards = gallery.locator('.voice-card')
    assert.ok(await cards.count() >= 10, 'gallery lists the voices')
    assert.ok(await gallery.locator('.voice-tag', { hasText: 'Wie Siri' }).count() >= 2)
    // Ohne Gemini-Schlüssel ist die Hörprobe gesperrt statt still zu scheitern.
    const klar = gallery.getByRole('article', { name: 'Stimme Klar', exact: true })
    assert.equal(await klar.getByRole('button', { name: 'Klar anhören' }).isDisabled(), true)
    await klar.getByRole('button', { name: 'Klar wählen', exact: true }).click()
    await klar.getByRole('button', { name: 'Klar ist aktiv', exact: true }).waitFor()
    await gallery.getByRole('status').waitFor()
    const saved = await settings.evaluate(() => window.jarvis.invoke('settings:get'))
    assert.equal(saved.voice, 'Erinome')
    assert.equal(saved.speech.voicePreset, 'gemini-erinome')
    assert.equal(saved.speech.provider, 'gemini')
    await gallery.screenshot({ path: join(audit, 'voice-gallery.png') })
    assert.equal(await settings.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)

    await settings.evaluate(() => window.jarvis.invoke('app:openSettings', { section: 'connections' }))
    const panel = settings.getByRole('region', { name: 'Apple iCloud' })
    await panel.waitFor()
    for (const label of ['Mail', 'Kalender', 'iCloud Drive', 'Fotos', 'Notizen', 'Wo ist?']) {
      await panel.getByRole('group', { name: 'iCloud-Apps öffnen' }).getByRole('button', { name: label, exact: true }).waitFor()
    }
    await panel.getByLabel('iCloud-Mailadresse').fill('hans@icloud.com')
    await panel.getByLabel('App-spezifisches Passwort').fill('meinApplePasswort')
    await panel.getByRole('button', { name: 'Speichern und prüfen' }).click()
    await panel.getByRole('status').filter({ hasText: 'kein app-spezifisches Passwort' }).waitFor()
    assert.equal(await panel.getByText('Error invoking').count(), 0, 'no technical IPC prefix shown')
    const status = await settings.evaluate(() => window.jarvis.invoke('icloud:status'))
    assert.equal(status.mailConfigured, false)
    await panel.screenshot({ path: join(audit, 'icloud-panel.png') })

    assert.deepEqual(errors.filter(e => !/kein app-spezifisches Passwort/.test(e)), [])
    console.log('PASS: voice gallery (list, Siri tags, locked preview without key, selection saved), iCloud panel (services, wrong password rejected); isolated profile, no account requests.')
  } catch (error) {
    if (app) for (const [i, page] of app.windows().entries()) {
      console.log(page.url(), (await page.locator('body').innerText().catch(() => '')).slice(0, 1500))
      await page.screenshot({ path: join(audit, `failure-${i}.png`) }).catch(() => {})
    }
    throw error
  } finally {
    if (app) await app.close()
    rmSync(wrapper, { force: true })
    assert.ok(profile.startsWith(join(tmpdir(), 'james-voice-icloud-')))
    rmSync(profile, { recursive: true, force: true })
  }
})().catch(e => { console.error(e); process.exitCode = 1 })
