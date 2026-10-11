import { ELEVEN } from '@shared/config/defaults'
import { createSentenceBuffer } from '@shared/speakable'
import type { Settings } from '@shared/types'

/**
 * James' Stimme bei ElevenLabs.
 *
 * Der Aufbau ist ein Förderband: Gemini liefert Text in Bruchstücken, hier
 * werden sie auf die Leitung gelegt, und zurück kommt roher Ton, der ohne
 * Umrechnung in denselben Player läuft wie Geminis eigene Ausgabe. 24 kHz auf
 * beiden Seiten ist kein Zufall, sondern der Grund, warum an dieser Stelle
 * nichts gerechnet werden muss.
 *
 * Drei Entscheidungen tragen das Ganze:
 *
 * 0. **Gesprochen wird in Sätzen, nicht in Bruchstücken.** Was vom Modell
 *    kommt, endet an beliebiger Stelle — mitten im Wort, mitten in der Zahl,
 *    mitten in einem Sternchenpaar. Wer das unverändert weiterreicht, gibt der
 *    Stimme Silben, und Betonung entsteht nun einmal über den ganzen Satz.
 *    Deshalb sammelt der Satzpuffer aus `shared/speakable.ts` erst und macht
 *    den fertigen Satz dabei gleich sprechbar: keine Sternchen, keine
 *    Adressen, keine Abkürzungen. Das ist der Unterschied zwischen einer
 *    Stimme, die einen Text vorliest, und einer, die etwas sagt.
 *
 * 1. **Ein Sockel über mehrere Züge hinweg.** Ihn pro Antwort neu aufzumachen
 *    kostet einen Handschlag nach Amerika, und der läge genau zwischen der
 *    Frage und dem ersten Ton. Er bleibt deshalb offen und wird zwischen zwei
 *    Antworten nur durchgespült.
 *
 * 2. **Abgebrochen wird hart.** Beim Dazwischenreden nützt es nichts, den
 *    Nachschub zu stoppen: Was der Anbieter schon erzeugt hat, ist unterwegs
 *    und käme trotzdem an. Also wird der Sockel weggeworfen. Der nächste Zug
 *    baut einen neuen auf — dieser eine Handschlag ist der Preis dafür, dass
 *    "sei still" wirklich still heißt.
 *
 * Der Schlüssel geht in der ersten Nachricht mit, nicht im Kopf der Anfrage.
 * Das ist keine Nachlässigkeit: Ein Browser lässt bei einem WebSocket keine
 * eigenen Kopfzeilen zu, und der Anbieter sieht genau dafür ein Feld vor.
 */

export interface VoiceStreamOptions {
  apiKey: string
  voiceId: string
  modelId: string
  /** Zwei Buchstaben, z. B. `de`. Leer heißt: das Modell entscheidet selbst. */
  language: string
  stability: number
  similarity: number
  /** 0 bis 1. Wie viel Schauspiel in der Betonung steckt. Kostet Rechenzeit. */
  style: number
  /** 0,7 bis 1,2. Unter eins bedächtiger, über eins hastiger. */
  speed: number
  /** Fertiger Ton, 24 kHz, 16 bit, mono — genau das, was der Player frisst. */
  onAudio(pcm: Int16Array): void
  /**
   * Etwas ist schiefgegangen. `fatal` heißt: Mit diesem Anbieter wird es auch
   * beim nächsten Versuch nichts — Schlüssel abgelehnt, Kontingent leer,
   * Stimme unbekannt. Dann soll der Aufrufer auf Gemini zurückfallen, statt
   * stumm zu bleiben.
   */
  onError(reason: string, fatal: boolean): void
}

export interface VoiceStream {
  /**
   * Den Sockel schon aufmachen, bevor es etwas zu sagen gibt.
   *
   * Der Handschlag nach Amerika kostet ein paar hundert Millisekunden, und ohne
   * diesen Aufruf liegen die genau zwischen der Frage und dem ersten Ton. Ruft
   * man ihn, während das Modell noch denkt, kosten sie nichts — dann wartet man
   * ohnehin.
   */
  prewarm(): void
  /** Ein Stück Text, so wie es vom Modell kommt. Muss kein ganzer Satz sein. */
  speak(text: string): void
  /** Der Zug ist zu Ende: alles Übriggebliebene aussprechen. */
  finish(): void
  /** Dazwischengeredet oder Not-Aus: sofort still, Rest verwerfen. */
  abort(): void
  /** Endgültig. Danach ist dieser Strom unbrauchbar. */
  close(): void
  /** Wie viele Zeichen bisher hinausgingen — die Währung des Kontingents. */
  spentChars(): number
}

/**
 * Fehlermeldungen, nach denen ein zweiter Versuch sinnlos ist.
 *
 * Bewusst am Wortlaut entlang und nicht am Schließcode: Der Anbieter schickt
 * für Kontingent, Schlüssel und unbekannte Stimme denselben Code 1008, und der
 * Unterschied steht nur im Text. Wer hier zu großzügig ist, schaltet bei einem
 * vorübergehenden Netzfehler dauerhaft auf die zweite Stimme um.
 */
const FATAL_HINTS = [
  'quota',
  'credit',
  // Die gewählte Stimme gibt es, sie ist nur nicht freigeschaltet — Stimmen aus
  // der Bibliothek verlangen einen bezahlten Tarif. Ein zweiter Versuch ändert
  // daran nichts, und die Meldung muss den Nutzer erreichen.
  'payment',
  'paid_plan',
  'unusual activity',
  'invalid_api_key',
  'api_key',
  'unauthorized',
  'permission',
  'voice_not_found',
  'model_not_found',
  'invalid model'
]

export interface VoicePlan {
  apiKey: string
  voiceId: string
  modelId: string
}

/**
 * Steht ElevenLabs bereit — und mit welcher Stimme?
 *
 * Beantwortet mit echten Fragen statt Annahmen: Ist ein Schlüssel da, ist
 * Kontingent übrig, welche Stimme hat das Konto überhaupt. Jedes "nein" ist
 * hier kein Fehler, sondern ein Grund, den anderen Weg zu nehmen — deshalb
 * `null` und keine Ausnahme.
 *
 * Steht hier und nicht in einem der beiden Motoren, weil beide dieselbe Antwort
 * brauchen und zwei Fassungen davon irgendwann auseinanderliefen.
 */
export async function planVoice(
  settings: Settings,
  note: (message: string) => void
): Promise<VoicePlan | null> {
  const apiKey = await window.jarvis.invoke('secrets:getElevenForLive')
  if (!apiKey) {
    note('ElevenLabs-Schlüssel fehlt. Unter Stimme direkt speichern und prüfen.')
    return null
  }

  const quota = await window.jarvis.invoke('eleven:quota', {})
  if (!quota.ok || quota.remaining < settings.speech.reserveChars) {
    console.info('[eleven] steht nicht bereit:', quota.reason ?? 'Kontingent zu knapp')
    note(quota.reason ?? `ElevenLabs hat weniger als die eingestellte Reserve von ${settings.speech.reserveChars} Credits. Reserve im Sparplan reduzieren oder Kontingent auffüllen.`)
    return null
  }

  /**
   * Stimme und Modell, notfalls selbst herausgefunden.
   *
   * Beides darf leer sein — dann wird genommen, was das Konto hergibt, und zwar
   * jedes Mal neu. Zurückgeschrieben wird nichts, auch nicht von der
   * Einstellungsseite: Dort steht "Passende automatisch wählen" als eigene
   * Auswahl, und leer heißt genau das. Eine einmal gefundene Kennung
   * festzuschreiben hieße, ein besseres Modell oder eine neue Stimme im Konto
   * nie wieder zu sehen — und eine gelöschte für immer zu behalten.
   */
  let voiceId = settings.speech.elevenVoiceId
  let modelId = settings.speech.elevenModelId

  if (!voiceId) {
    const voices = await window.jarvis.invoke('eleven:voices')
    /**
     * Nicht einfach die erste.
     *
     * Die erste Stimme eines frischen Kontos ist meistens eine junge
     * Frauenstimme — als selbsttätige Wahl für einen Assistenten, der nach
     * seinem Vorbild klingen soll, denkbar schlecht. Gesucht wird deshalb
     * zuerst unter den Namen, die dazu passen; erst wenn keiner davon da ist,
     * gilt wieder die Reihenfolge des Kontos.
     */
    const fitting = voices.find((voice) =>
      ELEVEN.jarvisVoiceNames.some((name) => voice.name.toLowerCase() === name.toLowerCase())
    )
    // Leere Liste heißt meist: Die Liste war nicht abrufbar, nicht dass es
    // keine Stimme gäbe. Dann spricht George, den hat jedes Konto.
    voiceId = fitting?.id ?? voices[0]?.id ?? ELEVEN.fallbackVoiceId
  }
  // Sparsam und ausgewogen bleiben beim halb so teuren Flash/Turbo-Weg. Nur
  // die ausdrückliche Qualitätswahl darf eine gespeicherte Modellwahl
  // überstimmen; sonst könnte ein alter Multilingual-Wert den Sparplan heimlich
  // wieder doppelt so teuer machen.
  if (settings.speech.elevenPlan === 'quality' && !/multilingual_v2/.test(modelId)) modelId = ''
  if (settings.speech.elevenPlan !== 'quality' && /multilingual_v2/.test(modelId)) modelId = ''
  if (!modelId) {
    modelId =
      (await window.jarvis.invoke('eleven:bestModel', {
        quality: settings.speech.elevenPlan === 'quality'
      })) ?? ''
  }
  if (!modelId) {
    note('Kein passendes ElevenLabs-Sprachmodell verfügbar. Modellberechtigungen prüfen und Stimmen neu laden.')
    return null
  }

  return { apiKey, voiceId, modelId }
}

export function createVoiceStream(options: VoiceStreamOptions): VoiceStream {
  let socket: WebSocket | null = null
  /** Text, der aufgelaufen ist, während der Sockel noch aufging. */
  let queued: string[] = []
  let closed = false
  let finishPending = false
  let spent = 0
  /**
   * Ein einzelnes Byte, das aus einem Block übrig blieb.
   *
   * Roher Ton ist zwei Byte pro Abtastwert, aber der Anbieter schneidet seine
   * Blöcke nicht danach. Ein ungerader Block ohne diesen Übertrag verschöbe
   * alles Folgende um ein Byte — aus Sprache würde Rauschen, und zwar erst ab
   * der Mitte eines Satzes.
   */
  let carry: number | null = null

  const url = (): string => {
    const params = new URLSearchParams({
      model_id: options.modelId,
      output_format: ELEVEN.outputFormat,
      inactivity_timeout: String(ELEVEN.inactivityTimeoutSec),
      // Wir schicken ausschließlich fertige Sätze. ElevenLabs empfiehlt dafür
      // den Auto-Modus: keine doppelte Pufferung, schnellerer erster Ton.
      auto_mode: 'true',
      // Zahlen, Daten und Uhrzeiten sollen wie Sprache klingen, nicht wie Rohtext.
      apply_text_normalization: 'on'
    })
    // Nur die schnellen Modelle nehmen eine Sprachvorgabe an; den anderen ist
    // sie ein Fehler, und der käme als abgewiesener Sockel zurück.
    if (options.language && /v2_5|turbo|flash/.test(options.modelId)) {
      params.set('language_code', options.language)
    }
    return `${ELEVEN.socket}/${encodeURIComponent(options.voiceId)}/stream-input?${params}`
  }

  const fail = (reason: string, fatal: boolean): void => {
    if (closed) return
    drop()
    options.onError(reason, fatal)
  }

  /** Sockel wegwerfen, ohne den Strom als Ganzes aufzugeben. */
  const drop = (): void => {
    const dying = socket
    socket = null
    queued = []
    finishPending = false
    carry = null
    if (!dying) return
    dying.onmessage = null
    dying.onclose = null
    dying.onerror = null
    dying.onopen = null
    try {
      dying.close()
    } catch {
      // War schon zu.
    }
  }

  const open = (): void => {
    if (socket || closed) return
    let ws: WebSocket
    try {
      ws = new WebSocket(url())
    } catch (err) {
      fail(`Der Sprech-Sockel ließ sich nicht öffnen: ${String(err)}`, false)
      return
    }
    socket = ws

    ws.onopen = () => {
      if (socket !== ws) return
      /**
       * Die erste Nachricht ist Vertrag und Einstellung in einem — und ihr Text
       * muss ein einzelnes Leerzeichen sein. Etwas anderes hineinzuschreiben
       * bringt den Anbieter dazu, es mitzusprechen.
       */
      ws.send(
        JSON.stringify({
          text: ' ',
          voice_settings: {
            stability: options.stability,
            similarity_boost: options.similarity,
            // Stil kostet Rechenzeit auf der Gegenseite und damit Verzögerung.
            // Bei null wird er gar nicht erst mitgeschickt — ein Feld, das
            // nichts bewirkt, soll auch nichts kosten.
            ...(options.style > 0 ? { style: options.style } : {}),
            ...(options.speed !== 1 ? { speed: options.speed } : {}),
            use_speaker_boost: true
          },
          'xi-api-key': options.apiKey
        })
      )
      // Was während des Aufbaus gesagt wurde, gehört an den Anfang.
      const pending = queued
      queued = []
      for (const text of pending) push(text)
      if (finishPending) {
        finishPending = false
        flush()
      }
    }

    ws.onmessage = (event) => {
      if (socket !== ws || typeof event.data !== 'string') return
      let msg: { audio?: string | null; isFinal?: boolean; error?: string; message?: string }
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      if (msg.error || (msg.message && !msg.audio)) {
        const reason = msg.error ?? msg.message ?? ''
        fail(reason, isFatal(reason))
        return
      }
      if (msg.audio) options.onAudio(decode(msg.audio))
    }

    ws.onclose = (event) => {
      if (socket !== ws) return
      socket = null
      // 1000 ist der planmäßige Abschied — nach einer Zeit ohne Text etwa.
      // Dann ist nichts kaputt, der nächste Zug macht einfach wieder auf.
      if (event.code === 1000) return
      const reason = event.reason || `Code ${event.code}`
      fail(`ElevenLabs hat aufgelegt: ${reason}`, isFatal(reason))
    }

    ws.onerror = () => {
      // `onclose` folgt und trägt den Grund.
    }
  }

  const push = (text: string): void => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    // Der Anbieter verlangt ein Leerzeichen am Ende jedes Stücks — ohne das
    // klebt das letzte Wort am ersten des nächsten Stücks.
    socket.send(JSON.stringify({ text: text.endsWith(' ') ? text : `${text} ` }))
  }

  const flush = (): void => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    // Sprich aus, was im Puffer liegt, aber lass die Leitung offen: Der nächste
    // Zug kommt oft in wenigen Sekunden, und ein Handschlag weniger ist
    // Verzögerung weniger.
    socket.send(JSON.stringify({ text: ' ', flush: true }))
  }

  /**
   * Base64 → PCM.
   *
   * Der Übertrag ist der Grund, warum das hier steht und nicht in einer Zeile:
   * Ein Block mit ungerader Byte-Zahl darf sein letztes Byte nicht verlieren,
   * sonst verschiebt sich alles Folgende um eines.
   */
  const decode = (base64: string): Int16Array => {
    const binary = atob(base64)
    const offset = carry === null ? 0 : 1
    const bytes = new Uint8Array(binary.length + offset)
    if (carry !== null) bytes[0] = carry
    for (let i = 0; i < binary.length; i++) bytes[i + offset] = binary.charCodeAt(i)

    const usable = bytes.byteLength - (bytes.byteLength % 2)
    carry = usable === bytes.byteLength ? null : bytes[bytes.byteLength - 1]

    const pcm = new Int16Array(usable / 2)
    new Uint8Array(pcm.buffer).set(bytes.subarray(0, usable))
    return pcm
  }

  /** Sammelt Bruchstücke und gibt fertige, sprechbare Sätze heraus. */
  const sentences = createSentenceBuffer()

  /** Ein fertiger Satz geht hinaus — oder wartet, bis der Sockel steht. */
  const say = (sentence: string): void => {
    spent += sentence.length
    if (!socket) {
      queued.push(sentence)
      open()
      return
    }
    if (socket.readyState === WebSocket.CONNECTING) {
      queued.push(sentence)
      return
    }
    push(sentence)
  }

  return {
    prewarm() {
      if (closed) return
      open()
    },

    speak(text) {
      if (closed || text.length === 0) return
      // Der Sockel darf schon aufgehen, während der Satz noch wächst: Der
      // Handschlag und das Warten auf das Satzende laufen dann nebeneinander
      // statt hintereinander.
      if (!socket) open()
      for (const sentence of sentences.push(text)) say(sentence)
    },

    finish() {
      if (closed) return
      for (const sentence of sentences.flush()) say(sentence)
      if (socket?.readyState === WebSocket.OPEN) {
        flush()
        return
      }
      // Der Sockel geht noch auf; das Durchspülen wird nachgeholt, sobald er
      // steht. Ohne diese Merker bliebe ein kurzer Satz ungesprochen liegen,
      // weil er den Zeitplan des Anbieters nie erreicht.
      if (socket) finishPending = true
    },

    abort() {
      // Auch der halbe Satz im Puffer ist überholt. Ohne dieses Vergessen
      // begänne die nächste Antwort mit dem Rest der abgebrochenen.
      sentences.clear()
      drop()
    },

    close() {
      closed = true
      sentences.clear()
      drop()
    },

    spentChars() {
      return spent
    }
  }
}

function isFatal(reason: string): boolean {
  const lower = reason.toLowerCase()
  return FATAL_HINTS.some((hint) => lower.includes(hint))
}
