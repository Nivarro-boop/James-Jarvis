const { build }=require('esbuild')
const { chromium }=require('playwright-core')
const { resolve }=require('node:path')
const { writeFileSync, mkdirSync }=require('node:fs')
const assert=require('node:assert/strict')
require('../tests/helpers/register-electron.cjs')
;(async()=>{
 await build({entryPoints:['src/main/automation/chromeCdp.ts'],bundle:true,platform:'node',format:'cjs',packages:'external',outfile:'out/browser-gate-test.cjs',alias:{'@shared':resolve('src/shared')}})
 globalThis.browserAutomation=require('../out/browser-gate-test.cjs')
 await build({entryPoints:['src/main/tools/impl/chrome.ts'],bundle:true,platform:'node',format:'cjs',packages:'external',outfile:'out/browser-tools-test.cjs',alias:{'@shared':resolve('src/shared')},plugins:[{name:'fixture-browser',setup(b){b.onLoad({filter:/automation[\\/]chromeCdp\.ts$/},()=>({contents:`export const detectBlock=(p,o)=>globalThis.browserAutomation.detectBlock(p,o);export const getContext=async()=>globalThis.fixtureContext;export const activePage=async()=>globalThis.fixturePage;export const selectActivePage=p=>globalThis.fixturePage=p;export const setWindowVisible=async()=>{};export const declineCookies=async()=>false;export const openPage=async url=>{const p=await globalThis.fixtureContext.newPage();await p.goto(url);return p}`,loader:'ts'}))}}]})
 const tools=require('../out/browser-tools-test.cjs').chromeTools
 const cards=[],ctx={show:c=>{cards.push(c);return true},say:()=>{},confirm:async()=>true,setState:()=>{},annotate:()=>{},signal:new AbortController().signal}
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true})
 try{
  const context=await browser.newContext();globalThis.fixtureContext=context
  await context.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<html><title>Anmelden</title><body><label>Eingabe<input type="password"></label></body></html>'}))
  const page=await context.newPage();globalThis.fixturePage=page
  await page.setContent('<html><title>Security Check</title><body><p>Verify you are human</p><button onclick="window.clicked=true">Weiter</button><label>E-Mail<input></label></body></html>')
  assert.match(await globalThis.browserAutomation.detectBlock(page),/menschliche Sicherheitsprüfung/)
  let result=await tools.find(t=>t.name==='chrome_click').execute({text:'Weiter'},ctx)
  assert.equal(result.status,'needs-user');assert.equal(await page.evaluate(()=>Boolean(window.clicked)),false)
  result=await tools.find(t=>t.name==='chrome_fill').execute({field:'E-Mail',value:'test@example.test'},ctx)
  assert.equal(result.status,'needs-user');assert.equal(await page.locator('input').inputValue(),'')
  assert.equal(cards.at(-1).kind,'browser-handoff')
  await page.setContent('<html><title>Mein Konto</title><body><nav>Hallo Testnutzer</nav><main>Meine Dokumente</main></body></html>')
  assert.equal(await globalThis.browserAutomation.detectBlock(page),null)
  result=await tools.find(t=>t.name==='chrome_read_page').execute({},ctx)
  assert.match(result.inhalt,/Hallo Testnutzer/);assert.equal(await page.locator('nav').count(),1)
  await page.setContent('<html><title>Formular</title><body><label>Eingabe<input type="password"></label></body></html>')
  result=await tools.find(t=>t.name==='chrome_fill').execute({field:'Eingabe',value:'fixture-not-a-real-secret'},ctx)
  assert.equal(result.status,'needs-user');assert.equal(await page.locator('input').inputValue(),'')
  await assert.rejects(tools.find(t=>t.name==='chrome_prepare_login').execute({url:'http://example.test'},ctx),/HTTPS/)
  await assert.rejects(tools.find(t=>t.name==='chrome_prepare_login').execute({url:'https://user:pass@example.test'},ctx),/HTTPS/)
  result=await tools.find(t=>t.name==='chrome_prepare_login').execute({url:'https://example.test/login'},ctx)
  assert.equal(result.status,'needs-user')
  const card=cards.at(-1);assert.equal(card.domain,'example.test');assert.equal(card.actions[0].label,'Ich bin fertig – prüfen')
  mkdirSync(resolve('out/audit'),{recursive:true});writeFileSync(resolve('out/audit/browser-login-card.json'),JSON.stringify(card))
  console.log('PASS: challenge pauses click/fill, login pauses for user, no credential typing, solved page can be read, navigation retained, HTTPS validation, actionable handoff card')
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1})

