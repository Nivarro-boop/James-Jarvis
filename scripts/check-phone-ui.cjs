const { createServer } = require('node:http')
const { readFile, mkdir } = require('node:fs/promises')
const { join } = require('node:path')
const { chromium } = require('playwright-core')
const assert = require('node:assert/strict')
;(async () => {
const root = join(process.cwd(), 'resources', 'companion')
const server = createServer(async (req, res) => {
  const file = new URL(req.url, 'http://localhost').pathname
  try {
    const body = await readFile(join(root, file === '/' ? 'index.html' : file))
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.png') ? 'image/png' : 'text/html'
    res.writeHead(200, {'content-type':type}); res.end(body)
  } catch { res.writeHead(404); res.end() }
})
await new Promise(r => server.listen(0,'127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true })
try {
const context = await browser.newContext({ viewport: {width:390,height:844}, deviceScaleFactor:2, isMobile:true, hasTouch:true })
const page = await context.newPage()
const errors = []
page.on('pageerror', e => errors.push(e.message))
await page.addInitScript(() => {
  class Socket {
    static OPEN=1; readyState=0; binaryType=''; sent=[]
    constructor() { window.testSocket=this; setTimeout(() => { this.readyState=1; this.onopen?.(); this.deliver({t:'availability',ready:true}); this.deliver({t:'state',state:'idle',paused:false}) }, 10) }
    deliver(data) { this.onmessage?.({ data: JSON.stringify(data) }) }
    send(raw) { const msg=JSON.parse(raw); this.sent.push(msg); if(msg.t==='ping')this.deliver({t:'pong'}); if(msg.t==='text') queueMicrotask(() => { this.deliver({t:'captions',items:[{id:1,who:'user',text:msg.text},{id:2,who:'james',text:'Alles klar. Ich bin bereit und antworte direkt auf deinem iPhone.'}]}); this.deliver({t:'text-result',requestId:msg.requestId,ok:true}) }) }
    close() { this.readyState=3 }
  }
  window.WebSocket=Socket
})
await page.goto(url)
await page.locator('#pairing').waitFor({state:'visible'})
await mkdir('docs/screenshots/phone-2026-10-24',{recursive:true})
await page.screenshot({path:'docs/screenshots/phone-2026-10-24/pairing.png',fullPage:true})
await page.locator('#host').fill('127.0.0.1:8788')
await page.locator('#token').fill('local-test-code-not-a-real-token')
await page.locator('#pair').click()
await page.locator('#status').filter({hasText:'bereit'}).waitFor()
await page.locator('#audio-test').click()
assert.match(await page.locator('#audio-status').innerText(), /Ausgabe bereit/)
await page.locator('.conversation > summary').click()
await page.locator('#say').fill('Hallo James, kannst du mich hören?')
await page.locator('#say-form button').click()
await page.waitForTimeout(100)
await page.screenshot({path:'docs/screenshots/phone-2026-10-24/main.png',fullPage:true})
assert.equal(await page.locator('#messages .message').count(),2)
assert.equal(await page.locator('#say').inputValue(),'')
assert.equal(await page.locator('#say-form button').isEnabled(),true)
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false)
await page.setViewportSize({width:320,height:568})
await page.screenshot({path:'docs/screenshots/phone-2026-10-24/small.png',fullPage:true})
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false)
await page.evaluate(() => window.testSocket.deliver({t:'availability',ready:false}))
assert.equal(await page.locator('#talk').isDisabled(),true)
assert.equal(await page.locator('#say-form button').isDisabled(),true)
assert.deepEqual(errors,[])
console.log(JSON.stringify({ok:true,viewports:['390x844','320x568'],errors, audio:'AudioContext running, test tone scheduled',screenshots:'docs/screenshots/phone-2026-10-24'}))
} finally {await browser.close();await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1})
