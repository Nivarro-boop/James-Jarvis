const { _electron } = require('playwright-core')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const assert = require('node:assert/strict')
;(async () => {
 const profile = mkdtempSync(join(tmpdir(), 'james-map-ui-')), wrapper = resolve('out/map-ui-wrapper.cjs')
 const userData = join(profile, 'void-jarvis'); mkdirSync(userData, { recursive: true })
 writeFileSync(join(userData, 'settings.json'), JSON.stringify({ setupDone: true, gamingMode: true, pcProfile: false, dailyBriefing: false, diagnosticReporting: { enabled: false, automatic: false, capabilityGaps: false, url: '' }, wake: { enabled: false, clap: false }, automaticBackups: false }))
 writeFileSync(wrapper, `const {app}=require('electron');app.setPath('appData',${JSON.stringify(profile)});app.setPath('userData',${JSON.stringify(userData)});require('./main/index.js')`)
 let app
 try {
  app = await _electron.launch({ executablePath: require('electron'), args: [wrapper, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
  await app.firstWindow()
  let page
  for (let i = 0; i < 100 && !page; i++) { page = app.windows().find(p => p.url().includes('crystal.html')); if (!page) await new Promise(r => setTimeout(r, 100)) }
  assert.ok(page); await page.locator('.home-bar').waitFor()
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  await app.evaluate(({ BrowserWindow }) => {
   const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('crystal.html')); w.setSize(1000, 800)
   const from = { label: 'Stephansplatz', lat: 48.2083, lon: 16.3725 }, to = { label: 'Stadtpark', lat: 48.204, lon: 16.38 }
   for (const card of [
    { kind: 'route', id: 'route:test', from, to, mode: 'zu_fuss', durationS: 620, distanceM: 860, arrivalAt: Date.now() + 620000, path: [[from.lon, from.lat], [16.377, 48.208], [to.lon, to.lat]], actions: [{ type: 'ask', label: 'Auto', prompt: 'Und mit dem Auto?' }] },
    { kind: 'places', id: 'places:test', query: 'Apotheken', places: [{ name: 'Testapotheke', lat: 48.208, lon: 16.374, distanceM: 150, address: 'Wien' }] },
    { kind: 'sources', id: 'sources:test', query: 'Testquellen', sources: [{ title: 'OpenStreetMap', domain: 'openstreetmap.org', url: 'https://www.openstreetmap.org' }, { domain: 'invalid', url: 'javascript:alert(1)' }] }
   ]) w.webContents.send('display:card', { ...card, at: Date.now() })
  })
  await page.locator('.answer-card').nth(2).waitFor(); assert.equal(await page.locator('.answer-card').count(), 3)
  assert.equal(await page.locator('a[href^="javascript:"]').count(), 0)
  await page.waitForFunction(() => [...document.querySelectorAll('.map-view')].every(e => !e.textContent.includes('lädt')), { timeout: 30000 })
  assert.equal(await page.locator('.map-status').count(), 0, 'Live basemap failed')
  const map = page.locator('.map-view').first(); const box = await map.boundingBox(); await page.mouse.move(box.x + 60, box.y + 60); await page.mouse.down(); await page.mouse.move(box.x + 100, box.y + 70); await page.mouse.up(); await page.mouse.wheel(0, -100)
  mkdirSync(resolve('out/audit'), { recursive: true }); await page.screenshot({ path: resolve('out/audit/maps-answer-cards.png') })
  await page.getByRole('button', { name: 'Karte ausblenden' }).first().click(); assert.equal(await page.locator('.answer-card').count(), 2)
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('crystal.html')); w.webContents.send('display:card', { kind: 'agenda', id: 'agenda:test', range: 'Heute', events: [{ title: 'Prüftermin', start: Date.now(), allDay: false }], at: Date.now() }) })
  await page.getByText('Prüftermin', { exact: true }).waitFor(); assert.deepEqual(errors, [])
  console.log('PASS: live vector tiles, route/places/sources/agenda, pan/zoom, dismiss, unsafe URL blocked, no renderer errors')
 } finally {
  if (app) await app.close()
  rmSync(wrapper, { force: true })
  assert.ok(profile.startsWith(join(tmpdir(), 'james-map-ui-'))); rmSync(profile, { recursive: true, force: true })
 }
})().catch(e => { console.error(e); process.exitCode = 1 })
