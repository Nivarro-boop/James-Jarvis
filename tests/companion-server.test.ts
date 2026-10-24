import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { startCompanion, stopCompanion, companionStatus, companionHostKey } from '@main/companion/server'

it('vermittelt echte Telefon-WebSockets, Audio, Sendebestätigungen und Rechnerausfälle', { timeout: 15000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'james-phone-server-'))
  const originalPath = app.getPath, originalAppPath = app.getAppPath
  app.getPath = () => directory
  app.getAppPath = () => process.cwd()
  const sockets: WebSocket[] = []
  t.after(async () => {
    for (const ws of sockets) ws.close()
    await stopCompanion()
    app.getPath = originalPath; app.getAppPath = originalAppPath
    rmSync(directory, { recursive: true, force: true })
  })
  let port = 34000 + Math.floor(Math.random() * 10000)
  for (let attempt = 0; ; attempt++, port += 3) {
    try { await startCompanion(port); break } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt >= 3) throw err
    }
  }
  const base = `http://127.0.0.1:${port}`
  const page = await fetch(base)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /audio-test/)
  const script = await fetch(`${base}/app.js`)
  assert.equal(script.headers.get('x-content-type-options'), 'nosniff')
  const connect = async (url: string) => {
    const ws = new WebSocket(url)
    sockets.push(ws)
    const messages: any[] = []
    ws.binaryType = 'arraybuffer'
    ws.addEventListener('message', event => messages.push(typeof event.data === 'string' ? JSON.parse(event.data) : new Uint8Array(event.data)))
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('WebSocket-Aufbau fehlgeschlagen')) })
    return { ws, messages }
  }
  async function waitFor(check: () => boolean) {
    const until = Date.now() + 2000
    while (!check()) {
      if (Date.now() > until) throw new Error('Erwartete WebSocket-Nachricht fehlt')
      await new Promise(r => setTimeout(r, 10))
    }
  }
  const phone = await connect(`ws://127.0.0.1:${port}/ws/phone?token=${companionStatus().token}`)
  await waitFor(() => phone.messages.some(msg => msg.t === 'availability' && !msg.ready))
  const host = await connect(`ws://127.0.0.1:${port + 1}/ws/host?key=${companionHostKey()}`)
  await waitFor(() => phone.messages.some(msg => msg.t === 'availability' && msg.ready))
  phone.ws.send(JSON.stringify({ t: 'mic', on: 'false' }))
  await waitFor(() => phone.messages.some(msg => msg.t === 'error'))
  assert.equal(host.messages.some(msg => msg.t === 'mic'), false)
  phone.ws.send(JSON.stringify({ t: 'text', text: 'Hallo', requestId: 'request-1' }))
  await waitFor(() => host.messages.some(msg => msg.t === 'text' && msg.requestId === 'request-1'))
  host.ws.send(JSON.stringify({ t: 'text-result', requestId: 'request-1', ok: true }))
  host.ws.send(JSON.stringify({ t: 'captions', items: [{ id: 1, who: 'james', text: 'Hallo vom Rechner' }] }))
  host.ws.send(new Uint8Array([2, 0, 1, 0, 2]))
  await waitFor(() => phone.messages.some(msg => msg instanceof Uint8Array))
  assert.ok(phone.messages.some(msg => msg.t === 'text-result' && msg.ok))
  assert.ok(phone.messages.some(msg => msg.t === 'captions' && msg.items[0].text === 'Hallo vom Rechner'))
  const audio = phone.messages.find(msg => msg instanceof Uint8Array)
  assert.ok(audio)
  assert.deepEqual(Array.from(audio), [2, 0, 1, 0, 2])
  host.ws.close()
  await waitFor(() => phone.messages.filter(msg => msg.t === 'availability' && !msg.ready).length === 2)
  assert.ok(phone.messages.some(msg => msg.t === 'state' && msg.state === 'offline'))
})
