import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'
import { DEFAULT_SETTINGS } from '@shared/config/defaults'

/** Run the real session against deterministic sockets and audio, without a paid API call. */
async function harness() {
  const bundle = await build({
    entryPoints: [resolve('src/renderer/live/RealtimeSession.ts')], bundle: true,
    write: false, platform: 'node', format: 'cjs', logLevel: 'silent',
    plugins: [{ name: 'test-audio', setup(b) {
      b.onResolve({ filter: /audio\/player$/ }, () => ({ path: 'player', namespace: 'test' }))
      b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
        contents: 'export const createPlayer = () => window.testCreatePlayer()', loader: 'js'
      }))
    } }]
  })
  let next = 1
  const timers = new Map<number, { callback: () => void; ms: number }>()
  const sockets: Socket[] = []
  class Socket {
    static OPEN = 1
    readyState = 1
    sent: any[] = []
    onopen: (() => void) | null = null
    onmessage: ((msg: { data: string }) => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor() { sockets.push(this) }
    send(raw: string) { this.sent.push(JSON.parse(raw)) }
    close() { this.readyState = 3; this.onclose?.() }
    event(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
  }
  const players: any[] = []
  const window = {
    setTimeout: (callback: () => void, ms: number) => { const id = next++; timers.set(id, { callback, ms }); return id },
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: () => next++, clearInterval: () => {},
    testCreatePlayer: async () => {
      const player = { push() {}, flush() {}, setSettings() {}, isSpeaking: () => false, destroy: async () => {} }
      players.push(player)
      return player
    },
    jarvis: { invoke: async (channel: string): Promise<any> => {
      if (channel === 'openai:realtimeSecret') return { ok: true, value: 'dummy' }
      if (channel === 'agent:systemPrompt') return 'Test'
      if (channel === 'agent:toolSchemas') return []
      throw new Error(`Unexpected IPC: ${channel}`)
    } }
  }
  const module = { exports: {} as any }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, window, WebSocket: Socket, console, AbortSignal, AbortController, btoa, atob })
  const errors: string[] = []
  const states: string[] = []
  const transcripts: string[] = []
  const session = new module.exports.RealtimeSession(structuredClone(DEFAULT_SETTINGS), {
    onStateChange: (state: string) => states.push(state), onError: (error: string) => errors.push(error),
    onClosed() {}, onUserTranscript() {}, onModelTranscript(text: string) { transcripts.push(text) }
  })
  return { session, window, sockets, players, timers, errors, states, transcripts }
}
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

it('wendet Realtime-Kontextbudget an und übernimmt Sparmoduswechsel in laufender Sitzung', async () => {
  const h = await harness()
  await h.session.start()
  h.sockets[0].onopen?.()
  await settle()
  const updates = () => h.sockets[0].sent.filter((item: any) => item.type === 'session.update')
  assert.equal(updates().at(-1).session.truncation.token_limits.post_instructions, 8000)
  assert.equal(updates().at(-1).session.max_output_tokens, 2048)
  h.sockets[0].event({ type: 'session.updated' })
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.tokenSaver.enabled = false
  h.session.updateSettings(settings)
  await settle()
  assert.equal(updates().at(-1).session.truncation, 'auto')
  assert.equal(updates().at(-1).session.max_output_tokens, 'inf')
  await h.session.dispose()
})

it('streamt Realtime-Untertitel ohne die fertige Antwort doppelt anzuhängen', async () => {
  const h = await harness()
  await h.session.start()
  const socket = h.sockets[0]
  socket.event({ type: 'session.updated' })
  socket.event({ type: 'response.created' })
  socket.event({ type: 'response.output_audio_transcript.delta', delta: 'Guten ' })
  socket.event({ type: 'response.output_audio_transcript.delta', delta: 'Tag.' })
  socket.event({ type: 'response.output_audio_transcript.done', transcript: 'Guten Tag.' })
  assert.deepEqual(h.transcripts, ['Guten ', 'Tag.'])
  socket.event({ type: 'response.created' })
  socket.event({ type: 'response.output_audio_transcript.done', transcript: 'Erledigt.' })
  assert.equal(h.transcripts.at(-1), 'Erledigt.')
  await h.session.dispose()
})

it('wechselt bei Textaufträgen und Server-Antwortbeginn sofort vom Zuhören zum Arbeiten', async () => {
  const h = await harness()
  await h.session.start()
  h.sockets[0].event({ type: 'session.updated' })
  h.session.sendText('Öffne den Browser')
  assert.equal(h.states.at(-1), 'thinking')
  h.sockets[0].event({ type: 'response.done', response: { status: 'completed', output: [] } })
  assert.equal(h.states.at(-1), 'listening')
  h.sockets[0].event({ type: 'response.created' })
  assert.equal(h.states.at(-1), 'thinking')
  await h.session.dispose()
})

it('meldet eine fehlgeschlagene Realtime-Antwort statt wortlos weiterzuhören', async () => {
  const h = await harness()
  await h.session.start()
  h.sockets[0].event({ type: 'session.updated' })
  h.sockets[0].event({ type: 'response.done', response: { status: 'failed',
    status_details: { error: { code: 'insufficient_quota', message: 'quota exceeded' } }, output: [] } })
  assert.equal(h.errors.length, 1)
  await h.session.dispose()
})

it('schließt einen stummen Realtime-Aufbau und startet einen begrenzten Wiederholungsversuch', async () => {
  const h = await harness()
  await h.session.start()
  const old = h.sockets[0]
  assert.equal(h.session.isStarting(), true)
  const watchdog = [...h.timers.values()].find(t => t.ms === 25_000)!
  watchdog.callback()
  assert.equal(old.readyState, 3)
  assert.equal(h.session.isConnected(), false)
  const retry = [...h.timers.values()].find(t => t.ms === 2000)!
  retry.callback()
  await settle()
  assert.equal(h.sockets.length, 2)
  h.sockets[1].event({ type: 'session.updated' })
  assert.equal(h.session.isConnected(), true)
  assert.equal([...h.timers.values()].some(t => t.ms === 25_000), false)
  await h.session.dispose()
})

it('überträgt alte Werkzeugergebnisse nach Stop und Neustart nicht in die neue Sitzung', async () => {
  const h = await harness()
  const original = h.window.jarvis.invoke
  let resolveTool!: (value: unknown) => void
  h.window.jarvis.invoke = async channel => channel === 'tools:call'
    ? new Promise(resolve => { resolveTool = resolve }) : original(channel)
  await h.session.start()
  h.sockets[0].event({ type: 'session.updated' })
  h.sockets[0].event({ type: 'response.done', response: { status: 'completed', output: [
    { type: 'function_call', call_id: 'old-call', name: 'test', arguments: '{}' }
  ] } })
  await h.session.stop()
  await h.session.start()
  const current = h.sockets[1]
  current.event({ type: 'session.updated' })
  resolveTool({ id: 'old-call', name: 'test', ok: true, durationMs: 1 })
  await settle()
  assert.equal(current.sent.length, 0)
  assert.equal(h.states.at(-1), 'listening')
  await h.session.dispose()
})

it('behält bei einem Neustart während langsamer Audiofreigabe den neuen Player', async () => {
  const h = await harness()
  await h.session.start()
  let finishDestroy!: () => void
  h.players[0].destroy = () => new Promise<void>(resolve => { finishDestroy = resolve })
  const stopping = h.session.stop()
  await h.session.start()
  h.sockets[1].event({ type: 'session.updated' })
  finishDestroy()
  await stopping
  assert.equal(h.players.length, 2)
  assert.equal(h.session.isConnected(), true)
  assert.equal(h.states.at(-1), 'listening')
  await h.session.dispose()
})

it('sendet kein Audio an einen Realtime-Sockel in CLOSING und reicht den Satz nach dem Neuaufbau nach', async () => {
  const h = await harness()
  await h.session.start()
  const old = h.sockets[0]
  old.event({ type: 'session.updated' })
  const appends = (socket: { sent: any[] }) => socket.sent.filter((item: any) => item.type === 'input_audio_buffer.append')
  h.session.pushAudio(new Int16Array(320))
  assert.equal(appends(old).length, 1)

  // Der Server hat schon geschlossen, `onclose` steht noch aus.
  old.readyState = 2
  h.session.pushAudio(new Int16Array(320))
  h.session.pushAudio(new Int16Array(320))
  assert.equal(appends(old).length, 1)

  ;(old.onclose as any)({ code: 1011, reason: 'Internal error encountered.' })
  assert.equal(h.session.isConnected(), false)
  const retry = [...h.timers.values()].find(t => t.ms === 2000)!
  retry.callback()
  await settle()
  h.sockets[1].event({ type: 'session.updated' })
  assert.equal(appends(h.sockets[1]).length, 2)
  await h.session.dispose()
})

for (const input of ['text', 'speech']) it(`erholt sich von einer Realtime-Verbindung ohne Antwort auf ${input}`, async () => {
  const h = await harness()
  await h.session.start()
  const socket = h.sockets[0]
  socket.event({ type: 'session.updated' })
  if (input === 'text') h.session.sendText('Wie ist das Wetter?')
  else socket.event({ type: 'input_audio_buffer.speech_stopped' })
  assert.equal(h.states.at(-1), 'thinking')
  ;[...h.timers.values()].find(timer => timer.ms === 45_000)!.callback()
  assert.equal(socket.readyState, 3)
  assert.equal(h.session.isConnected(), false)
  assert.equal(h.session.awaitingReply, false)
  assert.equal(h.states.at(-1), 'connecting')
  assert.match(h.errors.at(-1)!, /keine Antwort/)
  await h.session.dispose()
})

it('meldet Texteingabe am schließenden Realtime-Socket und repariert die Verbindung', async () => {
  const h = await harness()
  await h.session.start()
  const socket = h.sockets[0]
  socket.event({ type: 'session.updated' })
  socket.readyState = 2
  assert.equal(h.session.isConnected(), false)
  assert.equal(h.session.sendText('Hallo'), false)
  assert.equal(socket.sent.length, 0)
  assert.equal(h.session.awaitingReply, false)
  assert.match(h.errors.at(-1)!, /noch nicht bereit/)
  assert.equal(h.states.at(-1), 'connecting')
  await h.session.dispose()
})

it('gibt einen getippten Realtime-Zug bei einem Sendefehler frei', async () => {
  const h = await harness()
  await h.session.start()
  const socket = h.sockets[0]
  socket.event({ type: 'session.updated' })
  socket.send = () => { throw new Error('Socket verloren') }
  h.session.sendText('Hallo')
  assert.equal(h.session.awaitingReply, false)
  assert.equal(h.states.at(-1), 'connecting')
  assert.match(h.errors.at(-1)!, /konnte nicht gesendet/)
  await h.session.dispose()
})

it('löscht die Realtime-Antwortzeitgrenze bei Antwort, Unterbrechung und Stop', async () => {
  const h = await harness()
  await h.session.start()
  const socket = h.sockets[0]
  socket.event({ type: 'session.updated' })
  h.session.sendText('Hallo')
  socket.event({ type: 'response.output_audio.delta', delta: 'AAA=' })
  assert.equal([...h.timers.values()].some(timer => timer.ms === 45_000), false)
  h.session.sendText('Hallo')
  h.session.interrupt()
  assert.equal([...h.timers.values()].some(timer => timer.ms === 45_000), false)
  h.session.sendText('Hallo')
  await h.session.stop()
  assert.equal([...h.timers.values()].some(timer => timer.ms === 45_000), false)
})

it('begrenzt Realtime-Neuaufbauten auch nach wiederholt kurzlebigen erfolgreichen Handshakes', async () => {
  const h = await harness()
  await h.session.start()
  for (let retry = 1; retry <= 6; retry++) {
    const socket = h.sockets.at(-1)!
    socket.event({ type: 'session.updated' })
    ;(socket.onclose as any)({ code: 1011, reason: 'Internal error encountered.' })
    assert.equal(h.session.retries, retry)
    if (retry <= 5) {
      const timer = [...h.timers.values()].find(t => t.ms === Math.min(1000 * 2 ** retry, 20_000))!
      timer.callback()
      await settle()
    }
  }
  assert.equal(h.session.stopped, true)
  assert.equal(h.states.at(-1), 'idle')
  assert.equal(h.errors.length, 1)
  await h.session.dispose()
})

it('teilt gleichzeitige Realtime-Starts während langsamer Audiofreigabe', async () => {
  const h = await harness()
  let finishPlayer!: (player: any) => void
  let playerCalls = 0
  h.window.testCreatePlayer = () => { playerCalls++; return new Promise(resolve => { finishPlayer = resolve }) }
  const first = h.session.start()
  const second = h.session.start()
  assert.equal(h.session.isStarting(), true)
  finishPlayer({ destroy: async () => {} })
  await Promise.all([first, second])
  assert.equal(playerCalls, 1)
  assert.equal(h.sockets.length, 1)
  await h.session.dispose()
})

it('setzt die Realtime-Antwortzeitgrenze während Werkzeugen aus und danach neu', async () => {
  const h = await harness()
  await h.session.start()
  const socket = h.sockets[0]
  socket.event({ type: 'session.updated' })
  h.session.sendText('Prüfe das Wetter')
  let finishTool!: (result: any) => void
  const invoke = h.window.jarvis.invoke
  h.window.jarvis.invoke = async channel => channel === 'tools:call'
    ? new Promise(resolve => { finishTool = resolve }) : invoke(channel)
  const running = h.session.handleToolCalls([{ call_id: 'weather', name: 'weather', arguments: '{}' }])
  assert.equal([...h.timers.values()].some(timer => timer.ms === 45_000), false)
  finishTool({ id: 'weather', name: 'weather', ok: true, result: 'sonnig' })
  await running
  assert.equal(socket.sent.at(-1).type, 'response.create')
  assert.equal(h.session.awaitingReply, true)
  assert.equal([...h.timers.values()].some(timer => timer.ms === 45_000), true)
  await h.session.dispose()
})

it('lässt alte Realtime-Player-Rückrufe nach einem Stop das Mikrofon nicht sperren', async () => {
  const h = await harness()
  const gates: boolean[] = []
  h.session.onUploadGate = (muted: boolean) => gates.push(muted)
  await h.session.start()
  const oldPlayer = h.session.player
  await h.session.stop()
  await h.session.start()
  h.sockets[1].event({ type: 'session.updated' })
  oldPlayer.onSpeakingChange(true)
  assert.equal(h.session.modelSpeaking, false)
  assert.equal(gates.at(-1), false)
  await h.session.dispose()
})

for (const reason of ['stop', 'timeout']) it(`löst einen hängenden Realtime-Audiostart bei ${reason} und räumt den späten Player auf`, async () => {
  const h = await harness()
  let finishPlayer!: (player: any) => void
  h.window.testCreatePlayer = () => new Promise(resolve => { finishPlayer = resolve })
  const starting = h.session.start()
  if (reason === 'stop') await h.session.stop()
  else [...h.timers.values()].find(timer => timer.ms === 25_000)!.callback()
  await starting
  assert.equal(h.session.isStarting(), false)
  assert.equal(h.session.isConnected(), false)
  assert.equal(h.states.at(-1), 'idle')
  assert.equal(h.errors.length, reason === 'stop' ? 0 : 1)
  let destroyed = 0
  finishPlayer({ destroy: async () => { destroyed++ } })
  await settle()
  assert.equal(destroyed, 1)
  assert.equal(h.session.player, null)
})

it('löst einen hängenden Realtime-Zugriff auf den Schlüssel sofort beim Stop', async () => {
  const h = await harness()
  let finishSecret!: (value: any) => void
  h.window.jarvis.invoke = () => new Promise(resolve => { finishSecret = resolve })
  const starting = h.session.start()
  await settle()
  assert.ok(finishSecret)
  await h.session.stop()
  await starting
  finishSecret({ ok: true, value: 'test' })
  await settle()
  assert.equal(h.session.isStarting(), false)
  assert.equal(h.sockets.length, 0)
  assert.equal(h.errors.length, 0)
})
