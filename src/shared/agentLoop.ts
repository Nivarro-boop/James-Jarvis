/**
 * Gemeinsamer Kern der Werkzeugschleifen — nach dem Vorbild von Hermes Agent
 * (Nous Research, MIT-Lizenz: `agent/tool_guardrails.py`,
 * `agent/iteration_budget.py`).
 *
 * Jede Schleife in James (Gemini, Ollama, ChatGPT, Unteragenten) hatte bisher
 * nur eine harte Rundengrenze. Zwei Dinge fehlten, die Hermes so zuverlässig
 * machen:
 *
 * 1. Leitplanken gegen Werkzeugschleifen. Ein Modell, das denselben
 *    fehlschlagenden Aufruf wiederholt oder immer wieder dasselbe Ergebnis
 *    abholt, verbrennt Runden, ohne voranzukommen. Erst kommt ein Hinweis im
 *    Ergebnis, danach wird der Aufruf gar nicht mehr ausgeführt.
 * 2. Budgetdruck. Ab 70 % der Runden erfährt das Modell, dass es zum Ende
 *    kommen soll, ab 90 %, dass es jetzt antworten muss — statt mitten in der
 *    Arbeit abgeschnitten zu werden.
 *
 * Reine Logik, ohne Electron-Abhängigkeit: läuft im Haupt- und im
 * Darstellungsprozess und lässt sich ohne App testen.
 */

export interface ToolOutcome {
  ok: boolean
  result?: unknown
  error?: string
}

export interface GuardThresholds {
  exactFailureWarnAfter: number
  exactFailureBlockAfter: number
  sameToolFailureWarnAfter: number
  sameToolFailureHaltAfter: number
  noProgressWarnAfter: number
  noProgressBlockAfter: number
}

/** Dieselben Vorgaben wie Hermes' `ToolCallGuardrailConfig`. */
export const DEFAULT_THRESHOLDS: GuardThresholds = {
  exactFailureWarnAfter: 2,
  exactFailureBlockAfter: 5,
  sameToolFailureWarnAfter: 3,
  sameToolFailureHaltAfter: 8,
  noProgressWarnAfter: 2,
  noProgressBlockAfter: 5
}

/** Werkzeuge, deren wiederholter Aufruf gewollt ist (Warten, Zustand abfragen). */
const REPEATABLE = /^(wait|sleep|timer_|screen_?shot|screenshot|clipboard_read|time_now|now)/

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function callSignature(name: string, args: Record<string, unknown>): string {
  return `${name}:${canonical(args ?? {})}`
}

export interface GuardDecision {
  /** `run`: ausführen; `block`: nicht ausführen, `message` als Fehler zurückgeben; `halt`: Schleife beenden. */
  action: 'run' | 'block' | 'halt'
  message?: string
}

export class ToolLoopGuard {
  private exactFailures = new Map<string, number>()
  private toolFailures = new Map<string, number>()
  private lastResult = new Map<string, string>()
  private sameResult = new Map<string, number>()
  halted = false

  constructor(private limits: GuardThresholds = DEFAULT_THRESHOLDS) {}

  before(name: string, args: Record<string, unknown>): GuardDecision {
    if (this.halted) return { action: 'halt', message: 'Werkzeugschleife wurde angehalten.' }
    const key = callSignature(name, args)
    if ((this.toolFailures.get(name) ?? 0) >= this.limits.sameToolFailureHaltAfter) {
      this.halted = true
      return { action: 'halt', message: `${name} ist ${this.limits.sameToolFailureHaltAfter}-mal fehlgeschlagen. Hör auf, es zu versuchen, und erkläre dem Nutzer, was nicht ging.` }
    }
    if ((this.exactFailures.get(key) ?? 0) >= this.limits.exactFailureBlockAfter) {
      return { action: 'block', message: `Nicht ausgeführt: genau dieser Aufruf von ${name} ist schon ${this.limits.exactFailureBlockAfter}-mal fehlgeschlagen. Ändere die Argumente, nimm ein anderes Werkzeug oder antworte.` }
    }
    if (!REPEATABLE.test(name) && (this.sameResult.get(key) ?? 0) >= this.limits.noProgressBlockAfter) {
      return { action: 'block', message: `Nicht ausgeführt: ${name} hat mit diesen Argumenten schon mehrfach dasselbe geliefert. Nutze das vorhandene Ergebnis.` }
    }
    return { action: 'run' }
  }

  /** Gibt einen Hinweis zurück, der an das Ergebnis angehängt wird — oder nichts. */
  after(name: string, args: Record<string, unknown>, outcome: ToolOutcome): string | undefined {
    const key = callSignature(name, args)
    if (!outcome.ok) {
      const exact = (this.exactFailures.get(key) ?? 0) + 1
      const total = (this.toolFailures.get(name) ?? 0) + 1
      this.exactFailures.set(key, exact)
      this.toolFailures.set(name, total)
      if (exact >= this.limits.exactFailureWarnAfter) {
        return `Hinweis: Derselbe Aufruf ist ${exact}-mal fehlgeschlagen. Nicht unverändert wiederholen.`
      }
      if (total >= this.limits.sameToolFailureWarnAfter) {
        return `Hinweis: ${name} ist in dieser Aufgabe ${total}-mal fehlgeschlagen. Prüfe den Ansatz.`
      }
      return undefined
    }
    this.toolFailures.set(name, 0)
    if (REPEATABLE.test(name)) return undefined
    const text = typeof outcome.result === 'string' ? outcome.result : canonical(outcome.result)
    const repeats = this.lastResult.get(key) === text ? (this.sameResult.get(key) ?? 0) + 1 : 0
    this.lastResult.set(key, text)
    this.sameResult.set(key, repeats)
    if (repeats >= this.limits.noProgressWarnAfter) {
      return `Hinweis: ${name} liefert mit denselben Argumenten immer dasselbe. Kein Fortschritt — anders vorgehen oder antworten.`
    }
    return undefined
  }
}

/**
 * Hermes' Budgetdruck: ab 70 % ein Vorsichtshinweis, ab 90 % die Aufforderung
 * abzuschließen. `round` zählt ab 0, `limit` ist die Rundenzahl.
 */
export function budgetNotice(round: number, limit: number): string | undefined {
  if (limit < 4) return undefined
  const used = (round + 1) / limit
  const left = limit - round - 1
  if (used >= 0.9 || left <= 1) return `[Budget] Nur noch ${left} Runde${left === 1 ? '' : 'n'}. Jetzt abschließen und antworten — keine neuen Werkzeuge mehr außer unbedingt nötigen.`
  if (used >= 0.7) return `[Budget] ${left} Runden übrig. Auf das Ergebnis zusteuern.`
  return undefined
}

/**
 * Lange Ergebnisse kappen, damit eine einzige Webseite nicht den ganzen
 * Kontext frisst (Hermes kürzt Werkzeugausgaben ebenso).
 */
export function clipResult(text: string, max = 12000): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.7)
  return `${text.slice(0, head)}\n[… ${text.length - max} Zeichen gekürzt …]\n${text.slice(-(max - head))}`
}

/**
 * Ein Werkzeug mit Leitplanken und Budgethinweis ausführen. Liefert das
 * Ergebnis, wie es dem Modell zurückgegeben wird.
 */
export async function guardedCall(
  guard: ToolLoopGuard,
  name: string,
  args: Record<string, unknown>,
  run: () => Promise<ToolOutcome>,
  budget?: { round: number; limit: number }
): Promise<ToolOutcome> {
  const decision = guard.before(name, args)
  if (decision.action !== 'run') return { ok: false, error: decision.message }
  const outcome = await run()
  const notes = [guard.after(name, args, outcome), budget && budgetNotice(budget.round, budget.limit)].filter(Boolean)
  const body = outcome.ok
    ? clipResult(typeof outcome.result === 'string' ? outcome.result : outcome.result === undefined ? 'Erledigt.' : JSON.stringify(outcome.result))
    : outcome.error ?? 'Unbekannter Fehler.'
  if (!notes.length && body === outcome.result) return outcome
  const text = notes.length ? `${body}\n\n${notes.join('\n')}` : body
  return outcome.ok ? { ok: true, result: text } : { ok: false, error: text }
}

/**
 * Hermes' Wiederholungswächter (`agent/repetition_guard.py`), vereinfacht:
 * Ein Modell, das sich festgefahren hat, schreibt denselben Abschnitt immer
 * wieder. Ab 400 Zeichen gilt eine Antwort als durchgegangen, wenn das letzte
 * 60-Zeichen-Stück mindestens fünfmal vorkommt und zusammen die Hälfte des
 * Textes ausmacht.
 */
export function isRunawayRepetition(text: string): boolean {
  if (text.length < 400) return false
  const window = text.slice(-60)
  if (!window.trim()) return false
  let count = 0
  for (let at = text.indexOf(window); at !== -1; at = text.indexOf(window, at + 1)) count++
  return count >= 5 && count * window.length >= text.length * 0.5
}

/**
 * Was beim Kürzen des Verlaufs wegfällt, nicht spurlos verlieren: Hermes
 * verdichtet alte Runden zu einer Zusammenfassung. Hier ohne zusätzlichen
 * Modellaufruf (kostet nichts) — die Kernsätze jeder alten Frage und Antwort.
 */
export function digestDropped(items: { role?: string; content?: unknown }[], max = 900): string | undefined {
  const lines: string[] = []
  for (const item of items) {
    if ((item.role !== 'user' && item.role !== 'assistant') || typeof item.content !== 'string') continue
    const text = item.content.replace(/\s+/g, ' ').trim()
    if (!text || text.startsWith('[Früher im Gespräch]')) continue
    lines.push(`${item.role === 'user' ? 'Nutzer' : 'James'}: ${text.length > 140 ? `${text.slice(0, 140)}…` : text}`)
  }
  if (!lines.length) return undefined
  let digest = lines.join('\n')
  if (digest.length > max) digest = `…${digest.slice(-max)}`
  return `[Früher im Gespräch]\n${digest}`
}
