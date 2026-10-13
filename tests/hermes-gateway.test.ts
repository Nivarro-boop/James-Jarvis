import { checkpoint, clearWorkingContext } from '@main/agent/workingContext'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { closeDb } from '@main/db'
import { setSettings } from '@main/store/settings'
import { hermesBase, hermesHealth, hermesRun } from '@main/providers/hermes'

it('verbindet nur lokale Hermes-Adressen', () => {
  assert.equal(hermesBase('http://127.0.0.1:8642/'), 'http://127.0.0.1:8642')
  for (const input of ['https://example.com', 'file:///C:/secret', 'http://user:pass@localhost', 'http://localhost/?key=secret']) {
    assert.throws(() => hermesBase(input))
  }
})

it('streamt Unicode früh, verwirft doppelte/fremde Events, ergänzt abgebrochene Streams und stoppt den Server', async t => {
  const root = mkdtempSync(join(tmpdir(),'james-hermes-stream-'))
  t.mock.method(app,'getPath',()=>root)
  let mode: 'complete' | 'drop' | 'cancel' = 'complete'
  let completed = false
  let stopped = false
  let abort: AbortController | null = null
  let early: (()=>void) | null = null
  const server = createServer(async (req,res) => {
    if (req.url?.endsWith('/events')) {
      res.setHeader('Content-Type','text/event-stream')
      const send = (seq:number,event:string,extra:Record<string,unknown>={},run_id='run_stream'):void => {
        const bytes = Buffer.from(`data: ${JSON.stringify({run_id,seq,event,...extra})}\r\n\r\n`)
        for (let i=0;i<bytes.length;i+=7) res.write(bytes.subarray(i,i+7))
      }
      res.write(': open\n\n')
      if (mode==='cancel') { abort?.abort(); return }
      send(0,'tool.started',{tool:'file_read',preview:'Nicht vorlesen'})
      send(1,'reasoning.delta',{delta:'Nicht vorlesen'})
      send(500,'message.delta',{delta:'Fremde Antwort'},'run_other')
      if (mode==='complete') {
        send(2,'message.interim',{text:'Ich prüfe.',already_streamed:false})
        send(3,'message.delta',{delta:'Grüß'})
        send(3,'message.delta',{delta:'Grüß'})
        setTimeout(()=> { send(4,'message.delta',{delta:' dich.'}); completed=true;res.end() },30)
      } else { send(2,'message.delta',{delta:'Grüß'});completed=true;res.end() }
      return
    }
    res.setHeader('Content-Type','application/json')
    if (req.url==='/v1/runs') return res.end(JSON.stringify({run_id:'run_stream'}))
    if (req.url?.endsWith('/stop')) { stopped=true;return res.end('{}') }
    res.end(JSON.stringify(completed?{status:'completed',output:'Grüß dich.'}:{status:'running'}))
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>{server.closeAllConnections();server.close();closeDb();assert.ok(root.startsWith(join(tmpdir(),'james-hermes-stream-')));rmSync(root,{recursive:true,force:true})})
  setSettings({confirmActions:false,hermes:{baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}`,model:'hermes-agent'}})
  const text:string[]=[]
  const progress:string[]=[]
  let settled=false
  const firstDelta = new Promise<void>(resolve=>{early=resolve})
  const run = hermesRun('Streamtest','stream-session',undefined,{onText:chunk=>{text.push(chunk);early?.()},onProgress:chunk=>progress.push(chunk)})
    .finally(()=>{settled=true})
  await firstDelta
  assert.equal(settled,false)
  assert.equal(await run,'Grüß dich.')
  assert.equal(text.join(''),'Ich prüfe.\nGrüß dich.')
  assert.deepEqual(progress,['Hermes verwendet file_read.'])
  assert.equal(stopped,false)
  mode='drop';completed=false;text.length=0
  assert.equal(await hermesRun('Streamtest','stream-session',undefined,{onText:chunk=>text.push(chunk)}),'Grüß dich.')
  assert.equal(text.join(''),'Grüß dich.')
  mode='cancel';completed=false;text.length=0;abort=new AbortController()
  await assert.rejects(hermesRun('Streamtest','stream-session',abort.signal,{onText:chunk=>text.push(chunk)}))
  assert.equal(stopped,true)
  assert.deepEqual(text,[])
})

it('prüft echtes HTTP, Gesprächskontext, autonome Freigaben und serverseitigen Stopp', async t => {
  const root = mkdtempSync(join(tmpdir(), 'james-hermes-'))
  t.mock.method(app, 'getPath', () => root)
  checkpoint({ goal: 'Gateway-Aufgabe', decisions: ['Nur lokal arbeiten'], completed: [], next: ['Ergebnis prüfen'], blockers: [], status: 'paused' })
  const paths: string[] = []
  let state: 'approval' | 'completed' = 'approval'
  let abortOnStart: AbortController | null = null
  const server = createServer(async (req, res) => {
    paths.push(`${req.method} ${req.url}`)
    let body = ''
    for await (const part of req) body += part
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'hermes-agent' }] }))
    if (req.url === '/v1/runs' && req.method === 'POST') {
      const input = JSON.parse(body)
      assert.equal(input.session_id, 'test-session')
      assert.equal(input.input, 'Testauftrag')
      assert.match(input.instructions, /Gateway-Aufgabe/)
      assert.match(input.instructions, /Nur lokal arbeiten/)
      assert.match(input.instructions, /dort tatsächlich verfügbaren Werkzeuge/)
      abortOnStart?.abort()
      return res.end(JSON.stringify({ run_id: 'run_test' }))
    }
    if (req.url?.endsWith('/approval')) {
      assert.deepEqual(JSON.parse(body), { choice: 'once', all: true })
      state = 'completed'
      return res.end(JSON.stringify({ resolved: 1 }))
    }
    if (req.url?.endsWith('/stop')) return res.end(JSON.stringify({ stopped: true }))
    return res.end(JSON.stringify(state === 'approval'
      ? { status: 'waiting_for_approval' } : { status: 'completed', output: 'Test erledigt.' }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  t.after(() => {
    server.closeAllConnections(); server.close(); closeDb(); clearWorkingContext()
    assert.ok(root.startsWith(join(tmpdir(), 'james-hermes-')))
    rmSync(root, { recursive: true, force: true })
  })
  setSettings({ confirmActions: false, hermes: { baseUrl: `http://127.0.0.1:${address.port}`, model: 'hermes-agent' } })
  assert.equal((await hermesHealth()).ok, true)
  assert.equal(await hermesRun('Testauftrag', 'test-session'), 'Test erledigt.')
  assert.ok(paths.includes('POST /v1/runs/run_test/approval'))
  assert.equal(paths.includes('POST /v1/runs/run_test/stop'), false)

  paths.length = 0
  abortOnStart = new AbortController()
  await assert.rejects(hermesRun('Testauftrag', 'test-session', abortOnStart.signal))
  assert.ok(paths.includes('POST /v1/runs/run_test/stop'))
  abortOnStart = null
  paths.length = 0; state = 'approval'
  setSettings({ confirmActions: true })
  await assert.rejects(hermesRun('Testauftrag', 'test-session'), /Freigabe/)
  assert.equal(paths.includes('POST /v1/runs/run_test/approval'), false)
  assert.ok(paths.includes('POST /v1/runs/run_test/stop'))
})
