import type { CrystalState, Settings } from '@shared/types'
import { COST_ESTIMATES } from '@shared/config/defaults'
import { describeError } from '@shared/errorText'
import { startCapture, type CaptureHandle } from '../audio/capture'
import { BargeInDetector } from '@shared/audio/bargeIn'
import { ClapDetector } from '@shared/audio/clap'
import { createWakeWord, type WakeWordHandle } from '../wake/wakeword'
import { LiveSession } from './LiveSession'
import { CascadeSession } from './CascadeSession'
import { RealtimeSession } from './RealtimeSession'
import type { VoiceEngine, VoiceEngineEvents } from './engine'
import { TurnGapWatcher } from './turnGaps'
import { amplitude, useCrystal } from '../store/crystalStore'

/**
 * Bindeglied zwischen Mikrofon, Wake-Word, Live-Sitzung und Kristall.
 *
 * Die Aufnahme läuft dauerhaft, die Sitzung nicht. Das ist der Kern der
 * Kostenkontrolle: Live-Audio wird pro Sekunde abgerechnet, das Wake-Word
 * läuft lokal und gratis. Erst wenn "Hey James" fällt, ein Hotkey kommt oder
 * der Kristall angeklickt wird, geht eine Verbindung auf — und nach
 * eingestellter Stille wieder zu.
 *
 * Dazu kommt die Pause: ein Druck auf den Kristall legt ihn still. Dann ist
 * nicht nur die Sitzung zu, sondern auch das Weckwort taub — er kann sich
 * also nicht selbst wieder einschalten.
 */

/**
 * 20-ms-Blöcke; fünfzehn davon sind 300 ms Vorlauf.
 *
 * Mehr als früher, weil das Gatter jetzt erst nach `ONSET_CHUNKS` lauten
 * Blöcken öffnet — der Sprechbeginn liegt dann schon im Vorlauf.
 */
const PREROLL_CHUNKS = 15

/**
 * So viele laute Blöcke am Stück, bevor hochgeladen wird: 60 ms.
 *
 * Ein Tastenanschlag, ein Mausklick, ein Glas auf dem Tisch ist kürzer. Jedes
 * davon öffnete bisher das Gatter, die Sprechpausenerkennung des Servers
 * sprang darauf an, und das Modell antwortete auf ein Geräusch — eine
 * bezahlte Runde mit dem ganzen Gesprächskontext.
 */
const ONSET_CHUNKS = 3

/**
 * Abstand zur gemessenen Raumruhe, auf der Skala von `chunkLevel`.
 *
 * Die feste Schwelle allein reicht nicht: Der Pegel ist stark gestaucht
 * (vierte Wurzel der Leistung), und mit automatischer Verstärkung landet ein
 * Lüfter oder ein laufendes Spiel schon über 0,15. Sprache liegt deutlich
 * darüber, deshalb wird die Schwelle über dem Grundrauschen mitgeführt.
 */
const NOISE_MARGIN = 0.12
/**
 * So lange nach der letzten Sprache wird weiter hochgeladen.
 *
 * Nicht bloß Höflichkeit gegenüber Nachsilben: die serverseitige
 * Sprechpausenerkennung braucht echte Stille im Strom, um den Zug zu beenden.
 * Wer den Upload sofort abwürgt, wartet ewig auf eine Antwort.
 */
const GATE_HANGOVER_EXTRA_MS = 400

/**
 * So lange darf vom Telefon nichts kommen, bevor die Sprechtaste als
 * losgelassen gilt.
 *
 * Solange sie gehalten wird, trudelt alle 20 ms ein Block ein — auch wenn
 * niemand redet, denn Stille ist auch Ton. Bleibt der Nachschub aus, ist nicht
 * der Sprecher verstummt, sondern die Leitung weg. Ohne diese Sicherung blieb
 * `remoteMicOpen` danach für immer stehen, und weil der Rechner dem Telefon den
 * Vortritt lässt, war das eigene Mikrofon ab da taub: James reagierte auf
 * nichts mehr, bis die App neu startete. Das ist die "verbuggte Stimme".
 */
const REMOTE_SILENCE_MS = 2_500

export class JarvisController {
  private capture: CaptureHandle | null = null
  private captureStarting: Promise<void> | null = null
  /** Der Grund des letzten gescheiterten Mikrofonstarts; leer, solange es läuft. */
  private lastMicFailure = ''
  private disposed = false
  private captureGeneration = 0
  private wake: WakeWordHandle | null = null
  private readonly clap = new ClapDetector(() => {
    if (!this.settings.wake.clap || this.session?.isConnected() || this.session?.isStarting()) return
    console.info('[wake] zweimal geklatscht')
    void this.wakeUp()
  })
  private session: VoiceEngine | null = null
  /**
   * Der ElevenLabs-Weg ist für diesen Programmlauf aufgegeben.
   *
   * Gesetzt, wenn der zusammengesetzte Motor meldet, dass er nicht mehr kann —
   * kein Kontingent, kein Schlüssel. Ohne dieses Merkzeichen würde beim nächsten
   * Wecken wieder er gebaut, wieder scheitern und wieder abgelöst: eine Schleife
   * mit Wartezeit statt einer Antwort.
   */
  private cascadeGivenUp = false
  private settings: Settings
  private uploadMuted = false
  private starting = false
  private sessionStarting: Promise<void> | null = null
  private sessionGeneration = 0
  private paused = false
  private pauseRevision = 0
  /** Solange die Sprechtaste am Telefon gehalten wird. */
  private remoteMicOpen = false
  private remoteMicGeneration = 0
  private remoteSeenAt = 0
  private remoteWatchdog: number | null = null
  /** Zeitpunkt des selbsttätigen Aufwachens; `null` heißt unbefristet. */
  private pauseUntil: number | null = null

  /** Ringpuffer der letzten Blöcke, damit die erste Silbe nicht fehlt. */
  private preroll: Int16Array[] = []
  private speakingUntil = 0
  private skippedSamples = 0
  /** Geschätzte Raumruhe, nachgeführt in den stillen Blöcken. */
  private noiseFloor = 0.08
  /** Wie viele laute Blöcke gerade am Stück kamen. */
  private loudRun = 0
  private bargeIn = new BargeInDetector()
  private reportTimer: number | null = null
  /**
   * Züge, in denen James ablehnt („das kann ich nicht“). Gemeldet wird an den
   * Hauptprozess; ob daraus ein Bericht wird, entscheiden dort die Einstellungen.
   */
  private readonly gaps = new TurnGapWatcher({
    report: (turn) => { void window.jarvis.invoke('gaps:turn', turn).catch(() => {}) },
    completed: (turn) => { void window.jarvis.invoke('context:turn', { request: turn.request, answer: turn.answer }).catch(() => {}) }
  })

  private readonly onDeviceChange = (): void => {
    if (this.capture) return
    void this.startCapture()
  }

  private readonly onNetworkChange = (): void => {
    if (!this.disposed) this.setWish('network', navigator.onLine ? null : 'offline')
  }

  /** Wird von außen gesetzt, damit Startseite und Tray dasselbe anzeigen. */
  public onPauseChange: ((paused: boolean, until: number | null) => void) | null = null

  /** Abzweig der Sprachausgabe an das Telefon, falls eines hängt. */
  public onOutputAudio: ((pcm: Int16Array) => void) | null = null

  constructor(settings: Settings) {
    this.settings = settings
  }

  async init(): Promise<void> {
    const wake = await createWakeWord({
      threshold: this.settings.wake.threshold,
      modelName: this.settings.wake.modelName,
      enabled: this.settings.wake.enabled,
      onDetected: (score) => {
        console.info(`[wake] erkannt (${score.toFixed(2)})`)
        void this.wakeUp()
      }
    })
    if (this.disposed) { wake.destroy(); return }
    this.wake = wake
    this.wake.setEnabled(this.settings.wake.enabled && !this.paused)
    useCrystal.getState().setWakeAvailable(this.wake.available)

    await this.startCapture()
    if (this.disposed) return
    this.watchMicrophone()
    this.watchNetwork()
    this.startSavingsReport()
  }

  private async startCapture(): Promise<void> {
    if (this.capture || this.paused || this.disposed) return
    if (this.captureStarting) return this.captureStarting
    const generation = this.captureGeneration
    this.captureStarting = this.openCapture(generation).finally(() => { this.captureStarting = null })
    return this.captureStarting
  }

  private async openCapture(generation: number): Promise<void> {
    try {
      const capture = await startCapture({
        settings: this.settings.audio,
        onChunk: (pcm) => this.onChunk(pcm)
      })
      if (this.paused || this.disposed || generation !== this.captureGeneration) {
        await capture.stop()
        return
      }
      this.capture = capture
      this.lastMicFailure = ''
      // Nach einem geglückten Anlauf steht keine Mikrofonmeldung mehr an.
      useCrystal.getState().setError(null)
    } catch (err) {
      // Name und Text zusammen: getUserMedia wirft DOMExceptions mit leerer
      // `message`, und das Protokoll zeigte dann nur „Mikrofon nicht verfügbar:“.
      const message = describeError(err, 'ohne Angabe vom Browser')
      // Jeder Gerätewechsel startet die Aufnahme neu (siehe `onDeviceChange`).
      // Derselbe Grund steht dafür nur einmal als Fehler im Protokoll — das
      // Selbstheilungsprotokoll zählt jede Fehlerzeile als neue Störung.
      const repeated = message === this.lastMicFailure
      this.lastMicFailure = message
      if (repeated) console.info('[controller] Mikrofon weiterhin nicht verfügbar:', message)
      else console.error('[controller] Mikrofon nicht verfügbar:', message)
      useCrystal.getState().setError(
        message.includes('NotAllowedError') || message.includes('Permission')
          ? 'Windows verweigert den Mikrofonzugriff. Unter Datenschutz → Mikrofon den Zugriff für Desktop-Apps erlauben.'
          : message.includes('NotFoundError')
            ? 'Windows meldet kein nutzbares Mikrofon. Mikrofon anschließen und unter Audio ein Eingabegerät wählen; beim Erkennen eines Geräts startet die Aufnahme erneut.'
            : `Mikrofonaufnahme fehlgeschlagen: ${message}`
      )
    }
  }

  /**
   * Nimmt das Mikrofon auch dann, wenn es erst später auftaucht.
   *
   * Ohne das bleibt James nach einem Fehlstart taub, bis die App neu startet —
   * und der Fehlstart ist der Normalfall: Läuft er beim Anmelden mit, steckt
   * das Headset oft noch nicht, und Windows meldet dann "Requested device not
   * found". Danach wäre der Kristall zwar wach, hörte aber nie etwas.
   */
  private watchMicrophone(): void {
    navigator.mediaDevices?.addEventListener('devicechange', this.onDeviceChange)
  }

  /**
   * Der einzige Pfad, auf dem Mikrofonton weiterläuft.
   *
   * Das Wake-Word bekommt immer alles — auch während einer laufenden Sitzung,
   * damit ein erneutes "Hey James" ihn unterbrechen kann. Hochgeladen wird
   * dagegen nur, was nach Sprache klingt.
   */
  private onChunk(pcm: Int16Array): void {
    if (this.paused) return

    this.wake?.feed(pcm)
    if (this.settings.wake.clap && !this.session?.isConnected() && !this.session?.isStarting()) this.clap.feed(pcm)

    // `isAcceptingAudio` statt `isConnected`: Während des Aufbaus nimmt die
    // Sitzung den Ton entgegen und hebt ihn auf. Genau der Satz, den man nach
    // dem Weckwort sagt, fällt sonst in diese Lücke — siehe `pendingAudio`
    // in LiveSession.
    const session = this.session
    if (!session?.isAcceptingAudio()) return

    // Redet gerade jemand ins Telefon, hat das Vorrang. Beide Mikrofone
    // gleichzeitig hochzuladen hieße, den leeren Raum am Rechner unter die
    // Stimme zu mischen — und der Sinn der Fernbedienung ist ja gerade, dass
    // dort niemand steht.
    if (this.remoteMicOpen) return

    // Listen locally for an interruption even while half-duplex blocks upload.
    if (this.uploadMuted) {
      const threshold = Math.max(this.settings.vad.localGateThreshold, this.noiseFloor + NOISE_MARGIN) * 1.6
      const speech = this.bargeIn.feed(pcm, chunkLevel(pcm), threshold)
      if (speech) {
        session.interrupt()
        this.uploadMuted = false
        this.preroll.length = 0
        this.speakingUntil = Date.now() + this.settings.vad.silenceDurationMs + GATE_HANGOVER_EXTRA_MS
        for (const frame of speech) session.pushAudio(frame)
      }
      return
    }
    this.bargeIn.reset()

    if (!this.settings.vad.localGateEnabled) {
      session.pushAudio(pcm)
      return
    }

    const now = Date.now()
    const level = chunkLevel(pcm)

    const open = now < this.speakingUntil
    const threshold = Math.max(this.settings.vad.localGateThreshold, this.noiseFloor + NOISE_MARGIN)
    const loud = level >= threshold
    this.loudRun = loud ? this.loudRun + 1 : 0
    // Raumruhe nur bei geschlossenem Gatter lernen: nach unten schnell, nach
    // oben langsam (rund zwei Sekunden). So folgt sie einem Lüfter, der
    // anläuft, aber kein Satzanfang schiebt die Schwelle hoch. Gedeckelt,
    // damit normale Sprache auch in lauter Umgebung noch durchkommt.
    if (!open) {
      const rate = level < this.noiseFloor ? 0.1 : 0.01
      this.noiseFloor = Math.min(0.4, this.noiseFloor + (level - this.noiseFloor) * rate)
    }

    if (loud && (open || this.loudRun >= ONSET_CHUNKS)) {
      this.speakingUntil = now + this.settings.vad.silenceDurationMs + GATE_HANGOVER_EXTRA_MS
      // Vorlauf zuerst, sonst fehlt dem Modell der Sprechbeginn.
      for (const earlier of this.preroll) session.pushAudio(earlier)
      this.preroll.length = 0
      session.pushAudio(pcm)
      return
    }

    if (open) {
      session.pushAudio(pcm)
      return
    }

    this.skippedSamples += pcm.length
    this.preroll.push(pcm)
    if (this.preroll.length > PREROLL_CHUNKS) this.preroll.shift()
  }

  /** Sitzung öffnen — oder, wenn sie schon läuft, die Ausgabe abbrechen. */
  async wakeUp(): Promise<void> {
    if (this.paused || this.disposed) return
    if (this.sessionStarting) return this.sessionStarting

    if (this.session?.isConnected()) {
      // Zweites "Hey James" während er redet: als Unterbrechung werten.
      this.session.interrupt()
      this.setWish('session', 'listening')
      return
    }

    this.starting = true
    if (!this.session) this.session = this.buildSession()
    const session = this.session
    const pending = Promise.resolve().then(() => {
      if (!this.paused && !this.disposed && this.session === session && this.sessionStarting === pending) return session.start()
    }).catch((error) => {
      if (!this.paused && !this.disposed && this.session === session) {
        useCrystal.getState().setError(describeError(error, 'Die Verbindung konnte nicht gestartet werden.'))
        this.setWish('session', null)
      }
    }).finally(() => {
      if (this.sessionStarting === pending) {
        this.sessionStarting = null
        this.starting = false
      }
    })
    this.sessionStarting = pending
    return pending
  }

  async sleep(): Promise<void> {
    this.sessionStarting = null
    this.starting = false
    this.clap.reset()
    this.setWish('session', null)
    await this.session?.stop()
  }

  // ─────────────────────────────────────────────────────────
  // Pause
  // ─────────────────────────────────────────────────────────

  isPaused(): boolean {
    return this.paused
  }

  /**
   * Der Kristallklick.
   *
   * Ein Druck heißt "ansprechen", der nächste "sei still". Läuft gerade
   * nichts, weckt er ihn; läuft etwas, legt er ihn still; ist er still,
   * holt er ihn zurück und öffnet gleich die Sitzung — sonst müsste man
   * zweimal klicken, um wieder reden zu können.
   */
  async pressCrystal(): Promise<void> {
    if (this.paused) {
      await this.setPaused(false)
      await this.wakeUp()
      return
    }

    const busy = this.session?.isConnected() || this.session?.isStarting() || this.starting
    if (busy) {
      await this.setPaused(true)
      return
    }

    await this.wakeUp()
  }

  async togglePause(): Promise<void> {
    await this.setPaused(!this.paused)
  }

  /**
   * `until` ist der Zeitpunkt, zu dem er von selbst zurückkommt — gesetzt nur
   * vom Werkzeug `jarvis_quiet`, alles andere legt ihn unbefristet still.
   * Gewartet wird darauf im Hauptprozess: Hier ist ja gerade das, was still
   * ist. Der Zeitpunkt steht trotzdem auch hier, damit die Startseite sagen
   * kann, wie lange noch.
   */
  async setPaused(paused: boolean, until: number | null = null): Promise<void> {
    const next = paused ? until : null
    if (this.paused === paused && this.pauseUntil === next) return

    const changed = this.paused !== paused
    const revision = ++this.pauseRevision
    this.paused = paused
    this.pauseUntil = next

    if (changed && paused) {
      this.sessionStarting = null
      this.starting = false
      this.clap.reset()
      this.captureGeneration++
      // Weckwort taub schalten, sonst weckt ihn das nächste Wort im Raum
      // wieder auf — und der Klick hätte nichts bewirkt.
      this.wake?.setEnabled(false)
      this.uploadMuted = false
      this.preroll.length = 0
      amplitude.input = 0
      const capture = this.capture
      this.capture = null
      await Promise.all([capture?.stop(), this.session?.stop()])
      if (this.disposed || revision !== this.pauseRevision) return
      this.setWish('session', null)
      this.setWish('pause', 'paused')
    } else if (changed) {
      // Eine ausstehende Windows-Mikrofonfreigabe darf Texteingaben nicht blockieren.
      void (async () => {
        await this.captureStarting
        await this.startCapture()
      })()
      this.wake?.setEnabled(this.settings.wake.enabled)
      this.setWish('pause', null)
    }

    if (this.disposed || revision !== this.pauseRevision) return
    this.onPauseChange?.(paused, next)
    void window.jarvis.invoke('app:pauseState', { paused, until: next }).catch(() => undefined)
  }

  // ─────────────────────────────────────────────────────────
  // Das Telefon
  // ─────────────────────────────────────────────────────────

  /**
   * Die Sprechtaste auf dem Telefon ist gedrückt worden.
   *
   * Sie ersetzt dort das Weckwort — iOS lässt nichts dauerhaft mithören —, und
   * damit ersetzt sie auch das lokale Sprachgatter: Was gedrückt gehalten wird,
   * ist ausdrücklich gemeint und geht ungefiltert hoch.
   */
  async setRemoteMic(on: boolean): Promise<void> {
    const generation = ++this.remoteMicGeneration
    if (this.disposed) return
    if (on) {
      if (this.paused) {
        // Ein Druck aufs Telefon holt ihn zurück. Sonst müsste man erst
        // aufwecken und dann noch einmal drücken, und der erste Satz wäre weg.
        //
        // Nur beim Drücken, nicht beim Loslassen: Das Loslassen kommt neuerdings
        // auch von der Wache und vom Abriss der Verbindung, und ein Telefon, das
        // aus dem Funkloch fällt, darf ihn nicht aus der Stilllegung holen.
        await this.setPaused(false)
      }
      if (generation !== this.remoteMicGeneration || this.disposed) return
      this.remoteMicOpen = true
      this.remoteSeenAt = Date.now()
      this.preroll.length = 0
      this.startRemoteWatchdog()
      if (!this.session?.isConnected()) {
        await this.wakeUp()
        await this.waitForConnection(6000)
      }
      return
    }

    this.stopRemoteWatchdog()
    if (!this.remoteMicOpen) return
    this.remoteMicOpen = false
    this.sendTrailingSilence()
  }

  /** Ein Tonblock vom Telefon. Format und Rate sind dieselben wie am Rechner. */
  pushRemoteAudio(pcm: Int16Array): void {
    if (this.paused || !this.remoteMicOpen) return
    // Auch ein Block voller Stille zählt als Lebenszeichen — gemeint ist das
    // Eintreffen, nicht der Inhalt.
    this.remoteSeenAt = Date.now()

    // Dieselbe Lücke wie am Rechner, nur schlimmer: Am Telefon ersetzt die
    // Sprechtaste das Weckwort, man drückt und redet sofort los — und der
    // Verbindungsaufbau läuft genau dann. Aufgehoben wird das eine Etage
    // tiefer: `isAcceptingAudio` gilt schon während des Aufbaus, und die
    // Sitzung reicht nach, was dabei ankam (siehe `LiveSession.pendingAudio`).
    if (!this.session?.isAcceptingAudio()) return
    this.session.pushAudio(pcm)
  }

  /**
   * Die Wache über die Sprechtaste.
   *
   * Sie läuft nur, solange die Taste gilt — ein Zeitgeber, der immer liefe,
   * wäre für einen Fall gedacht, den es dann gar nicht gibt.
   */
  private startRemoteWatchdog(): void {
    if (this.remoteWatchdog !== null) return
    this.remoteWatchdog = window.setInterval(() => {
      if (!this.remoteMicOpen) {
        this.stopRemoteWatchdog()
        return
      }
      if (Date.now() - this.remoteSeenAt <= REMOTE_SILENCE_MS) return
      console.warn('[controller] Kein Ton mehr vom Telefon — Sprechtaste gilt als losgelassen')
      void this.setRemoteMic(false)
    }, 1000)
  }

  private stopRemoteWatchdog(): void {
    if (this.remoteWatchdog !== null) window.clearInterval(this.remoteWatchdog)
    this.remoteWatchdog = null
  }

  /**
   * Beim Loslassen noch etwas Stille hinterherschicken.
   *
   * Das serverseitige Sprechpausen-Erkennen beendet den Zug erst, wenn im Strom
   * wirklich nichts mehr ist — hört der Upload einfach auf, wartet die
   * Gegenseite ewig auf den Rest und antwortet nie. Am Rechner erledigt das der
   * Nachlauf des lokalen Gatters; hier muss es von Hand sein, weil das Gatter
   * für die Sprechtaste nicht zuständig ist.
   */
  private sendTrailingSilence(): void {
    const session = this.session
    if (!session?.isAcceptingAudio()) return

    const chunk = new Int16Array(320) // 20 ms bei 16 kHz, alles Nullen.
    const total = this.settings.vad.silenceDurationMs + GATE_HANGOVER_EXTRA_MS
    for (let sent = 0; sent < total; sent += 20) session.pushAudio(chunk)
  }

  /**
   * Von außen eingespeister Text (Zeitplan, Preisalarm, Recherche fertig).
   *
   * `fromUser`: Der Text stammt doch vom Nutzer, etwa getippt am Telefon. Dann
   * zählt eine Ablehnung als Fähigkeitslücke wie bei getipptem Text.
   */
  async speakPrompt(text: string, fromUser = false): Promise<void> {
    // Stillgelegt heißt stillgelegt — auch für Timer und Preisalarme.
    if (this.paused) return

    if (!this.session?.isConnected()) {
      await this.wakeUp()
      // Auf die Sitzung warten statt blind eine Pause zu raten: sonst geht
      // der Zug verloren, wenn der Aufbau mal eine Sekunde länger braucht.
      const ready = await this.waitForConnection(6000)
      if (!ready) return
    }
    // Kein Wunsch des Nutzers: Was James darauf sagt, ist keine Fähigkeitslücke.
    if (fromUser) this.gaps.typed(text)
    else this.gaps.systemPrompt(text)
    this.session?.sendText(text)
  }

  /**
   * Getippter Text aus dem Fenster.
   *
   * Sieht aus wie `speakPrompt` und ist an einer Stelle ausdrücklich anders:
   * Eine Stilllegung hält das hier nicht auf, sie wird aufgehoben. Der
   * Unterschied liegt darin, wer spricht. `speakPrompt` bringt Nachrichten von
   * Timern und Preiswächtern — die sollen schweigen, wenn jemand Ruhe wollte.
   * Hier hat der Nutzer gerade selbst etwas geschrieben; ihn mit Schweigen zu
   * beantworten, weil er vorhin still gestellt hat, wäre keine Rücksicht,
   * sondern ein Fehler.
   *
   * Dass dabei auch das Mikrofon wieder aufgeht, ist gewollt: Stillgelegt ist
   * ein Zustand für den ganzen Assistenten, und wer ihn anspricht, holt ihn
   * zurück — genau wie ein Klick auf den Kristall.
   */
  async sendTyped(text: string): Promise<boolean> {
    const trimmed = text.trim()
    if (!trimmed) return false
    useCrystal.getState().addCaption('user', trimmed)

    try {
      if (this.disposed) return false
      if (this.paused) await this.setPaused(false)

      if (!this.session?.isConnected()) {
        await this.wakeUp()
        const ready = await this.waitForConnection(8000)
        if (!ready) {
          if (!this.disposed && !this.paused) useCrystal.getState().setError('Die Verbindung ist nicht bereit. Bitte erneut senden oder unter Diagnose die Verbindung neu starten.')
          return false
        }
      }

      const session = this.session
      if (this.disposed || this.paused || !session?.isConnected()) return false
      // Getipptes unterbricht den bisherigen Beitrag, sobald die Leitung steht.
      session.interrupt()
      this.gaps.typed(trimmed)
      return session.sendText(trimmed) !== false
    } catch (error) {
      if (!this.disposed) useCrystal.getState().setError(describeError(error, 'Die Nachricht konnte nicht gesendet werden. Bitte erneut versuchen.'))
      return false
    }
  }

  /**
   * Die Werkzeugliste hat sich geändert (ein Zugang kam dazu oder fiel weg).
   * Läuft gerade keine Sitzung, ist nichts zu tun — die nächste holt sich die
   * neue Liste beim Aufbau ohnehin.
   */
  async refreshSession(): Promise<void> {
    if (!this.session?.isConnected()) return
    await this.session.refreshConfig()
  }

  /** Explicit repair rebuilds the chosen engine, not only its tool config. */
  async repairVoice(): Promise<string> {
    if (this.disposed || this.starting) throw new Error('Eine Verbindung wird bereits aufgebaut. Bitte kurz warten.')
    if (this.paused) return 'Die Stimme ist pausiert. Zum Sprechen die Kugel aktivieren.'
    const old = this.session
    this.session = null
    this.sessionGeneration++
    await old?.dispose()
    this.cascadeGivenUp = false
    this.uploadMuted = false
    this.preroll.length = 0
    this.bargeIn.reset()
    useCrystal.getState().setError(null)
    await this.startCapture()
    if (!this.capture) throw new Error('Mikrofon konnte nicht gestartet werden. Mikrofonzugriff und Audiogerät prüfen.')
    // Eine Texteingabe kann während des Abbaus bereits eine neue Sitzung öffnen.
    const replacement = this.session as VoiceEngine | null
    if (!replacement?.isConnected()) await this.wakeUp()
    if (!await this.waitForConnection(25000)) throw new Error(useCrystal.getState().lastError || 'Sprachverbindung konnte nicht bestätigt werden. Zugang und Internetverbindung prüfen.')
    return `Sprachverbindung neu aufgebaut: ${useCrystal.getState().engineLabel}.`
  }

  /** Not-Aus aus dem Hauptprozess: Sprachausgabe sofort abbrechen. */
  interrupt(): void {
    this.session?.interrupt()
  }

  private async waitForConnection(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.disposed || this.paused) return false
      if (this.session?.isConnected()) return true
      await new Promise((r) => setTimeout(r, 100))
    }
    return false
  }

  updateSettings(settings: Settings): void {
    const previous = this.settings
    const audioChanged =
      settings.audio.inputDeviceId !== previous.audio.inputDeviceId ||
      settings.audio.echoCancellation !== previous.audio.echoCancellation ||
      settings.audio.noiseSuppression !== previous.audio.noiseSuppression ||
      settings.audio.autoGainControl !== previous.audio.autoGainControl

    // War das Weckwort nicht verfügbar (Modell fehlte, Laden scheiterte) und
    // wird jetzt eingeschaltet, neu bauen: Ein inzwischen abgelegtes Modell
    // griffe sonst erst beim nächsten Start.
    const wakeModelChanged =
      settings.wake.modelName !== previous.wake.modelName ||
      (settings.wake.enabled && !previous.wake.enabled && this.wake?.available === false)
    const providerChanged = settings.speech.provider !== previous.speech.provider
    const speechChanged = JSON.stringify(settings.speech) !== JSON.stringify(previous.speech)
    const liveVoiceChanged =
      settings.liveModel !== previous.liveModel ||
      settings.voice !== previous.voice ||
      settings.language !== previous.language

    const oldSession = this.session
    const sessionWasActive = oldSession?.isConnected() || oldSession?.isStarting() || false
    const rebuildSession =
      !!oldSession && (providerChanged || (sessionWasActive && (speechChanged || liveVoiceChanged)))

    this.settings = settings
    this.wake?.setEnabled(settings.wake.enabled && !this.paused)
    this.wake?.setThreshold(settings.wake.threshold)
    if (rebuildSession) {
      // Anbieter, Stimme und Tempo stecken beim Aufbau im jeweiligen Sockel.
      // Ein bloßes Ändern des Einstellungsobjekts ließe die alte Stimme bis zum
      // nächsten Programmstart weiterreden.
      this.session = null
      this.sessionGeneration++
      this.sessionStarting = null
      this.starting = false
      this.cascadeGivenUp = false
      void (async () => {
        await oldSession?.dispose()
        if (!sessionWasActive || this.paused || this.disposed || this.session) return
        await this.wakeUp()
      })().catch((error) => {
        if (!this.disposed) useCrystal.getState().setError(describeError(error, 'Der Sprachweg konnte nicht gewechselt werden.'))
      })
    } else {
      this.session?.updateSettings(settings)
    }

    // Anderes Weckwort: Der Klassifikator ändert sich, der ganze Aufbau
    // muss neu. Im Hintergrund, damit die Einstellungen nicht haken.
    if (wakeModelChanged) {
      void this.rebuildWake(settings)
    }

    // Gerät oder Verarbeitungsketten geändert: Aufnahme neu aufbauen, das
    // lässt sich an einem laufenden MediaStream nicht umstellen.
    if (audioChanged) {
      void (async () => {
        this.captureGeneration++
        const capture = this.capture
        this.capture = null
        await capture?.stop()
        await this.captureStarting
        await this.startCapture()
      })()
    }
  }

  /** Weckwort neu laden — nötig, wenn sich der Klassifikator ändert. */
  private async rebuildWake(settings: Settings): Promise<void> {
    try {
      const next = await createWakeWord({
        threshold: settings.wake.threshold,
        modelName: settings.wake.modelName,
        enabled: settings.wake.enabled,
        onDetected: (score) => {
          console.info(`[wake] erkannt (${score.toFixed(2)})`)
          void this.wakeUp()
        }
      })
      if (this.disposed || this.settings.wake.modelName !== settings.wake.modelName) {
        next.destroy()
        return
      }
      this.wake?.destroy()
      this.wake = next
      useCrystal.getState().setWakeAvailable(next.available)
      this.wake.setEnabled(settings.wake.enabled && !this.paused)
    } catch (err) {
      console.error('[wake] Wechsel des Modells fehlgeschlagen:', err)
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.sessionGeneration++
    this.captureGeneration++
    if (this.reportTimer) window.clearInterval(this.reportTimer)
    this.reportTimer = null
    this.gaps.dispose()
    this.stopRemoteWatchdog()
    navigator.mediaDevices?.removeEventListener('devicechange', this.onDeviceChange)
    window.removeEventListener('online', this.onNetworkChange)
    window.removeEventListener('offline', this.onNetworkChange)
    this.flushSavings()
    await this.session?.dispose()
    await this.capture?.stop()
    this.wake?.destroy()
    this.session = null
    this.capture = null
    this.wake = null
  }

  // ─────────────────────────────────────────────────────────

  /**
   * Welcher Motor?
   *
   * Jeder fremde Sprecher verlangt den zusammengesetzten Weg, weil kein
   * Live-Modell Text ausgibt — und ohne Text hat ein Sprecher nichts vorzulesen.
   * Das gilt für ElevenLabs wie für piper auf diesem Rechner; nur `gemini`
   * spricht selbst und kommt deshalb mit dem Live-Motor aus.
   *
   * Fällt der gewählte Sprecher aus — Kontingent leer, Schlüssel abgelehnt,
   * Stimme nicht da, Prozess abgestürzt —, tritt der Live-Motor an seine Stelle
   * und spricht mit Geminis eigener Stimme. Der Wechsel passiert im Betrieb; zu
   * hören ist eine andere Stimme, kein Ausfall.
   */
  private buildSession(): VoiceEngine {
    const generation = ++this.sessionGeneration
    const current = (): boolean => !this.disposed && generation === this.sessionGeneration
    this.uploadMuted = false
    this.bargeIn.reset()
    const provider = this.settings.speech.provider
    const wantsOwnVoice =
      (provider === 'elevenlabs' || provider === 'piper') &&
      !this.cascadeGivenUp
    // OpenAI Realtime ist wie Gemini Live ein Motor aus einem Stück. Gibt er
    // auf, übernimmt Gemini Live — derselbe Rückweg wie bei der Kaskade.
    const wantsRealtime = provider === 'openai' && !this.cascadeGivenUp
    const session: VoiceEngine = wantsRealtime
      ? new RealtimeSession(this.settings, this.sessionEvents(current))
      : wantsOwnVoice
        ? new CascadeSession(this.settings, this.sessionEvents(current))
        : new LiveSession(this.settings, this.sessionEvents(current))

    const label = wantsRealtime ? 'OpenAI Realtime'
      : wantsOwnVoice ? `${this.settings.speech.thinkProvider === 'chatgpt' ? 'ChatGPT' : this.settings.speech.thinkProvider === 'ollama' ? 'Ollama' : 'Gemini'} · ${provider === 'piper' ? 'Piper' : 'ElevenLabs'}`
      : 'Gemini Live'
    useCrystal.getState().setEngineLabel(label)
    this.gaps.setChannel(wantsRealtime ? 'realtime' : wantsOwnVoice ? 'cascade' : 'live')

    session.onUploadGate = (muted) => {
      if (!current()) return
      if (muted !== this.uploadMuted) this.bargeIn.reset()
      this.uploadMuted = muted
      if (muted) {
        amplitude.input = 0
        this.preroll.length = 0
      }
    }

    // Über den Umweg statt direkt: Die Sitzung wird verworfen und neu gebaut,
    // der Horcher des Telefons überlebt das. Hinge er an der Sitzung, wäre er
    // nach dem ersten Wiederverbinden stumm.
    session.onOutputAudio = (pcm) => { if (current()) this.onOutputAudio?.(pcm) }

    session.onExhausted = (reason) => {
      if (!current()) return
      if (wantsRealtime) {
        useCrystal.getState().setError(reason)
        this.setWish('session', null)
        return
      }
      if (!wantsOwnVoice && !wantsRealtime) return
      console.warn('[controller] Der eigene Sprecher hat aufgegeben:', reason)
      this.cascadeGivenUp = true
      void this.swapToLive().catch((error) => {
        if (!this.disposed) useCrystal.getState().setError(describeError(error, 'Der Ersatz-Sprachweg konnte nicht gestartet werden.'))
      })
    }

    return session
  }

  /**
   * Den laufenden Motor gegen den Live-Motor tauschen.
   *
   * Der alte wird zuerst abgeräumt: Zwei Motoren, die gleichzeitig auf denselben
   * Player und dasselbe Telefon sprechen, wären schlimmer als Stille.
   */
  private async swapToLive(): Promise<void> {
    const old = this.session
    this.session = null
    this.sessionGeneration++
    this.sessionStarting = null
    this.starting = false
    await old?.dispose()
    if (this.paused || this.disposed || this.session) return
    await this.wakeUp()
  }

  /** Die Rückrufe sind für beide Motoren dieselben — der Kristall kennt keinen Unterschied. */
  private sessionEvents(current: () => boolean): VoiceEngineEvents {
    return {
      onStateChange: (state) => {
        if (!current()) return
        this.gaps.state(state)
        const map: Record<string, CrystalState> = {
          connecting: 'connecting',
          listening: 'listening',
          thinking: 'thinking',
          speaking: 'speaking',
          idle: 'idle'
        }
        this.setWish('session', state === 'idle' ? null : map[state])
        if (state === 'idle') {
          amplitude.input = 0
          this.preroll.length = 0
        }
      },
      // Live-Untertitel in der Mitte der Startseite, wie bei ChatGPT Voice.
      onUserTranscript: (text) => {
        if (!current()) return
        useCrystal.getState().addCaption('user', text)
        this.gaps.userText(text)
      },
      onModelTranscript: (text) => {
        if (!current()) return
        useCrystal.getState().addCaption('james', text)
        this.gaps.modelText(text)
      },
      onError: (message) => { if (current()) useCrystal.getState().setError(message) },
      onClosed: () => {
        if (!current()) return
        this.uploadMuted = false
        this.bargeIn.reset()
        this.setWish('session', null)
      }
    }
  }

  private setWish(source: 'session' | 'network' | 'pause', state: CrystalState | null): void {
    useCrystal.getState().setWish(source, state)
  }

  private watchNetwork(): void {
    window.addEventListener('online', this.onNetworkChange)
    window.addEventListener('offline', this.onNetworkChange)
    this.onNetworkChange()
  }

  // ─────────────────────────────────────────────────────────
  // Sparmodus: nicht hochgeladene Stille melden
  // ─────────────────────────────────────────────────────────

  private startSavingsReport(): void {
    this.reportTimer = window.setInterval(() => this.flushSavings(), 30_000)
  }

  private flushSavings(): void {
    if (this.skippedSamples < 16_000) return
    const seconds = this.skippedSamples / 16_000
    this.skippedSamples = 0
    void window.jarvis.invoke('tokens:record', {
      kind: 'silence',
      tokens: Math.round(seconds * COST_ESTIMATES.AUDIO_TOKENS_PER_SECOND)
    }).catch(() => undefined)
  }
}

/**
 * Pegel eines Blocks auf derselben Skala wie die Kristall-Amplitude.
 *
 * Die Wurzel ist wichtig: linear liegt normale Sprache bei RMS 0,05 und der
 * Schwellwertregler in den Einstellungen wäre auf den ersten fünf Prozent
 * seines Weges unbrauchbar fein.
 */
function chunkLevel(pcm: Int16Array): number {
  let sum = 0
  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i] / 0x8000
    sum += s * s
  }
  return Math.min(1, Math.sqrt(Math.sqrt(sum / pcm.length)) * 2.6)
}
