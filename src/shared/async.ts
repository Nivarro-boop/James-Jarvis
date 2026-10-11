/** Release the caller even when an IPC/provider ignores cancellation. */
export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(signal.reason ?? new Error('Abgebrochen.'))
    if (signal.aborted) { operation.catch(() => undefined); aborted(); return }
    signal.addEventListener('abort', aborted, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}
