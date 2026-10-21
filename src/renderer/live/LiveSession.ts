import { GoogleGenAI, Modality } from '@google/genai'
import type { Settings, ToolCallResult } from '@shared/types'
import { LIVE_CONTEXT_COMPRESSION, LIVE_LIMITS } from '@shared/config/defaults'
import { createPlayer, type PlayerHandle } from '../audio/player'
import type { EngineState, VoiceEngine, VoiceEngineEvents } from './engine'
import { useCrystal } from '../store/crystalStore'
import { abortable } from '@shared/async'

/**
 * Die Live-Sitzung.
 *
 * Vier Dinge machen den Unterschied zwischen "Demo" und "benutzbar":
 *
 * 1. Barge-in. Kommt `interrupted`, wird der Wiedergabepuffer sofort geleert.
 *    Ohne das redet James noch zehn Sekunden weiter, nachdem du ihn
 *    unterbrochen hast.
 *
 * 2. Session-Resumption. Die API kappt reine Audio-Sitzungen nach 15 Minuten.
 *    Wir bauen die Nachfolgeverbindung vorher auf und schwenken um, statt auf
 *    den Abbruch zu warten — hörbar ist davon nichts.
 *
 * 3. Half-Duplex-Gate. Ohne Headset landet die eigene Ausgabe wieder im
 *    Mikrofon. Zusätzlich zur Echounterdrückung pausiert der Upload deshalb,
 *    solange James spricht.
 *
 * 4. Verbindungs-Identität. Jeder Socket bekommt eine Nummer und seine
 *    Rückrufe prüfen sie. Ohne das reißt der `onclose` der planmäßig
 *    abgelösten Verbindung die frisch aufgebaute mit — alle 15 Minuten
 *    genau einmal, und danach ist die Stimme weg.
 *
 * Hier spricht immer Gemini selbst. Der Weg über eine fremde Stimme ist ein
 * anderer Motor — `CascadeSession` —, und das ist kein Geschmacksurteil: Kein
 * verfügbares Live-Modell gibt Text aus, sie sprechen alle. Eine Betriebsart
 * dafür stand hier einmal, konnte aber nie greifen; sie ist wieder
 * ausgebaut, damit diese Datei nur eine Sache tut.
 */

type LiveMessage = Record<string, any>

/**
 * Zustand und Rückrufe sind für beide Motoren dieselben und stehen deshalb in
 * `engine.ts`. Die Namen von hier bleiben als Zweitnamen stehen, weil sie im
 * Projekt an mehreren Stellen benutzt werden und ein reines Umbenennen keine
 * Verbesserung wäre.
 */
export type LiveState = EngineState
export type LiveSessionEvents = VoiceEngineEvents

interface ActiveConnection {
  /** Laufende Nummer. Rückrufe älterer Sockets erkennt man daran. */
  id: number
  session: any
  openedAt: number
  closing: boolean
}

/**
 * So lange muss eine Verbindung gehalten haben, damit sie als Erfolg zählt.
 *
 * Bis dahin geht der Wiederholungszähler nicht zurück auf null. Das Protokoll
 * zeigt, warum: Der Server nimmt die Konfiguration an, schickt seine ersten
 * Meldungen und kappt zehn Sekunden später mit "Internal error encountered".
 * Jede dieser Meldungen setzte den Zähler zurück — der Rückzug blieb bei zwei
 * Sekunden stehen, und es wurde ohne Ende neu aufgebaut, jedes Mal mit
 * Abrechnung. Jetzt wächst die Wartezeit, und nach sechs Versuchen ist Schluss.
 */
const STABLE_CONNECTION_MS = 30_000

/**
 * So lange darf der Aufbau höchstens dauern, bis der Server das Einrichten bestätigt.
 *
 * Normal ist eine Sekunde. Das SDK hat für einen Aufbau, der nie fertig wird,
 * keinen Ausgang (siehe `awaitConnect`) — das hier ist die letzte Sicherung.
 */
const CONNECT_TIMEOUT_MS = 20_000
const REPLY_TIMEOUT_MS = 45_000

/** `WebSocket.OPEN`. Als Zahl, weil die Prüfung auch ohne Browser-Global laufen soll. */
const WS_OPEN = 1

/**
 * Nimmt der Sockel unter einer SDK-Sitzung noch Daten an?
 *
 * Der Browser wirft beim Senden auf einen Sockel in CLOSING oder CLOSED nicht.
 * Er schreibt "WebSocket is already in CLOSING or CLOSED state." als Fehler in
 * die Konsole und verwirft den Block — ein `try/catch` sieht davon nichts. Die
 * Aufnahme liefert aber alle 20 ms einen Block, und zwischen dem Close-Frame
 * des Servers und dem `onclose` vergehen genug davon, um das Protokoll mit
 * Fehlern zu füllen (und die Selbstheilung jedes Mal ohne Gegenmittel zu
 * wecken). Deshalb wird vor dem Senden nachgesehen.
 *
 * Das SDK hält seinen Sockel in `session.conn.ws`. Sieht es einmal anders aus,
 * gilt der Sockel als offen: Dann lieber senden wie bisher, als stumm werden.
 */
function socketAcceptsData(session: any): boolean {
  const readyState = session?.conn?.ws?.readyState
  if (typeof readyState !== 'number') return true
  return readyState === WS_OPEN
}

export class LiveSession implements VoiceEngine {
  private ai: GoogleGenAI | null = null
  private conn: ActiveConnection | null = null
  private player: PlayerHandle | null = null

  /**
   * Wird vom Controller gesetzt. Solange James spricht und Half-Duplex aktiv
   * ist, stoppt der Controller den Upload — die Aufnahme selbst läuft weiter,
   * weil das Wake-Word sie braucht.
   */
  public onUploadGate: ((muted: boolean) => void) | null = null

  /**
   * Abzweig der Ausgabe, für das Telefon.
   *
   * Die Blöcke gehen unverändert *zusätzlich* hier hinaus — der Lautsprecher
   * am Rechner bleibt bedient. Das ist Absicht: Wer sein Telefon danebenlegt,
   * soll nicht plötzlich am Rechner nichts mehr hören. Wer den Rechner
   * stummschalten will, hat dafür den Lautstärkeregler.
   */
  public onOutputAudio: ((pcm: Int16Array) => void) | null = null

  private settings: Settings
  private events: LiveSessionEvents

  private resumptionHandle: string | null = null
  private reconnectTimer: number | null = null
  private retryTimer: number | null = null
  private idleTimer: number | null = null
  private lastActivity = Date.now()
  /** Verbrauch dieser Sitzung laut `usageMetadata` — fürs Protokoll beim Schließen. */
  private sessionTokens = 0
  private sessionTurns = 0
  private sessionStartedAt = 0
  /**
   * Das Live-Modell, das gerade benutzt wird.
   *
   * Normalerweise das eingestellte. Ist dessen Kontingent leer, wird einmal
   * auf das andere Live-Modell gewechselt — Google zählt je Modell.
   */
  private activeModel: string | null = null

  private connSeq = 0
  /**
   * Die Nummer, deren Rückrufe gelten. Wechselt erst, wenn der Nachfolger
   * wirklich steht — scheitert der Aufbau, bleibt die alte Verbindung in
   * Betrieb, statt stumm weiterzulaufen.
   */
  private activeId = 0
  private connecting = false
  private starting: Promise<void> | null = null
  private startupAbort: AbortController | null = null
  private lifecycle = 0
  /** Der Aufbau, der gerade auf die Bestätigung des Servers wartet — und sein Notausgang. */
  private pendingConnect: { id: number; fail(err: Error): void } | null = null
  private reconnectAttempts = 0
  private disposed = false
  /** Nach einem ausdrücklichen stop() wird nicht mehr von selbst neu verbunden. */
  private stopped = true

  private modelSpeaking = false
  private busyTools = 0
  /**
   * Der Nutzer hat ausgeredet, die Antwort ist noch nicht da. Ohne diesen
   * Zustand stand „Hört zu", obwohl James längst am Antworten war.
   */
  private awaitingReply = false
  private replyTimer: number | null = null
  private replyWatchdog: number | null = null
  private reportedState: LiveState | null = null

  /**
   * Dieser Motor gibt nie auf — er ist selbst die Rückfallebene.
   *
   * Steht trotzdem hier, weil der Controller beide Motoren gleich behandelt.
   */
  public onExhausted: ((reason: string) => void) | null = null

  /**
   * Nach dem Not-Aus: ankommende Audiodaten fallen lassen, bis der Zug vorbei ist.
   *
   * Der Server weiß von dreimal Escape nichts. Er hat die Antwort längst
   * fertig erzeugt und schickt sie weiter, egal was wir hier tun. Den
   * Wiedergabepuffer zu leeren reicht deshalb nicht — er füllte sich im selben
   * Atemzug wieder, und nach einer halben Sekunde Stille redete James weiter.
   * Der Not-Aus wäre eine Kunstpause gewesen.
   */
  private suppressAudio = false

  /**
   * Was gesagt wurde, während die Verbindung noch aufging.
   *
   * Die auffälligste Wartezeit der ganzen App stand hier, und sie war keine
   * Wartezeit, sondern ein Verlust. Der Ablauf: „Hey James" weckt ihn, der
   * Aufbau des Sockets dauert je nach Netz eine halbe bis anderthalb Sekunden
   * — und genau in dieser Zeit sagt man den eigentlichen Satz. `sendAudio`
   * hatte ohne offene Verbindung nichts, wohin damit, und ließ ihn fallen.
   * Beim Modell kam nur das Ende an, oder gar nichts. Dann steht man davor,
   * wartet auf eine Antwort auf einen Satz, den nie jemand gehört hat, und
   * sagt ihn schließlich noch einmal. Gefühlt braucht James ewig; tatsächlich
   * hat er den ersten Anlauf nie bekommen.
   *
   * Also wird ab dem Weckwort mitgeschrieben und beim Öffnen alles in einem
   * Rutsch nachgeschickt. Die Reihenfolge bleibt dabei erhalten, und für die
   * Sprechpausenerkennung sieht es aus wie ein durchgehender Strom.
   */
  private pendingAudio: Int16Array[] = []
  /**
   * Deckel für den Puffer: 20-ms-Blöcke, 500 davon sind zehn Sekunden.
   *
   * Braucht der Aufbau länger als das, ist der Satz ohnehin verloren und der
   * Puffer wäre nur noch ein Leck. Verworfen wird von vorne — das Ende einer
   * Äußerung trägt mehr als ihr Anfang, wenn man ohnehin kürzen muss.
   */
  private static readonly PENDING_AUDIO_MAX_CHUNKS = 500

  constructor(settings: Settings, events: LiveSessionEvents) {
    this.settings = settings
    this.events = events
  }

  isConnected(): boolean {
    return this.conn !== null && !this.conn.closing && socketAcceptsData(this.conn.session)
  }

  isStarting(): boolean {
    return this.connecting || this.starting !== null
  }

  /**
   * Ob Ton überhaupt hereingereicht werden darf.
   *
   * Weiter gefasst als `isConnected`: Auch während des Aufbaus wird
   * angenommen, sonst fehlt genau der Satz, für den die Verbindung aufgeht.
   */
  isAcceptingAudio(): boolean {
    return this.isConnected() || (!this.stopped && !this.disposed)
  }

  // ─────────────────────────────────────────────────────────
  // Lebenszyklus
  // ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.disposed) return
    if (this.starting) return this.starting
    if (this.isConnected() || this.connecting) return
    const lifecycle = ++this.lifecycle
    const abort = new AbortController()
    this.startupAbort = abort
    const timeout = window.setTimeout(() => abort.abort(new Error('Zeitüberschreitung beim Start der Sprachverbindung')), CONNECT_TIMEOUT_MS)
    const starting = this.beginStart(lifecycle, abort.signal).catch((error) => {
      if (!this.disposed && !this.stopped && lifecycle === this.lifecycle) {
        void this.stop().catch(() => {})
        this.events.onError(`Die Sprachverbindung konnte nicht gestartet werden: ${error instanceof Error ? error.message : String(error)}.`)
      }
    })
    this.starting = starting
    try {
      await starting
    } finally {
      window.clearTimeout(timeout)
      if (this.startupAbort === abort) this.startupAbort = null
      if (this.starting === starting) this.starting = null
    }
  }

  private async beginStart(lifecycle: number, signal: AbortSignal): Promise<void> {
    this.clearTimers()
    this.clearAwaitingReply()
    this.stopped = false
    this.reconnectAttempts = 0
    // Frisch anfangen: Bleibt hier etwas aus einem gescheiterten Anlauf
    // liegen, bekäme die nächste Sitzung als Erstes einen Satz vorgesetzt,
    // den der Nutzer vor Minuten gesagt hat.
    this.pendingAudio = []
    this.emit('connecting')

    let apiKey: string | null
    try {
      apiKey = await abortable(window.jarvis.invoke('secrets:getGeminiForLive'), signal)
    } catch (error) {
      if (this.disposed || this.stopped || lifecycle !== this.lifecycle) return
      this.stopped = true
      this.emit('idle')
      this.events.onError(`Der Gemini Zugang konnte nicht geladen werden: ${error instanceof Error ? error.message : String(error)}.`)
      return
    }
    if (this.disposed || this.stopped || lifecycle !== this.lifecycle) return
    if (!apiKey) {
      this.stopped = true
      this.emit('idle')
      this.events.onError('Es ist kein Gemini Zugang hinterlegt.')
      return
    }

    this.ai = new GoogleGenAI({ apiKey })
    this.sessionTokens = 0
    this.sessionTurns = 0
    this.sessionStartedAt = Date.now()

    // Der Zweig darüber macht es für den fehlenden Schlüssel richtig vor:
    // anhalten, auf 'idle' zurück, und dem Nutzer sagen, was los ist. Die
    // Tonausgabe hatte davon nichts. Sie kann aber genauso scheitern — ein
    // abgezogenes Headset, ein AudioContext, den Windows nicht hergibt, ein
    // Worklet, das im gebauten Paket nicht lädt.
    //
    // Ohne diesen Fang blieb `conn` leer, `connecting` falsch und `stopped`
    // falsch. Der einzige je gesendete Zustand war 'connecting': Der Kristall
    // stand auf "Verbindet…", ohne Fehler, ohne Zeitgrenze. Jeder weitere
    // Klick und jedes Weckwort lief in denselben Fehler, weil beide Wächter
    // oben falsch waren — geholfen hat nur ein Neustart der App.
    // Eng um die Tonausgabe und nicht um den ganzen Rest: `connect()` bringt
    // seine eigene Behandlung mit, samt eigener Meldung und Wiederaufbau, und
    // wirft nie nach außen. Läge es mit in diesem Fang, stünde dort eines
    // Tages "Die Tonausgabe ließ sich nicht öffnen" über einem Netzfehler.
    if (!this.player) {
      try {
        const pending = createPlayer(this.settings.audio)
        let player: PlayerHandle
        try {
          player = await abortable(pending, signal)
        } catch (error) {
          // The audio API cannot be cancelled; dispose a player that arrives after Stop/timeout.
          void pending.then(late => late.destroy()).catch(() => {})
          throw error
        }
        if (this.disposed || this.stopped || lifecycle !== this.lifecycle) {
          await player.destroy()
          return
        }
        this.player = player
      } catch (err) {
        if (this.disposed || this.stopped || lifecycle !== this.lifecycle) return
        this.stopped = true
        this.emit('idle')
        this.events.onError(
          'Die Tonausgabe ließ sich nicht öffnen: ' +
            `${err instanceof Error ? err.message : String(err)}. ` +
            'Prüfe, ob ein Wiedergabegerät angeschlossen und ausgewählt ist.'
        )
        return
      }
      const player = this.player
      this.player.onSpeakingChange = (speaking) => {
        if (this.player !== player || this.stopped) return
        this.modelSpeaking = speaking
        if (speaking) this.clearAwaitingReply()
        // Half-Duplex: solange James spricht, geht nichts vom Mikrofon raus.
        // Mit Headset kann man das abschalten und echtes Reinreden nutzen.
        this.applyUploadGate()
        this.emitDerivedState()
      }
    }

    await abortable(this.connect(null), signal)
  }

  /** Vom Controller gespeist. Die Aufnahme gehört nicht der Session. */
  pushAudio(pcm: Int16Array): void {
    this.sendAudio(pcm)
  }

  private async connect(resumeHandle: string | null): Promise<void> {
    if (!this.ai || this.disposed || this.stopped) return
    // Zwei gleichzeitige Aufbauten wären zwei Abrechnungen und ein Rennen um
    // `this.conn`. Der zweite Wunsch wartet, bis der erste durch ist.
    if (this.connecting) return

    this.connecting = true
    const previous = this.conn
    const id = ++this.connSeq
    let abandoned = false

    try {
      const session = await this.awaitConnect(
        id,
        (async () => {
          const config = await this.buildConfig(resumeHandle)
          if (abandoned || this.disposed || this.stopped || id !== this.connSeq) throw new Error('Verbindungsaufbau abgebrochen')
          return this.ai!.live.connect({
            model: this.liveModel(),
            config,
            callbacks: {
              onopen: () => this.handleOpen(id),
              onmessage: (message: LiveMessage) => this.handleMessage(id, message),
              onerror: (err: { message?: string }) => this.handleError(id, err),
              onclose: (event: { reason?: string }) => this.handleClose(id, event)
            }
          })
        })()
      )

      if (this.disposed || this.stopped || id !== this.connSeq) {
        try { session?.close() } catch { /* Already closed. */ }
        return
      }

      if (previous) {
        // Tool results and playback belong to the old socket. Its delayed
        // finally callbacks cannot release busyTools after ownership changes.
        this.cancelRunningTools()
        this.busyTools = 0
        this.stopSpeaking()
        this.clearAwaitingReply()
        this.onUploadGate?.(false)
      }
      this.conn = { id, session, openedAt: Date.now(), closing: false }
      this.activeId = id
      // Eine frische Verbindung kennt den abgewürgten Zug nicht mehr. Bliebe
      // die Sperre stehen, wäre James ab hier für immer stumm.
      this.suppressAudio = false
      this.lastActivity = Date.now()
      this.scheduleReconnect()
      this.scheduleIdleCheck()
      this.emitDerivedState()

      // Was während des Aufbaus gesagt wurde, gehört jetzt hinein — vor allem
      // anderen, sonst stünde es hinter einem später aufgenommenen Block.
      this.flushPendingAudio()

      // Erst nach erfolgreichem Aufbau die alte Verbindung schließen —
      // so entsteht beim Umschwenken keine Lücke im Audiostrom. Ihr `onclose`
      // trägt die alte Nummer und wird deshalb unten ignoriert.
      if (previous) {
        previous.closing = true
        try {
          previous.session.close()
        } catch {
          // Bereits geschlossen.
        }
      }
    } catch (err) {
      abandoned = true
      if (this.disposed || this.stopped || id !== this.connSeq) return
      const message = err instanceof Error ? err.message : String(err)
      console.error('[live] Verbindung fehlgeschlagen:', message)
      // Läuft die Vorgängerverbindung noch, ist nur der vorgezogene Wechsel
      // misslungen — dann gibt es nichts zu melden und nichts zu wiederholen.
      if (!this.isConnected()) {
        if (this.handleQuota(message)) return
        this.events.onError(this.friendlyError(message))
        this.scheduleRetry()
      }
    } finally {
      if (id === this.connSeq) this.connecting = false
    }
  }

  /**
   * `live.connect` mit Ausweg.
   *
   * Das SDK wartet auf die Bestätigung des Servers, und für den Fall, dass der
   * Sockel vorher zugeht — kein Netz, abgelehnter Schlüssel, unbekanntes Modell —,
   * gibt es keinen Ausgang: Das Versprechen löst sich weder auf, noch scheitert
   * es. `connecting` bliebe für immer wahr, `start()` und jeder Neuaufbau
   * kehrten sofort zurück, und der Kristall stünde auf „Verbindet…“, bis die
   * App neu gestartet wird. Zwei Auswege: das `onclose` der Verbindung im Aufbau
   * (siehe `handleClose`) und die Zeitgrenze.
   *
   * Kommt die Sitzung nach dem Aufgeben doch noch zustande, gehört sie niemandem
   * mehr und wird geschlossen — sonst bliebe ein Sockel offen, den keiner kennt.
   */
  private async awaitConnect(id: number, attempt: Promise<any>): Promise<any> {
    let fail: (err: Error) => void = () => undefined
    const gaveUp = new Promise<never>((_, reject) => {
      fail = reject
    })
    const timer = window.setTimeout(
      () => fail(new Error('Zeitüberschreitung beim Verbindungsaufbau')),
      CONNECT_TIMEOUT_MS
    )
    this.pendingConnect = { id, fail }
    let abandoned = false
    attempt.then(
      (late) => {
        if (!abandoned) return
        try {
          late?.close()
        } catch {
          // Schon zu.
        }
      },
      () => undefined
    )
    try {
      return await Promise.race([attempt, gaveUp])
    } catch (err) {
      abandoned = true
      throw err
    } finally {
      window.clearTimeout(timer)
      if (this.pendingConnect?.id === id) this.pendingConnect = null
    }
  }

  private async buildConfig(resumeHandle: string | null): Promise<Record<string, unknown>> {
    const [systemPrompt, tools] = await Promise.all([
      window.jarvis.invoke('agent:systemPrompt'),
      window.jarvis.invoke('agent:toolDeclarations')
    ])

    const vad = this.settings.vad

    return {
      responseModalities: [Modality.AUDIO],

      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: this.settings.voice } },
        // Ohne languageCode driftet das Modell mitten im Gespräch ins Englische.
        languageCode: this.settings.language
      },

      systemInstruction: { parts: [{ text: systemPrompt }] },

      tools,

      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: `START_SENSITIVITY_${vad.startSensitivity}`,
          endOfSpeechSensitivity: `END_SENSITIVITY_${vad.endSensitivity}`,
          prefixPaddingMs: vad.prefixPaddingMs,
          // Der wichtigste Wert der ganzen App: zu niedrig und er schneidet
          // dich ab, sobald du mitten im Satz kurz nachdenkst.
          silenceDurationMs: vad.silenceDurationMs
        }
      },

      // Transkripte brauchen wir für Gedächtnis und Aktionslog, nicht für die
      // Anzeige — es gibt ja keine.
      inputAudioTranscription: {},
      outputAudioTranscription: {},

      // Ohne das ist nach 15 Minuten Schluss.
      sessionResumption: resumeHandle ? { handle: resumeHandle } : {},

      // Rollierendes Fenster, damit lange Gespräche nicht am Kontextlimit sterben.
      contextWindowCompression: {
        triggerTokens: LIVE_CONTEXT_COMPRESSION.TRIGGER_TOKENS,
        slidingWindow: { targetTokens: LIVE_CONTEXT_COMPRESSION.TARGET_TOKENS }
      }
    }
  }

  async stop(): Promise<void> {
    this.cancelRunningTools()
    if (!this.stopped && this.sessionStartedAt > 0) {
      const seconds = Math.round((Date.now() - this.sessionStartedAt) / 1000)
      console.info(
        `[live] Sitzung beendet nach ${seconds} s: ${this.sessionTokens} Token in ${this.sessionTurns} Runden (${this.liveModel()})`
      )
      this.sessionStartedAt = 0
    }
    // Vor dem Aufräumen setzen: sonst legt ein gerade laufender Rückruf einen
    // neuen Versuch nach, während wir schließen.
    this.stopped = true
    this.startupAbort?.abort(new Error('Sprachstart abgebrochen'))
    this.startupAbort = null
    this.lifecycle++
    this.starting = null
    this.connSeq++
    this.activeId = 0
    this.pendingConnect?.fail(new Error('Verbindungsaufbau abgebrochen'))
    this.connecting = false
    this.clearTimers()
    this.reconnectAttempts = 0
    // Ein aufgehobener Satz gilt für die Verbindung, für die er gesagt wurde.
    // Ihn nach dem Schließen aufzuheben hieße, ihn beim nächsten Aufwachen
    // ungefragt loszuschicken.
    this.pendingAudio = []

    if (this.conn) {
      this.conn.closing = true
      try {
        this.conn.session.close()
      } catch {
        // Egal.
      }
      this.conn = null
    }

    const player = this.player
    this.player = null
    this.modelSpeaking = false
    this.suppressAudio = false
    this.busyTools = 0
    this.clearAwaitingReply()
    this.onUploadGate?.(false)
    this.emit('idle')
    await player?.destroy()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.stop()
  }

  /**
   * Sitzung mit frischer Konfiguration neu aufsetzen.
   *
   * Werkzeugliste und System-Prompt stecken in der Setup-Nachricht und lassen
   * sich an einer laufenden Verbindung nicht nachreichen. Wird gebraucht,
   * sobald ein Zugang dazukommt oder wegfällt — sonst kennt das Modell die
   * neuen Werkzeuge bis zum nächsten planmäßigen Neuaufbau nicht, also bis zu
   * fünfzehn Minuten lang.
   *
   * Über das Resumption-Handle bleibt der Gesprächsfaden dabei erhalten.
   */
  async refreshConfig(): Promise<void> {
    if (!this.conn || this.conn.closing) return
    await this.connect(this.resumptionHandle)
  }

  /** Sprachausgabe sofort abbrechen — für den Not-Aus. */
  interrupt(): void {
    this.cancelRunningTools()
    this.clearAwaitingReply()
    this.stopSpeaking()
    this.suppressAudio = true
    this.applyUploadGate()
    this.emitDerivedState()
  }

  /** Alles verstummen lassen, was gerade läuft. */
  private stopSpeaking(): void {
    this.player?.flush()
    this.modelSpeaking = false
  }

  updateSettings(settings: Settings): void {
    const needsReconnect =
      settings.liveModel !== this.settings.liveModel ||
      settings.voice !== this.settings.voice ||
      settings.language !== this.settings.language ||
      settings.assistantRole !== this.settings.assistantRole ||
      JSON.stringify(settings.vad) !== JSON.stringify(this.settings.vad)

    const halfDuplexChanged = settings.audio.halfDuplex !== this.settings.audio.halfDuplex

    this.settings = settings
    this.player?.setSettings(settings.audio)

    // Wird Half-Duplex mitten im Sprechen abgeschaltet, bliebe das Mikrofon
    // sonst für immer zu — die Freigabe kommt erst beim nächsten Wechsel.
    if (halfDuplexChanged) this.applyUploadGate()

    // Stimme und VAD stecken in der Setup-Nachricht — die lässt sich nicht
    // nachträglich ändern, also bauen wir neu auf.
    if (needsReconnect && this.conn) {
      void this.connect(this.resumptionHandle)
    }
  }

  // ─────────────────────────────────────────────────────────
  // Zustand
  // ─────────────────────────────────────────────────────────

  private emit(state: LiveState): void {
    if (this.reportedState === state) return
    this.reportedState = state
    this.events.onStateChange(state)
  }

  /**
   * Ein einziger Ort, an dem der Zustand entsteht.
   *
   * Vorher setzte jede Quelle für sich: der Player meldete beim kleinsten
   * Puffer-Loch "spricht nicht mehr" und überschrieb damit das "denkt nach"
   * eines laufenden Werkzeugs. Der Kristall flackerte, und mit ihm ging das
   * Half-Duplex-Gate im Sekundentakt auf und zu.
   */
  private emitDerivedState(): void {
    if (this.stopped || !this.conn || this.conn.closing) return
    if (this.busyTools > 0) return this.emit('thinking')
    if (this.modelSpeaking) return this.emit('speaking')
    if (this.awaitingReply) return this.emit('thinking')
    this.emit('listening')
  }

  /** Nach kurzer Sprechpause gilt der Satz als fertig: „Denkt nach". */
  private expectReply(): void {
    if (this.replyTimer !== null) window.clearTimeout(this.replyTimer)
    this.awaitingReply = false
    this.replyTimer = window.setTimeout(() => {
      this.replyTimer = null
      if (this.modelSpeaking) return
      this.awaitingReply = true
      this.emitDerivedState()
      this.armReplyWatchdog()
    }, 650)
  }

  private clearAwaitingReply(): void {
    if (this.replyTimer !== null) window.clearTimeout(this.replyTimer)
    this.replyTimer = null
    if (this.replyWatchdog !== null) window.clearTimeout(this.replyWatchdog)
    this.replyWatchdog = null
    if (!this.awaitingReply) return
    this.awaitingReply = false
    this.emitDerivedState()
  }

  private armReplyWatchdog(): void {
    if (this.replyWatchdog !== null) window.clearTimeout(this.replyWatchdog)
    const owner = this.conn
    this.replyWatchdog = window.setTimeout(() => {
      this.replyWatchdog = null
      if (this.stopped || this.disposed || this.conn !== owner || this.busyTools > 0) return
      this.events.onError('James hat keine Antwort erhalten. Die Sprachverbindung wird neu aufgebaut. Bitte wiederhole deine Anfrage.')
      this.recoverConnection()
    }, REPLY_TIMEOUT_MS)
  }

  private recoverConnection(): void {
    const conn = this.conn
    if (conn) {
      conn.closing = true
      this.conn = null
      this.activeId = 0
      try { conn.session.close() } catch { /* Already closed. */ }
    }
    this.scheduleRetry()
  }

  private applyUploadGate(): void {
    const muted = !this.stopped && this.isConnected() && this.settings.audio.halfDuplex && this.modelSpeaking
    this.onUploadGate?.(muted)
  }

  // ─────────────────────────────────────────────────────────
  // Audio raus
  // ─────────────────────────────────────────────────────────

  private sendAudio(pcm: Int16Array): void {
    const conn = this.conn
    // Auch ein Sockel, der schon schließt, ist „keine Leitung": `this.conn` wird
    // erst im `onclose` frei, und bis dahin liefe jeder Block in den Fehler.
    // Der Satz geht stattdessen in den Puffer und mit dem Neuaufbau hinaus.
    if (!conn || conn.closing || !socketAcceptsData(conn.session)) {
      // Noch keine Leitung, aber eine im Kommen: aufheben statt wegwerfen.
      //
      // Bewusst nicht an `connecting` gebunden, sondern an „nicht angehalten".
      // Der Weg von `start()` bis zum eigentlichen `connect()` geht über den
      // Schlüssel aus dem Hauptprozess und den Aufbau der Tonausgabe, und die
      // lädt ein AudioWorklet — das sind noch einmal ein paar Zehntel, in
      // denen `connecting` schlicht falsch ist. Nach `stop()` steht `stopped`,
      // dann ist es Raumklang ohne Adressaten und wird verworfen.
      if (!this.stopped && !this.disposed) {
        this.pendingAudio.push(pcm)
        if (this.pendingAudio.length > LiveSession.PENDING_AUDIO_MAX_CHUNKS) {
          this.pendingAudio.shift()
        }
      }
      return
    }

    try {
      conn.session.sendRealtimeInput({
        audio: {
          data: int16ToBase64(pcm),
          mimeType: 'audio/pcm;rate=16000'
        }
      })
    } catch (err) {
      // Ein einzelner fehlgeschlagener Frame ist kein Grund für Alarm —
      // beim Umschwenken zwischen Verbindungen passiert das kurz.
      console.debug('[live] Audio-Frame verworfen:', err)
      if (!this.stopped && !this.disposed) {
        this.pendingAudio.push(pcm)
        if (this.pendingAudio.length > LiveSession.PENDING_AUDIO_MAX_CHUNKS) this.pendingAudio.shift()
        this.recoverConnection()
      }
    }
  }

  /**
   * Den Vorlauf nachschicken, sobald die Leitung steht.
   *
   * Erst leeren, dann senden: `sendAudio` würde sonst, wenn dabei etwas
   * schiefgeht, in denselben Puffer zurückschreiben, den wir gerade abarbeiten.
   */
  private flushPendingAudio(): void {
    if (this.pendingAudio.length === 0) return
    const queued = this.pendingAudio
    this.pendingAudio = []
    console.info(`[live] ${queued.length} Blöcke aus dem Verbindungsaufbau nachgereicht`)
    for (const chunk of queued) this.sendAudio(chunk)
  }

  /** Text als Nutzer-Turn einspeisen (Zeitplan, Preisalarm, Research-Ergebnis). */
  sendText(text: string): boolean {
    const conn = this.conn
    if (!conn || conn.closing || !socketAcceptsData(conn.session)) {
      this.events.onError('Die Sprachverbindung ist noch nicht bereit. Bitte versuche die Texteingabe erneut.')
      if (conn && !this.stopped && !this.disposed) this.recoverConnection()
      return false
    }
    try {
      conn.session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true
      })
    } catch (error) {
      console.warn('[live] Texteingabe konnte nicht gesendet werden:', error)
      this.events.onError('Die Texteingabe konnte nicht gesendet werden. Die Verbindung wird neu aufgebaut. Bitte wiederhole deine Anfrage.')
      this.recoverConnection()
      return false
    }
    this.clearAwaitingReply()
    this.awaitingReply = true
    this.suppressAudio = false
    this.armReplyWatchdog()
    this.emitDerivedState()
    this.lastActivity = Date.now()
    // Getipptes ist genauso ein Nutzerzug wie Gesprochenes. Ohne das prüfte
    // die Rückfrage ein getipptes „ja" gegen den letzten *gesprochenen* Satz
    // und lehnte ab — die Kaskade machte es schon immer so.
    this.lastUserText = text
    this.lastUserTextAt = Date.now()
    return true
  }

  // ─────────────────────────────────────────────────────────
  // Nachrichten rein
  // ─────────────────────────────────────────────────────────

  private handleOpen(id: number): void {
    // Der Rückruf feuert, bevor `live.connect` auflöst — die Nummer ist also
    // erst nach dem Umschwenken die gültige. Zurücksetzen kann er trotzdem.
    if (id !== this.activeId && id !== this.connSeq) return
    this.lastActivity = Date.now()
  }

  private handleError(id: number, err: { message?: string }): void {
    // Fehler eines bereits abgelösten Sockets sind Rauschen.
    if (id !== this.activeId) return
    console.error('[live] Socket-Fehler:', err)
    this.events.onError(this.friendlyError(err?.message ?? ''))
  }

  private handleMessage(id: number, message: LiveMessage): void {
    if (id !== this.activeId) return
    /*
     * Nicht jede Nachricht ist Aktivität.
     *
     * Bisher setzte jede eingehende Nachricht die Leerlaufuhr zurück — auch die
     * Verwaltungsmeldungen, die der Server laufend von selbst schickt
     * (Wiederaufnahme-Handles, Verbrauchsangaben). Die Sitzung schloss deshalb
     * nie wegen Stille, das Mikrofon lief stundenlang weiter, und jedes
     * Geräusch im Raum wurde zu einer bezahlten Runde mit dem ganzen Kontext.
     * Jetzt zählt nur, was nach Gespräch aussieht: Worte des Nutzers, Ton
     * oder Text des Modells, Werkzeugaufrufe.
     */
    const touch = (): void => {
      this.lastActivity = Date.now()
    }

    const usage = message.usageMetadata ?? message.usage_metadata
    const tokens = Number(usage?.totalTokenCount ?? usage?.total_token_count ?? 0)
    if (Number.isFinite(tokens) && tokens > 0) {
      this.sessionTokens += tokens
      this.sessionTurns++
    }
    /**
     * Erst jetzt gilt der Aufbau als geglückt.
     *
     * Vorher stand das Zurücksetzen direkt hinter `live.connect` — und das war
     * zu früh. Weist der Server die Konfiguration ab, tut er das erst, nachdem
     * der Sockel offen ist: Aufbau geglückt, Zähler auf null, Verbindung tot,
     * neuer Versuch. Daraus wurde eine Schleife ohne Ende, die sich weder
     * beschleunigte noch aufgab, weil jeder Durchlauf als Erfolg zählte.
     * Eine Nachricht dagegen bekommt nur, wer wirklich angenommen wurde.
     *
     * Eine einzelne Nachricht reicht aber auch nicht: Der Server nimmt die
     * Konfiguration an und kappt kurz darauf mit einem internen Fehler. Erst
     * eine Verbindung, die `STABLE_CONNECTION_MS` durchhält, setzt den Zähler
     * zurück — sonst bliebe der Rückzug für immer bei der ersten Stufe.
     */
    this.markStableIfOldEnough(this.conn)

    // Feldnamen kommen je nach SDK-Version in camelCase oder snake_case —
    // die Live API ist noch Preview. Beide Varianten akzeptieren.
    const content = message.serverContent ?? message.server_content
    const toolCall = message.toolCall ?? message.tool_call
    const cancellation = message.toolCallCancellation ?? message.tool_call_cancellation
    const resumption = message.sessionResumptionUpdate ?? message.session_resumption_update
    const goAway = message.goAway ?? message.go_away

    if (resumption) {
      const resumable = resumption.resumable ?? true
      const handle = resumption.newHandle ?? resumption.new_handle
      if (resumable && handle) this.resumptionHandle = handle
    }

    if (goAway) {
      // Der Server kündigt das Ende an. Sofort umschwenken statt abzuwarten.
      const timeLeftMs = parseDuration(goAway.timeLeft ?? goAway.time_left)
      console.info(`[live] goAway, Restzeit ${timeLeftMs} ms — baue neu auf`)
      void this.connect(this.resumptionHandle)
      return
    }

    if (content) {
      if (content.interrupted) {
        this.cancelRunningTools()
        this.clearAwaitingReply()
        // Barge-in. Der Puffer muss sofort weg, sonst redet er über dich hinweg.
        // Der Zug ist damit beendet, also fällt auch die Not-Aus-Sperre.
        this.stopSpeaking()
        this.suppressAudio = false
        this.applyUploadGate()
        this.emitDerivedState()
      }

      const modelTurn = content.modelTurn ?? content.model_turn
      if (modelTurn?.parts) touch()
      if (modelTurn?.parts && !this.suppressAudio) {
        for (const part of modelTurn.parts) {
          const inline = part.inlineData ?? part.inline_data
          if (inline?.data) {
            this.clearAwaitingReply()
            const pcm = base64ToInt16(inline.data)
            this.player?.push(pcm)
            this.onOutputAudio?.(pcm)
          }

        }
      }

      const inputTx = content.inputTranscription ?? content.input_transcription
      // Ein Klicken oder Rauschen kommt als Transkript ohne Wort an, oft nur
      // als Satzzeichen. Das hält die Sitzung nicht offen.
      if (inputTx?.text && /\p{L}{2,}/u.test(inputTx.text)) touch()
      if (inputTx?.text) {
        // Der Nutzer redet wieder — was auch immer vorher lief, ist vorbei.
        // Zugleich die Sicherung gegen eine Sperre, die hängen bleibt, weil
        // das `turnComplete` des abgewürgten Zuges nie ankam.
        this.suppressAudio = false
        // Für die Bestätigungsprüfung im Main-Prozess: es muss nachweisbar
        // sein, dass der Nutzer nach der Rückfrage tatsächlich geantwortet hat.
        this.lastUserText = inputTx.text
        this.lastUserTextAt = Date.now()
        this.events.onUserTranscript(inputTx.text)
        if (/\p{L}{2,}/u.test(inputTx.text)) this.expectReply()
      }

      const outputTx = content.outputTranscription ?? content.output_transcription
      if (outputTx?.text) {
        touch()
        this.events.onModelTranscript(outputTx.text)
        this.clearAwaitingReply()
      }

      const turnComplete = content.turnComplete ?? content.turn_complete
      if (turnComplete) {
        // Ab dem Ende der Antwort zählt die Stille.
        touch()
        this.suppressAudio = false
        this.clearAwaitingReply()
        this.emitDerivedState()
      }
    }

    if (cancellation?.ids) {
      // Das Modell hat die Aufgabe verworfen — laufende Tools interessieren
      // niemanden mehr, aber wir dürfen keine Antwort mehr schicken.
      for (const id of cancellation.ids) {
        this.cancelledToolCalls.add(id)
        this.toolAborts.get(id)?.abort()
        void window.jarvis.invoke('tools:cancel', { id }).catch(() => {})
      }
    }

    if (toolCall) {
      touch()
      const calls = toolCall.functionCalls ?? toolCall.function_calls ?? []
      void this.handleToolCalls(calls)
    }
  }

  private cancelledToolCalls = new Set<string>()
  private activeTools = new Set<string>()
  private toolAborts = new Map<string, AbortController>()
  private cancelRunningTools(): void {
    for (const id of this.activeTools) {
      this.cancelledToolCalls.add(id)
      this.toolAborts.get(id)?.abort()
      void window.jarvis.invoke('tools:cancel', { id }).catch(() => {})
    }
    this.activeTools.clear()
  }
  private lastUserText = ''
  private lastUserTextAt = 0

  private async handleToolCalls(
    calls: { id: string; name: string; args?: Record<string, unknown> }[]
  ): Promise<void> {
    if (calls.length === 0) return
    const owner = this.conn

    this.clearAwaitingReply()

    this.busyTools += calls.length
    this.emitDerivedState()

    // Schnappschuss vor der Ausführung: sonst könnte ein Transkript, das
    // während des Tool-Laufs eintrudelt, eine Bestätigung nachträglich decken.
    const userTurn = { lastUserText: this.lastUserText, lastUserTextAt: this.lastUserTextAt }

    let results: { call: (typeof calls)[number]; result: ToolCallResult }[] = []
    try {
      // Parallel ausführen: ein Preisvergleich über vier Shops soll nicht
      // viermal nacheinander laufen.
      results = await Promise.all(
        calls.map(async (call) => {
          this.activeTools.add(call.id)
          const abort = new AbortController()
          this.toolAborts.set(call.id, abort)
          try {
            const result: ToolCallResult = await abortable(window.jarvis.invoke('tools:call', {
              id: call.id,
              name: call.name,
              args: call.args ?? {},
              userTurn,
              budgetId: `live-${this.lastUserTextAt}`
            }), AbortSignal.any([abort.signal, AbortSignal.timeout(180_000)]))
            return { call, result }
          } catch (error) {
            void window.jarvis.invoke('tools:cancel', { id: call.id }).catch(() => {})
            return { call, result: { ok: false, error: error instanceof Error ? error.message : String(error) } as ToolCallResult }
          } finally {
            if (this.toolAborts.get(call.id) === abort) {
              this.activeTools.delete(call.id)
              this.toolAborts.delete(call.id)
            }
          }
        })
      )
    } finally {
      if (this.conn === owner) {
        this.busyTools = Math.max(0, this.busyTools - calls.length)
        this.emitDerivedState()
      }
    }

    const conn = this.conn
    if (!conn || conn !== owner || conn.closing) return

    const responses = results
      .filter(({ call }) => !this.cancelledToolCalls.has(call.id))
      .map(({ call, result }) => ({
        id: call.id,
        name: call.name,
        // Fehler gehören als Inhalt in die Antwort, nicht als Protokollfehler:
        // sonst wartet das Modell ewig oder halluziniert ein Ergebnis.
        response: result.ok
          ? { output: result.result ?? 'Erledigt.' }
          : { error: result.error ?? 'Unbekannter Fehler.' }
      }))

    for (const { call } of results) this.cancelledToolCalls.delete(call.id)
    if (responses.length === 0) return

    // Der Sockel kann während des Werkzeuglaufs gekippt sein, ohne dass `onclose`
    // schon da war. Die Antwort wäre ohnehin verloren — nur ohne Konsolenfehler.
    if (!socketAcceptsData(conn.session)) {
      console.info('[live] Tool-Antwort verworfen: Verbindung ist schon zu')
      this.events.onError('Das Werkzeugergebnis konnte nicht übermittelt werden. Die Verbindung wird neu aufgebaut. Bitte wiederhole deine Anfrage.')
      this.recoverConnection()
      return
    }

    try {
      conn.session.sendToolResponse({ functionResponses: responses })
      this.awaitingReply = true
      this.armReplyWatchdog()
      this.emitDerivedState()
    } catch (err) {
      console.error('[live] Tool-Antwort konnte nicht gesendet werden:', err)
      this.events.onError('Das Werkzeugergebnis konnte nicht übermittelt werden. Die Verbindung wird neu aufgebaut. Bitte wiederhole deine Anfrage.')
      this.recoverConnection()
    }
  }

  private handleClose(id: number, event: { reason?: string }): void {
    // Zugegangen, bevor das Einrichten fertig war: `live.connect` käme nie zurück
    // (siehe `awaitConnect`). Der Grund geht dorthin und von da in den Aufbau-Fehler —
    // samt Kontingent- und Modellprüfung, die sonst nie davon erführe.
    if (this.pendingConnect?.id === id) {
      this.pendingConnect.fail(new Error(event?.reason || 'Verbindung beim Aufbau geschlossen'))
      return
    }

    // Der planmäßig abgelöste Socket meldet sich ab. Für die App ist das ein
    // Nicht-Ereignis — die Nachfolgeverbindung läuft längst. Genau hier lag
    // der Fehler: ohne Nummernprüfung riss dieser Rückruf die frisch
    // aufgebaute Verbindung mit ins Grab.
    if (id !== this.activeId) return

    const conn = this.conn
    if (conn && conn.id === id) {
      if (conn.closing) return
      this.conn = null
    }

    // Eine Verbindung, die lange genug hielt, war ein Erfolg — der nächste
    // Versuch fängt wieder bei der kürzesten Wartezeit an. Eine, die nach
    // Sekunden stirbt, zählt weiter hoch (siehe `STABLE_CONNECTION_MS`).
    this.markStableIfOldEnough(conn)

    this.clearTimers()
    this.cancelRunningTools()
    this.busyTools = 0
    this.stopSpeaking()
    this.clearAwaitingReply()
    this.applyUploadGate()

    if (this.disposed || this.stopped) {
      this.events.onClosed()
      return
    }

    const reason = event?.reason ?? ''
    console.warn('[live] Verbindung getrennt:', reason)

    /**
     * Absagen an der Konfiguration wiederholen sich beliebig oft mit demselben
     * Ergebnis — ein Neuversuch wäre nur eine Schleife mit Wartezeit.
     *
     * Sie kommen erst, wenn der Sockel schon offen ist: Der Aufbau glückt, die
     * Verbindung stirbt, und ohne diese Unterscheidung sähe das aus wie ein
     * Netzfehler. Genau daran hing eine Schleife ohne Ende.
     */
    if (this.handleQuota(reason)) return

    if (/not supported|invalid argument|not found|modalit/i.test(reason)) {
      this.stopped = true
      this.events.onError(this.friendlyError(reason))
      this.emit('idle')
      return
    }

    this.scheduleRetry()
  }

  // ─────────────────────────────────────────────────────────
  // Zeitsteuerung
  // ─────────────────────────────────────────────────────────

  /**
   * Vorzeitiger Neuaufbau, bevor die API bei 15 Minuten kappt.
   * `goAway` kommt normalerweise vorher — das hier ist die Rückfallebene für
   * den Fall, dass die Ankündigung ausbleibt.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer)
    const delay = LIVE_LIMITS.AUDIO_SESSION_MAX_MS - LIVE_LIMITS.RECONNECT_LEAD_MS
    this.reconnectTimer = window.setTimeout(() => {
      if (this.conn && !this.conn.closing) void this.connect(this.resumptionHandle)
    }, delay)
  }

  /** Nach längerer Stille trennen — Live-Audio wird pro Sekunde abgerechnet. */
  private scheduleIdleCheck(): void {
    if (this.idleTimer) window.clearInterval(this.idleTimer)
    this.idleTimer = window.setInterval(() => {
      const idleSec = (Date.now() - this.lastActivity) / 1000
      const limit = this.settings.wake.idleDisconnectSec
      const busy = this.modelSpeaking || this.busyTools > 0 || this.awaitingReply
      if (limit > 0 && idleSec > limit && !busy) {
        console.info('[live] Sitzung wegen Stille geschlossen')
        void this.stop()
      }
    }, 5000)
  }

  /** Setzt den Wiederholungszähler zurück, wenn die Verbindung lange genug gehalten hat. */
  private markStableIfOldEnough(conn: ActiveConnection | null): void {
    if (conn && Date.now() - conn.openedAt >= STABLE_CONNECTION_MS) this.reconnectAttempts = 0
  }

  private scheduleRetry(): void {
    if (this.disposed || this.stopped) return
    this.clearTimers()
    this.cancelRunningTools()
    this.busyTools = 0
    this.stopSpeaking()
    this.clearAwaitingReply()
    this.applyUploadGate()
    this.emit('connecting')
    this.reconnectAttempts++
    if (this.reconnectAttempts > 6) {
      this.stopped = true
      this.events.onError('Die Verbindung lässt sich gerade nicht aufbauen.')
      useCrystal.getState().setWish('network', 'offline')
      this.emit('idle')
      return
    }
    // Exponentiell mit Deckel — bei Netzwechsel (WLAN → LAN) fängt sich das
    // von selbst, bei echtem Ausfall hämmern wir nicht dagegen.
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 20_000)
    if (this.retryTimer) window.clearTimeout(this.retryTimer)
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null
      if (!this.disposed && !this.stopped) void this.connect(this.resumptionHandle)
    }, delay)
  }

  private clearTimers(): void {
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer)
    if (this.idleTimer) window.clearInterval(this.idleTimer)
    if (this.retryTimer) window.clearTimeout(this.retryTimer)
    this.reconnectTimer = null
    this.idleTimer = null
    this.retryTimer = null
  }

  /** Rohe API-Fehler sind zum Vorlesen ungeeignet. */
  /** Das andere Live-Modell, falls das eingestellte kein Kontingent mehr hat. */
  private static readonly LIVE_FALLBACK: Record<string, string> = {
    'gemini-3.8-live': 'gemini-2.5-flash-native-audio-preview-12-2025',
    'gemini-3.1-flash-live-preview': 'gemini-3.8-live',
    'gemini-2.5-flash-native-audio-preview-12-2025': 'gemini-3.8-live'
  }

  /**
   * Leeres Kontingent: wechseln oder aufhören — aber nicht sechsmal dagegen
   * anrennen. Jeder Neuversuch wäre eine weitere abgewiesene Anfrage.
   */
  private handleQuota(raw: string): boolean {
    const lower = raw.toLowerCase()
    if (!(lower.includes('quota') || lower.includes('429') || lower.includes('resource_exhausted') || lower.includes('404') || lower.includes('not found') || lower.includes('not supported'))) return false
    if (this.switchModelOnQuota(raw)) {
      // Das Wiederaufnahme-Handle gehört zum alten Modell.
      this.resumptionHandle = null
      setTimeout(() => {
        if (!this.disposed && !this.stopped) void this.connect(null)
      }, 0)
      return true
    }
    this.stopped = true
    this.events.onError(this.friendlyError(raw))
    this.emit('idle')
    return true
  }

  private liveModel(): string {
    return this.activeModel ?? this.settings.liveModel
  }

  /**
   * Bei leerem Kontingent einmal aufs andere Live-Modell wechseln.
   *
   * Gibt `true` zurück, wenn gewechselt wurde — dann baut der Aufrufer neu
   * auf, statt dem Nutzer „Kontingent aufgebraucht" zu sagen. Ein zweites Mal
   * wird nicht gewechselt: Ist auch das andere leer, hilft nur Warten.
   */
  private switchModelOnQuota(raw: string): boolean {
    const lower = raw.toLowerCase()
    if (!(lower.includes('quota') || lower.includes('429') || lower.includes('resource_exhausted') || lower.includes('404') || lower.includes('not found') || lower.includes('not supported'))) return false
    if (this.activeModel !== null) return false
    const next = LiveSession.LIVE_FALLBACK[this.settings.liveModel]
    if (!next) return false
    console.warn(`[live] ${this.settings.liveModel} nicht verfügbar, wechsle auf ${next}`)
    this.activeModel = next
    return true
  }

  private friendlyError(raw: string): string {
    const lower = raw.toLowerCase()
    if (lower.includes('api key') || lower.includes('unauthenticated') || lower.includes('401')) {
      return 'Der Gemini Zugang wird nicht akzeptiert. Prüf den Schlüssel in den Einstellungen.'
    }
    if (lower.includes('quota') || lower.includes('429') || lower.includes('resource_exhausted')) {
      // Google setzt Tageslimits um Mitternacht in Kalifornien zurück, bei uns um 9 Uhr früh.
      return 'Das Gemini-Kontingent ist bei beiden Sprachmodellen aufgebraucht. Ist es das Tageslimit, geht es ab 9 Uhr früh wieder.'
    }
    if (lower.includes('not found') || lower.includes('404')) {
      return 'Das eingestellte Modell gibt es nicht. Wähl in den Einstellungen ein anderes.'
    }
    if (lower.includes('network') || lower.includes('econn') || lower.includes('enotfound')) {
      return 'Ich komme gerade nicht ins Netz.'
    }
    return 'Da ist etwas schiefgegangen bei der Verbindung.'
  }
}

// ─────────────────────────────────────────────────────────────
// Base64 ohne Umweg über Strings pro Sample
// ─────────────────────────────────────────────────────────────

function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  // In Blöcken, weil String.fromCharCode bei sehr großen Arrays den Stack sprengt.
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function base64ToInt16(base64: string): Int16Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  // Ungerade Byte-Länge wäre ein kaputter Frame — lieber abschneiden als werfen.
  const usable = bytes.byteLength - (bytes.byteLength % 2)
  return new Int16Array(bytes.buffer, 0, usable / 2)
}

/** Protobuf-Dauer ("12.5s") oder Millisekunden-Zahl. */
function parseDuration(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const match = value.match(/^([\d.]+)s$/)
    if (match) return Math.round(parseFloat(match[1]) * 1000)
    const num = Number(value)
    if (!Number.isNaN(num)) return num
  }
  return 0
}
