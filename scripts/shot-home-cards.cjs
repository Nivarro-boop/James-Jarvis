// Startet Jarvis mit leerem Profil, zeigt Wetter-, Aktien- und Routenkarte und
// speichert einen Screenshot der Startseite. Aufruf: node scripts/shot-home-cards.cjs <name>
const { _electron } = require('playwright-core')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const name = process.argv[2] || 'home'
;(async () => {
  const profile = mkdtempSync(join(tmpdir(), 'james-shot-'))
  const userData = join(profile, 'void-jarvis')
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ setupDone: true, wake: { enabled: false, clap: false }, automaticBackups: false }))
  const wrapper = resolve('out/shot-wrapper.cjs')
  writeFileSync(wrapper, `const {app}=require('electron');app.setPath('appData',${JSON.stringify(profile)});app.setPath('userData',${JSON.stringify(userData)});require('./main/index.js')`)
  let app
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: [wrapper, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
    await app.firstWindow()
    let page
    for (let i = 0; i < 100 && !page; i++) {
      page = app.windows().find((p) => p.url().includes('crystal.html'))
      if (!page) await new Promise((r) => setTimeout(r, 100))
    }
    await page.locator('.home-bar').waitFor()
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('crystal.html'))
      w.setSize(1280, 1400)
      const now = Date.now()
      const hours = Array.from({ length: 24 }, (_, i) => {
        const d = new Date(now + i * 3600e3)
        return { time: d.toISOString().slice(0, 13) + ':00', temperature: 9 + Math.round(4 * Math.sin(i / 4)), rain: i % 7 === 0 ? 0.4 : 0, wind: 12 + (i % 5), code: i % 6 === 0 ? 61 : 2 }
      })
      const days = Array.from({ length: 7 }, (_, i) => ({ date: new Date(now + i * 86400e3).toISOString().slice(0, 10), description: i % 3 ? 'Bewölkt' : 'Regen', code: i % 3 ? 3 : 61, max: 14 - i % 3, min: 6 + i % 2, rain: i % 3 ? 0 : 3.2 }))
      const start = now - 6.5 * 3600e3
      const points = Array.from({ length: 80 }, (_, i) => ({ t: start + i * 5 * 60e3, p: 182 + Math.sin(i / 7) * 2 + i * 0.04 }))
      const from = { label: 'Stephansplatz', lat: 48.2083, lon: 16.3725 }, to = { label: 'Stadtpark', lat: 48.204, lon: 16.38 }
      const cards = [
        { kind: 'weather', id: 'w', place: 'Wien', lat: 48.21, lon: 16.37, temperature: 11, apparent: 9, humidity: 72, wind: 14, description: 'Leicht bewölkt', code: 2, hourly: hours, daily: days },
        { kind: 'stock', id: 's', symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', currency: 'USD', price: 185.32, change: 2.11, changePct: 1.15, previousClose: 183.21, marketState: 'REGULAR', asOf: now, timezone: 'America/New_York', open: 183.5, high: 186.1, low: 182.9, yearHigh: 199.6, yearLow: 164.1, volume: 51234000, extended: null, regularStart: start, regularEnd: start + 6.5 * 3600e3, points },
        { kind: 'route', id: 'r', from, to, mode: 'zu_fuss', durationS: 620, distanceM: 860, arrivalAt: now + 620000, path: [[from.lon, from.lat], [16.377, 48.208], [to.lon, to.lat]], actions: [] }
      ]
      for (const c of cards) w.webContents.send('display:card', { ...c, at: now })
    })
    await page.locator('.answer-card').first().waitFor().catch(() => {})
    console.log('cards', await page.locator('.answer-card').count(), await page.evaluate(() => [...document.querySelectorAll('[class*=card]')].map((e) => e.className).slice(0, 12).join(' | ')))
    await page.waitForFunction(() => [...document.querySelectorAll('.map-view')].every((e) => !e.textContent.includes('lädt')), { timeout: 30000 }).catch(() => {})
    await new Promise((r) => setTimeout(r, 1200))
    mkdirSync(resolve('out/audit'), { recursive: true })
    await page.screenshot({ path: resolve(`out/audit/${name}.png`), fullPage: true })
    console.log('saved', `out/audit/${name}.png`)
  } finally {
    if (app) await app.close()
    rmSync(wrapper, { force: true })
    rmSync(profile, { recursive: true, force: true })
  }
})().catch((e) => { console.error(e); process.exitCode = 1 })
