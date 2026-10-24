import assert from 'node:assert/strict'
import { it } from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { isPhoneMessage, isCaptionMessage } from '@shared/companion'

function phone() {
  const elements = new Map<string, any>()
  function element() {
    const classes = new Set<string>()
    return { value: '', textContent: '', hidden: false, disabled: false, dataset: {}, children: [],
      handlers: new Map<string, Function>(), classList: { add: (v: string) => classes.add(v), remove: (v: string) => classes.delete(v), contains: (v: string) => classes.has(v) },
      addEventListener(name: string, fn: Function) { this.handlers.set(name, fn) },
      setAttribute() {}, setPointerCapture() {}, querySelector() { return button },
      replaceChildren() {}, append() {}, remove() {} }
  }
  const button = element()
  const document = { getElementById: (id: string) => {
    if (!elements.has(id)) elements.set(id, element())
    return elements.get(id)
  }, addEventListener() {}, createElement: element }
  const storage = new Map<string, string>()
  let starts = 0
  class Context {
    state = 'running'; sampleRate = 48000; currentTime = 0
    destination = {}; async resume() { this.state = 'running' }
    addEventListener() {}
    createBuffer(_channels: number, samples: number, rate: number) { return { duration: samples / rate, getChannelData: () => new Float32Array(samples) } }
    createBufferSource() { return { connect() {}, start() { starts++ }, stop() {}, onended: null } }
  }
  const globals: any = { document, AudioContext: Context, navigator: {}, location: { hash: '', pathname: '/', protocol: 'https:' },
    localStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) },
    history: {}, URL, WebSocket: { OPEN: 1 }, window: { addEventListener() {} }, console,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {} }
  runInNewContext(readFileSync('resources/companion/app.js', 'utf-8') + `
    globalThis.testPhone = { playback, mic, beginTalk, endTalk, send, handleMessage,
      setSocket: value => { socket = value }, getPending: () => pendingText }`, globals)
  return { ...globals.testPhone, elements, button, storage, starts: () => starts }
}

it('prüft Telefonbefehle zur Laufzeit und begrenzt Text und Kennungen', () => {
  for (const value of [null, [], { t: 'mic', on: 'false' }, { t: 'pause', paused: 1 }, { t: 'text', text: ' ' },
    { t: 'text', text: 'x'.repeat(8001) }, { t: 'text', text: 'ok', requestId: {} }, { t: 'unknown' }]) assert.equal(isPhoneMessage(value), false)
  for (const value of [{ t: 'mic', on: false }, { t: 'text', text: 'Hallo', requestId: 'phone-1' }, { t: 'ping' }]) assert.equal(isPhoneMessage(value), true)
  assert.equal(isCaptionMessage({ t: 'captions', items: [{ id: 1, who: 'james', text: 'Hallo' }] }), true)
  assert.equal(isCaptionMessage({ t: 'captions', items: [{ id: 1, who: 'script', text: 'Hallo' }] }), false)
})

it('bewahrt die erste Antwort bis zur Audiofreigabe und spielt sie mit korrekter Dauer ab', async () => {
  const h = phone()
  h.playback.push(new Int16Array(2400))
  assert.equal(h.playback.pendingSamples, 2400)
  await h.playback.ensure()
  assert.equal(h.starts(), 1)
  assert.equal(h.playback.pendingSamples, 0)
  assert.ok(Math.abs(h.playback.nextTime - .16) < .001)
})

it('begrenzt blockiertes Audio und verwirft es beim Unterbrechen', () => {
  const h = phone()
  for (let i = 0; i < 50; i++) h.playback.push(new Int16Array(24000))
  assert.ok(h.playback.pendingSamples <= 24000 * 8)
  h.playback.flush()
  assert.equal(h.playback.pendingSamples, 0)
})

it('startet nach Loslassen während der Mikrofonfreigabe keine verspätete Aufnahme', async () => {
  const h = phone()
  const sent: any[] = []
  h.setSocket({ readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) })
  let release!: () => void
  let cleaned = 0
  h.mic.ensure = () => new Promise<void>(resolve => { release = resolve })
  h.mic.teardown = async () => { cleaned++ }
  const starting = h.beginTalk()
  h.endTalk()
  release()
  await starting
  assert.equal(h.mic.active, false)
  assert.equal(sent.some(msg => msg.t === 'mic' && msg.on), false)
  assert.equal(cleaned, 1)
})

it('behält Offline-Texte und löscht online erst nach erfolgreicher Bestätigung', () => {
  const h = phone()
  const input = h.elements.get('say')
  const submit = h.elements.get('say-form').handlers.get('submit')
  input.value = 'Meine Aufgabe'
  submit({ preventDefault() {} })
  assert.equal(input.value, 'Meine Aufgabe')
  const sent: any[] = []
  h.setSocket({ readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) })
  submit({ preventDefault() {} })
  assert.equal(input.value, 'Meine Aufgabe')
  const requestId = sent[0].requestId
  h.handleMessage({ t: 'text-result', requestId, ok: true })
  assert.equal(input.value, '')
})

it('behält einen während des Sendens geänderten Entwurf und fehlgeschlagene Nachrichten', () => {
  const h = phone()
  const input = h.elements.get('say')
  const sent: any[] = []
  h.setSocket({ readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) })
  const submit = h.elements.get('say-form').handlers.get('submit')
  input.value = 'Erste Frage'
  submit({ preventDefault() {} })
  input.value = 'Nächste Frage'
  h.handleMessage({ t: 'text-result', requestId: sent[0].requestId, ok: true })
  assert.equal(input.value, 'Nächste Frage')
  submit({ preventDefault() {} })
  h.handleMessage({ t: 'text-result', requestId: sent[1].requestId, ok: false })
  assert.equal(input.value, 'Nächste Frage')
})
