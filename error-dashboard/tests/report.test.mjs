import { it } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../netlify/lib/report-handler.mjs'
const data=new Map();const listCalls=[]
const store={setJSON:async(k,v)=>data.set(k,structuredClone(v)),get:async k=>data.has(k)?structuredClone(data.get(k)):null,list:async function*(opts={}){listCalls.push(opts);yield {blobs:[...data.keys()].filter(key=>key.startsWith(opts.prefix||'')).reverse().map(key=>({key}))}}}
const req=(method='GET',body,headers={})=>new Request('https://aimarketer-electronics.netlify.app/api/error-report?limit=200',{method,headers:{'Content-Type':'application/json',...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})})
const get=(query,headers={})=>new Request(`https://aimarketer-electronics.netlify.app/api/error-report${query}`,{headers})
const auth={Authorization:'Bearer secret'}
const gapDetails=(request,tools=[],appVersion='1.2.19',answer='Das kann ich leider nicht.')=>JSON.stringify({kind:'capability-gap',appVersion,platform:'win32',request,answer,reason:'Das kann ich leider nicht.',suggestion:'Werkzeug dafür bauen.',tools,channel:'text',sources:['answer']})
const gap=(request,tools,appVersion,answer)=>({level:'info',kind:'capability-gap',message:'JARVIS: Fähigkeit fehlt – Das kann ich leider nicht.',source:'JARVIS',details:gapDetails(request,tools,appVersion,answer)})
const gapKeys=()=>[...data.keys()].filter(key=>key.startsWith('gap/'))
it('speichert Vier-Felder-Bericht und liest ihn mit Serverzeit wieder aus',async()=>{
 data.clear();const handler=createHandler(()=>store,{})
 const result=await handler(req('POST',{level:'error',message:'OpenAI API request failed',source:'JARVIS',details:'HTTP 429',private:'never store'}));assert.equal(result.status,201)
 const response=await handler(req());assert.equal(response.status,200)
 const reports=(await response.json()).reports;assert.equal(reports.length,1);assert.equal(reports[0].details,'HTTP 429');assert.ok(reports[0].timestamp);assert.equal(reports[0].private,undefined)
})
it('weist kaputte Berichte und falsche Methoden ab',async()=>{
 const handler=createHandler(()=>store,{})
 for(const body of [{},[],{level:'other',message:'hi'},{level:'error',message:'hi',details:{secret:'test'}}])assert.equal((await handler(req('POST',body))).status,400)
 assert.equal((await handler(req('DELETE'))).status,405)
 const malformed=new Request('https://api.test/api/error-report',{method:'POST',body:'{',headers:{'Content-Type':'application/json'}});assert.equal((await handler(malformed)).status,400)
})
it('schützt GET und POST mit optionalem Token',async()=>{
 const handler=createHandler(()=>store,{JARVIS_REPORT_TOKEN:'secret'})
 assert.equal((await handler(req())).status,401)
 assert.equal((await handler(req('POST',{level:'info',message:'hi'}))).status,401)
 assert.equal((await handler(req('GET',undefined,{Authorization:'Bearer secret'}))).status,200)
})
it('beantwortet erlaubten CORS-Preflight und verweigert fremde Webseiten',async()=>{
 const handler=createHandler(()=>store,{})
 const response=await handler(req('OPTIONS',undefined,{Origin:'https://resonant-shortbread-6be4b2.netlify.app'}));assert.equal(response.status,204);assert.equal(response.headers.get('access-control-allow-origin'),'https://resonant-shortbread-6be4b2.netlify.app')
 assert.equal((await handler(req('GET',undefined,{Origin:'https://evil.test'}))).status,403)
 assert.match(response.headers.get('access-control-allow-methods'),/PATCH/)
})
it('prüft kind und speichert Fehlerberichte weiter ohne Präfix',async()=>{
 data.clear();const handler=createHandler(()=>store,{})
 for(const kind of ['other',5,null,'','Capability-Gap'])assert.equal((await handler(req('POST',{level:'info',message:'hi',kind}))).status,400)
 assert.equal((await handler(req('POST',{level:'error',message:'hi',kind:'incident'}))).status,201)
 assert.equal((await handler(req('POST',{level:'error',message:'ohne Art'}))).status,201)
 assert.equal(data.size,2);for(const [key,value] of data){assert.match(key,/^\d{13}-[0-9a-f-]{36}$/);assert.equal(value.kind,'incident')}
 assert.equal((await handler(get('?kind=bogus'))).status,400)
 assert.equal((await (await handler(get('?kind=incident'))).json()).reports.length,2)
})
it('nimmt Fähigkeitslücken ohne Server-Token weder an noch zeigt sie',async()=>{
 data.clear();const handler=createHandler(()=>store,{})
 const response=await handler(req('POST',gap('Bitte öffne das Garagentor')));assert.equal(response.status,403)
 assert.equal((await response.json()).error,'Fähigkeitslücken brauchen JARVIS_REPORT_TOKEN auf dem Server.');assert.equal(data.size,0)
 assert.equal((await handler(get('?kind=capability-gap'))).status,403)
 data.set('gap/0000000000001-0123456789abcdef-00000000-0000-4000-8000-000000000000',{id:'x',kind:'capability-gap',timestamp:new Date().toISOString(),message:'alt',details:'privat'})
 data.set('0000000000002-00000000-0000-4000-8000-000000000001',{id:'y',kind:'incident',timestamp:new Date().toISOString(),level:'error',message:'Fehler',details:''})
 const all=(await (await handler(req())).json()).reports;assert.deepEqual(all.map(r=>r.id),['y'])
})
it('speichert Lücken mit Token unter gap/ und listet sie getrennt',async()=>{
 data.clear();listCalls.length=0;const handler=createHandler(()=>store,{JARVIS_REPORT_TOKEN:'secret'})
 assert.equal((await handler(req('POST',gap('Bitte öffne das Garagentor')))).status,401)
 assert.equal((await handler(req('POST',{level:'error',message:'HTTP 500'},auth))).status,201)
 const created=await handler(req('POST',gap('Bitte öffne das Garagentor',[{tool:'smart_home',kind:'unknown',detail:'gibt es nicht'}]),auth));assert.equal(created.status,201)
 const {id}=await created.json();assert.equal(gapKeys().length,1);assert.match(gapKeys()[0],new RegExp(`^gap/\\d{13}-[0-9a-f]{16}-${id}$`))
 const gaps=(await (await handler(get('?kind=capability-gap&limit=200',auth))).json()).reports
 assert.equal(gaps.length,1);assert.equal(gaps[0].id,id);assert.equal(gaps[0].kind,'capability-gap');assert.equal(gaps[0].status,'open');assert.equal(gaps[0].count,1);assert.equal(JSON.parse(gaps[0].details).request,'Bitte öffne das Garagentor')
 assert.ok(listCalls.some(call=>call.prefix==='gap/'))
 const incidents=(await (await handler(get('?kind=incident',auth))).json()).reports;assert.deepEqual(incidents.map(r=>r.kind),['incident'])
 assert.equal((await (await handler(get('',auth))).json()).reports.length,2)
})
it('zählt gleiche Lücken, statt sie doppelt zu speichern',async()=>{
 data.clear();const handler=createHandler(()=>store,{JARVIS_REPORT_TOKEN:'secret'})
 const tools=[{tool:'smart_home',kind:'unknown',detail:'erster Versuch'}]
 const first=await (await handler(req('POST',gap('Bitte öffne das Garagentor',tools),auth))).json()
 const again=await handler(req('POST',gap('Garagentor öffne, BITTE!',[{...tools[0],detail:'zweiter Versuch'}],'1.2.20'),auth))
 assert.equal(again.status,200);assert.deepEqual(await again.json(),{ok:true,id:first.id,duplicate:true,count:2})
 assert.equal(gapKeys().length,1);const stored=data.get(gapKeys()[0]);assert.equal(stored.count,2);assert.equal(stored.lastAppVersion,'1.2.20');assert.ok(stored.lastSeen>=stored.timestamp)
 assert.equal((await handler(req('POST',gap('Bitte öffne das Garagentor',[{tool:'tool_search',kind:'no-match',detail:'garage'}]),auth))).status,201)
 assert.equal((await handler(req('POST',gap('Wie wird das Wetter morgen in Graz',tools),auth))).status,201)
 assert.equal(gapKeys().length,3)
})
it('setzt den Status per PATCH nur mit Token und öffnet bei neuerer Version wieder',async()=>{
 data.clear()
 const patch=(body,headers={})=>new Request('https://aimarketer-electronics.netlify.app/api/error-report',{method:'PATCH',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)})
 const open=createHandler(()=>store,{});assert.equal((await open(patch({id:'00000000-0000-4000-8000-000000000000',status:'done'}))).status,403)
 const handler=createHandler(()=>store,{JARVIS_REPORT_TOKEN:'secret'})
 const {id}=await (await handler(req('POST',gap('Bitte öffne das Garagentor'),auth))).json()
 assert.equal((await handler(patch({id,status:'done'}))).status,401)
 for(const body of [{id,status:'later'},{id:'gap/../x',status:'done'},{status:'done'},[]])assert.equal((await handler(patch(body,auth))).status,400)
 assert.equal((await handler(patch({id:'00000000-0000-4000-8000-000000000000',status:'done'},auth))).status,404)
 const done=await handler(patch({id,status:'done'},auth));assert.equal(done.status,200);assert.deepEqual(await done.json(),{ok:true,id,status:'done'})
 let stored=data.get(gapKeys()[0]);assert.equal(stored.status,'done');assert.equal(stored.doneVersion,'1.2.19');assert.ok(stored.doneAt)
 await handler(req('POST',gap('Bitte öffne das Garagentor',[],'1.2.18'),auth));stored=data.get(gapKeys()[0]);assert.equal(stored.status,'done');assert.equal(stored.count,2)
 await handler(req('POST',gap('Bitte öffne das Garagentor',[],'1.3.0'),auth));stored=data.get(gapKeys()[0]);assert.equal(stored.status,'open');assert.equal(stored.count,3);assert.ok(stored.reopenedAt);assert.equal(stored.doneVersion,undefined)
 await handler(patch({id,status:'done'},auth));assert.equal((await (await handler(patch({id,status:'open'},auth))).json()).status,'open');assert.equal(data.get(gapKeys()[0]).doneAt,undefined)
})
it('nimmt Berichte knapp unter 16 KB mit Umlauten an und weist größere ab',async()=>{
 data.clear();const handler=createHandler(()=>store,{JARVIS_REPORT_TOKEN:'secret'})
 const body=n=>gap('Bitte übersetze das Märchen',[],'1.2.19','ä'.repeat(n));const bytes=n=>Buffer.byteLength(JSON.stringify(body(n)))
 const n=Math.floor((16384-bytes(0))/2);assert.ok(bytes(n)>16000&&bytes(n)<=16384);assert.ok(body(n).details.length<=10000)
 assert.equal((await handler(req('POST',body(n),auth))).status,201)
 assert.equal(JSON.parse(data.get(gapKeys()[0]).details).answer,'ä'.repeat(n))
 assert.equal((await handler(req('POST',body(n+1),auth))).status,413)
})
it('zeigt Speicherfehler als 503 statt Erfolg an',async()=>{
 const handler=createHandler(()=>{throw Error('secret backend failure')},{})
 const response=await handler(req());assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/secret backend/)
})
