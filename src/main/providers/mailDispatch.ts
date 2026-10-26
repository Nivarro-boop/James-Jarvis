import { createHash } from 'node:crypto'

/** Retain failures too: a missing SMTP reply must not cause a second delivery. */
export function mailDispatcher() {
  const attempts = new Map<string, { hash: string; result: Promise<unknown> }>()
  return function dispatch<T>(id: string, payload: unknown, send: () => Promise<T>): Promise<T> {
    if (!/^[a-zA-Z0-9-]{16,100}$/.test(id)) return Promise.reject(new Error('Ungültige Versandkennung.'))
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
    const previous = attempts.get(id)
    if (previous) {
      if (previous.hash !== hash) return Promise.reject(new Error('Dieser Entwurf wurde bereits zum Versand übergeben. Prüfe „Gesendet“ und beginne bei Bedarf ausdrücklich eine neue Mail.'))
      return previous.result as Promise<T>
    }
    // Do not evict uncertain writes and make them accidentally retryable.
    if (attempts.size >= 500) return Promise.reject(new Error('Versandgrenze dieser Sitzung erreicht. Bitte James neu starten.'))
    const result = Promise.resolve().then(send)
    attempts.set(id, { hash, result })
    return result
  }
}
