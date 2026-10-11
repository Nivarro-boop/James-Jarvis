import type { Settings, ToolCallResult } from '@shared/types'
import { createPlayer, type PlayerHandle } from '../audio/player'
import type { EngineState, VoiceEngine, VoiceEngineEvents } from './engine'
import { abortable } from '../../shared/async'

/**
 * Der dritte Motor: OpenAIs Realtime-API.
 *
 * Gebaut wie `LiveSession` — ein offener Sockel, der Server erkennt die
 * Sprechpausen, hört, denkt und spricht in einem Stück. Die Unterschiede
 * stecken im Protokoll, nicht im Ablauf:
 *
 * - Der Schlüssel bleibt im Hauptprozess. Hier kommt nur ein Token an, das
 *   eine Minute gilt und genau einen Aufbau trägt.
 * - Die API will 24 kHz, die Aufnahme liefert 16 kHz. Hochgerechnet wird hier.
 * - Werkzeugergebnisse lösen keine Antwort von selbst aus; nach dem letzten
 *   Ergebnis eines Zuges fordern wir sie mit `response.create` an.
 *
 * Gibt der Motor auf — Schlüssel fehlt, abgelehnt, Modell unbekannt —, meldet
 * er das über `onExhausted`, und der Controller fällt auf Gemini Live zurück.
 */

type RealtimeEvent = Record<string, any>

interface FunctionCall {
  call_id: string
  name: string
  arguments: string
}

const PENDING_AUDIO_MAX_CHUNKS = 500
const MAX_RETRIES = 5
const STABLE_CONNECTION_MS = 30_000
const REPLY_TIMEOUT_MS = 45_000

export class RealtimeSession implements VoiceEngine {
  public onUploadGate: ((muted: boolean) => void) | null = null
  public onOutputAudio: ((pcm: Int16Array) => void) | null = null
  public onExhausted: ((reason: string) => void) | null = null

  private settings: Settings
  private events: VoiceEngineEvents
  private ws: WebSocket | null = null
  private player: PlayerHandle | null = null

  private connecting = false
  private starting: Promise<void> | null = null
  private startupAbort: AbortController | null = null
  private generation = 0
  private connectTimer: number | null = null
  private ready = false
  private stopped = true
  private disposed = false
  private retries = 0
  private retryTimer: number | null = null
  private idleTimer: number | null = null
  private lastActivity = Date.now()
  private openedAt = 0

  private modelSpeaking = false
  private busyTools = 0
  /** Nutzer hat ausgeredet, Antwort noch nicht da — dann „Denkt nach" statt „Hört zu". */
  private awaitingReply = false
  private replyTimer: number | null = null
  private modelTranscriptStreamed = false
  private suppressAudio = false
  private reportedState: EngineState | null = null
  private pendingAudio: Int16Array[] = []

  private lastUserText = ''
  private lastUserTextAt = 0

  constructor(settings: Settings, events: VoiceEngineEvents) {
    this.settings = settings
    this.events = events
  }

  isConnected(): boolean {
    return this.ready && this.ws?.readyState === WebSocket.OPEN
  }

  isStarting(): boolean {
    return this.connecting || this.starting !== null
  }

  isAcceptingAudio(): boolean {
    return this.ready || (!this.stopped && !this.disposed)
  }

  // ─────────────────────────────────────────────────────────
  // Lebenszyklus
  // ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.disposed) return
    if (this.starting) return this.starting
    if (this.ws || this.connecting) return
    const abort = new AbortController()
    this.startupAbort = abort
    const timeout = window.setTimeout(() => abort.abort(new Error('Zeitüberschreitung beim Start der Sprachverbindung')), 25_000)
    const starting = this.beginStart(abort.signal).catch((error) => {
      if (!this.disposed && !this.stopped && this.startupAbort === abort) {
        void this.stop().catch(() => {})
        this.events.onError(`Die Sprachverbindung konnte nicht gestartet werden: ${error instanceof Error ? error.message : String(error)}.`)
      }
    })
    this.starting = starting
    try {
      await starting
    } finally {
      window.clearTimeout(timeout)
      if (this.startupAbort === abort) this.startupAbort = null
      if (this.starting === starting) this.starting = null
    }
  }

  private async beginStart(signal: AbortSignal): Promise<void> {
    this.clearTimers()
    this.clearAwaitingReply()
    this.stopped = false
    this.retries = 0
    this.pendingAudio = []
    this.lastActivity = Date.now()
    this.lastUserText = ''
    this.lastUserTextAt = 0
    const generation = ++this.generation
    this.emit('connecting')

    if (!this.player) {
      try {
        const pending = createPlayer(this.settings.audio)
        let player: PlayerHandle
        try {
          player = await abortable(pending, signal)
        } catch (error) {
          void pending.then(late => late.destroy()).catch(() => {})
          throw error
        }
        if (this.disposed || this.stopped || generation !== this.generation) {
          await player.destroy()
          return
        }
        this.player = player
      } catch (err) {
        if (this.disposed || this.stopped || generation !== this.generation) return
        this.stopped = true
        this.emit('idle')
        this.events.onError(
          `Die Tonausgabe ließ sich nicht öffnen: ${err instanceof Error ? err.message : String(err)}.`
        )
        return
      }
      const player = this.player
      this.player.onSpeakingChange = (speaking) => {
        if (this.player !== player || this.stopped) return
        this.modelSpeaking = speaking
        if (speaking) this.clearAwaitingReply()
        this.applyUploadGate()
        this.emitDerivedState()
      }
    }

    await abortable(this.connect(), signal)
  }

  private async connect(): Promise<void> {
    if (this.disposed || this.stopped || this.connecting) return
    this.connecting = true
    const generation = ++this.generation
    this.connectTimer = window.setTimeout(() => {
      if (generation === this.generation && !this.ready) this.scheduleRetry()
    }, 25_000)
    try {
      const secret = await abortable(window.jarvis.invoke('openai:realtimeSecret'), AbortSignal.timeout(25_000))
      if (this.disposed || this.stopped || generation !== this.generation) return
      if (!secret.ok) {
        if (/network/i.test(secret.error)) {
          this.scheduleRetry()
        } else {
          this.giveUp(secret.error)
        }
        return
      }

      const model = encodeURIComponent(this.settings.speech.realtimeModel)
      const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, [
        'realtime',
        `openai-insecure-api-key.${secret.value}`
      ])
      this.ws = ws
      ws.onopen = () => {
        if (this.ws !== ws) return
        void this.configure(ws).catch((error) => {
          if (this.ws !== ws) return
          console.warn('[realtime] Konfiguration fehlgeschlagen:', error)
          this.scheduleRetry()
        })
      }
      ws.onmessage = (msg) => {
        if (this.ws !== ws) return
        try {
          this.handleEvent(JSON.parse(String(msg.data)))
        } catch (err) {
          console.debug('[realtime] Nachricht verworfen:', err)
        }
      }
      ws.onerror = () => {
        if (this.ws !== ws) return
        console.error('[realtime] Socket-Fehler')
      }
      ws.onclose = (ev) => {
        if (this.ws !== ws) return
        this.handleClose(ev.code, ev.reason)
      }
    } catch (err) {
      if (generation !== this.generation) return
      console.error('[realtime] Aufbau fehlgeschlagen:', err)
      this.scheduleRetry()
    }
  }

  private async configure(ws: WebSocket): Promise<void> {
    const [instructions, schemas] = await Promise.all([
      window.jarvis.invoke('agent:systemPrompt'),
      window.jarvis.invoke('agent:toolSchemas')
    ])
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return

    const tools = (schemas as { function?: Record<string, unknown> }[])
      .map((t) => t.function)
      .filter((f): f is Record<string, unknown> => !!f)
      .map((f) => ({ type: 'function', name: f.name, description: f.description, parameters: f.parameters }))

    const vad = this.settings.vad
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions,
        output_modalities: ['audio'],
        // Bound growing voice history while amortizing cache invalidation.
        ...(this.settings.tokenSaver.enabled ? {
          max_output_tokens: 2048,
          truncation: { type: 'retention_ratio', retention_ratio: 0.8, token_limits: { post_instructions: 8000 } }
        } : { max_output_tokens: 'inf', truncation: 'auto' }),
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            noise_reduction: { type: 'far_field' },
            transcription: { model: 'gpt-4o-mini-transcribe', language: this.settings.language.slice(0, 2) },
            turn_detection: {
              type: 'server_vad',
              prefix_padding_ms: vad.prefixPaddingMs,
              silence_duration_ms: vad.silenceDurationMs,
              create_response: true,
              interrupt_response: true
            }
          },
          output: {
            format: { type: 'audio/pcm', rate: 24000 },
            voice: this.settings.speech.realtimeVoice
          }
        },
        tools,
        tool_choice: 'auto'
      }
    })
  }

  async stop(): Promise<void> {
    this.cancelRunningTools()
    this.generation++
    this.startupAbort?.abort(new Error('Sprachstart abgebrochen'))
    this.startupAbort = null
    this.starting = null
    this.connecting = false
    this.stopped = true
    this.clearTimers()
    this.pendingAudio = []
    this.ready = false
    const ws = this.ws
    this.ws = null
    try {
      ws?.close()
    } catch {
      // Bereits zu.
    }
    const player = this.player
    this.player = null
    this.modelSpeaking = false
    this.suppressAudio = false
    this.busyTools = 0
    this.clearAwaitingReply()
    this.onUploadGate?.(false)
    this.emit('idle')
    await player?.destroy()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.stop()
  }

  /** Prompt und Werkzeuge lassen sich hier an der laufenden Sitzung nachreichen. */
  async refreshConfig(): Promise<void> {
    if (this.ws && this.ready) await this.configure(this.ws)
  }

  updateSettings(settings: Settings): void {
    const reconfigure =
      settings.tokenSaver.enabled !== this.settings.tokenSaver.enabled ||
      settings.speech.realtimeVoice !== this.settings.speech.realtimeVoice ||
      settings.language !== this.settings.language ||
      JSON.stringify(settings.vad) !== JSON.stringify(this.settings.vad)
    const halfDuplexChanged = settings.audio.halfDuplex !== this.settings.audio.halfDuplex
    this.settings = settings
    this.player?.setSettings(settings.audio)
    if (halfDuplexChanged) this.applyUploadGate()
    if (reconfigure) void this.refreshConfig().catch((error) => {
      this.events.onError(`Die Spracheinstellungen konnten nicht übernommen werden: ${error instanceof Error ? error.message : String(error)}.`)
    })
  }

  interrupt(): void {
    this.clearAwaitingReply()
    this.cancelRunningTools()
    this.player?.flush()
    this.modelSpeaking = false
    this.suppressAudio = true
    this.send({ type: 'response.cancel' })
    this.applyUploadGate()
    this.emitDerivedState()
  }

  // ─────────────────────────────────────────────────────────
  // Ein- und Ausgabe
  // ─────────────────────────────────────────────────────────

  pushAudio(pcm: Int16Array): void {
    // `ready` bleibt bis zum `onclose` wahr, ein Sockel in CLOSING nimmt aber
    // nichts mehr an. Ohne die Prüfung würde der Block noch umgerechnet und
    // kodiert, nur damit `send` ihn verwirft — und der Satz wäre weg. So geht
    // er in den Puffer und mit dem Neuaufbau hinaus.
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) {
      if (!this.stopped && !this.disposed) {
        this.pendingAudio.push(pcm)
        if (this.pendingAudio.length > PENDING_AUDIO_MAX_CHUNKS) this.pendingAudio.shift()
      }
      return
    }
    if (!this.send({ type: 'input_audio_buffer.append', audio: int16ToBase64(upsample16to24(pcm)) })) {
      this.pendingAudio.push(pcm)
      if (this.pendingAudio.length > PENDING_AUDIO_MAX_CHUNKS) this.pendingAudio.shift()
      this.scheduleRetry()
    }
  }

  sendText(text: string): boolean {
    if (!this.isConnected()) {
      this.events.onError('Die Sprachverbindung ist noch nicht bereit. Bitte versuche die Texteingabe erneut.')
      if (this.ws && !this.stopped && !this.disposed) this.scheduleRetry()
      return false
    }
    if (!this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
    }) || !this.send({ type: 'response.create' })) {
      this.events.onError('Die Texteingabe konnte nicht gesendet werden. Die Verbindung wird neu aufgebaut. Bitte wiederhole deine Anfrage.')
      this.scheduleRetry()
      return false
    }
    this.lastActivity = Date.now()
    this.lastUserText = text
    this.lastUserTextAt = Date.now()
    this.expectReply()
    this.suppressAudio = false
    this.emitDerivedState()
    return true
  }

  private send(event: Record<string, unknown>): boolean {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    try {
      ws.send(JSON.stringify(event))
      return true
    } catch (err) {
      console.debug('[realtime] Senden fehlgeschlagen:', err)
      return false
    }
  }

  private handleEvent(ev: RealtimeEvent): void {
    this.lastActivity = Date.now()
    if (this.ready && Date.now() - this.openedAt >= STABLE_CONNECTION_MS) this.retries = 0
    switch (ev.type) {
      case 'response.created':
        this.modelTranscriptStreamed = false
        this.expectReply()
        this.emitDerivedState()
        return
      case 'session.updated': {
        const first = !this.ready
        this.ready = true
        this.connecting = false
        if (this.connectTimer !== null) window.clearTimeout(this.connectTimer)
        this.connectTimer = null
        if (first) {
          this.openedAt = Date.now()
          this.scheduleIdleCheck()
          this.emitDerivedState()
          const queued = this.pendingAudio
          this.pendingAudio = []
          for (const chunk of queued) this.pushAudio(chunk)
        }
        return
      }
      case 'input_audio_buffer.speech_stopped':
        this.expectReply()
        this.emitDerivedState()
        return
      case 'input_audio_buffer.speech_started':
        this.clearAwaitingReply()
        this.cancelRunningTools()
        // Barge-in: Der Server bricht die Antwort ab, wir den Puffer.
        this.player?.flush()
        this.modelSpeaking = false
        this.suppressAudio = false
        this.applyUploadGate()
        this.emitDerivedState()
        return
      case 'conversation.item.input_audio_transcription.completed':
        if (ev.transcript) {
          this.lastUserText = ev.transcript
          this.lastUserTextAt = Date.now()
          this.events.onUserTranscript(ev.transcript)
        }
        return
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        if (this.suppressAudio || !ev.delta) return
        this.clearAwaitingReply()
        const pcm = base64ToInt16(ev.delta)
        this.player?.push(pcm)
        this.onOutputAudio?.(pcm)
        return
      }
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        if (ev.delta) {
          this.clearAwaitingReply()
          this.modelTranscriptStreamed = true
          this.events.onModelTranscript(ev.delta)
        }
        return
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        this.clearAwaitingReply()
        if (ev.transcript && !this.modelTranscriptStreamed) this.events.onModelTranscript(ev.transcript)
        return
      case 'response.done': {
        this.suppressAudio = false
        this.clearAwaitingReply()
        this.emitDerivedState()
        if (ev.response?.status === 'incomplete' && ev.response.status_details?.reason === 'max_output_tokens') {
          this.events.onError('Die Antwort erreichte das Sparlimit. Für eine ausführlichere Antwort den Sparmodus ausschalten oder in Teilfragen fortsetzen.')
        }
        if (ev.response?.status === 'failed') {
          const error = ev.response.status_details?.error
          const message = error?.message ?? 'OpenAI konnte diese Antwort nicht erzeugen.'
          console.error('[realtime] Antwort fehlgeschlagen:', error?.code ?? '', message)
          this.events.onError(friendlyError(message))
        }
        const output: RealtimeEvent[] = ev.response?.output ?? []
        const calls = output.filter((o) => o.type === 'function_call') as FunctionCall[]
        if (calls.length > 0 && ev.response?.status !== 'cancelled' && ev.response?.status !== 'failed') {
          void this.handleToolCalls(calls).catch((error) => {
            console.warn('[realtime] Werkzeugantwort fehlgeschlagen:', error)
          })
        }
        this.emitDerivedState()
        return
      }
      case 'error': {
        const message: string = ev.error?.message ?? 'Unbekannter Fehler'
        const code: string = ev.error?.code ?? ''
        // Ein abgebrochener Zug ohne laufende Antwort ist kein Fehler.
        if (code === 'response_cancel_not_active') return
        this.clearAwaitingReply()
        console.error('[realtime] Fehler:', code, message)
        if (/invalid_api_key|model_not_found|unsupported/i.test(code + ' ' + message)) {
          this.giveUp(message)
        } else {
          this.events.onError(friendlyError(message))
        }
        return
      }
    }
  }

  private async handleToolCalls(calls: FunctionCall[]): Promise<void> {
    this.clearAwaitingReply()
    const generation = this.generation
    const toolTurn = this.toolTurn
    const ws = this.ws
    this.busyTools += calls.length
    this.emitDerivedState()
    const userTurn = { lastUserText: this.lastUserText, lastUserTextAt: this.lastUserTextAt }
    let results: { call: FunctionCall; result: ToolCallResult }[] = []
    try {
      results = await Promise.all(
        calls.map(async (call) => {
          let args: Record<string, unknown> = {}
          try {
            args = call.arguments ? JSON.parse(call.arguments) : {}
          } catch {
            // Kaputtes JSON: Das Werkzeug meldet den fehlenden Wert selbst.
          }
          let result: ToolCallResult
          this.activeTools.add(call.call_id)
          const abort = new AbortController()
          this.toolAborts.set(call.call_id, abort)
          try {
            result = await abortable(window.jarvis.invoke('tools:call', {
              id: call.call_id, name: call.name, args, userTurn,
              budgetId: `realtime-${generation}-${userTurn.lastUserTextAt}`
            }), AbortSignal.any([abort.signal, AbortSignal.timeout(180_000)]))
          } catch (error) {
            void window.jarvis.invoke('tools:cancel', { id: call.call_id }).catch(() => {})
            result = { id: call.call_id, name: call.name, ok: false, durationMs: 0,
              error: error instanceof Error ? error.message : 'Werkzeugaufruf fehlgeschlagen.' }
          } finally {
            if (this.toolAborts.get(call.call_id) === abort) {
              this.activeTools.delete(call.call_id)
              this.toolAborts.delete(call.call_id)
            }
          }
          return { call, result }
        })
      )
    } finally {
      if (generation === this.generation) {
        this.busyTools = Math.max(0, this.busyTools - calls.length)
        this.emitDerivedState()
      }
    }
    if (!this.ready || generation !== this.generation || toolTurn !== this.toolTurn || this.ws !== ws) return
    for (const { call, result } of results) {
      if (!this.send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: call.call_id,
          output: JSON.stringify(
            result.ok ? { output: result.result ?? 'Erledigt.' } : { error: result.error ?? 'Unbekannter Fehler.' }
          )
        }
      })) {
        this.events.onError('Das Werkzeugergebnis konnte nicht übermittelt werden. Die Verbindung wird neu aufgebaut. Bitte wiederhole deine Anfrage.')
        this.scheduleRetry()
        return
      }
    }
    if (this.send({ type: 'response.create' })) {
      this.expectReply()
      this.emitDerivedState()
    } else {
      this.events.onError('Die Antwort auf das Werkzeugergebnis konnte nicht angefordert werden. Die Verbindung wird neu aufgebaut. Bitte wiederhole deine Anfrage.')
      this.scheduleRetry()
    }
  }

  private activeTools = new Set<string>()
  private toolAborts = new Map<string, AbortController>()
  private toolTurn = 0
  private cancelRunningTools(): void {
    this.toolTurn++
    for (const id of this.activeTools) {
      this.toolAborts.get(id)?.abort()
      void window.jarvis.invoke('tools:cancel', { id }).catch(() => {})
    }
    this.activeTools.clear()
  }

  private handleClose(code: number, reason: string): void {
    if (this.ready && Date.now() - this.openedAt >= STABLE_CONNECTION_MS) this.retries = 0
    this.cancelRunningTools()
    this.ws = null
    this.ready = false
    this.connecting = false
    this.clearTimers()
    if (this.disposed || this.stopped) {
      this.events.onClosed()
      return
    }
    console.warn('[realtime] Verbindung getrennt:', code, reason)
    // 1008 = Richtlinie verletzt, hier: Token oder Modell abgelehnt.
    if (code === 1008 || /invalid|unauthor|not found/i.test(reason)) {
      this.giveUp(reason || 'Der OpenAI Zugang wurde abgelehnt.')
      return
    }
    this.scheduleRetry()
  }

  private giveUp(reason: string): void {
    console.error('[realtime] Verbindung aufgegeben:', reason)
    this.generation++
    this.clearTimers()
    this.connecting = false
    const ws = this.ws
    this.ws = null
    try { ws?.close() } catch { /* already closed */ }
    this.player?.flush()
    this.modelSpeaking = false
    this.clearAwaitingReply()
    this.cancelRunningTools()
    this.applyUploadGate()
    this.pendingAudio = []
    this.busyTools = 0
    this.stopped = true
    this.ready = false
    this.emit('idle')
    this.events.onError(friendlyError(reason))
    this.onExhausted?.(reason)
  }

  // ─────────────────────────────────────────────────────────
  // Zustand und Zeit
  // ─────────────────────────────────────────────────────────

  private emit(state: EngineState): void {
    if (this.reportedState === state) return
    this.reportedState = state
    this.events.onStateChange(state)
  }

  private emitDerivedState(): void {
    if (this.stopped || !this.ready) return
    if (this.busyTools > 0) return this.emit('thinking')
    if (this.modelSpeaking) return this.emit('speaking')
    if (this.awaitingReply) return this.emit('thinking')
    this.emit('listening')
  }

  private applyUploadGate(): void {
    this.onUploadGate?.(!this.stopped && this.isConnected() && this.settings.audio.halfDuplex && this.modelSpeaking)
  }

  private expectReply(): void {
    this.clearAwaitingReply()
    this.awaitingReply = true
    const generation = this.generation
    this.replyTimer = window.setTimeout(() => {
      this.replyTimer = null
      if (this.disposed || this.stopped || generation !== this.generation || this.busyTools > 0) return
      this.events.onError('James hat keine Antwort erhalten. Die Sprachverbindung wird neu aufgebaut. Bitte wiederhole deine Anfrage.')
      this.scheduleRetry()
    }, REPLY_TIMEOUT_MS)
  }

  private clearAwaitingReply(): void {
    if (this.replyTimer !== null) window.clearTimeout(this.replyTimer)
    this.replyTimer = null
    this.awaitingReply = false
  }

  private scheduleIdleCheck(): void {
    if (this.idleTimer) window.clearInterval(this.idleTimer)
    this.idleTimer = window.setInterval(() => {
      const idleSec = (Date.now() - this.lastActivity) / 1000
      const limit = this.settings.wake.idleDisconnectSec
      if (limit > 0 && idleSec > limit && !this.modelSpeaking && this.busyTools === 0 && !this.awaitingReply) {
        console.info('[realtime] Sitzung wegen Stille geschlossen')
        void this.stop()
      }
    }, 5000)
  }

  private scheduleRetry(): void {
    if (this.disposed || this.stopped) return
    this.generation++
    this.cancelRunningTools()
    this.connecting = false
    this.ready = false
    this.busyTools = 0
    const ws = this.ws
    this.ws = null
    try { ws?.close() } catch { /* already closed */ }
    this.clearTimers()
    this.clearAwaitingReply()
    this.player?.flush()
    this.modelSpeaking = false
    this.applyUploadGate()
    this.emit('connecting')
    this.retries++
    if (this.retries > MAX_RETRIES) {
      this.giveUp('Die Verbindung zu OpenAI lässt sich gerade nicht aufbauen.')
      return
    }
    const delay = Math.min(1000 * 2 ** this.retries, 20_000)
    if (this.retryTimer) window.clearTimeout(this.retryTimer)
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null
      void this.connect()
    }, delay)
  }

  private clearTimers(): void {
    if (this.replyTimer !== null) window.clearTimeout(this.replyTimer)
    this.replyTimer = null
    if (this.connectTimer !== null) window.clearTimeout(this.connectTimer)
    this.connectTimer = null
    if (this.retryTimer) window.clearTimeout(this.retryTimer)
    if (this.idleTimer) window.clearInterval(this.idleTimer)
    this.retryTimer = null
    this.idleTimer = null
  }
}

function friendlyError(raw: string): string {
  const lower = raw.toLowerCase()
  if (lower.includes('kein openai')) return raw
  if (lower.includes('api key') || lower.includes('401') || lower.includes('unauthor')) {
    return 'Der OpenAI Zugang wird nicht akzeptiert. Prüf den Schlüssel in den Einstellungen.'
  }
  if (lower.includes('quota') || lower.includes('429') || lower.includes('rate')) {
    return 'Das OpenAI Kontingent ist gerade aufgebraucht.'
  }
  if (lower.includes('model') && (lower.includes('not') || lower.includes('404'))) {
    return 'Das eingestellte OpenAI Modell gibt es nicht.'
  }
  if (lower.includes('network')) return 'Ich komme gerade nicht ins Netz.'
  return 'Bei der Verbindung zu OpenAI ist etwas schiefgegangen.'
}

/** 16 kHz → 24 kHz, linear. Für Sprache reicht das völlig. */
export function upsample16to24(input: Int16Array): Int16Array {
  const outLength = Math.floor((input.length * 3) / 2)
  const out = new Int16Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const pos = (i * 2) / 3
    const idx = Math.floor(pos)
    const frac = pos - idx
    const a = input[idx] ?? 0
    const b = input[idx + 1] ?? a
    out[i] = Math.round(a + (b - a) * frac)
  }
  return out
}

function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function base64ToInt16(base64: string): Int16Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length - (binary.length % 2))
  for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Int16Array(bytes.buffer)
}
