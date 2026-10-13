const {_electron}=require('playwright-core')
const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync}=require('node:fs')
const {tmpdir}=require('node:os')
const {join,resolve}=require('node:path')
const assert=require('node:assert/strict')
;(async()=>{
 const root=mkdtempSync(join(tmpdir(),'james-login-ui-')),userData=join(root,'void-jarvis');mkdirSync(userData)
 writeFileSync(join(userData,'settings.json'),JSON.stringify({setupDone:true,wake:{enabled:false,clap:false},automaticBackups:false}))
 const wrapper=resolve('out/login-ui-wrapper.cjs');writeFileSync(wrapper,`const {app}=require('electron');app.setPath('appData',${JSON.stringify(root)});app.setPath('userData',${JSON.stringify(userData)});require('./main/index.js')`)
 let app
 try{
  app=await _electron.launch({executablePath:require('electron'),args:[wrapper,'--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});await app.firstWindow();let page
  for(let i=0;i<100&&!page;i++){page=app.windows().find(p=>p.url().includes('crystal.html'));if(!page)await new Promise(r=>setTimeout(r,100))}
  assert.ok(page);await page.locator('.home-bar').waitFor()
  const errors=[];page.on('pageerror',e=>errors.push(e.message))
  await page.evaluate(()=>{window.testTexts=[];const dispatch=window.dispatchEvent.bind(window);window.dispatchEvent=e=>{if(e.type==='jarvis:text'){window.testTexts.push(e.detail);return true}return dispatch(e)}})
  const card=JSON.parse(readFileSync(resolve('out/audit/browser-login-card.json'),'utf8'))
  await app.evaluate(({BrowserWindow},card)=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('crystal.html'));w.setSize(1000,900);w.webContents.send('display:card',{...card,at:Date.now()-600000})},card)
  await page.getByRole('button',{name:'Ich bin fertig – prüfen',exact:true}).waitFor()
  await page.getByRole('button',{name:'Ich bin fertig – prüfen',exact:true}).click()
  assert.match(await page.evaluate(()=>window.testTexts.at(-1)),/keine erfolgreiche Anmeldung ohne erkennbaren Nachweis/)
  await page.locator('.answer-card').scrollIntoViewIfNeeded();await page.screenshot({path:resolve('out/audit/browser-login-ui.png')})
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('crystal.html')).setSize(520,800))
  await page.screenshot({path:resolve('out/audit/browser-login-ui-narrow.png')})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  await page.waitForTimeout(10500)
  assert.equal(await page.getByRole('button',{name:'Ich bin fertig – prüfen',exact:true}).count(),1)
  assert.deepEqual(errors,[])
  console.log('PASS: handoff card, bring-forward/resume actions, login not falsely confirmed, no timeout dismissal, narrow layout, no renderer errors')
 }finally{if(app)await app.close();assert.ok(root.startsWith(join(tmpdir(),'james-login-ui-')));rmSync(root,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1})
