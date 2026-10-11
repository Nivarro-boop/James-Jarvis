import { abortable } from '@shared/async'

/** Read Hermes SSE without interpreting reasoning, previews or tool arguments as speech. */
export async function readHermesEvents(
  body: ReadableStream<Uint8Array>, runId: string, onEvent: (event: Record<string, unknown>) => void, signal?: AbortSignal
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let lastSeq = -1
  try {
    while (true) {
      signal?.throwIfAborted()
      const read = reader.read()
      const { value, done } = signal ? await abortable(read, signal) : await read
      buffer += decoder.decode(value, { stream: !done })
      if (buffer.length > 1_000_000) throw new Error('Hermes-Ereignis ist zu groß.')
      let boundary: RegExpExecArray | null
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        const data = block.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart()).join('\n')
        if (!data) continue
        const event: unknown = JSON.parse(data)
        if (!event || typeof event !== 'object' || Array.isArray(event)) continue
        const item = event as Record<string, unknown>
        if (item.run_id !== runId || typeof item.event !== 'string') continue
        if (item.event === 'replay.truncated') throw new Error('Hermes-Ereignisverlauf unvollständig.')
        if (!Number.isSafeInteger(item.seq) || (item.seq as number) <= lastSeq) continue
        lastSeq = item.seq as number
        onEvent(item)
      }
      if (done) return
    }
  } finally {
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
