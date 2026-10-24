import { GoogleGenAI } from '@google/genai'
import { withModelFallback } from '@shared/geminiQuota'
import type { Settings, ToolCallResult } from '@shared/types'
import { AUDIO_CONSTANTS } from '@shared/config/defaults'
import { abortable } from '@shared/async'
import { createPlayer, type PlayerHandle } from '../audio/player'
import { createVoiceStream, planVoice, type VoiceStream } from '../audio/elevenVoice'
import { createPiperStream, planPiperVoice } from '../audio/piperVoice'
import { createBrain, GeminiBrain, type Brain, type BrainInput } from './brain'
import type { EngineState, VoiceEngine, VoiceEngineEvents } from './engine'

/**
 * Der zusammengesetzte Weg: irgendwer hört, irgendwer denkt, irgendwer spricht.
 *
 * Gebaut aus einem Zwang. Die Live-API kann alles drei in einem Stück, aber kein
 * verfügbares Live-Modell gibt Text aus — sie sprechen alle nur. Wer eine
 * fremde Stimme will, braucht deshalb einen Text, und woher der kommt, ist ab
 * da eine Einstellung.
 *
 * Inzwischen sind es drei Einstellungen, und jede steht für sich (siehe
 * `SpeechSettings` in shared/types.ts):
 *
 * - **Hören**: Gemini oder whisper auf diesem Rechner.
 * - **Denken**: Gemini oder Ollama auf diesem Rechner (siehe `brain.ts`).
 * - **Sprechen**: ElevenLabs, piper auf diesem Rechner, oder — dann aber über
 *   den Live-Motor statt über diesen hier — Gemini selbst.
 *
 * Ab Werk stehen alle drei auf „dieser Rechner". Dann verlässt kein gesprochenes
 * Wort mehr die Wohnung, und dieser Motor kommt ohne einen einzigen Gemini-Aufruf
 * aus. Jede Mischung dazwischen geht auch; welcher Weg wirklich läuft, entscheidet
 * sich unten in `start` und wird nicht geraten.
 *
 * Was hier selbst gebaut werden muss, weil es sonst der Server tat:
 *
 * 1. **Wann ist der Nutzer fertig?** Die Live-API entscheidet das serverseitig
 *    und hat dafür ein Modell. Hier zählt ein Pegel und eine Stille. Wie lang
 *    diese Stille sein muss, ist der wichtigste Regler dieses Motors: Er ist
 *    die Wartezeit vor jeder Antwort, und er steht deshalb eigens in den
 *    Einstellungen — nicht am Wert der Live-Sitzung, der eine ganz andere
 *    Aufgabe hat.
 *
 * 2. **Der Anfang des Satzes.** Bis der Pegel die Schwelle reißt, ist die erste
 *    Silbe schon vorbei. Ein kleiner Vorlauf läuft deshalb immer mit.
 *
 * 3. **Das Dazwischenreden.** Niemand meldet mehr, dass der Nutzer angefangen
 *    hat. Also wird auch während des Sprechens gemessen — vorsichtig, denn ein
 *    Fehlalarm klingt nicht nach Aufmerksamkeit, sondern nach einem Abbruch
 *    mitten im Satz.
 */

/** 20 ms je Block — dieselbe Größe, die die Aufnahme liefert. */
const CHUNK_MS = 20
/** 160 ms Vorlauf. Genug für einen Zischlaut, zu wenig für einen Fehlstart. */
const PREROLL_CHUNKS = 8
/** Kürzeres gilt als Räuspern, nicht als Beitrag. */
const MIN_SPEECH_MS = 240
/** Sicherung gegen ein Mikrofon, das nie still wird. */
const MAX_UTTERANCE_MS = 30_000

/**
 * So viele laute Blöcke hintereinander gelten als Dazwischenreden.
 *
 * Acht sind 160 Millisekunden. Zwei waren es einmal, und das war zu wenig: Ein
 * Tastendruck, ein Stuhl, ein Rest der eigenen Stimme, den die Echounterdrückung
 * durchgelassen hat — alles davon reißt vierzig Millisekunden lang eine
 * Schwelle, und James brach mitten im Satz ab. Ein verpasster Einwurf kostet
 * eine Wiederholung; ein falscher kostet die Antwort.
 */
const BARGE_IN_CHUNKS = 8

/**
 * Und lauter als beim gewöhnlichen Zuhören muss es auch sein.
 *
 * Während er spricht, ist der Raum nicht still — seine eigene Stimme steht im
 * Mikrofon, gedämpft, aber vorhanden. Wer hier dieselbe Schwelle nimmt wie für
 * die Stille davor, misst am Ende sich selbst.
 */
const BARGE_IN_LOUDER = 1.6

/**
 * Nachlauf, bevor "der Player ist leer" als "fertig gesprochen" gilt.
 *
 * Zwischen zwei Blöcken von ElevenLabs kann eine Lücke liegen, wenn das Netz
 * kurz stockt. Ohne diesen Nachlauf hieße jede solche Lücke: Zug zu Ende,
 * Mikrofon auf — und der nächste Block liefe dann in ein offenes Mikrofon, das
 * ihn als Dazwischenreden wertet und die eigene Antwort abwürgt. Genau so
 * klingt "er bricht mitten im Satz ab".
 */
const SPEECH_TAIL_MS = 350
/** A missing local synthesis completion must not leave the microphone muted. */
const OUTPUT_STALL_MS = 60_000
const START_TIMEOUT_MS = 60_000

export class CascadeSession implements VoiceEngine {
  private settings: Settings
  private events: VoiceEngineEvents

  private brain: Brain
  private ai: GoogleGenAI | null = null
  private player: PlayerHandle | null = null
  private voice: VoiceStream | null = null
  /**
   * Wer gerade in `voice` steckt.
   *
   * Nicht aus den Einstellungen abzulesen, und darauf kommt es an: Wird
   * ElevenLabs mitten im Betrieb aufgegeben, steht dort weiter `elevenlabs`,
   * während längst ein anderer spricht. An dieser Stelle hängt die
   * Kontingentmeldung — ein piper-Strom, der Zeichen abrechnet, verfälscht sie.
   */
  private voiceKind: 'elevenlabs' | 'piper' = 'elevenlabs'
  /** Flash und Turbo kosten einen Credit je zwei Zeichen, Multilingual einen je Zeichen. */
  private voiceCreditMultiplier = 1

  private awake = false
  private starting = false
  private startAbort: AbortController | null = null
  private lifecycle = 0
  private readonly budgetPrefix = `${Date.now()}-${Math.random()}`
  private pendingAudio: Int16Array[] = []
  private disposed = false
  /** Eine Anfrage ist unterwegs oder Werkzeuge laufen. */
  private thinking = false
  private acceptingRedirect = false
  /** Der laufende Zug ist überholt — dazwischengeredet oder Not-Aus. */
  private turn = 0
  private turnAbort: AbortController | null = null
  /** Ein Beitrag, der kam, während noch gedacht wurde. Höchstens einer. */
  private queued: { input: BrainInput; audio: Int16Array[] | null } | null = null

  private reportedState: EngineState | null = null

  // ── Aufnahme ─────────────────────────────────────────────
  private frames: Int16Array[] = []
  private preroll: Int16Array[] = []
  private capturing = false
  private speechMs = 0
  private silenceMs = 0
  private loudWhileSpeaking = 0

  // ── Ausgabe ──────────────────────────────────────────────
  /** Der Player hat Ton. */
  private playerSpeaking = false
  /** Text ist unterwegs zu ElevenLabs, der Zug also noch nicht zu Ende. */
  private voiceActive = false
  /** Was die Welt sieht: Er redet. Fällt erst nach dem Nachlauf. */
  private outputBusy = false
  private tailTimer: number | null = null
  private outputTimer: number | null = null
  private spokenReported = 0
  /**
   * Wann der Sprech-Sockel zuletzt ohne endgültigen Grund abbrach.
   *
   * Ein einzelner Abbruch ist ein Netzschluckauf, der nächste Satz baut neu
   * auf. Zwei kurz hintereinander heißen aber: Diese Stimme kommt gerade
   * nicht durch — und jeder Satz, der in einen sterbenden Sockel geht, ist ein
   * Satz, den niemand hört. Dann lieber gleich auf Geminis Stimme.
   */
  private voiceFailures: number[] = []

  private idleTimer: number | null = null
  private lastActivity = Date.now()

  public onUploadGate: ((muted: boolean) => void) | null = null
  public onOutputAudio: ((pcm: Int16Array) => void) | null = null
  public onExhausted: ((reason: string) => void) | null = null

  constructor(settings: Settings, events: VoiceEngineEvents) {
    this.settings = settings
    this.events = events
    this.brain = createBrain(settings)
  }

  // ─────────────────────────────────────────────────────────
  // Lebenszyklus
  // ─────────────────────────────────────────────────────────

  isConnected(): boolean {
    return this.awake
  }

  isStarting(): boolean {
    return this.starting
  }

  /**
   * Während des Aufbaus bleibt der Satzanfang in einem begrenzten lokalen Puffer.
   */
  isAcceptingAudio(): boolean {
    return (this.awake || this.starting) && !this.disposed
  }

  async start(): Promise<void> {
    if (this.disposed || this.awake || this.starting) return
    this.starting = true
    const generation = ++this.lifecycle
    const abort = new AbortController()
    this.startAbort = abort
    const timer = window.setTimeout(() => abort.abort(new Error('Der Aufbau der Sprachverbindung hat zu lange gedauert. Bitte starte sie erneut.')), START_TIMEOUT_MS)
    const wait = <T>(operation: Promise<T>): Promise<T> => abortable(operation, abort.signal)
    const cancelled = (): boolean => abort.signal.aborted || this.disposed || generation !== this.lifecycle
    this.emit('connecting')

    try {
      const apiKey = await wait(window.jarvis.invoke('secrets:getGeminiForLive'))
      if (cancelled()) return
      if (apiKey) this.ai = new GoogleGenAI({ apiKey })

      /**
       * Gemini wird nur noch verlangt, wo Gemini wirklich gebraucht wird.
       *
       * Hier stand einmal, ohne Gemini gehe dieser Weg gar nicht: Ein Textmodell
       * hört nichts, und die Prüfung, ob eine Zustimmung wirklich gefallen ist,
       * braucht den Wortlaut — beides lief über Gemini, auch wenn das Denken
       * schon lokal passierte. Mit whisper stimmt das nicht mehr. Die Abschrift
       * entsteht dann auf diesem Rechner, und sie taugt für beides.
       *
       * Übrig bleiben genau zwei Gründe, und beide werden einzeln geprüft, damit
       * die Meldung sagen kann, welcher es war. Wer einen Schlüssel eintragen
       * soll, will wissen, wofür.
       */
      const hearsRemotely = this.settings.speech.hearProvider === 'gemini'
      const thinksRemotely = !this.brain.needsText

      if (!apiKey && (hearsRemotely || thinksRemotely)) {
        this.events.onError(
          hearsRemotely && thinksRemotely
            ? 'Zum Zuhören und Denken brauche ich einen Gemini Zugang. Trag ihn in den Einstellungen ein — ' +
                'oder stell unter Ohren auf whisper und unter Stimme das Denken auf ein Modell hier um.'
            : hearsRemotely
              ? 'Zum Zuhören brauche ich einen Gemini Zugang. Trag ihn in den Einstellungen ein — ' +
                  'oder stell unter Ohren auf whisper um, dann bleibt das Zuhören auf diesem Rechner.'
              : 'Zum Denken brauche ich einen Gemini Zugang. Trag ihn in den Einstellungen ein — ' +
                  'oder wähl unter Stimme ein Denkmodell auf diesem Rechner.'
        )
        this.emit('idle')
        return
      }

      try {
        await wait(this.brain.prepare(abort.signal))
      } catch (err) {
        if (cancelled()) throw err
        const message = err instanceof Error ? err.message : String(err)
        // Ollama oder ChatGPT nicht bereit: Gemini übernimmt nur das Denken.
        // Ollama darf nur gewählt bleiben, wenn das Modell wirklich Werkzeuge
        // kann. Ist es aus oder ungeeignet, übernimmt Gemini nur das Denken —
        // die ausgewählte ElevenLabs-Stimme bleibt dadurch erhalten.
        if (this.settings.speech.thinkProvider !== 'gemini' && apiKey) {
          this.events.onError(`${message} Vorübergehend denkt Gemini API; die Stimme bleibt gleich.`)
          this.brain = new GeminiBrain(this.settings)
          await wait(this.brain.prepare(abort.signal))
        } else {
          this.events.onError(message)
          this.onExhausted?.(message)
          this.emit('idle')
          return
        }
      }
      if (cancelled()) return

      /**
       * Der Sprecher wird aufgestellt, bevor der Player steht.
       *
       * Beide können ausfallen, und ein Ausfall heißt hier nicht Stille, sondern
       * Motorwechsel: `onExhausted` schickt den Controller zum Live-Motor, der
       * mit Geminis eigener Stimme spricht. Das darf aber erst passieren, wenn
       * feststeht, dass es nicht geht — einen Player aufzubauen, den gleich
       * darauf niemand füttert, kostet ein Audiogerät für nichts.
       */
      const wantsPiper = this.settings.speech.provider === 'piper'
      const note = (message: string): void => { if (!cancelled()) this.events.onError(message) }

      if (wantsPiper) {
        const plan = await wait(planPiperVoice(note))
        if (cancelled()) return
        if (!plan) {
          this.onExhausted?.('piper steht nicht bereit.')
          this.emit('idle')
          return
        }
        console.info(`[kaskade] piper spricht mit ${plan.voice} (${plan.backend}, ${plan.sampleRate} Hz)`)
        if (!(await wait(this.ensurePlayer(abort.signal, generation))) || cancelled()) return
        this.openPiper()
      } else {
        const plan = await wait(planVoice(this.settings, note))
        if (cancelled()) return
        if (!plan) {
          this.onExhausted?.('ElevenLabs steht nicht bereit.')
          this.emit('idle')
          return
        }
        if (!(await wait(this.ensurePlayer(abort.signal, generation))) || cancelled()) return
        this.openEleven(plan)
      }

      // Bei ElevenLabs der Handschlag nach Amerika, bei piper der Start des
      // Prozesses und das Laden der ONNX-Sitzung. Beides jetzt, nicht vor dem
      // ersten Wort — dort läge es zwischen der Frage und dem ersten Ton.
      this.voice?.prewarm()

      if (cancelled()) return
      this.awake = true
      this.lastActivity = Date.now()
      this.startIdleWatch()
      this.emitDerived()
      const pending = this.pendingAudio
      this.pendingAudio = []
      for (const pcm of pending) this.pushAudio(pcm)
    } catch (err) {
      if (generation !== this.lifecycle || this.disposed) return
      this.voice?.close()
      this.voice = null
      const player = this.player
      this.player = null
      await player?.destroy()
      if (generation === this.lifecycle && !this.disposed) this.emit('idle')
      throw err
    } finally {
      window.clearTimeout(timer)
      if (this.startAbort === abort) {
        this.startAbort = null
        this.starting = false
        if (!this.awake) this.pendingAudio = []
      }
    }
  }

  async stop(): Promise<void> {
    this.lifecycle++
    this.startAbort?.abort()
    this.startAbort = null
    this.starting = false
    this.pendingAudio = []
    this.awake = false
    this.thinking = false
    this.turn++
    this.turnAbort?.abort()
    this.queued = null
    this.resetCapture()
    this.stopIdleWatch()
    this.clearTail()
    this.clearOutputWatch()

    this.reportSpent()
    this.voice?.close()
    this.voice = null

    const player = this.player
    this.player = null
    this.playerSpeaking = false
    this.voiceActive = false
    this.outputBusy = false
    this.onUploadGate?.(false)
    this.emit('idle')
    await player?.destroy()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.stop()
    this.brain.reset()
  }

  /** Prompt und Werkzeuge werden bei jedem Beitrag frisch geholt — nichts zu tun. */
  async refreshConfig(): Promise<void> {}

  updateSettings(settings: Settings): void {
    this.settings = settings
    this.brain.update(settings)
    this.player?.setSettings(settings.audio)
  }

  // ─────────────────────────────────────────────────────────
  // Zuhören
  // ─────────────────────────────────────────────────────────

  /**
   * Ein Block vom Mikrofon.
   *
   * Hier steckt die Sprechpausen-Erkennung, die bei der Live-API auf dem Server
   * saß. Sie ist absichtlich schlicht: ein Pegel gegen dieselbe Schwelle, die
   * der Nutzer für das lokale Gatter ohnehin schon eingestellt hat, und eine
   * Stille, deren Länge eigens für diesen Weg einstellbar ist.
   */
  pushAudio(pcm: Int16Array): void {
    if (this.disposed) return
    if (!this.awake) {
      if (this.starting) {
        this.pendingAudio.push(pcm.slice())
        // Three seconds of local preroll, never unbounded audio retention.
        while (this.pendingAudio.reduce((sum, frame) => sum + frame.length, 0) > AUDIO_CONSTANTS.INPUT_SAMPLE_RATE * 3) this.pendingAudio.shift()
      }
      return
    }
    const level = chunkLevel(pcm)
    const loud = level >= this.settings.vad.localGateThreshold

    // ── Dazwischenreden ──────────────────────────────────
    if (this.outputBusy) {
      const veryLoud = level >= this.settings.vad.localGateThreshold * BARGE_IN_LOUDER
      this.loudWhileSpeaking = veryLoud ? this.loudWhileSpeaking + 1 : 0
      if (this.loudWhileSpeaking >= BARGE_IN_CHUNKS) {
        this.loudWhileSpeaking = 0
        this.hush()
        // Nicht verwerfen: Was gerade gesagt wurde, ist der Anfang des
        // nächsten Beitrags und gehört mit hinein.
        this.beginCapture(pcm)
      }
      return
    }
    this.loudWhileSpeaking = 0

    /**
     * Während gedacht wird, fängt kein neuer Beitrag an — die Antwort auf den
     * vorigen ist ja noch nicht da.
     *
     * Ein Beitrag, der schon läuft, wird dagegen zu Ende aufgenommen. Genau der
     * entsteht beim Dazwischenreden: Die Ausgabe bricht ab, der neue Satz
     * beginnt, und der alte Zug räumt derweil noch ein Werkzeug ab. Wer hier
     * auch ihn abweist, nimmt seine erste Silbe auf, dann nichts, und irgendwann
     * den Schluss — ein Beitrag mit einem Loch in der Mitte, der außerdem nie
     * endet, weil in der Zwischenzeit auch keine Stille gezählt wird. Auf das
     * Ende dieser Aufnahme wartet die Warteschlange in `ask`.
     */
    if (this.thinking && !this.capturing && !this.acceptingRedirect) return

    if (!this.capturing) {
      if (!loud) {
        this.preroll.push(pcm)
        if (this.preroll.length > PREROLL_CHUNKS) this.preroll.shift()
        return
      }
      this.beginCapture(pcm)
      return
    }

    this.frames.push(pcm)
    if (loud) {
      this.speechMs += CHUNK_MS
      this.silenceMs = 0
    } else {
      this.silenceMs += CHUNK_MS
    }

    const spoken = this.frames.length * CHUNK_MS
    if (this.silenceMs >= this.settings.speech.endpointMs || spoken >= MAX_UTTERANCE_MS) {
      this.endCapture()
    }
  }

  private beginCapture(first: Int16Array): void {
    this.acceptingRedirect = false
    this.capturing = true
    this.frames = [...this.preroll, first]
    this.preroll = []
    this.speechMs = CHUNK_MS
    this.silenceMs = 0
  }

  private endCapture(): void {
    const frames = this.frames
    const speech = this.speechMs
    this.resetCapture()

    // Ein Husten ist kein Beitrag. Ohne diese Schranke antwortet James auf
    // jedes Geräusch im Raum, und zwar mit einer bezahlten Anfrage.
    if (speech < MIN_SPEECH_MS) return

    this.lastActivity = Date.now()
    void this.ask({ wavBase64: toWavBase64(frames) }, frames)
  }

  private resetCapture(): void {
    this.capturing = false
    this.frames = []
    this.preroll = []
    this.speechMs = 0
    this.silenceMs = 0
  }

  // ─────────────────────────────────────────────────────────
  // Denken
  // ─────────────────────────────────────────────────────────

  sendText(text: string): boolean {
    if (!this.awake || this.disposed || !text.trim()) return false
    this.lastActivity = Date.now()
    void this.ask({ text }, null)
    return true
  }

  /**
   * Ein Beitrag geht hinaus, und was zurückkommt, wird gesprochen.
   *
   * Gestreamt, nicht am Stück abgewartet: Die ersten Sätze gehen an ElevenLabs,
   * während das Modell noch schreibt. Am Stück zu warten hieße, die Verzögerung
   * der ganzen Antwort vor den ersten Ton zu legen — bei drei Sätzen ist das der
   * Unterschied zwischen einem Gespräch und einem Formular.
   */
  private async ask(input: BrainInput, audio: Int16Array[] | null): Promise<void> {
    /**
     * Zwei Beiträge gleichzeitig kann diese Kette nicht — aber wegwerfen darf
     * sie den zweiten auch nicht.
     *
     * Der Fall tritt nach jedem Dazwischenreden auf: Die Ausgabe ist abgebrochen,
     * der neue Satz ist fertig gesprochen, und der alte Zug räumt gerade noch
     * ein Werkzeug ab. Wer hier nur zurückkehrt, lässt genau den Satz fallen,
     * mit dem Void ihn unterbrochen hat — und das sieht aus wie Taubheit.
     */
    if (this.thinking) {
      this.queued = { input, audio }
      return
    }
    this.thinking = true
    const abort = new AbortController()
    const turnTimer = window.setTimeout(() => abort.abort(new Error('Die Antwort hat zu lange gedauert. Bitte versuche es erneut.')), 180_000)
    this.turnAbort = abort
    const turn = ++this.turn
    const budgetId = `${this.budgetPrefix}-${turn}`
    this.applyGate()
    this.emitDerived()

    /**
     * Die Abschrift läuft nebenher.
     *
     * Der Hauptprozess prüft bei heiklen Werkzeugen, ob der Nutzer wirklich
     * zugestimmt hat, und dafür braucht er den Wortlaut. Die Live-API lieferte
     * ihn nebenbei mit; hier muss er eigens geholt werden. Nebenher, weil er
     * bei einer Antwort ohne Werkzeug gar nicht gebraucht wird — und bis dahin
     * ist er längst da.
     */
    // Erst auf Abruf: Bisher lief die Abschrift bei jedem Satz mit, auch
    // ohne Werkzeug, und verdoppelte damit die Anfragen ans Tageskontingent.
    const typed = (input.text ?? '').trim()
    let pendingTranscript: Promise<string> | null = null
    const transcript = (): Promise<string> => {
      if (pendingTranscript) return pendingTranscript
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)])
      return (pendingTranscript = audio ? abortable(this.transcribe(audio, signal), signal) : Promise.resolve(typed))
    }

    /**
     * Wann Void das gesagt hat — festgehalten, bevor das Modell loslegt.
     *
     * Die Bestätigungsprüfung verlangt, dass nach der Rückfrage etwas gesagt
     * wurde. Stünde hier die Uhrzeit des Werkzeugaufrufs, wäre jeder Aufruf
     * jünger als die Rückfrage aus demselben Zug: Das Modell könnte fragen und
     * sich im selben Atemzug mit `confirmed: true` selbst die Zustimmung geben.
     */
    const heardAt = Date.now()

    // Solange das Modell denkt, kann der Sprech-Sockel schon aufgehen. Danach
    // wäre derselbe Handschlag eine Pause zwischen Frage und erstem Ton.
    this.voice?.prewarm()
    let finishedOutput = false

    try {
      let spokenText = ''
      if (this.brain.needsText && !input.text) {
        // Ein Textmodell hört nichts — hier muss gewartet werden, was auf dem
        // Gemini-Weg nebenher läuft. Das ist der Preis des lokalen Denkens.
        spokenText = await transcript()
        if (abort.signal.aborted || turn !== this.turn) return
        if (!spokenText) {
          this.events.onError('Ich habe nicht verstanden, was du gesagt hast.')
          return
        }
        input = { text: spokenText }
        this.events.onUserTranscript(spokenText)
      }

      const spoke = await abortable(this.brain.run(input, {
        budgetId,
        onText: (chunk) => {
          if (turn !== this.turn || abort.signal.aborted) return
          this.speak(chunk)
          this.events.onModelTranscript(chunk)
        },
        callTool: async (name, args) => {
          const text = spokenText || (await transcript())
          if (abort.signal.aborted || turn !== this.turn) return { ok: false, error: 'Unterbrochen.' }
          const id = crypto.randomUUID()
          const cancel = (): void => { void window.jarvis.invoke('tools:cancel', { id }).catch(() => {}) }
          abort.signal.addEventListener('abort', cancel, { once: true })
          try {
            const result: ToolCallResult = await abortable(window.jarvis.invoke('tools:call', {
              id, name, args, budgetId, userTurn: { lastUserText: text, lastUserTextAt: heardAt }
            }), abort.signal)
            return { ok: result.ok, result: result.result, error: result.error }
          } finally { abort.signal.removeEventListener('abort', cancel) }
        },
        transcript: async () => {
          const text = spokenText || (await transcript())
          if (text && turn === this.turn && !abort.signal.aborted && this.awake) this.events.onUserTranscript(text)
          return text
        },
        cancelled: () => turn !== this.turn || abort.signal.aborted || !this.awake || this.disposed,
        signal: abort.signal
      }), abort.signal)

      if (turn !== this.turn) return
      if (spoke) { this.finishSpeaking(); finishedOutput = true }
      else this.events.onError('James hat keine Antwort erhalten. Bitte versuche es erneut.')

      // Nur weiterreichen, was ohnehin geholt wurde. Eine eigene Abschrift
      // allein dafür wäre eine zweite bezahlte Anfrage pro Satz — und der
      // Empfänger zeigt sie nirgends an.
      // Der Typ muss genannt werden: Gesetzt wird nur im Rückruf oben, und
      // TypeScript hält die Variable hier deshalb für immer `null`.
      const fetched = pendingTranscript as Promise<string> | null
      if (fetched && !spokenText) {
        void fetched.then((text) => {
          if (text && turn === this.turn && !abort.signal.aborted && this.awake) this.events.onUserTranscript(text)
        }).catch(() => undefined)
      }
    } catch (err) {
      if (turn !== this.turn || !this.awake || this.disposed) return
      const message = err instanceof Error ? err.message : String(err)
      abort.abort(err)
      console.error('[kaskade] Anfrage fehlgeschlagen:', message)
      this.events.onError(friendlyError(message, this.brain.label))
    } finally {
      window.clearTimeout(turnTimer)
      // A stopped/restarted session may already own a newer turn.
      if (this.turnAbort !== abort) return
      if (turn === this.turn && !finishedOutput && this.voiceActive) {
        this.voice?.abort()
        this.voiceActive = false
        this.settleOutput()
      }
      this.turnAbort = null
      this.thinking = false
      this.applyGate()
      this.emitDerived()
      this.lastActivity = Date.now()

      const next = this.queued
      this.queued = null
      if (next && this.awake && !this.disposed) void this.ask(next.input, next.audio)
    }
  }

  /**
   * Der Wortlaut des Beitrags — für die Bestätigungsprüfung und das lokale Denken.
   *
   * Zweimal unentbehrlich: Ein Textmodell hört nichts, und die Prüfung, ob eine
   * Zustimmung wirklich gefallen ist, braucht den Wortlaut. Ohne ihn scheitert
   * jedes Werkzeug, das eine ausdrückliche Zustimmung verlangt, und zwar stumm.
   *
   * Wer ihn schreibt, steht in den Einstellungen. Der Unterschied zwischen den
   * beiden Wegen ist nicht nur, wohin der Ton geht, sondern was er kostet:
   * Gemini kostet Token — bei fünfundzwanzig je Sekunde ist der Beitrag ein
   * zweites Mal zu bezahlen —, whisper kostet Rechenzeit auf dieser CPU, und
   * die liegt vor jeder Antwort. Beides ist ein Preis, keiner davon ist
   * versteckt.
   */
  private async transcribe(frames: Int16Array[], signal?: AbortSignal): Promise<string> {
    if (this.settings.speech.hearProvider === 'whisper') {
      return this.transcribeHere(frames, signal)
    }
    return this.transcribeAtGoogle(frames, signal)
  }

  /**
   * whisper auf diesem Rechner.
   *
   * Die Länge des Beitrags geht mit, und sie ist keine Beigabe: Der Encoder
   * rechnet sonst für jedes „ja" dieselben dreißig Sekunden wie für einen
   * Absatz — die Eingabe wird schlicht mit Stille aufgefüllt. Aus der Länge
   * rechnet der Dienst aus, wie viel vom Zeitfenster er überhaupt anfassen muss,
   * und das ist der einzige wirksame Hebel auf die Wartezeit (siehe
   * `audioContextFor` in main/providers/whisper.ts).
   *
   * Ein leerer Text ist hier kein Fehler, sondern eine Aussage: Da war nichts,
   * was nach Sprache klang — die Spracherkennung hat alles verworfen, oder die
   * Sperrliste hat eine Erfindung kassiert. Dann wird geschwiegen und nicht neu
   * versucht. Ein Fehler mit Grund ist etwas anderes und muss den Nutzer
   * erreichen: Die Sätze von dort sind schon für ihn geschrieben und sagen, was
   * zu holen ist.
   */
  private async transcribeHere(frames: Int16Array[], signal?: AbortSignal): Promise<string> {
    const samples = frames.reduce((sum, frame) => sum + frame.length, 0)
    const seconds = samples / AUDIO_CONSTANTS.INPUT_SAMPLE_RATE

    try {
      const operation = window.jarvis.invoke('whisper:transcribe', {
        wavBase64: toWavBase64(frames),
        seconds
      })
      const result = await (signal ? abortable(operation, signal) : operation)
      if (!result.ok) {
        // Die Meldung „von einem neueren Beitrag überholt" ist kein Ausfall,
        // sondern der gewollte Lauf der Dinge: Der Nutzer hat weitergeredet, und
        // die alte Abschrift ist überholt. Sie gehört ins Protokoll, nicht vor
        // die Nase.
        if (result.error) {
          console.warn('[kaskade] whisper:', result.error)
          if (!result.error.includes('überholt')) this.events.onError(result.error)
        }
        return ''
      }
      return result.text
    } catch (err) {
      if (signal?.aborted) throw err
      const message = err instanceof Error ? err.message : String(err)
      console.error('[kaskade] whisper nicht erreichbar:', message)
      this.events.onError(
        'Der lokale Zuhörer antwortet nicht. Sieh in den Einstellungen unter Spracherkennung nach.'
      )
      return ''
    }
  }

  private async transcribeAtGoogle(frames: Int16Array[], signal?: AbortSignal): Promise<string> {
    if (!this.ai) return ''
    try {
      const ai = this.ai
      const contents = [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'audio/wav', data: toWavBase64(frames) } },
            { text: 'Schreib wörtlich auf, was gesagt wurde. Nur den Wortlaut, sonst nichts.' }
          ]
        }
      ]
      const response = await withModelFallback(this.settings.speech.transcribeModel, (model) =>
        ai.models.generateContent({ model, contents: contents as never, config: { abortSignal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) } })
      )
      return (response.text ?? '').trim()
    } catch {
      // Ohne Abschrift läuft alles weiter, nur Bestätigungen scheitern. Das ist
      // die richtige Richtung: lieber ein Werkzeug zu wenig als eines zu viel.
      return ''
    }
  }

  // ─────────────────────────────────────────────────────────
  // Sprechen
  // ─────────────────────────────────────────────────────────

  /**
   * Der Player, einmal.
   *
   * Gibt zurück, ob es weitergehen kann. Er ist die einzige Stelle im Aufbau,
   * die aus einem Grund scheitern kann, der nichts mit dem Sprecher zu tun hat —
   * kein Ausgabegerät, gesperrter Audiokontext. Ein Motorwechsel hülfe dagegen
   * nicht, der nächste bräuchte denselben Player. Deshalb hier kein
   * `onExhausted`, sondern ein Satz und Ruhe.
   */
  private async ensurePlayer(signal?: AbortSignal, generation = this.lifecycle): Promise<boolean> {
    if (this.player) return true
    try {
      const player = await createPlayer(this.settings.audio)
      if (signal?.aborted || this.disposed || generation !== this.lifecycle) {
        await player.destroy()
        return false
      }
      this.player = player
      player.onSpeakingChange = (speaking) => { if (this.player === player) this.onPlayerSpeaking(speaking) }
      return true
    } catch (err) {
      if (signal?.aborted || this.disposed || generation !== this.lifecycle) return false
      const message = err instanceof Error ? err.message : String(err)
      console.error('[kaskade] Der Player ließ sich nicht aufbauen:', message)
      this.events.onError('Die Tonausgabe ließ sich nicht öffnen. Prüf das Ausgabegerät in den Einstellungen.')
      this.emit('idle')
      return false
    }
  }

  /**
   * Der Sprecher auf diesem Rechner.
   *
   * Dieselbe Schnittstelle wie ElevenLabs, und das ist der ganze Grund, warum
   * dieser Motor sonst nichts davon merkt: `speak`, `finish`, `abort` verhalten
   * sich gleich. Zwei Unterschiede gibt es doch, und beide stehen hier.
   *
   * Der erste ist `onIdle`. Bei ElevenLabs kommt der Ton auf demselben Sockel
   * zurück wie der Text hinausging, ein Zug endet also ungefähr mit dem
   * Nachschub. Hier liegt zwischen dem letzten Satz und seinem letzten Tonblock
   * eine ganze Synthese. Wer den Zug schon vorher für beendet hielte, machte das
   * Mikrofon auf, während piper noch redet — und würde die eigene Stimme als
   * Dazwischenreden werten.
   *
   * Der zweite ist die Bedeutung von „kann nicht": kein Kontingent, das leer
   * läuft, sondern eine fehlende Datei oder ein abgestürzter Prozess. Siehe
   * `explainPiper`.
   */
  private openPiper(): void {
    this.voiceKind = 'piper'
    this.spokenReported = 0
    this.voice = createPiperStream({
      onAudio: (pcm) => {
        this.player?.push(pcm)
        this.onOutputAudio?.(pcm)
        this.watchOutput()
      },
      onIdle: () => {
        this.voiceActive = false
        this.settleOutput()
      },
      onError: (reason, fatal) => {
        console.warn(`[kaskade] piper: ${reason}${fatal ? ' (endgültig)' : ''}`)
        this.voiceActive = false
        this.settleOutput()
        if (!fatal) return
        this.events.onError(explainPiper(reason))
        this.onExhausted?.(reason)
      }
    })
  }

  private openEleven(plan: { apiKey: string; voiceId: string; modelId: string }): void {
    this.voiceKind = 'elevenlabs'
    this.voiceCreditMultiplier = /flash|turbo/.test(plan.modelId) ? 0.5 : 1
    this.spokenReported = 0
    this.voice = createVoiceStream({
      apiKey: plan.apiKey,
      voiceId: plan.voiceId,
      modelId: plan.modelId,
      language: this.settings.language.slice(0, 2),
      stability: this.settings.speech.stability,
      similarity: this.settings.speech.similarity,
      style: this.settings.speech.style,
      speed: this.settings.speech.speed,
      onAudio: (pcm) => {
        this.player?.push(pcm)
        this.onOutputAudio?.(pcm)
        this.watchOutput()
      },
      onError: (reason, fatal) => {
        console.warn(`[kaskade] ElevenLabs: ${reason}${fatal ? ' (endgültig)' : ''}`)
        this.voiceActive = false
        this.settleOutput()
        if (!fatal) {
          // Der planmäßige Schluss nach einer Minute Stille zählt nicht.
          if (/timeout|inactiv/i.test(reason)) return
          const now = Date.now()
          this.voiceFailures = [...this.voiceFailures.filter((t) => now - t < 60_000), now]
          if (this.voiceFailures.length < 2) return
          this.voiceFailures = []
        }
        // Bei einem vorübergehenden Grund baut der Strom beim nächsten Wort
        // selbst neu auf. Endgültig heißt dagegen: Dieser Motor ist am Ende.
        this.events.onError(explainVoice(reason))
        this.onExhausted?.(reason)
      }
    })
  }

  private speak(text: string): void {
    this.clearTail()
    if (!this.voiceActive || !this.outputBusy) {
      this.voiceActive = true
      this.outputBusy = true
      this.applyGate()
      this.emitDerived()
    }
    this.voice?.speak(text)
    this.watchOutput()
  }

  /**
   * Der Denkmotor ist fertig — aber der Sprecher womöglich noch nicht.
   *
   * Bei ElevenLabs fällt beides praktisch zusammen: Text und Ton laufen über
   * denselben Sockel, und was noch aussteht, ist eine Netzlaufzeit, die der
   * Nachlauf in `settleOutput` abdeckt.
   *
   * Bei piper liegt dazwischen eine ganze Synthese auf dieser CPU. Wer hier
   * auch für ihn `voiceActive` fallen ließe, hätte nur noch den Nachlauf von
   * 350 ms zwischen sich und einem offenen Mikrofon — und ein Satz, der länger
   * braucht, träfe dann auf ein Mikrofon, das die eigene Stimme für
   * Dazwischenreden hält und die eigene Antwort abwürgt. Genau dafür gibt es
   * `onIdle`: Der Strom sagt selbst, wann er ausgesprochen hat.
   */
  private finishSpeaking(): void {
    this.voice?.finish()
    if (this.voiceKind === 'elevenlabs') this.voiceActive = false
    this.reportSpent()
    this.settleOutput()
  }

  /** Sofort still — Dazwischenreden oder Not-Aus. */
  private hush(): void {
    this.turn++
    this.turnAbort?.abort()
    this.queued = null
    this.acceptingRedirect = true
    this.clearTail()
    this.clearOutputWatch()
    this.player?.flush()
    this.reportSpent()
    this.voice?.abort()
    this.voiceActive = false
    this.playerSpeaking = false
    this.outputBusy = false
    this.applyGate()
    this.emitDerived()
  }

  interrupt(): void {
    this.hush()
  }

  private onPlayerSpeaking(speaking: boolean): void {
    this.playerSpeaking = speaking
    if (speaking) {
      this.clearTail()
      this.outputBusy = true
      this.watchOutput()
      this.applyGate()
      this.emitDerived()
      return
    }
    if (this.outputBusy) this.watchOutput()
    this.settleOutput()
  }

  /**
   * Ist der Zug wirklich zu Ende?
   *
   * Nur wenn nichts mehr unterwegs ist *und* der Player leer bleibt. Der
   * Nachlauf ist der Unterschied zwischen einer Lücke im Nachschub und einem
   * Ende — von außen sehen beide gleich aus, und wer sie verwechselt, macht
   * mitten im Satz das Mikrofon auf.
   */
  private settleOutput(): void {
    if (!this.outputBusy) return
    if (this.voiceActive || this.playerSpeaking) return
    if (this.tailTimer !== null) return
    this.tailTimer = window.setTimeout(() => {
      this.tailTimer = null
      if (this.voiceActive || this.playerSpeaking) return
      this.outputBusy = false
      this.clearOutputWatch()
      this.applyGate()
      this.emitDerived()
    }, SPEECH_TAIL_MS)
  }

  private clearTail(): void {
    if (this.tailTimer !== null) window.clearTimeout(this.tailTimer)
    this.tailTimer = null
  }

  private watchOutput(): void {
    this.clearOutputWatch()
    if (!this.outputBusy || !this.awake || this.disposed) return
    this.outputTimer = window.setTimeout(() => {
      this.outputTimer = null
      if (!this.outputBusy || !this.awake || this.disposed) return
      // A queued recording can legitimately play longer than one minute.
      if (this.playerSpeaking) { this.watchOutput(); return }
      this.hush()
      this.events.onError('Die Sprachausgabe antwortet nicht. Bitte versuche es erneut.')
    }, OUTPUT_STALL_MS)
  }

  private clearOutputWatch(): void {
    if (this.outputTimer !== null) window.clearTimeout(this.outputTimer)
    this.outputTimer = null
  }

  /**
   * Verbrauchte Zeichen ans Kontingent melden — nur für ElevenLabs.
   *
   * piper kostet nichts und gibt deshalb 0 zurück. Die Abfrage hier ist trotzdem
   * nicht überflüssig: Ohne sie liefe bei jedem Zug eine IPC-Runde für eine Null,
   * und schlimmer, `spokenReported` und die Kontingentrechnung stünden für einen
   * Sprecher in den Büchern, der nie etwas abbucht.
   */
  private reportSpent(): void {
    if (!this.voice || this.voiceKind !== 'elevenlabs') return
    const total = this.voice.spentChars()
    const delta = total - this.spokenReported
    if (delta <= 0) return
    this.spokenReported = total
    void window.jarvis.invoke('eleven:spent', {
      chars: delta,
      creditMultiplier: this.voiceCreditMultiplier
    }).catch(() => undefined)
  }

  // ─────────────────────────────────────────────────────────
  // Zustand
  // ─────────────────────────────────────────────────────────

  private applyGate(): void {
    this.onUploadGate?.(this.settings.audio.halfDuplex && this.outputBusy)
  }

  private emit(state: EngineState): void {
    if (this.reportedState === state) return
    this.reportedState = state
    this.events.onStateChange(state)
  }

  private emitDerived(): void {
    if (!this.awake) return this.emit('idle')
    if (this.outputBusy) return this.emit('speaking')
    if (this.thinking) return this.emit('thinking')
    this.emit('listening')
  }

  private startIdleWatch(): void {
    this.stopIdleWatch()
    this.idleTimer = window.setInterval(() => {
      const limit = this.settings.wake.idleDisconnectSec
      if (limit <= 0) return
      const idle = (Date.now() - this.lastActivity) / 1000
      const busy = this.thinking || this.outputBusy || this.capturing
      if (idle > limit && !busy) {
        console.info('[kaskade] wegen Stille beendet')
        void this.stop()
      }
    }, 5000)
  }

  private stopIdleWatch(): void {
    if (this.idleTimer !== null) window.clearInterval(this.idleTimer)
    this.idleTimer = null
  }
}

// ─────────────────────────────────────────────────────────────
// Hilfsmittel
// ─────────────────────────────────────────────────────────────

/** Pegel eines Blocks, auf derselben Skala wie das lokale Gatter im Controller. */
function chunkLevel(pcm: Int16Array): number {
  let sum = 0
  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i] / 0x8000
    sum += s * s
  }
  return Math.min(1, Math.sqrt(Math.sqrt(sum / pcm.length)) * 2.6)
}

/**
 * Aus Blöcken wird eine WAV-Datei in base64.
 *
 * Der Umweg über den Kopf ist nötig, weil die gewöhnliche Schnittstelle rohes
 * PCM nicht kennt — sie will ein Format, dem eine Datei anzusehen ist, was sie
 * enthält. Vierundvierzig Byte davor genügen dafür.
 */
function toWavBase64(frames: Int16Array[]): string {
  const samples = frames.reduce((sum, frame) => sum + frame.length, 0)
  const rate = AUDIO_CONSTANTS.INPUT_SAMPLE_RATE
  const bytes = new Uint8Array(44 + samples * 2)
  const view = new DataView(bytes.buffer)

  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i)
  }

  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // Länge des Formatblocks
  view.setUint16(20, 1, true) // 1 = unkomprimiertes PCM
  view.setUint16(22, 1, true) // ein Kanal
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true) // Byte pro Sekunde
  view.setUint16(32, 2, true) // Byte pro Abtastwert
  view.setUint16(34, 16, true) // Bit je Wert
  ascii(36, 'data')
  view.setUint32(40, samples * 2, true)

  let offset = 44
  for (const frame of frames) {
    new Uint8Array(bytes.buffer, offset, frame.byteLength).set(
      new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength)
    )
    offset += frame.byteLength
  }

  // In Blöcken, weil String.fromCharCode bei großen Feldern den Stapel sprengt.
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/**
 * Warum ElevenLabs nicht spricht — in einem Satz, den man beantworten kann.
 *
 * "payment_required" ist die unfreundlichste dieser Meldungen: Sie klingt nach
 * einer leeren Geldbörse, meint aber meistens etwas anderes — die gewählte
 * Stimme stammt aus der Bibliothek und ist im Gratistarif gesperrt. Wer das
 * nicht weiß, sucht den Fehler beim Kontingent.
 */
function explainVoice(reason: string): string {
  const lower = reason.toLowerCase()
  if (lower.includes('paid_plan') || lower.includes('payment')) {
    return (
      'Diese ElevenLabs-Stimme gibt es nur mit bezahltem Tarif — Bibliotheksstimmen sind gesperrt. ' +
      'Wähl in den Einstellungen eine mitgelieferte. Solange spreche ich mit Geminis Stimme.'
    )
  }
  if (lower.includes('quota') || lower.includes('credit')) {
    return 'Das ElevenLabs-Kontingent ist aufgebraucht. Ich spreche mit Geminis Stimme weiter.'
  }
  if (lower.includes('api_key') || lower.includes('unauthorized')) {
    return 'Der ElevenLabs-Schlüssel wird nicht angenommen. Ich spreche mit Geminis Stimme weiter.'
  }
  return 'ElevenLabs macht gerade nicht mit. Ich spreche mit Geminis Stimme weiter.'
}

/**
 * Warum piper nicht spricht — in einem Satz, den man beantworten kann.
 *
 * Das Gegenstück zu `explainVoice`, und es musste eines geben: Dort heißt „kann
 * nicht" leeres Kontingent oder abgelehnter Schlüssel, hier eine fehlende Datei
 * oder ein Prozess, der beim Laden des Modells stirbt. Eine Meldung über
 * aufgebrauchtes Kontingent für ein Programm, das nichts kostet, schickte den
 * Nutzer an die falsche Stelle.
 *
 * Was fehlt, weiß der Hauptprozess genau, und er schreibt es in ganzen Sätzen
 * ("Die Stimme … fehlt. Hol sie in den Einstellungen"). Solche Sätze werden
 * durchgereicht statt ersetzt — sie sind besser als alles, was hier zu raten
 * wäre. Umformuliert wird nur, was von einem Prozessende oder einer Frist kommt.
 */
function explainPiper(reason: string): string {
  const lower = reason.toLowerCase()
  if (lower.includes('einstellungen')) return `${reason} Solange spreche ich mit Geminis Stimme.`
  if (lower.includes('python')) {
    return (
      'Die gepflegte piper-Fassung braucht Python, und ich finde keines. Trag den Pfad in den ' +
      'Einstellungen unter Stimme ein. Solange spreche ich mit Geminis Stimme.'
    )
  }
  return 'Der lokale Sprecher macht gerade nicht mit. Ich spreche mit Geminis Stimme weiter.'
}

function friendlyError(raw: string, brain: string): string {
  const lower = raw.toLowerCase()
  if (lower.includes('ollama')) return raw
  if (lower.includes('api key') || lower.includes('401')) {
    return 'Der Gemini Zugang wird nicht akzeptiert. Prüf den Schlüssel in den Einstellungen.'
  }
  if (lower.includes('quota') || lower.includes('429')) {
    return 'Das Kontingent ist gerade aufgebraucht. Versuch es in ein paar Minuten nochmal.'
  }
  if (lower.includes('not found') || lower.includes('404')) {
    return `Das eingestellte Denkmodell gibt es bei ${brain} nicht. Wähl in den Einstellungen ein anderes.`
  }
  return 'Da ist etwas schiefgegangen.'
}
