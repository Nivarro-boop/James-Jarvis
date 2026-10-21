export interface RequestDeduperOptions {
  /** Maximum number of request IDs retained, including in-flight work. */
  maxEntries?: number
  /** How long a completed request remains replayable. */
  ttlMs?: number
  /** Persist a claim before a new operation is allowed to start. */
  claim?: (requestId: string) => void
}

export class RequestDeduperFullError extends Error {
  constructor() {
    super('Alexa-Anfragen sind momentan ausgelastet; es wurde keine Aktion gestartet.')
    this.name = 'RequestDeduperFullError'
  }
}

interface Entry<T> {
  promise: Promise<T>
  /** null means work is still in flight and must never be evicted. */
  expiresAt: number | null
}

/**
 * Share concurrent work and retain its result for a bounded period. In-flight
 * entries are never evicted: if the fixed capacity is entirely occupied, new
 * requests fail closed instead of starting an action that cannot be deduped.
 */
export function createRequestDeduper(options: RequestDeduperOptions = {}) {
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 512))
  const ttlMs = Math.max(1, options.ttlMs ?? 10 * 60_000)
  const entries = new Map<string, Entry<unknown>>()

  function prune(now: number): void {
    for (const [id, entry] of entries) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) entries.delete(id)
    }
  }

  return {
    run<T>(requestId: string, operation: () => Promise<T> | T): Promise<T> {
      const now = Date.now()
      prune(now)
      const existing = entries.get(requestId) as Entry<T> | undefined
      if (existing) return existing.promise

      // Never evict a completed request before its TTL: that would reopen the
      // exact replay window the cache is meant to close. Under pressure reject
      // new work without starting an action that cannot be deduped.
      if (entries.size >= maxEntries) return Promise.reject(new RequestDeduperFullError())

      // This runs synchronously before creating the promise that starts work.
      // A failed durable claim must never fall through to the operation.
      try {
        options.claim?.(requestId)
      } catch (err) {
        return Promise.reject(err)
      }

      const entry: Entry<T> = {
        promise: Promise.resolve().then(operation),
        expiresAt: null
      }
      entries.set(requestId, entry as Entry<unknown>)
      const completed = (): void => {
        if (entries.get(requestId) === entry) entry.expiresAt = Date.now() + ttlMs
      }
      // Attach both handlers without creating an unobserved rejecting promise.
      void entry.promise.then(completed, completed)
      return entry.promise
    },
    /** Exposed for deterministic regression tests and diagnostics. */
    size(): number {
      prune(Date.now())
      return entries.size
    }
  }
}
