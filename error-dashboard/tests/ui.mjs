import { chromium } from 'playwright-core'
import { readFileSync, mkdirSync } from 'node:fs'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true})
try{
 const page=await browser.newPage({viewport:{width:1200,height:800}});let fail=true;let patchStatus=200;const patches=[]
 const xss='<img src=x onerror=alert(1)>';const now=new Date().toISOString()
 const gapReport=(id,status,request)=>({id,kind:'capability-gap',status,count:3,timestamp:now,lastSeen:now,level:'info',message:'JARVIS: Fähigkeit fehlt – '+xss,source:'JARVIS',details:JSON.stringify({kind:'capability-gap',appVersion:'1.2.19',request,answer:'Das kann ich nicht. '+xss,reason:'Kein *Werkzeug* für <Garage>',suggestion:'Werkzeug `garage_open` bauen\nund registrieren',tools:[{tool:'<script>window.__pwned=1</script>',kind:'unknown',detail:xss}],channel:'text',sources:['answer']})})
 const gaps=[gapReport('11111111-1111-4111-8111-111111111111','open','Öffne das <b>Garagentor</b>\nbitte'),gapReport('22222222-2222-4222-8222-222222222222','done','Erledigte Bitte'),{id:'33333333-3333-4333-8333-333333333333',kind:'capability-gap',status:'open',timestamp:now,level:'info',message:'Rohtext',details:'kein JSON '+xss}]
 await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copied=text}}}))
 await page.route('http://127.0.0.1:4319/**',route=>route.fulfill({contentType:'text/html',body:readFileSync(new URL('../public/index.html',import.meta.url),'utf8')}))
 await page.route('**/api/error-report*',route=>{
  const request=route.request();if(fail)return route.fulfill({status:404,body:'not found'})
  if(request.method()==='PATCH'){const body=request.postDataJSON();patches.push(body);if(patchStatus!==200)return route.fulfill({status:patchStatus,contentType:'application/json',body:JSON.stringify({error:'Fähigkeitslücken brauchen JARVIS_REPORT_TOKEN auf dem Server.'})});gaps.find(g=>g.id===body.id).status=body.status;return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,...body})})}
  const kind=new URL(request.url()).searchParams.get('kind')
  route.fulfill({contentType:'application/json',body:JSON.stringify({reports:kind==='capability-gap'?gaps:[{timestamp:now,level:'error',message:xss,source:'JARVIS',details:'HTTP 429'}]})})
 })
 await page.goto('http://127.0.0.1:4319/');await page.getByRole('alert').filter({hasText:'API-Route fehlt'}).waitFor()
 assert.ok(!(await page.locator('#table').innerText()).includes('Lade Berichte'))
 fail=false;await page.getByRole('button',{name:'Aktualisieren'}).click();await page.locator('#status').filter({hasText:'VERBUNDEN'}).waitFor()
 assert.equal(await page.locator('#errors').innerText(),'1');assert.equal(await page.locator('#table img').count(),0)
 assert.equal(await page.locator('#all').innerText(),'4');assert.match(await page.getByRole('tab',{name:/Fähigkeitslücken/}).innerText(),/offen 2/)
 const audit=name=>fileURLToPath(new URL(`../audit/${name}`,import.meta.url))
 mkdirSync(new URL('../audit/',import.meta.url),{recursive:true});await page.screenshot({path:audit('dashboard.png')})
 // Fähigkeitslücken: Tab, sichere Felder, Rohtext-Rückfall, Erledigte ein- und ausblenden.
 await page.getByRole('tab',{name:/Fähigkeitslücken/}).click()
 assert.equal(await page.locator('#table .pill.gap').count(),2);assert.equal(await page.locator('#table .pill.gap').first().innerText(),'LÜCKE')
 assert.equal(await page.locator('#table img, #table script, #table b').count(),0);assert.equal(await page.evaluate(()=>window.__pwned),undefined)
 const text=await page.locator('#table').innerText()
 for(const label of ['Anfrage','Antwort von James','Erkannter Grund','Lösungsvorschlag','Werkzeuge','Kanal','App-Version','Häufigkeit'])assert.ok(text.includes(label),label)
 assert.ok(text.includes('Öffne das <b>Garagentor</b>'));assert.ok(text.includes('<script>window.__pwned=1</script> (unbekanntes Werkzeug): '+xss));assert.ok(text.includes('kein JSON '+xss));assert.ok(text.includes('3×'))
 await page.getByLabel('Erledigte zeigen').check();assert.equal(await page.locator('#table .pill.gap').count(),3);await page.screenshot({path:audit('gaps.png'),fullPage:true});await page.getByLabel('Erledigte zeigen').uncheck()
 await page.getByRole('button',{name:'Aktualisieren'}).click();await page.locator('#refresh:not([disabled])').waitFor()
 assert.equal(await page.getByRole('tab',{name:/Fähigkeitslücken/}).getAttribute('aria-selected'),'true')
 await page.reload();await page.locator('#table .pill.gap').first().waitFor()
 assert.equal(await page.getByRole('tab',{name:/Fähigkeitslücken/}).getAttribute('aria-selected'),'true')
 // Markdown-Export: Überschrift, Aufgabenliste, maskierte Sonderzeichen, keine Zeilenumbrüche im Eintrag.
 await page.getByRole('button',{name:'Offene Lücken als Markdown kopieren'}).click();await page.locator('#gap-msg').filter({hasText:'2 offene Lücken'}).waitFor()
 const copied=await page.evaluate(()=>window.__copied);const lines=copied.trim().split('\n')
 assert.equal(lines[0],'## Fähigkeitslücken für das nächste Update');assert.equal(lines.filter(line=>line.startsWith('- [ ] **')).length,2)
 assert.ok(copied.includes('- [ ] **Kein \\*Werkzeug\\* für \\<Garage\\>** (3×, zuletzt '));assert.ok(copied.includes('— Vorschlag: Werkzeug \\`garage\\_open\\` bauen und registrieren'))
 assert.ok(copied.includes('  - Anfrage: „Öffne das \\<b\\>Garagentor\\</b\\> bitte“'));assert.ok(copied.includes('- [ ] **Rohtext**'));assert.ok(!copied.includes('Erledigte Bitte'))
 // Erledigt: PATCH mit id und Status; Fehler des Servers bleibt sichtbar.
 await page.locator('#table button[data-id="11111111-1111-4111-8111-111111111111"]').click();await page.locator('#gap-msg').filter({hasText:'Als erledigt markiert.'}).waitFor()
 assert.deepEqual(patches.at(-1),{id:'11111111-1111-4111-8111-111111111111',status:'done'});assert.match(await page.getByRole('tab',{name:/Fähigkeitslücken/}).innerText(),/offen 1/)
 patchStatus=403;await page.getByRole('button',{name:'Erledigt',exact:true}).click();await page.locator('#gap-msg').filter({hasText:'Status nicht geändert'}).waitFor()
 await page.setViewportSize({width:375,height:800});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth))
 console.log('PASS Browser: sichtbarer 404-Fehler, Wiederherstellung, Zähler, sichere Textdarstellung, Lücken-Tab, Erledigt, Markdown-Export')
}finally{await browser.close()}
