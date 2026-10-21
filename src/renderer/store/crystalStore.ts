import { create } from 'zustand'
import type { ConfirmationRequest, CrystalState, Settings } from '@shared/types'
import { CRYSTAL_STATE_PRIORITY } from '@shared/types'

/**
 * Zustandsspeicher des Kristalls.
 *
 * Mehrere Quellen setzen gleichzeitig Zustände (Live-Session, Tool-Runner,
 * Netzwerkwächter). Statt sie sich gegenseitig überschreiben zu lassen,
 * merken wir uns pro Quelle einen Wunsch und zeigen den mit der höchsten
 * Priorität — sonst blinkt der Kristall bei jedem Tool-Aufruf zwischen
 * "denkt" und "spricht" hin und her.
 *
 * Amplituden liegen bewusst NICHT im Store: sie ändern sich 60-mal pro
 * Sekunde und würden React bei jedem Frame neu rendern. Sie laufen über
 * ein Ref-Objekt direkt in die Shader.
 */

/**
 * `pause` und `confirm` stehen bewusst neben `local`.
 *
 * Über `local` läuft nur der Fehler-Toast, und der räumt sich nach ein paar
 * Sekunden selbst weg. Alles, was länger gilt, braucht eine eigene Quelle —
 * sonst reißt dieses Aufräumen es mit.
 *
 * Bei der Pause ist das offensichtlich: Die Kugel wäre nach dem nächsten
 * Fehler wieder blau, obwohl James weiterhin stillgelegt ist. Bei der
 * Rückfrage ist es dieselbe Mechanik und fällt nur später auf: Ein Fehler
 * während einer offenen Rückfrage überschrieb sie, und sechs Sekunden später
 * setzte der Aufräumer die Quelle auf null zurück. Die Frage stand dann noch
 * offen, aber weder die Kugel noch die Zeile auf der Startseite sagten das
 * noch — und beantworten muss der Nutzer sie trotzdem.
 */
export type StateSource = 'session' | 'tools' | 'network' | 'local' | 'pause' | 'confirm'

export interface AmplitudeRef {
  /** Mikrofonpegel 0..1, geglättet. */
  input: number
  /** Ausgabepegel 0..1, geglättet. */
  output: number
}

/** Wird von Audio-Modulen direkt beschrieben und im Frame-Loop gelesen. */
export const amplitude: AmplitudeRef = { input: 0, output: 0 }

/**
 * So lange gilt eine Rückfrage hier — derselbe Wert wie `CHALLENGE_TTL_MS` im
 * Hauptprozess.
 *
 * Aufgelöst wird eine Rückfrage sonst nur, wenn das Modell das Werkzeug ein
 * zweites Mal aufruft. Bei einer Ablehnung tut es das ausdrücklich nicht — die
 * Anweisung dazu lautet wörtlich "rufe es nicht erneut auf". Danach kam nie
 * ein `confirm:resolved`, und der Kristall blieb rot und pulsierend stehen,
 * die Zeile auf der Startseite bei einer Frage, die längst beantwortet war.
 * Im Hauptprozess verfällt der Vorgang nach drei Minuten von selbst; hier
 * musste er es auch.
 */
const CONFIRM_TTL_MS = 3 * 60 * 1000
let confirmTimer: number | null = null
let errorTimer: number | null = null
let errorGeneration = 0
export interface Caption {
  id: number
  who: 'user' | 'james'
  text: string
  at: number
}

let captionSeq = 0

interface CrystalStore {
  wishes: Partial<Record<StateSource, CrystalState>>
  state: CrystalState
  hovered: boolean
  /**
   * Getrennt vom Zustand geführt: ein Fehler-Toast überlagert den Kristall
   * für ein paar Sekunden, ändert aber nichts daran, dass James stillgelegt
   * ist. Die Zeile auf der Startseite soll das nicht durcheinanderbringen.
   */
  paused: boolean
  recoveryMode: boolean
  /**
   * Wann er von selbst zurückkommt. Nur gesetzt, wenn die Pause befristet ist
   * — also aus "sei die nächste Stunde ruhig". Klick, Hotkey und Tray legen
   * ihn unbefristet still.
   */
  pauseUntil: number | null
  confirmation: ConfirmationRequest | null
  settings: Settings | null
  lastError: string | null
  /** Wie viele Telefone gerade mithören. Die Startseite zeigt es an. */
  companions: number
  wakeAvailable: boolean | null
  engineLabel: string | null
  /** Live-Untertitel des laufenden Gesprächs, neueste zuletzt. */
  captions: Caption[]
  /** Hängt Text an; derselbe Sprecher direkt nacheinander wird zu einer Zeile. */
  addCaption: (who: Caption['who'], text: string) => void
  clearCaptions: () => void

  setWish: (source: StateSource, state: CrystalState | null) => void
  setHovered: (v: boolean) => void
  setPaused: (v: boolean, until?: number | null) => void
  setRecoveryMode: (v: boolean) => void
  setConfirmation: (c: ConfirmationRequest | null) => void
  setSettings: (s: Settings) => void
  setError: (message: string | null) => void
  setCompanions: (count: number) => void
  setWakeAvailable: (available: boolean) => void
  setEngineLabel: (label: string | null) => void
}

function resolve(wishes: Partial<Record<StateSource, CrystalState>>): CrystalState {
  let best: CrystalState = 'idle'
  let bestPriority = -1
  for (const state of Object.values(wishes)) {
    if (!state) continue
    const priority = CRYSTAL_STATE_PRIORITY[state]
    if (priority > bestPriority) {
      bestPriority = priority
      best = state
    }
  }
  return best
}

export const useCrystal = create<CrystalStore>((set, get) => ({
  wishes: {},
  state: 'idle',
  hovered: false,
  paused: false,
  recoveryMode: false,
  pauseUntil: null,
  confirmation: null,
  settings: null,
  lastError: null,
  companions: 0,
  wakeAvailable: null,
  engineLabel: null,
  setRecoveryMode: (recoveryMode) => set({ recoveryMode }),
  setWakeAvailable: (wakeAvailable) => set({ wakeAvailable }),
  setEngineLabel: (engineLabel) => set({ engineLabel }),
  captions: [],
  addCaption: (who, text) => {
    const clean = text.replace(/\s+/g, ' ')
    if (!clean.trim()) return
    const captions = get().captions
    const last = captions[captions.length - 1]
    // Gemini liefert Bruchstücke im Strom; sie gehören zur selben Zeile,
    // solange niemand dazwischen redet und keine lange Pause war.
    if (last && last.who === who && Date.now() - last.at < 8000) {
      const joined = (last.text + clean).replace(/\s+/g, ' ').slice(-12000)
      set({ captions: [...captions.slice(0, -1), { ...last, text: joined, at: Date.now() }] })
      return
    }
    set({ captions: [...captions, { id: ++captionSeq, who, text: clean.trim(), at: Date.now() }].slice(-80) })
  },
  clearCaptions: () => set({ captions: [] }),

  setWish: (source, state) => {
    const previous = get().wishes
    // Ohne diese Prüfung schreibt jeder Zustandsbericht ein neues
    // wishes-Objekt, auch wenn sich nichts geändert hat.
    if ((previous[source] ?? null) === state) return

    const wishes = { ...previous }
    if (state === null) {
      delete wishes[source]
    } else {
      wishes[source] = state
    }
    set({ wishes, state: resolve(wishes) })
  },

  setHovered: (v) => set({ hovered: v }),

  setPaused: (v, until = null) => set({ paused: v, pauseUntil: v ? until : null }),

  setConfirmation: (c) => {
    set({ confirmation: c })
    get().setWish('confirm', c ? 'confirm' : null)

    if (confirmTimer !== null) window.clearTimeout(confirmTimer)
    confirmTimer = null
    if (!c) return

    confirmTimer = window.setTimeout(() => {
      confirmTimer = null
      // Nur die eigene Rückfrage wegräumen: inzwischen kann längst eine neue
      // offenstehen.
      if (get().confirmation?.id === c.id) get().setConfirmation(null)
    }, CONFIRM_TTL_MS)
  },

  setSettings: (s) => set({ settings: s }),

  setCompanions: (count) => {
    // Nur bei echter Änderung schreiben: Die Brücke horcht ihrerseits auf
    // diesen Store, und ein Schreiben ohne Änderung wäre eine Schleife aus
    // Zustandsmeldung und Weiterreichen.
    if (get().companions === count) return
    set({ companions: count })
  },

  setError: (message) => {
    const generation = ++errorGeneration
    if (errorTimer !== null) window.clearTimeout(errorTimer)
    errorTimer = null
    set({ lastError: message })
    if (!message) get().setWish('local', null)
    if (message) {
      get().setWish('local', 'error')
      // Fehlerzustand nach ein paar Sekunden auflösen, sonst bleibt der
      // Kristall rot stehen und man weiß nicht, ob es noch aktuell ist.
      errorTimer = window.setTimeout(() => {
        if (generation !== errorGeneration) return
        errorTimer = null
        set({ lastError: null })
        get().setWish('local', null)
      }, 6000)
    }
  }
}))
