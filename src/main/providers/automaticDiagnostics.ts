/** Only counters leave this queue. Fingerprints stay in memory for duplicate suppression. */
const BATCH_MS = 30_000
const INTERVAL_MS = 5 * 60_000
const DUPLICATE_MS = 15 * 60_000
export interface AutomaticReportConfig { enabled: boolean; automatic: boolean; url: string }

export class AutomaticDiagnostics {
  private pending = 0
  private fingerprints = new Map<string, number>()
  private cancelTimer: (() => void) | null = null
  private controller: AbortController | null = null
  private nextSend = 0
  private generation = 0
  private stopped = false

  constructor(private deps: {
    config: () => AutomaticReportConfig
    send: (count: number, signal: AbortSignal) => Promise<boolean>
    now?: () => number
    schedule?: (callback: () => void, delay: number) => () => void
  }) {}

  private now(): number { return (this.deps.now ?? Date.now)() }
  private allowed(): boolean {
    const c = this.deps.config()
    return !this.stopped && c.enabled && c.automatic
  }

  notify(fingerprint: string): void {
    if (!this.allowed()) return
    const now = this.now()
    const previous = this.fingerprints.get(fingerprint)
    if (previous !== undefined && now - previous < DUPLICATE_MS) return
    for (const [key, time] of this.fingerprints) if (now - time >= DUPLICATE_MS) this.fingerprints.delete(key)
    if (this.fingerprints.size >= 128) this.fingerprints.delete(this.fingerprints.keys().next().value!)
    this.fingerprints.set(fingerprint, now)
    this.pending = Math.min(10_000, this.pending + 1)
    this.arm()
  }

  private arm(): void {
    if (this.cancelTimer || this.controller || !this.pending || !this.allowed()) return
    const schedule = this.deps.schedule ?? ((callback, delay) => {
      const timer = setTimeout(callback, delay)
      timer.unref()
      return () => clearTimeout(timer)
    })
    this.cancelTimer = schedule(() => { this.cancelTimer = null; void this.flush() }, Math.max(BATCH_MS, this.nextSend - this.now()))
  }

  private async flush(): Promise<void> {
    if (!this.allowed() || !this.pending || this.controller) return
    const count = this.pending
    this.pending = 0
    const generation = this.generation
    const controller = new AbortController()
    this.controller = controller
    this.nextSend = this.now() + INTERVAL_MS
    let ok = false
    try { ok = await this.deps.send(count, controller.signal) } catch { /* No logging: upload failures must not create new incidents. */ }
    if (generation !== this.generation) return
    this.controller = null
    if (!ok) this.pending = Math.min(10_000, this.pending + count)
    this.arm()
  }

  /** Disabling or changing the destination discards queued reports and cancels network work. */
  reset(): void {
    this.generation++
    this.cancelTimer?.()
    this.cancelTimer = null
    this.controller?.abort()
    this.controller = null
    this.pending = 0
    this.fingerprints.clear()
    this.nextSend = 0
  }

  stop(): void { this.stopped = true; this.reset() }
}
