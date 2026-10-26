import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

export async function limitedNodeStreamText(stream: Readable, maxBytes: number, signal?: AbortSignal): Promise<string> {
  const abort = (): void => { stream.destroy(new Error('Dateilesen abgebrochen.')) }
  signal?.addEventListener('abort', abort, { once: true })
  let bytes = 0, text = ''
  const decoder = new StringDecoder('utf8')
  try {
    signal?.throwIfAborted()
    for await (const chunk of stream) {
      signal?.throwIfAborted()
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > maxBytes) throw new Error('Die Datei ist zu groß zum Lesen.')
      text += decoder.write(buffer)
    }
    return text + decoder.end()
  } finally { signal?.removeEventListener('abort', abort); stream.destroy() }
}

/** Enforce the byte cap while downloading, before allocating a complete body. */
export async function limitedResponseText(response: Response, maxBytes: number): Promise<string> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > maxBytes) { await response.body?.cancel(); throw new Error('Die Serverantwort ist zu groß.') }
  if (!response.body) return ''
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let bytes = 0, text = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) throw new Error('Die Serverantwort ist zu groß.')
      text += decoder.decode(chunk.value, { stream: true })
    }
    return text + decoder.decode()
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}
