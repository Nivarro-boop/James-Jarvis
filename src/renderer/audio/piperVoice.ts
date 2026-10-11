import { createSentenceBuffer } from '@shared/speakable'
import type { PiperHealth } from '@shared/types'
import type { VoiceStream, VoiceStreamOptions } from './elevenVoice'

/**
 * James' Stimme auf diesem Rechner.
 *
 * Das ist das Gegenstück zu `elevenVoice.ts`, und zwar wörtlich: Heraus kommt
 * dieselbe Schnittstelle — prewarm, speak, finish, abort, close, spentChars.
 * Der Grund dafür steht nicht hier, sondern in `CascadeSession.ts`: Deren
 * ganzer Ablauf sitzt auf diesen sechs Methoden, und wer einen zweiten
 * Sprecher einbaut, indem er den Ablauf verzweigt, hat danach zwei Abläufe, von
 * denen einer immer der ungetestete ist. Hier wird deshalb nicht die Kaskade
 * erweitert, sondern derselbe Stecker ein zweites Mal gebaut.
 *
 * Vier Dinge sind trotzdem anders, und jedes davon, weil piper anders ist:
 *
 * 1. **Es gibt keinen Sockel, sondern einen Prozess in einem fremden Prozess.**
 *    piper ist ein fremdes Programm und keine Netzverbindung, und ein
 *    Kindprozess lässt sich aus dem Renderer nicht starten — er sitzt deshalb
 *    im Hauptprozess, und sein Ton macht auf dem Weg hierher einen
 *    Prozesswechsel. Alles, was in dieser Datei steht, ist Buchführung über
 *    diese eine Leitung.
 *
 * 2. **Gesprochen wird in Sätzen.** Drüben ist das eine Frage der Betonung,
 *    hier ist es eine des Formats: piper synthetisiert einen Satz in einem
 *    Durchlauf und kann innerhalb davon nicht streamen. Wer ihm die Bruchstücke
 *    gibt, die aus dem Denkmotor fallen, bekommt Bruchstücke zu hören — mitten
 *    im Wort abgeschnitten und einzeln betont. Der Satzpuffer aus
 *    `shared/speakable.ts` ist deshalb keine Zierde, sondern Bedingung, und er
 *    macht den fertigen Satz nebenbei sprechbar.
 *
 * 3. **Abgebrochen wird mit einer Zahl statt mit einer Axt.** Bei ElevenLabs
 *    ist der Abbruch das Wegwerfen des Sockels; das Gegenstück wäre hier, den
 *    Prozess zu töten, und das ist ausdrücklich falsch: Sein Start kostet je
 *    nach Fassung mehrere hundert Millisekunden bis Sekunden, und danach ist
 *    die ONNX-Sitzung wieder kalt. Er bleibt also stehen, und stattdessen trägt
 *    jeder Satz eine Stromnummer. Was mit einer alten Nummer ankommt, gehört zu
 *    einem Satz, über den schon hinweggeredet wurde, und wird weggeworfen. Ohne
 *    das trifft ein bereits synthetisierter Satz nach dem Verstummen wieder ein,
 *    und das klingt nicht nach Verzögerung, sondern nach einem Gespenst.
 *
 * 4. **Es kostet nichts.** Die Zahl aus `spentChars` gibt es trotzdem — warum,
 *    steht dort.
 */

/**
 * Was dieser Sprecher braucht: ein paar Rückrufe und sonst nichts.
 *
 * Absichtlich aus `VoiceStreamOptions` herausgeschnitten und nicht abgetippt.
 * `onAudio` bekommt bei beiden Sprechern dieselben Blöcke und läuft in
 * denselben Player; würde sich drüben die Form ändern, muss es hier weh tun und
 * nicht erst beim Hören. Alles Übrige — Stimme, Tempo, Rückseite — steht in den
 * Einstellungen, und die liest der Hauptprozess selbst. Ein Schlüssel ist nicht
 * dabei, weil es niemanden gibt, bei dem man sich ausweisen müsste.
 */
export interface PiperVoiceOptions extends Pick<VoiceStreamOptions, 'onAudio' | 'onError'> {
  /**
   * Dieser Strom hat alles Anstehende ausgesprochen.
   *
   * Die eine Meldung, die es drüben nicht gibt und hier geben muss: Bei
   * ElevenLabs endet ein Zug ungefähr dann, wenn der Nachschub endet, weil der
   * Ton auf demselben Sockel unterwegs ist wie der Text. Hier liegt zwischen
   * dem letzten hingeschickten Satz und seinem letzten Tonblock eine
   * Synthese — und wer den Zug schon für beendet hält, macht das Mikrofon auf,
   * während piper noch redet. Freiwillig, damit die Schnittstelle die geteilte
   * bleibt; wer sie nicht setzt, verhält sich wie vorher.
   */
  onIdle?(): void
}

/** Was piper über sich sagt, wenn er bereitsteht. */
export interface PiperPlan {
  /** Was tatsächlich läuft, nicht was eingestellt ist. Für die Protokollzeile. */
  backend: PiperHealth['backend']
  /** Dateiname der Stimme, ohne Pfad. */
  voice: string
  /**
   * Die Rate der Stimme, nicht die des Players — umgetastet wird im
   * Hauptprozess, weil dort bekannt ist, was die Stimme wirklich liefert. Sie
   * steht hier, weil sie im Protokoll die Frage beantwortet, warum eine Stimme
   * dumpf klingt: 16000 heißt `low`, und das hört man.
   */
  sampleRate: number
}

/**
 * Steht piper bereit — und womit?
 *
 * Dieselbe Aufgabe wie `planVoice` drüben und dieselbe Antwortform: Jedes
 * „nein" ist hier kein Fehler, sondern ein Grund, den anderen Weg zu nehmen.
 * Deshalb `null` und keine Ausnahme — der Aufrufer soll auf ElevenLabs oder
 * Gemini ausweichen, nicht schweigen.
 *
 * Der Satz, der im Fehlerfall an `note` geht, kommt aus dem Hauptprozess: Nur
 * dort ist bekannt, ob die Stimme fehlt, die Rückseite abgestürzt ist oder
 * Python nicht gefunden wurde, und `PiperHealth.detail` ist genau dafür ein
 * ganzer Satz und kein Brocken.
 */
export async function planPiperVoice(
  note: (message: string) => void
): Promise<PiperPlan | null> {
  let health: PiperHealth
  try {
    health = await window.jarvis.invoke('piper:health')
  } catch (err) {
    /**
     * Hier ist der Hauptprozess selbst der Ausfall, nicht piper. Electron legt
     * um solche Fehler noch „Error invoking remote method" herum, und das ist
     * kein Satz, den jemand beantworten kann — er geht ins Protokoll, und nach
     * draußen geht einer, der sagt, wo man nachsieht.
     */
    console.warn('[piper] Zustandsfrage fehlgeschlagen:', messageOf(err))
    note('Der lokale Sprecher antwortet nicht. Sieh in den Einstellungen nach, ob piper und eine Stimme da sind.')
    return null
  }

  if (!health.ok) {
    console.info('[piper] steht nicht bereit:', health.detail)
    if (health.detail) note(health.detail)
    return null
  }

  return { backend: health.backend, voice: health.voice, sampleRate: health.sampleRate }
}

/**
 * Die Stromnummern laufen über alle Ströme dieses Fensters hinweg weiter.
 *
 * Ein Zähler je Strom täte es fast — bis jemand `close()` ruft und einen neuen
 * baut. Der finge wieder bei eins an, und ein Block, der vom alten noch
 * unterwegs ist, träfe auf eine Nummer, die der neue für seine eigene hält.
 * Ein fremder Halbsatz mitten im ersten Wort ist genau die Art Fehler, die man
 * dreimal für einen Zufall hält.
 */
let nextStream = 1

/** Nichts zu hören — statt bei jedem verworfenen Block ein neues Feld zu bauen. */
const NOTHING = new Int16Array(0)

export function createPiperStream(options: PiperVoiceOptions): VoiceStream {
  /** Der Satz, der gerade gilt. Alles mit einer anderen Nummer ist überholt. */
  let stream = nextStream++
  let closed = false
  /**
   * Ein einzelnes Byte, das aus einem Block übrig blieb.
   *
   * Nur für den Fall, dass der Ton nicht als Int16Array ankommt, sondern als
   * roher Bytestrom — siehe `toPcm`. Zwei Byte sind ein Abtastwert, und ein
   * ungerader Block ohne diesen Übertrag verschöbe alles Folgende um ein Byte.
   * Aus Sprache würde dann Rauschen, und zwar erst ab der Mitte eines Satzes.
   */
  let carry: number | null = null

  /** Sammelt Bruchstücke und gibt fertige, sprechbare Sätze heraus. */
  const sentences = createSentenceBuffer()

  /**
   * Bytes werden Abtastwerte, kleinstwertiges Byte zuerst.
   *
   * Dieselbe Reihenfolge, in der Windows auf dieser Maschine rechnet, und
   * dieselbe, die der Player erwartet — deshalb wird sie nicht abgefragt,
   * sondern vorausgesetzt.
   */
  const fromBytes = (bytes: Uint8Array): Int16Array => {
    const offset = carry === null ? 0 : 1
    const all = new Uint8Array(bytes.byteLength + offset)
    if (carry !== null) all[0] = carry
    all.set(bytes, offset)

    const usable = all.byteLength - (all.byteLength % 2)
    carry = usable === all.byteLength ? null : all[all.byteLength - 1]

    const pcm = new Int16Array(usable / 2)
    new Uint8Array(pcm.buffer).set(all.subarray(0, usable))
    return pcm
  }

  /**
   * Was über die Leitung kam, als echtes Int16Array.
   *
   * Der Vertrag verspricht eines, und im Normalfall hält er es: Electron kopiert
   * getypte Felder unangetastet über die Prozessgrenze. Verlassen darf man sich
   * darauf trotzdem nicht, denn ein Node-`Buffer` kommt hier als `Uint8Array`
   * an, und der sieht einem Tonblock zum Verwechseln ähnlich — er ist nur
   * doppelt so lang und meint mit jedem Byte etwas anderes. Wer ihn ungeprüft
   * weiterreicht, gibt dem Player halb so viele Abtastwerte, wie er zu haben
   * glaubt, jeden davon aus einem halben zusammengesetzt; zu hören ist lautes
   * Rauschen in doppelter Geschwindigkeit.
   *
   * Deshalb wird die Form ausdrücklich festgestellt statt geglaubt, und zwar
   * über die Kennzeichnung und nicht über `instanceof`: Ein Feld, das aus einer
   * anderen Ausführungsumgebung stammt, ist kein `Int16Array` dieses Fensters,
   * obwohl es genau eines ist.
   */
  const toPcm = (payload: unknown): Int16Array => {
    if (isInt16Array(payload)) return payload
    if (ArrayBuffer.isView(payload)) {
      return fromBytes(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength))
    }
    if (payload instanceof ArrayBuffer) return fromBytes(new Uint8Array(payload))
    // Ein gewöhnliches Feld trägt schon Abtastwerte, keine Byte — hier wird
    // gekürzt, nicht neu zusammengesetzt.
    if (Array.isArray(payload)) return Int16Array.from(payload as number[])

    console.warn('[piper] Ein Tonblock kam in einer Form an, mit der sich nichts anfangen lässt.')
    return NOTHING
  }

  /**
   * Der laufende Satz wird fallen gelassen und die Nummer weitergedreht.
   *
   * Die Reihenfolge ist der Punkt: Erst gilt hier die neue Nummer, dann geht die
   * Bitte hinaus. Zwischen beidem liegt ein Prozesswechsel, und was in dieser
   * Zeit noch an Ton eintrifft, trägt die alte — es fällt also schon durch das
   * Sieb, bevor der Hauptprozess überhaupt vom Abbruch weiß. Mitgeschickt wird
   * ausdrücklich die aufgegebene Nummer: Sie benennt, was verworfen werden soll,
   * und der nächste Satz kommt mit einer höheren.
   */
  const cut = (): void => {
    const dying = stream
    stream = nextStream++
    carry = null
    void window.jarvis.invoke('piper:abort', { stream: dying }).catch((err) => {
      // Wenn der Abbruch nicht ankommt, spricht piper den Satz zu Ende — hören
      // wird ihn niemand, denn das Sieb steht schon. Es kostet Rechenzeit, sonst
      // nichts, und deshalb ist es eine Protokollzeile und keine Meldung.
      console.warn('[piper] Abbruch nicht zugestellt:', messageOf(err))
    })
  }

  /** Ein fertiger Satz geht in den Hauptprozess. */
  const say = (sentence: string): void => {
    const mine = stream
    void window.jarvis.invoke('piper:speak', { stream: mine, text: sentence }).catch((err) => {
      // Nur der laufende Satz zählt: Ein Fehlschlag, der zu einem abgebrochenen
      // Strom gehört, ist genauso überholt wie sein Ton.
      if (closed || mine !== stream) return
      /**
       * Endgültig, und das ist die unbequeme, aber richtige Wahl. Der
       * Hauptprozess meldet, was piper zustößt, über `piper:failed`; kommt
       * stattdessen der Aufruf selbst nicht durch, ist nicht die Synthese
       * gescheitert, sondern die Leitung — fehlender Behandler, gesperrter
       * Kanal, abgestürztes Modul. Nichts davon wird beim nächsten Satz besser,
       * und ein Sprecher, der stumm weitermacht, ist schlimmer als einer, der
       * sich abmeldet.
       */
      console.warn('[piper] Satz nicht angenommen:', messageOf(err))
      options.onError('Der lokale Sprecher hat den Satz nicht angenommen.', true)
    })
  }

  const offAudio = window.jarvis.on('piper:audio', (payload) => {
    if (closed || payload.stream !== stream) return
    const pcm = toPcm(payload.pcm)
    // Ein leerer Block ist kein Ton, sondern ein Übertrag, der auf sein zweites
    // Byte wartet. Den Player damit zu wecken, hieße ihn zum Reden zu bringen,
    // ohne dass etwas zu hören wäre — und genau daran hängt die Anzeige.
    if (pcm.length > 0) options.onAudio(pcm)
  })

  const offIdle = window.jarvis.on('piper:idle', (payload) => {
    if (closed || payload.stream !== stream) return
    options.onIdle?.()
  })

  const offFailed = window.jarvis.on('piper:failed', (payload) => {
    if (closed) return
    /**
     * Ein endgültiges Nein gilt dem Sprecher, nicht dem Satz.
     *
     * Deshalb wird nur das vorübergehende an der Stromnummer gemessen: Dass ein
     * überholter Satz nicht mehr fertig wurde, ist keine Nachricht. Dass piper
     * gestorben ist, dagegen schon — auch wenn er dabei an einem Satz saß, der
     * längst niemanden mehr interessiert. Wer auch das wegwirft, wartet auf den
     * nächsten Beitrag, um dann festzustellen, dass er stumm ist.
     */
    if (!payload.fatal && payload.stream !== stream) return
    options.onError(payload.reason, payload.fatal)
  })

  return {
    prewarm() {
      if (closed) return
      /**
       * Ruhig bei jedem Zug erneut.
       *
       * Der Aufruf ist im Hauptprozess wohlfeil, wenn der Prozess schon steht,
       * und unentbehrlich, wenn er zwischendurch gestorben ist. Ihn zu merken
       * und nur einmal zu schicken, spart einen Prozesswechsel und riskiert
       * dafür genau den Kaltstart, den er verhindern soll.
       */
      void window.jarvis.invoke('piper:prewarm').catch((err) => {
        // Aufwärmen ist eine Vorleistung, kein Versprechen. Was hier schiefgeht,
        // meldet sich beim ersten Satz noch einmal — und dann mit Folgen.
        console.info('[piper] ließ sich nicht vorwärmen:', messageOf(err))
      })
    },

    speak(text) {
      if (closed || text.length === 0) return
      // Hier wird nichts vorgewärmt: Der Hauptprozess fährt piper hoch, wenn der
      // erste Satz kommt. Ein Aufruf mehr würde die Wartezeit nicht verkürzen,
      // sondern nur zwei Wege für dieselbe Sache schaffen.
      for (const sentence of sentences.push(text)) say(sentence)
    },

    finish() {
      if (closed) return
      // Der Rest im Puffer geht hinaus, ganz gleich wie kurz. Ein
      // Durchspülen wie beim Sockel gibt es nicht — jeder Satz war schon für
      // sich eine vollständige Bestellung.
      for (const sentence of sentences.flush()) say(sentence)
    },

    abort() {
      if (closed) return
      // Auch der halbe Satz im Puffer ist überholt. Ohne dieses Vergessen begänne
      // die nächste Antwort mit dem Rest der abgebrochenen.
      sentences.clear()
      cut()
    },

    close() {
      if (closed) return
      closed = true
      sentences.clear()
      // Erst den Hauptprozess von der Arbeit entbinden, dann die Ohren zumachen.
      cut()
      /**
       * Und jetzt wirklich abmelden.
       *
       * `closed` allein genügt nicht: Ein Strom, der nach dem Schließen weiter
       * an den Ereignissen hängt, hält den ganzen Rückruf-Baum samt Player am
       * Leben, und beim nächsten Kristallfenster horchen zwei. Der zweite
       * schiebt seinen Ton dann in einen Player, den es nicht mehr gibt.
       */
      offAudio()
      offIdle()
      offFailed()
    },

    /**
     * Immer null, und die Methode gibt es trotzdem.
     *
     * piper rechnet auf dieser CPU und schickt nichts hinaus — es gibt kein
     * Kontingent, das sich verbrauchen ließe. Weggelassen wird sie aber nicht,
     * weil beide Sprecher durch dasselbe Loch passen müssen: Die Kaskade meldet
     * nach jedem Zug, was gesprochen wurde, und dürfte das nicht davon abhängig
     * machen, wer gerade redet. Null ist hier die ehrliche Antwort auf eine
     * Frage, die niemandem wehtut.
     */
    spentChars() {
      return 0
    }
  }
}

/**
 * Ein Int16Array, auch wenn es aus einer fremden Ausführungsumgebung stammt.
 *
 * `instanceof` prüft die Herkunft, nicht die Art: Ein Feld, das die Brücke aus
 * der abgeschotteten Welt des Preloads mitbringt, kann ein tadelloses
 * Int16Array sein und trotzdem an `instanceof Int16Array` scheitern, weil es zu
 * einem anderen Konstruktor gehört. Die Kennzeichnung überlebt die Grenze.
 */
function isInt16Array(value: unknown): value is Int16Array {
  return Object.prototype.toString.call(value) === '[object Int16Array]'
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
