import { buildSystemPrompt } from '../agent/prompt'
import { getSettings } from '../store/settings'
import { getSecret } from '../secrets/keystore'
import { readHermesEvents } from './hermesEvents'

export interface HermesHooks {
  onText(text: string): void
  onProgress?(text: string): void
}

/** Full Hermes gateway API, as specified by the user's archive, not a reimplementation of its tools. */
export function hermesBase(raw: string): string {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error('Hermes muss über eine lokale HTTP-Adresse ohne Zugangsdaten in der URL verbunden werden.')
  }
  return url.toString().replace(/\/+$/, '')
}

async function request(base: string, path: string, init: RequestInit = {}): Promise<any> {
  const key = getSecret('hermes')
  const response = await fetch(`${base}${path}`, {
    ...init, redirect: 'error',
    signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...init.headers }
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Hermes-Anfrage abgelehnt (${response.status}). ${response.status === 401 ? 'API_SERVER_KEY unter Zugänge speichern.' : 'Lokalen Hermes-Gateway und Modellkonfiguration prüfen.'}`)
  }
  return response.json()
}

export async function hermesHealth(): Promise<{ ok: boolean; detail: string }> {
  try {
    const base = hermesBase(getSettings().hermes.baseUrl)
    const models = await request(base, '/v1/models')
    if (!Array.isArray(models.data)) throw new Error('Keine Hermes-Modellliste erhalten.')
    return { ok: true, detail: `Gateway erreichbar. ${models.data.length} Modellrouten verfügbar.` }
  } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : String(error) } }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const abort = (): void => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export async function hermesRun(input: string, sessionId: string, parentSignal?: AbortSignal, hooks?: HermesHooks): Promise<string> {
  const settings = getSettings()
  const base = hermesBase(settings.hermes.baseUrl)
  const timeout = AbortSignal.timeout(10 * 60_000)
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout
  signal.throwIfAborted()
  if (!input.trim() || input.length > 100_000 || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error('Ungültiger Hermes-Auftrag oder Gesprächskennung.')
  // Obtain the run ID before applying caller cancellation, so a late start can
  // still be stopped on the server. The request itself has a bounded deadline.
  const start = await request(base, '/v1/runs', { method: 'POST', body: JSON.stringify({
    model: settings.hermes.model, input, session_id: sessionId,
    instructions: buildSystemPrompt({ lazyTools: false, query: input, desktopContext: true }) + '\nDu arbeitest über den Hermes-Gateway. Nutze ausschließlich die dort tatsächlich verfügbaren Werkzeuge; Jarvis-Werkzeugnamen im Kontext sind Referenzen, keine Zusage ihrer Verfügbarkeit. Antworte auf Deutsch.'
  }) })
  const runId = String(start.run_id ?? start.id ?? '')
  if (!/^run_[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Hermes hat keine gültige Auftragskennung geliefert.')
  let finished = false
  const streamAbort = new AbortController()
  let spoken = ''
  let segment = ''
  const emit = (text: string): void => { if (!text || signal.aborted) return; spoken += text; segment += text; hooks?.onText(text) }
  const stream = hooks ? (async () => {
    const connectAbort = new AbortController()
    const connectTimer = setTimeout(() => connectAbort.abort(), 10_000)
    let response: Response
    try {
      const key = getSecret('hermes')
      response = await fetch(`${base}/v1/runs/${runId}/events`, { redirect: 'error',
        headers: { Accept: 'text/event-stream', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        signal: AbortSignal.any([signal, streamAbort.signal, connectAbort.signal]) })
    } finally { clearTimeout(connectTimer) }
    if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body?.cancel(); return
    }
    await readHermesEvents(response.body, runId, event => {
      if (signal.aborted || streamAbort.signal.aborted) return
      if (event.event === 'message.delta' && typeof event.delta === 'string') emit(event.delta)
      if (event.event === 'message.interim') {
        if (!event.already_streamed && typeof event.text === 'string') emit(event.text)
        emit('\n'); segment = ''
      }
      if (event.event === 'tool.started') {
        const name = typeof event.tool === 'string' ? event.tool.replace(/[^\w.-]/g, '').slice(0, 100) : ''
        hooks.onProgress?.(name ? `Hermes verwendet ${name}.` : 'Hermes führt ein Werkzeug aus.')
      }
    }, AbortSignal.any([signal, streamAbort.signal]))
  })().catch(() => { /* Polling remains authoritative if the optional stream fails. */ }) : Promise.resolve()
  try {
    while (true) {
      signal.throwIfAborted()
      const state = await request(base, `/v1/runs/${runId}`, { signal })
      if (state.status === 'completed') {
        finished = true
        if (typeof state.output !== 'string' || !state.output.trim()) throw new Error('Hermes hat keinen Ergebnistext geliefert.')
        if (hooks) {
          await Promise.race([stream, delay(500, signal)])
          streamAbort.abort()
          await stream
          if (!spoken.endsWith(state.output)) {
            emit(state.output.startsWith(segment) ? state.output.slice(segment.length) : `${spoken ? '\n' : ''}${state.output}`)
          }
        }
        return state.output
      }
      if (['failed', 'cancelled', 'stopped', 'interrupted'].includes(state.status)) {
        finished = true
        throw new Error(typeof state.error === 'string' ? state.error : 'Hermes-Auftrag wurde beendet.')
      }
      if (state.status === 'waiting_for_approval') {
        if (settings.confirmActions) throw new Error('Hermes wartet auf eine Freigabe in seiner eigenen Oberfläche.')
        await request(base, `/v1/runs/${runId}/approval`, { method: 'POST', signal,
          body: JSON.stringify({ choice: 'once', all: true }) })
      }
      await delay(500, signal)
    }
  } finally {
    streamAbort.abort()
    await stream
    if (!finished) {
      try { await request(base, `/v1/runs/${runId}/stop`, { method: 'POST' }) }
      catch (error) { console.warn('[hermes] Serverseitiger Stopp nicht bestätigt:', error instanceof Error ? error.message : String(error)) }
    }
  }
}
