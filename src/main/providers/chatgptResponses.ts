import type { ChatGptItem, ChatGptModel, ChatGptResponse } from '@shared/chatgpt'
import { chatGptAccessToken, CHATGPT_RESOURCE } from './chatgptAuth'
import { consumeModelCall } from '../agent/modelBudget'
import { recordModelUsage } from '../agent/modelUsage'
import { abortable } from '@shared/async'

export function chatGptError(error?: { code?: string; message?: string }, status?: number): string {
  if (error?.code === 'subscription_sharing_usage_limit_exceeded' || status === 429) {
    return 'Dein ChatGPT-Kontingent oder das Limit für James ist erreicht. Verbrauch unter ChatGPT → Einstellungen → Nutzung verwalten.'
  }
  if (error?.code === 'subscription_sharing_usage_unavailable') return 'ChatGPT kann dein Plan-Kontingent gerade nicht nutzen. Nutzung in den ChatGPT-Einstellungen prüfen.'
  if (status === 401) return 'ChatGPT nimmt die Anmeldung nicht an. Bitte erneut anmelden.'
  if (status === 403) return 'Dein ChatGPT-Konto erlaubt diese Anfrage nicht. Plan-Freigabe und Modell in den Einstellungen prüfen.'
  return `ChatGPT meldet einen Fehler${error?.message ? `: ${error.message.slice(0, 400)}` : status ? ` (${status})` : ''}.`
}

async function authorizedFetch(path: string, init: RequestInit): Promise<Response> {
  const request = async (force: boolean): Promise<Response> => {
    init.signal?.throwIfAborted()
    // Refreshes are shared by callers. Cancel this wait without cancelling
    // another request's credential refresh.
    const pendingToken = chatGptAccessToken(force)
    const token = init.signal ? await abortable(pendingToken, init.signal) : await pendingToken
    init.signal?.throwIfAborted()
    return fetch(`${CHATGPT_RESOURCE}${path}`, {
      ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` }
    })
  }
  let response = await request(false)
  // Only retry a rejected credential, never a quota/network/partial-stream failure.
  if (response.status === 401) {
    void response.body?.cancel().catch(() => undefined)
    response = await request(true)
  }
  if (!response.ok) {
    let error: { code?: string; message?: string } | undefined
    try { error = (await response.json() as { error?: typeof error }).error } catch { /* status is enough */ }
    throw new Error(chatGptError(error, response.status))
  }
  return response
}

export async function chatGptModels(): Promise<ChatGptModel[]> {
  const response = await authorizedFetch('/models', { signal: AbortSignal.timeout(30_000) })
  const data = await response.json() as { models?: { slug?: string; display_name?: string; visibility?: string }[] }
  if (!Array.isArray(data.models)) throw new Error('ChatGPT hat keine gültige Modellliste geliefert.')
  return data.models.filter((m) => m.visibility === 'list' && typeof m.slug === 'string' && m.slug)
    .map((m) => ({ id: m.slug!, name: m.display_name || m.slug! }))
}

/** „Automatisch“ in den Einstellungen: kein fester Modellname. */
export const CHATGPT_AUTO = 'auto'
const FAST = /mini|nano|luna|flash|fast|spark|lite/i
let modelCache: { at: number; models: ChatGptModel[] } | null = null

/**
 * Löst „Automatisch“ auf: schnell im Gespräch, gründlich bei schwierigen
 * Aufgaben (Unteragenten, Bildschirmarbeit). Gewählt wird aus den Modellen,
 * die das Konto wirklich anbietet; die Liste wird zehn Minuten gemerkt.
 */
export async function resolveChatGptModel(model: string, purpose: 'fast' | 'deep' = 'fast'): Promise<string> {
  if (model !== CHATGPT_AUTO) return model
  if (!modelCache || Date.now() - modelCache.at > 10 * 60_000) modelCache = { at: Date.now(), models: await chatGptModels() }
  const all = modelCache.models.map(m => m.id)
  const general = all.filter(id => !/codex/i.test(id))
  const pool = general.length ? general : all
  const pick = purpose === 'fast' ? pool.find(id => FAST.test(id)) : pool.find(id => !FAST.test(id))
  const chosen = pick ?? pool[0]
  if (!chosen) throw new Error('Dein ChatGPT-Konto liefert keine verfügbaren Modelle.')
  return chosen
}

/** Deliberately whitelist fields: plan usage rejects max_output_tokens and many API parameters. */
export function chatGptRequestBody(model: string, instructions: string, input: ChatGptItem[], tools?: unknown[]): Record<string, unknown> {
  if (!model.trim()) throw new Error('Bitte ein verfügbares ChatGPT-Modell in den Einstellungen auswählen.')
  return { model, instructions, input, store: false, stream: true,
    ...(tools?.length ? { tools, parallel_tool_calls: false } : {}) }
}

export async function chatGptResponse(
  model: string, instructions: string, input: ChatGptItem[],
  options: { tools?: unknown[]; signal?: AbortSignal; onText?: (text: string) => void; purpose?: 'fast' | 'deep' } = {}
): Promise<ChatGptResponse> {
  // Nur „Automatisch“ braucht die Modellliste; sonst ohne Umweg, damit ein Abbruch sofort greift.
  if (model === CHATGPT_AUTO) model = await resolveChatGptModel(model, options.purpose)
  consumeModelCall()
  const started = Date.now()
  let firstMs: number | null = null
  const timeout = AbortSignal.timeout(180_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const response = await authorizedFetch('/responses', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(chatGptRequestBody(model, instructions, input, options.tools)),
    signal
  })
  if (!response.body) throw new Error('ChatGPT hat keinen Antwortstrom geliefert.')
  const result = await readResponseStream(response.body, text => {
    firstMs ??= Date.now() - started
    options.onText?.(text)
  }, signal)
  recordModelUsage(model, result.usage, Date.now() - started, firstMs)
  // Numbers only: make actual charged token usage inspectable without logging conversations.
  if (result.usage) console.info('[chatgpt:usage]', JSON.stringify({ model, ...result.usage }))
  return result
}

export async function chatGptThink(model: string, system: string, user: string, signal?: AbortSignal): Promise<string> {
  return (await chatGptResponse(model, system, [{ role: 'user', content: user }], { signal })).text
}

interface StreamEvent {
  type: string
  delta?: string
  error?: { code?: string; message?: string }
  code?: string
  message?: string
  output_index?: number
  item?: ChatGptItem
  response?: { status?: string; output?: ChatGptItem[]; usage?: ChatGptResponse['usage']; error?: { code?: string; message?: string } }
}

/** Handles CRLF split across network packets, UTF-8, explicit failures and reader cleanup. */
export async function readResponseStream(body: ReadableStream<Uint8Array>, onText?: (text: string) => void, signal?: AbortSignal): Promise<ChatGptResponse> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  const output = new Map<number, ChatGptItem>()
  const consume = (block: string): ChatGptResponse | null => {
    const data = block.split(/\r\n|\n|\r/).filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, '')).join('\n')
    if (!data || data === '[DONE]') return null
    const event = JSON.parse(data) as StreamEvent
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      text += event.delta
      onText?.(event.delta)
    } else if (event.type === 'response.output_item.done' && event.item) {
      output.set(event.output_index ?? output.size, event.item)
    } else if (event.type === 'response.completed') {
      if (event.response?.status && event.response.status !== 'completed') throw new Error('ChatGPT hat die Antwort nicht abgeschlossen.')
      const items = event.response?.output ?? [...output.entries()].sort(([a], [b]) => a - b).map(([, item]) => item)
      const finalText = items.filter((item) => item.type === 'message')
        .flatMap((item) => Array.isArray(item.content) ? item.content : [])
        .filter((part) => part.type === 'output_text').map((part) => part.text ?? '').join('')
      if (!text && finalText) onText?.(finalText)
      return { text: text || finalText, output: items, ...(event.response?.usage ? { usage: event.response.usage } : {}) }
    } else if (event.type === 'response.failed' || event.type === 'error') {
      throw new Error(chatGptError(event.response?.error ?? event.error ?? event))
    } else if (event.type === 'response.incomplete') throw new Error('ChatGPT hat die Antwort abgebrochen.')
    return null
  }
  try {
    while (true) {
      signal?.throwIfAborted()
      const read = reader.read()
      const chunk = signal ? await abortable(read, signal) : await read
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true })
      // Work on the accumulated buffer; replacing CRLF per chunk loses split CR/LF pairs.
      let separator: RegExpExecArray | null
      while ((separator = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
        const block = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator[0].length)
        const result = consume(block)
        if (result) return result
      }
      if (buffer.length > 16 * 1024 * 1024) throw new Error('ChatGPT hat ein zu großes Antwortereignis geliefert.')
      if (chunk.done) {
        const result = consume(buffer)
        if (result) return result
        break
      }
    }
    throw new Error('Die Verbindung zu ChatGPT ist vor dem Ende der Antwort abgerissen.')
  } finally {
    // Some stream transports never settle cancellation. Cleanup must not
    // hold a completed response (or the user's Stop action) hostage.
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export async function readStream(body: ReadableStream<Uint8Array>): Promise<string> {
  return (await readResponseStream(body)).text
}

/** Registry schemas use Chat Completions shape; the plan route requires namespaces. */
export function chatGptTools(schemas: unknown[]): unknown[] {
  const tools = schemas.map((schema) => {
    const definition = (schema as { function: { name: string; description?: string; parameters: unknown } }).function
    return { type: 'function', name: definition.name, description: definition.description,
      parameters: definition.parameters, strict: false }
  })
  return tools.length ? [{ type: 'namespace', name: 'jarvis', description: 'Werkzeuge von James-Jarvis auf diesem Rechner.', tools }] : []
}
