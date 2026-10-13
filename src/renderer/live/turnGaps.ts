import { detectRefusal } from '@shared/capabilityGap'
import type { EngineState } from './engine'

/**
 * Erkennt im laufenden Gespräch die Züge, in denen James eine Bitte ablehnt.
 *
 * Die Motoren kennen kein Ereignis „Zug fertig“. Sie melden Bruchstücke der
 * beiden Abschriften und ihren Zustand, mehr nicht. Daraus setzt dieser Wächter
 * Züge zusammen — Frage, Antwort — und prüft erst, wenn die Antwort wirklich
 * vorbei ist. Mitten im Satz geprüft, käme „Das kann ich …“ als Ablehnung an,
 * obwohl noch „… gern für dich erledigen“ folgt.
 *
 * Gemeldet wird nur an den Hauptprozess. Ob daraus ein Bericht wird, der das
 * Gerät verlässt, entscheiden dort die Einstellungen.
 *
 * Ohne DOM und mit Uhr von außen, damit die Tests die Zeit selbst schieben.
 */

export interface GapTurn {
  request: string
  answer: string
  /** live, realtime, cascade, text — oder `sprache`, wenn unbekannt. */
  channel: string
}

export interface TurnGapDeps {
  report(turn: GapTurn): void
  completed?(turn: GapTurn): void
  now?: () => number
  /** Plant `fn` in `ms` und gibt das Abbrechen zurück. */
  schedule?: (fn: () => void, ms: number) => () => void
}

/** Wer den Zug angestoßen hat. `system` sind Timer, Erinnerungen, Recherchen. */
type Origin = 'voice' | 'typed' | 'system'

interface Turn {
  origin: Origin
  channel: string
  request: string
  answer: string
}

/** So lange muss nach der Antwort Ruhe sein, bevor der Zug als fertig gilt. */
export const TURN_QUIET_MS = 1500

/**
 * So lange darf die Abschrift der Frage nach der Antwort noch kommen.
 *
 * OpenAI schreibt die gesprochene Frage nebenher mit und liefert sie oft erst,
 * wenn die Antwort schon läuft oder fertig ist. Die Kaskade holt sie nur bei
 * Bedarf und reicht sie am Ende nach. Ohne diese Frist stünde jede solche
 * Antwort ohne Frage da — und die Frage danach ohne Antwort.
 */
export const LATE_REQUEST_MS = 8000

/**
 * So lange muss James zugehört haben, bevor „denkt nach“ eine neue Frage heißt.
 *
 * Eine neue Frage braucht Sprechzeit und danach die Pause der Spracherkennung
 * (voreingestellt 700 ms); zwischen zwei Werkzeugrunden vergeht dagegen nichts.
 */
export const NEW_REQUEST_MS = 800

/** So lange gilt ein Echo von getipptem Text oder Systemauftrag als bekannt. */
const ECHO_MS = 5 * 60_000
const ECHO_KEEP = 4
const REQUEST_MAX = 4000
const ANSWER_MAX = 4000

export class TurnGapWatcher {
  private turn: Turn | null = null
  /** Ein Zug mit Antwort, aber noch ohne Frage — wartet auf die späte Abschrift. */
  private parked: Turn | null = null
  private cancelEnd: (() => void) | null = null
  private cancelPark: (() => void) | null = null
  private engineState: EngineState | null = null
  /** Seit wann der Motor zuhört oder ruht. */
  private quietSince = 0
  private channel = 'sprache'
  private echoes: Array<{ key: string; at: number }> = []
  private disposed = false
  private readonly now: () => number
  private readonly schedule: (fn: () => void, ms: number) => () => void

  constructor(private readonly deps: TurnGapDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.schedule = deps.schedule ?? ((fn, ms) => {
      const id = setTimeout(fn, ms)
      return () => clearTimeout(id)
    })
  }

  /** Bruchstück der Abschrift dessen, was der Nutzer gesagt hat. */
  userText(fragment: string): void {
    this.guard(() => {
      if (typeof fragment !== 'string' || !fragment.trim() || this.isEcho(fragment)) return
      // Die Kaskade reicht dieselbe Abschrift beim Werkzeug und am Ende noch
      // einmal nach. Als neue Worte gezählt, schnitte das die Antwort mittendrin
      // ab und hängte die alte Frage vor die nächste.
      if (this.turn?.request.trim() && echoKey(this.turn.request) === echoKey(fragment)) return
      // Ein Klicken oder Rauschen kommt als bloßes Satzzeichen an. Das darf
      // eine laufende Frage ergänzen, aber keinen Zug beenden oder beginnen.
      const wordy = /\p{L}{2,}/u.test(fragment)

      const parked = this.parked
      if (parked) {
        if (!wordy) return
        this.unpark()
        parked.request = join('', fragment, REQUEST_MAX)
        this.finish(parked)
        return
      }

      let turn = this.turn
      if (turn?.answer.trim()) {
        if (!wordy) return
        // Gemini Live schickt die Abschrift der Frage ohne feste Reihenfolge; die
        // letzten Worte kommen oft erst, wenn James schon spricht. Solange er
        // spricht oder ein Werkzeug läuft, ist das Mikrofon im Halbduplex zu —
        // was dann kommt, ist der Rest der Frage und keine neue.
        const liveTail = turn.channel === 'live' && (this.engineState === 'speaking' || this.engineState === 'thinking')
        if (turn.origin === 'voice' && (!turn.request.trim() || liveTail)) {
          // Späte Abschrift, die Antwort läuft noch: dieselbe Runde.
          turn.request = join(turn.request, fragment, REQUEST_MAX)
          return
        }
        // Neue Worte nach einer Antwort: Die vorige Runde ist vorbei.
        this.flush()
        turn = null
      }
      if (!turn) {
        if (!wordy) return
        turn = this.turn = this.open('voice', this.channel)
      }
      turn.request = join(turn.request, fragment, REQUEST_MAX)
    })
  }

  /** Bruchstück der Abschrift dessen, was James sagt. */
  modelText(fragment: string): void {
    this.guard(() => {
      if (typeof fragment !== 'string' || !fragment) return
      if (!fragment.trim() && !this.turn?.answer) return
      // Eine neue Antwort, bevor die Frage zur vorigen kam: Die kommt nicht mehr.
      this.unpark()
      const turn = this.turn ?? (this.turn = this.open('voice', this.channel))
      turn.answer = join(turn.answer, fragment, ANSWER_MAX)
      // Die Antwort läuft weiter. Die Ruhe zählt erst ab dem letzten Stück.
      this.stopEnd()
      if (this.engineState === 'listening' || this.engineState === 'idle') this.armEnd()
    })
  }

  /** Getippter Text; die Kaskade wirft ihn als Nutzerabschrift zurück. */
  typed(text: string): void {
    this.guard(() => {
      const clean = typeof text === 'string' ? text.trim() : ''
      if (!clean) return
      this.flush()
      this.unpark()
      this.remember(clean)
      this.turn = this.open('typed', 'text')
      this.turn.request = clean.slice(0, REQUEST_MAX)
    })
  }

  /**
   * Ein Auftrag von Timer, Erinnerung, Recherche oder Telefon.
   *
   * Was James darauf sagt, war keine Bitte des Nutzers. Sagt er etwa, eine
   * Erinnerung könne er nicht ausführen, ist das gewollt und keine Lücke.
   */
  systemPrompt(text?: string): void {
    this.guard(() => {
      this.flush()
      this.unpark()
      if (typeof text === 'string' && text.trim()) this.remember(text)
      this.turn = this.open('system', this.channel)
    })
  }

  state(state: EngineState): void {
    this.guard(() => {
      const quiet = (s: EngineState | null): boolean => s === 'listening' || s === 'idle'
      const previous = this.engineState
      this.engineState = state
      if (state === 'thinking' || state === 'speaking') {
        this.stopEnd()
        // Zwischen zwei Werkzeugrunden springt der Zustand im selben Atemzug
        // von „hört zu“ auf „denkt nach“. Lag dazwischen eine Weile, hat der
        // Nutzer etwas Neues gesagt — dessen Abschrift kommt bei Realtime erst
        // später und bei der Kaskade oft gar nicht. Ohne diesen Schnitt liefe
        // die neue Antwort in die alte Runde und stünde unter der alten Frage.
        if (state === 'thinking' && quiet(previous) && this.turn?.answer.trim() && this.now() - this.quietSince >= NEW_REQUEST_MS) this.end()
      } else if (quiet(state)) {
        if (!quiet(previous)) this.quietSince = this.now()
        if (this.turn?.answer.trim() && !this.cancelEnd) this.armEnd()
      }
    })
  }

  /** Name des Sprachwegs für die folgenden Züge. */
  setChannel(name: string): void {
    this.guard(() => {
      this.channel = (typeof name === 'string' && name.trim()) || 'sprache'
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.stopEnd()
    this.unpark()
    this.turn = null
    this.echoes = []
    this.disposed = true
  }

  // ─────────────────────────────────────────────────────────

  /** Die Erkennung ist Beiwerk — das Gespräch darf an ihr nie scheitern. */
  private guard(work: () => void): void {
    if (this.disposed) return
    try {
      work()
    } catch {
      // Bewusst still: Ein Fehler hier hieße höchstens eine fehlende Meldung.
    }
  }

  private open(origin: Origin, channel: string): Turn {
    return { origin, channel, request: '', answer: '' }
  }

  /** Den laufenden Zug sofort beenden, weil etwas Neues beginnt. */
  private flush(): void {
    this.stopEnd()
    const turn = this.turn
    this.turn = null
    if (turn) this.finish(turn)
  }

  private armEnd(): void {
    this.stopEnd()
    this.cancelEnd = this.schedule(() => {
      this.cancelEnd = null
      this.guard(() => this.end())
    }, TURN_QUIET_MS)
  }

  private stopEnd(): void {
    const cancel = this.cancelEnd
    this.cancelEnd = null
    cancel?.()
  }

  /** Nach der Ruhe: prüfen, oder ohne Frage noch auf die späte Abschrift warten. */
  private end(): void {
    const turn = this.turn
    this.turn = null
    if (!turn) return
    if (turn.origin === 'voice' && !turn.request.trim()) {
      this.parked = turn
      this.cancelPark = this.schedule(() => {
        this.cancelPark = null
        this.parked = null
      }, LATE_REQUEST_MS)
      return
    }
    this.finish(turn)
  }

  private unpark(): void {
    const cancel = this.cancelPark
    this.cancelPark = null
    this.parked = null
    cancel?.()
  }

  private finish(turn: Turn): void {
    if (turn.origin === 'system') return
    const request = flat(turn.request)
    const answer = flat(turn.answer)
    if (!request || !answer) return
    try { this.deps.completed?.({ request, answer, channel: turn.channel }) } catch { /* optional local history */ }
    if (!detectRefusal(answer)) return
    try {
      this.deps.report({ request, answer, channel: turn.channel })
    } catch {
      // Melden ist ein Versuch; der nächste Zug soll trotzdem gezählt werden.
    }
  }

  private remember(text: string): void {
    const at = this.now()
    this.echoes = [...this.echoes.filter((e) => at - e.at < ECHO_MS), { key: echoKey(text), at }].slice(-ECHO_KEEP)
  }

  /**
   * Die Kaskade gibt getippten Text und Systemaufträge als Nutzerabschrift
   * zurück, mitunter zweimal und erst nach der Antwort. Gezählt wäre das eine
   * zweite Frage — oder eine neue Runde, die die nächste echte Frage verfälscht.
   */
  private isEcho(fragment: string): boolean {
    if (this.echoes.length === 0) return false
    const key = echoKey(fragment)
    const at = this.now()
    return this.echoes.some((e) => e.key === key && at - e.at < ECHO_MS)
  }
}

function echoKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Bruchstücke zusammensetzen.
 *
 * Gemini und OpenAI liefern Wortteile mit eigenem Leerzeichen davor; dann wird
 * wie bei den Untertiteln nur angehängt — ein Leerzeichen dazwischen machte aus
 * „Wett“ und „er“ zwei Wörter. Ganze Sätze (Kaskade, OpenAI-Abschrift) kommen
 * ohne; zwischen ihnen fehlte es, und „nicht.Aber“ klebte zusammen.
 */
function join(buffer: string, fragment: string, max: number): string {
  if (buffer.length >= max) return buffer
  const glue =
    buffer && !/\s$/.test(buffer) && /^[^\s.,!?;:]/.test(fragment) &&
    (/[.!?,;:]$/.test(buffer) || /^\p{Lu}/u.test(fragment))
      ? ' '
      : ''
  return (buffer + glue + fragment).slice(0, max)
}
