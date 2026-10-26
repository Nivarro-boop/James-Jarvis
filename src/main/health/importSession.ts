/** One import at a time; clearing/cancelling invalidates even non-cooperative readers. */
export class HealthImportSession {
  private active: AbortController | null = null
  cancel(): void { this.active?.abort(new Error('Health-Import abgebrochen.')) }
  async run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.active) throw new Error('Ein Health-Import läuft bereits.')
    const controller = new AbortController()
    this.active = controller
    try {
      const result = await work(controller.signal)
      controller.signal.throwIfAborted()
      return result
    } finally { if (this.active === controller) this.active = null }
  }
}
