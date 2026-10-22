import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'
import { DEFAULT_SETTINGS } from '@shared/config/defaults'

/**
 * Die Gemini-Live-Sitzung gegen einen Sockel, der schon schließt.
 *
 * Der Browser wirft beim Senden auf CLOSING/CLOSED nicht, er schreibt einen
 * Konsolenfehler ("WebSocket is already in CLOSING or CLOSED state.") — den
 * kann kein `try/catch` fangen. Deshalb muss die Sitzung vorher nachsehen.
 */
async function loadLiveSession() {
  const fixtures: Record<string, string> = {
    '../audio/player': 'export const createPlayer=()=>window.testCreatePlayer()',
    '@google/genai': 'export const Modality={AUDIO:"AUDIO"}; export class GoogleGenAI {live={connect:(params)=>window.testConnect(params)}}',
    '../store/crystalStore': 'export const useCrystal={getState:()=>({setWish(){}})}'
  }
  const bundle = await build({ entryPoints: [resolve('src/renderer/live/LiveSession.ts')], bundle: true, write: false,
    platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
    alias: { '@shared': resolve('src/shared') }, plugins: [{ name: 'fixture', setup(b) {
      b.onResolve({ filter: /.*/ }, args => args.path in fixtures ? { path: args.path, namespace: 'fixture' } : undefined)
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: fixtures[args.path] }))
    } }] })
  const module = { exports: {} as any }
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let next = 1
  const window = {
    setTimeout: (fn: () => void, ms: number) => { const id = next++; timers.set(id, { fn, ms }); return id },
    clearTimeout: (id: number) => timers.delete(id), setInterval: () => next++, clearInterval() {},
    testCreatePlayer: async (): Promise<any> => ({ push() {}, flush() {}, setSettings() {}, destroy: async () => {} }),
    testConnect: async (_params: any): Promise<any> => ({ close() {}, sendRealtimeInput() {} }),
    jarvis: { invoke: async (_channel: string, _args?: unknown): Promise<unknown> => undefined }
  }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require, console, window, setTimeout,
    AbortSignal, AbortController, btoa, atob })
  const errors: string[] = []
  const states: string[] = []
  const session = new module.exports.LiveSession(structuredClone(DEFAULT_SETTINGS), {
    onStateChange: (state: string) => states.push(state), onError: (message: string) => errors.push(message), onClosed() {},
    onUserTranscript() {}, onModelTranscript() {}
  })
  return { session, window, timers, errors, states }
}

/** Eine SDK-Sitzung, deren Sockel (`session.conn.ws`) in einem wählbaren Zustand steht. */
function fakeConnection(readyState: number | undefined, id = 1, openedAt = Date.now()) {
  const calls = { audio: 0, text: 0, tool: 0, close: 0 }
  const session: any = {
    sendRealtimeInput: () => { calls.audio++ },
    sendClientContent: () => { calls.text++ },
    sendToolResponse: () => { calls.tool++ },
    close: () => { calls.close++ },
    conn: readyState === undefined ? undefined : { ws: { readyState } }
  }
  return { calls, session, conn: { id, session, openedAt, closing: false } }
}

it('sendet keinen Audioblock an einen Sockel in CLOSING oder CLOSED, sondern hebt ihn für den Neuaufbau auf', async () => {
  const { session } = await loadLiveSession()
  session.stopped = false
  for (const state of [2, 3]) {
    const fake = fakeConnection(state)
    session.conn = fake.conn
    session.sendAudio(new Int16Array(320))
    assert.equal(fake.calls.audio, 0)
  }
  assert.equal(session.pendingAudio.length, 2)

  const open = fakeConnection(1)
  session.conn = open.conn
  session.sendAudio(new Int16Array(320))
  assert.equal(open.calls.audio, 1)
})

it('sendet ohne bekannte SDK-Sockelform wie bisher', async () => {
  const { session } = await loadLiveSession()
  session.stopped = false
  const fake = fakeConnection(undefined)
  session.conn = fake.conn
  session.sendAudio(new Int16Array(320))
  assert.equal(fake.calls.audio, 1)
})

it('schickt weder Text noch Werkzeugantwort in einen schließenden Sockel', async () => {
  const { session, window } = await loadLiveSession()
  session.stopped = false

  const closing = fakeConnection(2)
  session.conn = closing.conn
  assert.equal(session.sendText('Erinnerung'), false)
  assert.equal(closing.calls.text, 0)
  assert.equal(session.awaitingReply, false)
  const open = fakeConnection(1)
  session.conn = open.conn
  assert.equal(session.sendText('Erinnerung'), true)
  assert.equal(open.calls.text, 1)

  // Der Sockel kippt, während das Werkzeug noch läuft.
  for (const [state, expected] of [[1, 1], [2, 0]] as const) {
    let finishTool!: (value: unknown) => void
    window.jarvis.invoke = async (channel: string) =>
      channel === 'tools:call' ? new Promise(resolve => { finishTool = resolve }) : undefined
    const fake = fakeConnection(1)
    session.conn = fake.conn
    const running = session.handleToolCalls([{ id: `call-${state}`, name: 'weather' }])
    await Promise.resolve()
    fake.session.conn.ws.readyState = state
    finishTool({ id: `call-${state}`, name: 'weather', ok: true, durationMs: 1, result: 'sonnig' })
    await running
    assert.equal(fake.calls.tool, expected)
  }
})

it('hält den Rückzug bei kurzlebigen Verbindungen aufrecht und gibt nach sechs Versuchen auf', async () => {
  const { session, timers, errors } = await loadLiveSession()
  session.stopped = false
  const reason = { reason: 'Internal error encountered.' }
  const waits: number[] = []
  for (let attempt = 1; attempt <= 6; attempt++) {
    // Die Verbindung steht, bekommt eine Nachricht — und stirbt nach Sekunden.
    const fake = fakeConnection(1, attempt, Date.now() - 10_000)
    session.conn = fake.conn
    session.activeId = attempt
    session.handleMessage(attempt, {})
    session.handleClose(attempt, reason)
    assert.equal(session.reconnectAttempts, attempt)
    waits.push([...timers.values()].at(-1)!.ms)
  }
  assert.deepEqual(waits, [2000, 4000, 8000, 16000, 20000, 20000])
  assert.equal(errors.length, 0)

  const last = fakeConnection(1, 7, Date.now() - 10_000)
  session.conn = last.conn
  session.activeId = 7
  session.handleClose(7, reason)
  assert.equal(session.stopped, true)
  assert.equal(errors.length, 1)
})

it('setzt den Rückzug zurück, sobald eine Verbindung lange genug gehalten hat', async () => {
  const { session, timers } = await loadLiveSession()
  session.stopped = false
  session.reconnectAttempts = 4

  // Eine Nachricht allein reicht nicht ...
  const young = fakeConnection(1, 1, Date.now() - 5_000)
  session.conn = young.conn
  session.activeId = 1
  session.handleMessage(1, {})
  assert.equal(session.reconnectAttempts, 4)

  // ... eine Verbindung, die 30 Sekunden steht, schon.
  const stable = fakeConnection(1, 2, Date.now() - 31_000)
  session.conn = stable.conn
  session.activeId = 2
  session.handleMessage(2, {})
  assert.equal(session.reconnectAttempts, 0)

  // Auch beim Abriss einer langen Verbindung beginnt der Rückzug bei der ersten Stufe.
  session.reconnectAttempts = 3
  session.handleClose(2, { reason: 'Internal error encountered.' })
  assert.equal(session.reconnectAttempts, 1)
  assert.equal([...timers.values()].at(-1)!.ms, 2000)
})

/** Ein SDK, dessen `connect` nie von selbst zurückkommt — wie bei einem Sockel, der vor der Bestätigung zugeht. */
async function hangingConnect() {
  const harness = await loadLiveSession()
  const { session } = harness
  session.stopped = false
  const hung = { callbacks: undefined as any, settle: undefined as undefined | ((value: unknown) => void) }
  session.ai = {
    live: {
      connect: (params: { callbacks: unknown }) => {
        hung.callbacks = params.callbacks
        return new Promise(resolve => { hung.settle = resolve })
      }
    }
  }
  const attempt: Promise<void> = session.connect(null)
  for (let i = 0; i < 20 && !hung.callbacks; i++) await new Promise(resolve => setImmediate(resolve))
  assert.ok(hung.callbacks, 'connect wurde aufgerufen')
  return { ...harness, hung, attempt }
}

it('lässt den Aufbau nicht hängen, wenn der Sockel vor der Bestätigung zugeht', async () => {
  const { session, timers, errors, hung, attempt } = await hangingConnect()
  assert.equal(session.connecting, true)

  hung.callbacks.onclose({ reason: 'Internal error encountered.' })
  await attempt

  assert.equal(session.connecting, false)
  assert.equal(errors.length, 1)
  // Und es wird neu versucht, statt für immer auf "Verbindet…" zu stehen.
  assert.equal(session.reconnectAttempts, 1)
  assert.ok([...timers.values()].some(timer => timer.ms === 2000))
})

it('gibt den Aufbau nach der Zeitgrenze frei und schließt eine Sitzung, die doch noch kommt', async () => {
  const { session, timers, hung, attempt } = await hangingConnect()
  const timeout = [...timers.values()].find(timer => timer.ms === 20_000)
  assert.ok(timeout, 'Zeitgrenze für den Aufbau gesetzt')

  timeout.fn()
  await attempt
  assert.equal(session.connecting, false)
  assert.equal(session.conn, null)

  let closed = 0
  hung.settle!({ close: () => { closed++ } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(closed, 1)
  assert.equal(session.conn, null)
})

it('räumt die Zeitgrenze weg, wenn der Aufbau gelingt', async () => {
  const { session, timers, hung, attempt } = await hangingConnect()
  hung.settle!({ close() {}, sendRealtimeInput() {} })
  await attempt

  assert.equal(session.connecting, false)
  assert.ok(session.conn, 'Verbindung steht')
  assert.equal(session.pendingConnect, null)
  assert.equal([...timers.values()].some(timer => timer.ms === 20_000), false)
})

it('setzt beim Verbindungsabriss Werkzeugzustand und Mikrofon-Gate zurück', async () => {
  const h = await loadLiveSession()
  const conn = fakeConnection(1)
  h.session.conn = conn.conn
  h.session.activeId = 1
  h.session.stopped = false
  h.session.modelSpeaking = true
  h.session.busyTools = 2
  h.session.awaitingReply = true
  let flushed = 0
  const gates: boolean[] = []
  h.session.player = { flush() { flushed++ } }
  h.session.onUploadGate = (muted: boolean) => gates.push(muted)
  h.session.handleClose(1, { reason: 'Internal error encountered.' })
  assert.equal(h.session.busyTools, 0)
  assert.equal(h.session.awaitingReply, false)
  assert.equal(h.session.modelSpeaking, false)
  assert.equal(gates.at(-1), false)
  assert.ok(flushed > 0)
  assert.equal(h.states.at(-1), 'connecting')
})

for (const input of ['text', 'speech']) it(`heilt eine offene Live-Verbindung ohne Antwort auf ${input}`, async () => {
  const h = await loadLiveSession()
  const conn = fakeConnection(1)
  h.session.conn = conn.conn
  h.session.activeId = 1
  h.session.stopped = false
  if (input === 'text') h.session.sendText('Wie ist das Wetter?')
  else {
    h.session.handleMessage(1, { serverContent: { inputTranscription: { text: 'Wie ist das Wetter?' } } })
    ;[...h.timers.values()].find(timer => timer.ms === 650)!.fn()
  }
  assert.equal(h.states.at(-1), 'thinking')
  ;[...h.timers.values()].find(timer => timer.ms === 45_000)!.fn()
  assert.equal(conn.calls.close, 1)
  assert.equal(h.session.conn, null)
  assert.equal(h.session.awaitingReply, false)
  assert.equal(h.session.reconnectAttempts, 1)
  assert.equal(h.states.at(-1), 'connecting')
  assert.match(h.errors.at(-1)!, /keine Antwort/)
})

it('beendet die Antwort-Zeitgrenze beim ersten Audioblock und bei Unterbrechung', async () => {
  const h = await loadLiveSession()
  h.session.conn = fakeConnection(1).conn
  h.session.activeId = 1
  h.session.stopped = false
  h.session.sendText('Hallo')
  h.session.handleMessage(1, { serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAA=' } }] } } })
  assert.equal([...h.timers.values()].some(timer => timer.ms === 45_000), false)
  h.session.sendText('Hallo')
  h.session.handleMessage(1, { serverContent: { interrupted: true } })
  assert.equal([...h.timers.values()].some(timer => timer.ms === 45_000), false)
})

it('bricht einen laufenden Live-Aufbau beim Stop ab und übernimmt dessen späte Sitzung nicht', async () => {
  const h = await hangingConnect()
  await h.session.stop()
  await h.attempt
  assert.equal(h.session.isStarting(), false)
  assert.equal(h.session.pendingConnect, null)
  let closed = 0
  h.hung.settle!({ close() { closed++ } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(closed, 1)
  assert.equal(h.session.conn, null)
  assert.equal(h.errors.length, 0)
})

it('begrenzt auch einen hängenden Prompt-Aufbau und startet danach keinen verwaisten Socket', async () => {
  const h = await loadLiveSession()
  let finishConfig!: (value: any) => void
  let connections = 0
  h.session.stopped = false
  h.session.ai = { live: { connect() { connections++; return Promise.resolve({ close() {} }) } } }
  h.session.buildConfig = () => new Promise(resolve => { finishConfig = resolve })
  const attempt = h.session.connect(null)
  ;[...h.timers.values()].find(timer => timer.ms === 20_000)!.fn()
  await attempt
  finishConfig({})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(connections, 0)
  assert.equal(h.session.isStarting(), false)
  assert.equal(h.session.reconnectAttempts, 1)
})

it('teilt gleichzeitige Live-Starts während der Zugangsfreigabe', async () => {
  const h = await loadLiveSession()
  let finishSecret!: (value: unknown) => void
  let secrets = 0
  let players = 0
  let sockets = 0
  h.window.jarvis.invoke = async (channel) => {
    if (channel === 'secrets:getGeminiForLive') { secrets++; return new Promise(resolve => { finishSecret = resolve }) }
    return []
  }
  h.window.testCreatePlayer = async () => { players++; return { destroy: async () => {} } }
  h.window.testConnect = async () => { sockets++; return { close() {}, sendRealtimeInput() {} } }
  const first = h.session.start()
  const second = h.session.start()
  assert.equal(h.session.isStarting(), true)
  finishSecret('test')
  await Promise.all([first, second])
  assert.equal(secrets, 1)
  assert.equal(players, 1)
  assert.equal(sockets, 1)
  await h.session.dispose()
})

it('behält beim Live-Neustart während langsamer Audiofreigabe den neuen Player und Zustand', async () => {
  const h = await loadLiveSession()
  h.window.jarvis.invoke = async channel => channel === 'secrets:getGeminiForLive' ? 'test' : []
  await h.session.start()
  let finishDestroy!: () => void
  h.session.player.destroy = () => new Promise<void>(resolve => { finishDestroy = resolve })
  const stopping = h.session.stop()
  await h.session.start()
  const player = h.session.player
  finishDestroy()
  await stopping
  assert.equal(h.session.player, player)
  assert.equal(h.session.isConnected(), true)
  assert.equal(h.states.at(-1), 'listening')
  await h.session.dispose()
})

it('setzt die Antwortzeitgrenze während eines Live-Werkzeugs aus und nach dessen Ergebnis neu', async () => {
  const h = await loadLiveSession()
  const fake = fakeConnection(1)
  h.session.conn = fake.conn
  h.session.activeId = 1
  h.session.stopped = false
  h.session.sendText('Prüfe das Wetter')
  let finishTool!: (result: any) => void
  h.window.jarvis.invoke = async channel => channel === 'tools:call'
    ? new Promise(resolve => { finishTool = resolve }) : undefined
  const tool = h.session.handleToolCalls([{ id: 'weather', name: 'weather' }])
  assert.equal([...h.timers.values()].some(timer => timer.ms === 45_000), false)
  finishTool({ id: 'weather', name: 'weather', ok: true, result: 'sonnig' })
  await tool
  assert.equal(fake.calls.tool, 1)
  assert.equal(h.session.busyTools, 0)
  assert.equal(h.session.awaitingReply, true)
  assert.equal([...h.timers.values()].some(timer => timer.ms === 45_000), true)
})

it('lässt alte Live-Player-Rückrufe nach einem Stop das Mikrofon nicht sperren', async () => {
  const h = await loadLiveSession()
  h.window.jarvis.invoke = async channel => channel === 'secrets:getGeminiForLive' ? 'test' : []
  const gates: boolean[] = []
  h.session.onUploadGate = (muted: boolean) => gates.push(muted)
  await h.session.start()
  const oldPlayer = h.session.player
  await h.session.stop()
  await h.session.start()
  oldPlayer.onSpeakingChange(true)
  assert.equal(h.session.modelSpeaking, false)
  assert.equal(gates.at(-1), false)
  await h.session.dispose()
})

for (const reason of ['stop', 'timeout']) it(`löst einen hängenden Live-Audiostart bei ${reason} und räumt den späten Player auf`, async () => {
  const h = await loadLiveSession()
  h.window.jarvis.invoke = async channel => channel === 'secrets:getGeminiForLive' ? 'test' : []
  let finishPlayer!: (player: any) => void
  h.window.testCreatePlayer = () => new Promise(resolve => { finishPlayer = resolve })
  const starting = h.session.start()
  for (let i = 0; i < 10; i++) await Promise.resolve()
  assert.ok(finishPlayer)
  if (reason === 'stop') await h.session.stop()
  else [...h.timers.values()].find(timer => timer.ms === 20_000)!.fn()
  await starting
  assert.equal(h.session.isStarting(), false)
  assert.equal(h.session.isConnected(), false)
  assert.equal(h.states.at(-1), 'idle')
  assert.equal(h.errors.length, reason === 'stop' ? 0 : 1)
  let destroyed = 0
  finishPlayer({ destroy: async () => { destroyed++ } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(destroyed, 1)
  assert.equal(h.session.player, null)
})

it('löst einen hängenden Live-Zugriff auf den Schlüssel sofort beim Stop', async () => {
  const h = await loadLiveSession()
  let finishSecret!: (value: any) => void
  h.window.jarvis.invoke = () => new Promise(resolve => { finishSecret = resolve })
  const starting = h.session.start()
  await h.session.stop()
  await starting
  finishSecret('test')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.session.isStarting(), false)
  assert.equal(h.session.conn, null)
  assert.equal(h.errors.length, 0)
})

it('räumt beim vorgezogenen Live-Verbindungswechsel alte Werkzeuge auf, ohne neue Ergebnisse zu beschädigen', async () => {
  const h = await loadLiveSession()
  const previous = fakeConnection(1, 1)
  const next = fakeConnection(1, 2)
  h.session.conn = previous.conn
  h.session.activeId = 1
  h.session.connSeq = 1
  h.session.stopped = false
  h.session.ai = { live: { connect: async () => next.session } }
  h.session.buildConfig = async () => ({})
  const tools = new Map<string, (result: any) => void>()
  const cancelled: string[] = []
  h.window.jarvis.invoke = async (channel, args: any) => {
    if (channel === 'tools:call') return new Promise(resolve => { tools.set(args.id, resolve) })
    if (channel === 'tools:cancel') cancelled.push(args.id)
    return undefined
  }
  let flushed = 0
  const gates: boolean[] = []
  h.session.player = { flush() { flushed++ }, destroy: async () => {} }
  h.session.onUploadGate = (muted: boolean) => gates.push(muted)
  h.session.modelSpeaking = true
  const oldTool = h.session.handleToolCalls([{ id: 'old', name: 'weather' }])
  assert.equal(h.session.busyTools, 1)

  await h.session.connect('resumption')
  assert.equal(h.session.conn.session, next.session)
  assert.equal(h.session.busyTools, 0)
  assert.equal(h.session.modelSpeaking, false)
  assert.equal(h.session.awaitingReply, false)
  assert.equal(gates.at(-1), false)
  assert.equal(h.states.at(-1), 'listening')
  assert.ok(flushed > 0)
  assert.ok(cancelled.includes('old'))
  assert.equal(previous.calls.close, 1)

  const newTool = h.session.handleToolCalls([{ id: 'new', name: 'weather' }])
  tools.get('old')!({ id: 'old', name: 'weather', ok: true, result: 'alt' })
  await oldTool
  assert.equal(previous.calls.tool, 0)
  assert.equal(next.calls.tool, 0)
  assert.equal(h.session.busyTools, 1)
  tools.get('new')!({ id: 'new', name: 'weather', ok: true, result: 'neu' })
  await newTool
  assert.equal(next.calls.tool, 1)
  assert.equal(h.session.busyTools, 0)
  ;[...h.timers.values()].find(timer => timer.ms === 45_000)!.fn()
  assert.equal(next.calls.close, 1)
  assert.match(h.errors.at(-1)!, /keine Antwort/)
  await h.session.dispose()
})


it('übernimmt geänderte Rollen in einer aktiven Gemini-Sitzung und startet dafür keine inaktive Sitzung', async () => {
  const { session } = await loadLiveSession()
  const reconnects: unknown[] = []
  session.conn = fakeConnection(1).conn
  session.resumptionHandle = 'role-resume-fixture'
  session.connect = async (handle: unknown) => { reconnects.push(handle) }
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.assistantRole = 'calendar'
  session.updateSettings(settings)
  assert.deepEqual(reconnects, ['role-resume-fixture'])
  assert.equal(session.settings.assistantRole, 'calendar')
  session.updateSettings(structuredClone(settings))
  assert.equal(reconnects.length, 1, 'Unchanged roles do not reconnect')
  session.conn = null
  settings.assistantRole = 'focus'
  session.updateSettings(settings)
  assert.equal(reconnects.length, 1, 'A role preference must not activate an idle provider')
})
