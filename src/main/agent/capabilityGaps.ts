import { AsyncLocalStorage } from 'node:async_hooks'
import {
  capabilityGapReport,
  clip,
  detectRefusal,
  gapFingerprint,
  suggestFix,
  type CapabilityGap,
  type GapSource,
  type GapToolFailure,
  type GapToolFailureKind
} from '@shared/capabilityGap'

/**
 * Fähigkeitslücken sammeln und an die Fehlerseite melden.
 *
 * Drei Quellen laufen hier zusammen: gescheiterte Werkzeugaufrufe aus dem
 * Runner, Antworten, in denen James ablehnt, und `report_capability_gap`, mit
 * dem das Modell selbst meldet. Gehören sie zur selben Bitte, wird daraus ein
 * Bericht — erst wenn sechs Sekunden lang nichts mehr dazukommt, ohne
 * Antwort zwanzig. Sonst käme
 * dieselbe Lücke dreimal an, einmal je Quelle, und keiner der drei Berichte
 * hätte das ganze Bild.
 *
 * Ohne beide Schalter (`enabled` und `capabilityGaps`) passiert nichts, auch
 * kein Zwischenspeichern: Wer die Zustimmung später gibt, schickt damit nicht
 * nachträglich alte Gespräche los. Wie bei der Fehlerstatistik bleibt ein
 * gescheiterter Versand still — ein Fehler beim Melden darf keinen neuen
 * Vorfall erzeugen.
 */

const QUIET_MS = 6000
/**
 * Ohne Antwort wartet ein Eintrag länger. Werkzeugfehler und Modellmeldung
 * kommen vor dem Satz, der Kristall reicht den Zug aber erst nach, wenn James
 * fertig gesprochen hat — eine Absage samt Erklärung dauert oft länger als
 * sechs Sekunden, und dann käme die Antwort als zweiter Bericht.
 */
const ANSWER_WAIT_MS = 20_000
const FAILURE_MS = 2 * 60_000
const FAILURE_LIMIT = 20
const PENDING_LIMIT = 20
const DUPLICATE_MS = 12 * 60 * 60_000
const FINGERPRINT_LIMIT = 256
const HOUR_MS = 60 * 60_000
const HOURLY_LIMIT = 12
const QUEUE_LIMIT = 50
const RETRY_MS = 5 * 60_000
const MAX_ATTEMPTS = 3
/** Obergrenze im Speicher; gekürzt für den Bericht wird erst in `sanitizeGap`. */
const TEXT_LIMIT = 4000
const TOOL_LIMIT = 12

export interface CapabilityGapConfig { enabled: boolean; capabilityGaps: boolean; url: string }
export type CapabilityGapReport = ReturnType<typeof capabilityGapReport>

interface Pending {
  gap: Omit<CapabilityGap, 'suggestion'>
  modelSuggestion: string
  /** Rang der Quelle, von der der Grund stammt. */
  rank: number
  cancel: () => void
}

interface Queued { gap: CapabilityGap; attempts: number; due: number }

interface Part {
  request?: string
  answer?: string
  reason?: string
  channel?: string
  tools?: GapToolFailure[]
  modelSuggestion?: string
}

/** Wessen Grund gilt: der des Modells vor dem der Antwort vor dem des Werkzeugs. */
const RANK: Record<GapSource, number> = { tool: 1, answer: 2, model: 3 }

/** Diese Fehler zeigen selbst eine Lücke an. Gesperrt oder gescheitert ist nur Beiwerk. */
const OPENS_GAP: ReadonlySet<GapToolFailureKind> = new Set(['unknown', 'no-match', 'invalid'])

/** Gleiche Bitte, gleicher Schlüssel — Groß-/Kleinschreibung und Satzzeichen zählen nicht. */
export function gapKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 200)
}

function toolReason(failure: GapToolFailure): string {
  switch (failure.kind) {
    case 'unknown': return `Werkzeug „${failure.tool}“ gibt es nicht.`
    case 'no-match': return `tool_search fand kein Werkzeug zu „${failure.detail}“.`
    case 'invalid': return `„${failure.tool}“ mit ungültigen Argumenten aufgerufen.`
    default: return `„${failure.tool}“ ist gescheitert.`
  }
}

export class CapabilityGapCollector {
  private failures: Array<{ key: string; at: number; failure: GapToolFailure }> = []
  private pending = new Map<string, Pending>()
  private queue: Queued[] = []
  private fingerprints = new Map<string, number>()
  /** Zeitpunkte der Versuche in der letzten Stunde; überdauert `reset`, schützt den Empfänger. */
  private sent: number[] = []
  private pauseUntil = 0
  private cancelTimer: (() => void) | null = null
  private controller: AbortController | null = null
  private generation = 0
  private stopped = false

  constructor(private deps: {
    config: () => CapabilityGapConfig
    send: (report: CapabilityGapReport, signal: AbortSignal) => Promise<boolean>
    version: string
    platform: string
    now?: () => number
    schedule?: (callback: () => void, delay: number) => () => void
  }) {}

  private now(): number { return (this.deps.now ?? Date.now)() }

  private allowed(): boolean {
    if (this.stopped) return false
    try {
      const c = this.deps.config()
      return c.enabled === true && c.capabilityGaps === true
    } catch {
      return false
    }
  }

  private schedule(callback: () => void, delay: number): () => void {
    const schedule = this.deps.schedule ?? ((cb, ms) => {
      const timer = setTimeout(cb, ms)
      timer.unref()
      return () => clearTimeout(timer)
    })
    return schedule(callback, delay)
  }

  /** Ein gescheiterter Werkzeugaufruf, aus dem Runner. */
  toolFailure(input: { tool: string; kind: GapToolFailureKind; detail: string; userText: string }): void {
    try {
      if (!this.allowed()) return
      const key = gapKey(input.userText)
      const failure: GapToolFailure = { tool: clip(input.tool, 80), kind: input.kind, detail: clip(input.detail, 300) }
      const now = this.now()
      this.failures = this.failures.filter((f) => now - f.at < FAILURE_MS).slice(-(FAILURE_LIMIT - 1))
      this.failures.push({ key, at: now, failure })
      if (OPENS_GAP.has(input.kind)) {
        this.merge(key, 'tool', { request: input.userText, tools: [failure], reason: toolReason(failure) })
      } else if (this.pending.has(key)) {
        this.merge(key, null, { tools: [failure] })
      }
    } catch {
      // Melden darf nie ein Werkzeug stören.
    }
  }

  /** Ein abgeschlossener Gesprächszug; zählt nur, wenn James darin ablehnt. */
  answer(input: { request: string; answer: string; channel: string }): void {
    try {
      if (!this.allowed()) return
      const reason = detectRefusal(input.answer)
      if (!reason) return
      const key = this.pendingKey(gapKey(input.request))
      this.merge(key, 'answer', {
        request: input.request,
        answer: input.answer,
        reason,
        channel: input.channel,
        tools: this.recent(key)
      })
    } catch {
      // still
    }
  }

  /**
   * Vom Modell gemeldet (`report_capability_gap`) oder von einem gescheiterten
   * Unteragenten. `userText` ist das, was der Nutzer wirklich gesagt hat — mit
   * ihm landet die Meldung beim selben Bericht wie die Ablehnung danach; die
   * Umschreibung des Modells träfe den Schlüssel nie.
   *
   * Gibt zurück, ob die Meldung angenommen wurde.
   */
  explicit(input: { request: string; reason: string; suggestion: string; channel?: string; userText?: string }): boolean {
    try {
      if (!this.allowed()) return false
      const request = input.userText?.trim() ? input.userText : input.request
      const key = gapKey(request)
      this.merge(key, 'model', {
        request,
        reason: input.reason,
        channel: input.channel,
        modelSuggestion: input.suggestion,
        tools: this.recent(key)
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * Gemini Live gibt dem Runner nur das letzte Bruchstück der Abschrift mit
   * („zum Bahnhof“), der Kristall meldet die ganze Frage. Ein offener Eintrag
   * ohne Antwort, dessen Schlüssel das Ende der Frage bildet, ist derselbe Zug.
   */
  private pendingKey(key: string): string {
    if (!key || this.pending.has(key)) return key
    for (const [k, entry] of this.pending) {
      if (k && key.endsWith(` ${k}`) && !entry.gap.sources.includes('answer')) return k
    }
    return key
  }

  private recent(key: string): GapToolFailure[] {
    const now = this.now()
    return this.failures.filter((f) => f.key === key && now - f.at < FAILURE_MS).map((f) => f.failure)
  }

  private merge(key: string, source: GapSource | null, part: Part): void {
    let entry = this.pending.get(key)
    if (!entry) {
      if (this.pending.size >= PENDING_LIMIT) this.flush(this.pending.keys().next().value!)
      entry = {
        gap: { request: '', answer: '', reason: '', tools: [], channel: '', sources: [] },
        modelSuggestion: '',
        rank: 0,
        cancel: () => {}
      }
      this.pending.set(key, entry)
    }
    const gap = entry.gap
    // Die Antwort bringt die ganze Frage mit; ein Bruchstück vom Runner weicht ihr.
    const longer = source === 'answer' && gapKey(part.request ?? '').length > gapKey(gap.request).length
    if (part.request?.trim() && (!gap.request || longer)) gap.request = clip(part.request, TEXT_LIMIT)
    if (part.answer?.trim()) gap.answer = clip(part.answer, TEXT_LIMIT)
    const rank = source ? RANK[source] : 0
    if (part.reason?.trim() && rank >= entry.rank) {
      gap.reason = clip(part.reason, TEXT_LIMIT)
      entry.rank = rank
    }
    // Den Kanal kennt am sichersten die Antwort; das Modellwerkzeug weiß ihn nicht.
    if (part.channel?.trim() && (!gap.channel || source === 'answer')) gap.channel = clip(part.channel, 30)
    if (part.modelSuggestion?.trim()) entry.modelSuggestion = clip(part.modelSuggestion, TEXT_LIMIT)
    for (const t of part.tools ?? []) {
      const known = gap.tools.some((x) => x.tool === t.tool && x.kind === t.kind && x.detail === t.detail)
      if (!known && gap.tools.length < TOOL_LIMIT) gap.tools.push(t)
    }
    if (source && !gap.sources.includes(source)) gap.sources.push(source)
    entry.cancel()
    entry.cancel = this.schedule(() => this.flush(key), gap.sources.includes('answer') ? QUIET_MS : ANSWER_WAIT_MS)
  }

  /** Die Ruhezeit ist um: Vorschlag bilden, Doppeltes aussortieren, einreihen. */
  private flush(key: string): void {
    const entry = this.pending.get(key)
    if (!entry) return
    this.pending.delete(key)
    entry.cancel()
    if (!this.allowed()) return
    const gap: CapabilityGap = {
      ...entry.gap,
      channel: entry.gap.channel || 'unbekannt',
      suggestion: suggestFix({ request: entry.gap.request, tools: entry.gap.tools, modelSuggestion: entry.modelSuggestion })
    }
    const now = this.now()
    const fingerprint = gapFingerprint(gap)
    const previous = this.fingerprints.get(fingerprint)
    if (previous !== undefined && now - previous < DUPLICATE_MS) return
    if (this.queue.length >= QUEUE_LIMIT) return
    for (const [k, time] of this.fingerprints) if (now - time >= DUPLICATE_MS) this.fingerprints.delete(k)
    if (this.fingerprints.size >= FINGERPRINT_LIMIT) this.fingerprints.delete(this.fingerprints.keys().next().value!)
    this.fingerprints.set(fingerprint, now)
    this.queue.push({ gap, attempts: 0, due: now })
    this.pump()
  }

  /** Einer nach dem anderen, höchstens zwölf pro Stunde, nach einem Fehlschlag fünf Minuten Pause. */
  private pump(): void {
    if (this.controller) return
    this.cancelTimer?.()
    this.cancelTimer = null
    if (!this.allowed()) {
      this.queue = []
      return
    }
    if (this.queue.length === 0) return
    const now = this.now()
    this.sent = this.sent.filter((t) => now - t < HOUR_MS)
    const index = this.queue.findIndex((q) => q.due <= now)
    let wait = index < 0 ? Math.min(...this.queue.map((q) => q.due)) - now : 0
    if (this.sent.length >= HOURLY_LIMIT) wait = Math.max(wait, this.sent[0] + HOUR_MS - now)
    wait = Math.max(wait, this.pauseUntil - now)
    if (wait > 0) {
      this.cancelTimer = this.schedule(() => { this.cancelTimer = null; this.pump() }, wait)
      return
    }
    const [item] = this.queue.splice(index, 1)
    void this.send(item)
  }

  private async send(item: Queued): Promise<void> {
    const generation = this.generation
    const controller = new AbortController()
    this.controller = controller
    this.sent.push(this.now())
    item.attempts++
    let ok = false
    try {
      ok = await this.deps.send(capabilityGapReport(this.deps.version, this.deps.platform, item.gap), controller.signal)
    } catch {
      // Keine Ausgabe: Ein gescheiterter Bericht soll keinen neuen Vorfall auslösen.
    }
    if (generation !== this.generation) return
    this.controller = null
    if (!ok) {
      this.pauseUntil = this.now() + RETRY_MS
      if (item.attempts < MAX_ATTEMPTS && this.queue.length < QUEUE_LIMIT) {
        item.due = this.pauseUntil
        this.queue.unshift(item)
      }
    }
    this.pump()
  }

  /** Ausschalten oder Empfängerwechsel: alles Offene verwerfen, laufenden Versand abbrechen. */
  reset(): void {
    try {
      this.generation++
      for (const entry of this.pending.values()) entry.cancel()
      this.pending.clear()
      this.cancelTimer?.()
      this.cancelTimer = null
      this.controller?.abort()
      this.controller = null
      this.failures = []
      this.queue = []
      this.fingerprints.clear()
      this.pauseUntil = 0
    } catch {
      // still
    }
  }

  stop(): void {
    this.stopped = true
    this.reset()
  }
}

// ── Für Runner, Werkzeug und Brücke ─────────────────────────

let current: CapabilityGapCollector | null = null

/** Der laufende Sammler, oder `null`, solange keiner gestartet ist. */
export function capabilityGaps(): CapabilityGapCollector | null {
  return current
}

export function setCapabilityGapCollector(next: CapabilityGapCollector | null): void {
  if (current && current !== next) current.stop()
  current = next
}

/**
 * Fremde Anrufer haben nichts zugestimmt. Scheitert ein Werkzeug in ihrem
 * Gespräch, ginge sonst ihr Satz als Anfrage mit hinaus.
 */
const muted = new AsyncLocalStorage<boolean>()

export function withoutGapReports<T>(operation: () => T): T {
  return muted.run(true, operation)
}

/** Ein gescheiterter Werkzeugaufruf. Wirft nie, auch ohne Sammler. */
export function noteToolFailure(input: { tool: string; kind: GapToolFailureKind; detail: string; userText?: string }): void {
  try {
    if (muted.getStore()) return
    current?.toolFailure({ ...input, userText: input.userText ?? '' })
  } catch {
    // Melden darf nie ein Werkzeug stören.
  }
}

/**
 * Worauf ein Werkzeug gerade antwortet.
 *
 * Der Runner kennt die letzte Äußerung des Nutzers, das Werkzeug selbst
 * nicht — `ToolContext` trägt sie nicht. Über den asynchronen Kontext kommt
 * sie trotzdem an, auch bei Unteragenten, die in einem Werkzeug starten.
 */
const turnText = new AsyncLocalStorage<string>()

export function withGapUserText<T>(userText: string | undefined, operation: () => T): T {
  return turnText.run(userText ?? '', operation)
}

export function gapUserText(): string {
  return turnText.getStore() ?? ''
}
