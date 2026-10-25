/** Share concurrent reads, but never cache settled results or failures. */
export function singleFlight<K, V>(read: (key: K) => Promise<V>): (key: K) => Promise<V> {
  const pending = new Map<K, Promise<V>>()
  return key => {
    const existing = pending.get(key)
    if (existing) return existing
    const operation = Promise.resolve().then(() => read(key))
    pending.set(key, operation)
    const clear = (): void => { if (pending.get(key) === operation) pending.delete(key) }
    void operation.then(clear, clear)
    return operation
  }
}
