import { randomUUID } from 'node:crypto'
import { EndSensitivity, GoogleGenAI, Modality, StartSensitivity } from '@google/genai'
import { getSecret } from '../secrets/keystore'
import { getSettings } from '../store/settings'
import { buildSystemPrompt } from '../agent/prompt'
import { runTool } from '../tools/runner'
import { withoutGapReports } from '../agent/capabilityGaps'
import { hasPhoneTools, phoneToolDeclarations, phoneToolNames } from './phoneTools'
import {
  bytesToPcm,
  Downsampler24kTo8k,
  muLawToPcm8k,
  OutboundPacer,
  pcmToBytes,
  upsample8kTo16k
} from './audio'

/**
 * Ein Telefongespräch gegen die Live-API.
 *
 * Der Unterschied zur Sitzung im Renderer ist nicht die API, sondern das,
 * was drumherum fehlt. Am Telefon gibt es kein Headset, keine
 * Echounterdrückung des Browsers und keinen Kristall, an dem abzulesen wäre,
 * was gerade passiert. Alles, was der andere hat, ist eine Leitung, auf
 * der entweder jemand spricht oder nicht.
 *
 * Daraus folgen drei Entscheidungen, die hier anders ausfallen:
 *
 * 1. Weniger Werkzeuge, und angesagte. Hier stand einmal "keine Werkzeuge",
 *    mit einer richtigen Begründung: Ein Anruf, bei dem James fünf Sekunden
 *    schweigt, weil er eine Webseite lädt, klingt wie ein Verbindungsabbruch,
 *    und der andere legt auf. Nur folgt daraus nicht Schweigen, sondern eine
 *    kurze Liste schneller Werkzeuge (`phoneTools.ts`) und die Anweisung,
 *    vorher zu sagen, was gleich passiert. Ein Assistent, der am Telefon
 *    nicht in den Kalender sehen kann, beantwortet die häufigste Frage nicht,
 *    die man ihm unterwegs stellt.
 *
 * 2. Barge-in ist Pflicht, nicht Komfort. Wer am Telefon dazwischenredet,
 *    erwartet, dass das Gegenüber aufhört. Kommt `interrupted`, fliegt der
 *    Ausgabepuffer weg, und weil Twilio bereits gesendete Pakete abspielt,
 *    wird zusätzlich `clear` geschickt.
 *
 * 3. Kein Wiederverbinden. Reißt die Live-Sitzung, ist das Gespräch vorbei;
 *    ein stiller Neuaufbau mitten im Satz wäre für den anderen nicht von
 *    einem Fehler zu unterscheiden, und er hat kein Fenster, in dem er
 *    nachsehen könnte.
 */

export interface LiveCallEvents {
  /** µ-law-Rahmen für Twilio. */
  onAudio(frame: Buffer): void
  /** Barge-in: Twilio soll seinen eigenen Puffer verwerfen. */
  onClear(): void
  onTranscript(role: 'caller' | 'jarvis', text: string): void
  onClosed(reason: string): void
}

type LiveMessage = Record<string, any>

/** Wie lange ein Anruf höchstens läuft, bevor von selbst aufgelegt wird. */
const MAX_CALL_MS = 10 * 60 * 1000

/**
 * Wie lange ein Werkzeug am Telefon laufen darf.
 *
 * Am Rechner darf eine Suche zehn Sekunden brauchen — der Kristall dreht sich,
 * man sieht, dass etwas passiert. Auf einer Telefonleitung gibt es dieses
 * Fenster nicht: Da ist zehn Sekunden lang nichts, und der andere sagt "hallo?"
 * oder legt auf. Nach dieser Grenze bekommt das Modell einen Fehler, den es
 * vorlesen kann, statt weiter zu warten.
 */
const TOOL_TIMEOUT_MS = 12_000

export class LiveCall {
  private session: any = null
  private pacer: OutboundPacer
  private closed = false
  private lastUpsampled = 0
  private downsampler = new Downsampler24kTo8k()
  private hardStop: NodeJS.Timeout | null = null
  /** Ton, der schon ankommt, während die Live-API noch den Handschlag macht. */
  private pendingCallerAudio: Buffer[] = []
  private pendingCallerBytes = 0

  constructor(
    private readonly events: LiveCallEvents,
    /** Was James von sich aus sagt, sobald abgenommen wurde. */
    private readonly opening: string,
    /**
     * Wer am anderen Ende ist, bei einem eingehenden Anruf.
     *
     * Der Name kommt aus dem Adressbuch und ist damit schon geprüft — nur wer
     * dort steht, kommt überhaupt durch. Ihn dem Modell zu nennen erspart die
     * erste Frage jedes Gesprächs.
     */
    private readonly caller?: string,
    /**
     * Ob am anderen Ende der Nutzer selbst ist.
     *
     * Entscheidet, welche Werkzeuge zur Verfügung stehen: Der Kalender geht
     * den Installateur nichts an, auch wenn er im Adressbuch steht.
     */
    private readonly owner = false,
    /** Besitzer mit richtiger PIN: alle Werkzeuge wie am Rechner. */
    private readonly fullAccess = false
  ) {
    this.pacer = new OutboundPacer((frame) => this.events.onAudio(frame))
  }

  async start(): Promise<void> {
    const apiKey = getSecret('gemini')
    if (!apiKey) throw new Error('Kein Gemini-Zugang hinterlegt — ohne den gibt es kein Gespräch.')

    const settings = getSettings()
    const ai = new GoogleGenAI({ apiKey })

    const session = await ai.live.connect({
      model: settings.liveModel,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.voice } },
          languageCode: settings.language
        },
        systemInstruction: { parts: [{ text: this.phonePrompt() }] },

        // Die Erkennung von Sprechbeginn und -ende macht die API. Auf einer
        // Telefonleitung ist das Grundrauschen höher als am Mikrofon, deshalb
        // eine unempfindlichere Startschwelle: sonst hält sie das Rauschen der
        // Leitung für den Anfang einer Äußerung und unterbricht sich selbst.
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
            endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
            prefixPaddingMs: 200,
            silenceDurationMs: 800
          }
        },

        inputAudioTranscription: {},
        outputAudioTranscription: {},
        contextWindowCompression: { slidingWindow: {} },

        // Nur die telefontauglichen. Eine leere Liste würde die API ablehnen,
        // deshalb bleibt das Feld dann ganz weg.
        ...(hasPhoneTools(this.owner, this.fullAccess)
          ? { tools: phoneToolDeclarations(this.owner, this.fullAccess) }
          : {})
      },
      callbacks: {
        onmessage: (msg: LiveMessage) => this.onMessage(msg),
        onerror: (err: unknown) => this.finish(`Live-API-Fehler: ${String(err).slice(0, 200)}`),
        // Der Grund gehört ins Protokoll: Ein leeres Kontingent kommt genau
        // hier an, und ohne ihn sah ein stummes Telefonat aus wie ein Netzfehler.
        onclose: (event: { reason?: string } | undefined) =>
          this.finish(`Die Live-Sitzung wurde beendet${event?.reason ? `: ${event.reason.slice(0, 200)}` : ''}.`)
      }
    })

    // Auflegen kann schneller sein als der Netzwerk-Handschlag. Eine danach
    // eintreffende Sitzung darf weder grüßen noch weiter Kosten erzeugen.
    if (this.closed) {
      try {
        session.close()
      } catch {
        // Der Handschlag kann schon beim Schließen abgebrochen worden sein.
      }
      return
    }
    this.session = session

    // Den ersten Satz anstoßen: Ohne das schweigt James, bis der andere etwas
    // sagt — und der wartet seinerseits. Bei einem eingehenden Anruf ist es
    // umgekehrt dringlicher: Wer anruft, hält Stille nach dem Abheben für
    // einen Fehler und legt wieder auf.
    const cue = this.caller
      ? `[${this.caller} ruft an, du hast gerade abgehoben. Sag: "${this.opening}"]`
      : `[Der Angerufene hat abgehoben. Sag: "${this.opening}"]`
    this.session.sendClientContent({
      turns: [{ role: 'user', parts: [{ text: cue }] }],
      turnComplete: true
    })

    // Ein Gespräch, das niemand beendet — etwa weil ein Anrufbeantworter
    // drangegangen ist —, läuft sonst bis zum Kontingentende und kostet
    // pro Minute weiter.
    this.hardStop = setTimeout(() => this.finish('Zeitgrenze für den Anruf erreicht.'), MAX_CALL_MS)

    // Der Anrufer kann direkt nach dem Abheben reden. Was während des
    // Verbindungsaufbaus kam, gehört an den Anfang und wird jetzt nachgereicht.
    const earlyAudio = this.pendingCallerAudio
    this.pendingCallerAudio = []
    this.pendingCallerBytes = 0
    for (const frame of earlyAudio) this.pushCallerAudio(frame)
  }

  /**
   * Der Systemhinweis fürs Telefon.
   *
   * Setzt auf dem gewohnten auf, ergänzt aber, was am Telefon anders ist. Der
   * wichtigste Zusatz ist die Kürze: Am Bildschirm kann man einen langen
   * Absatz überfliegen, am Telefon muss man ihn abwarten.
   */
  private phonePrompt(): string {
    const names = phoneToolNames(this.owner, this.fullAccess)

    if (this.fullAccess) {
      return (
        buildSystemPrompt({ lazyTools: false }) +
        '\n\n## Du bist gerade am Telefon — mit vollem Zugriff\n\n' +
        'Der Nutzer ruft dich selbst an und hat sich mit seiner PIN ausgewiesen. Du kannst am ' +
        'Telefon alles, was du am Rechner kannst: Programme bedienen, Dateien, Mails, Recherchen, ' +
        'Smart Home, Musik, Bildschirmsteuerung. Halte dich kurz — zwei, drei Sätze, dann lass ihn ' +
        'reden. Sag vor jedem Werkzeug in einem Halbsatz an, was du tust, sonst hört er nur Stille. ' +
        'Den Bildschirm sieht er nicht: Beschreibe knapp, was passiert ist, statt etwas zu zeigen. ' +
        'Fragt ein Werkzeug nach, stell die Frage laut und warte auf ein klares Ja. Dauert etwas ' +
        'länger, läuft es im Hintergrund weiter und das Ergebnis kommt als Nachricht in [eckigen ' +
        'Klammern] — sag es ihm dann kurz. Erfinde keine Auskünfte. Willst du dich ' +
        'verabschieden, sag es deutlich.'
      )
    }

    // Was hier steht, muss zu dem passen, was tatsächlich deklariert wurde.
    // Der Satz "du hast keine Werkzeuge" stand hier noch, als die Auswahl aus
    // `phoneTools.ts` längst mitging — das Modell glaubte den Satz und sagte
    // ab, statt in den Kalender zu sehen.
    const toolBlock =
      names.length > 0
        ? 'Du hast eine kleine Auswahl schneller Werkzeuge: ' +
          names.join(', ') +
          '. Sag vorher in einem Halbsatz an, was du tust — "Moment, ich sehe im Kalender nach". ' +
          'Ohne diese Ansage hört der andere nur Stille und hält die Leitung für tot. ' +
          'Alles andere geht am Telefon nicht: keine Mails, kein Bildschirm, keine Dateien, ' +
          'keine Einkäufe. Sag das offen und biete an, es zu erledigen, sobald der Nutzer ' +
          'wieder am Rechner ist.' +
          (this.owner
            ? ' Will der Nutzer am Telefon alles können, muss er in den Einstellungen unter ' +
              'Zugänge eine Telefon-PIN einrichten — mit PIN hat er vollen Zugriff.'
            : '')
        : 'Du hast hier keine Werkzeuge: keine Websuche, keinen Bildschirm, keine Mails. ' +
          'Wirst du nach etwas gefragt, das du nur am Rechner könntest, sag das offen und ' +
          'biete an, es zu erledigen, sobald der Nutzer wieder davor sitzt.'

    return (
      buildSystemPrompt({ lazyTools: false }) +
      '\n\n## Du bist gerade am Telefon\n\n' +
      'Dieses Gespräch läuft über eine Telefonleitung, nicht über den Rechner. ' +
      'Halte dich kurz — zwei, drei Sätze am Stück, dann lass den anderen zu Wort kommen. ' +
      toolBlock +
      ' Erfinde keine Auskünfte. Willst du dich verabschieden, sag es deutlich — ' +
      'der andere sieht nicht, dass du fertig bist.'
    )
  }

  // ─────────────────────────────────────────────────────────────
  // Werkzeuge
  // ─────────────────────────────────────────────────────────────

  /**
   * Was der Anrufer zuletzt gesagt hat.
   *
   * Wird nur für `userTurn` gebraucht: `runTool` prüft damit, ob ein
   * `confirmed: true` durch eine echte Antwort gedeckt ist. Am Telefon steht
   * derzeit kein Werkzeug mit Rückfrage zur Verfügung — aber die Prüfung hängt
   * an dieser Angabe, und sie hier wegzulassen hieße, sie später beim ersten
   * solchen Werkzeug still zu verlieren.
   */
  private lastCallerText = ''
  private lastCallerTextAt = 0

  private async handleToolCalls(
    calls: { id?: string; name?: string; args?: Record<string, unknown> }[]
  ): Promise<void> {
    if (calls.length === 0 || this.closed) return

    // Gegen die erlaubte Liste prüfen, obwohl schon nur diese deklariert wurde.
    // Der Systemhinweis enthält den vollen Prompt vom Rechner; ein Modell, das
    // daraus einen Namen aufschnappt, soll ihn am Telefon nicht ausführen
    // können, sondern eine Absage bekommen.
    const allowed = new Set(phoneToolNames(this.owner, this.fullAccess))
    const userTurn = { lastUserText: this.lastCallerText, lastUserTextAt: this.lastCallerTextAt }

    const responses = await Promise.all(
      calls.map(async (call) => {
        const id = call.id ?? randomUUID()
        const name = call.name ?? ''

        if (!allowed.has(name)) {
          return {
            id,
            name,
            response: {
              error:
                `${name} steht am Telefon nicht zur Verfügung. Sag dem Anrufer, dass das nur ` +
                'am Rechner geht, und biete an, es später zu erledigen.'
            }
          }
        }

        // Der Zeitdeckel liegt hier und nicht im Werkzeug: Am Rechner darf
        // dieselbe Suche länger brauchen.
        //
        // Der Timer wird ausdrücklich wieder abgeräumt. `Promise.race` lässt
        // den Verlierer weiterlaufen, und ein offener Timeout hält den
        // Node-Eventloop am Leben — bei jedem Werkzeugaufruf einer, und beim
        // Beenden der App wartet sie darauf.
        let timer: NodeJS.Timeout | undefined
        // Fähigkeitslücken nur aus Gesprächen des Besitzers: Ein fremder
        // Anrufer hat dem Senden seiner Sätze nicht zugestimmt.
        const execute = () => runTool({ id, name, args: call.args ?? {}, userTurn })
        const running = this.owner ? execute() : withoutGapReports(execute)
        const result = await Promise.race([
          running,
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), TOOL_TIMEOUT_MS)
          })
        ]).finally(() => clearTimeout(timer))

        if (!result) {
          /*
           * Nicht abbrechen, sondern weiterlaufen lassen und nachreichen.
           *
           * Vorher hieß „dauert zu lange": Fehler, noch einmal versuchen — und
           * der zweite Versuch dauerte genauso lang. Jetzt bekommt das Modell
           * sofort Bescheid, dass es läuft, kann das ansagen und weiterreden,
           * und das Ergebnis kommt als eigene Nachricht, sobald es da ist.
           */
          void running.then((late) => this.deliverLate(name, late))
          return {
            id,
            name,
            response: {
              output:
                'Läuft noch im Hintergrund. Sag dem Anrufer kurz, dass es einen Moment dauert ' +
                'und du dich meldest. Das Ergebnis kommt gleich als Nachricht in eckigen Klammern.'
            }
          }
        }

        // Ein Fehler gehört als Inhalt in die Antwort, nicht als abgebrochener
        // Aufruf: sonst wartet das Modell weiter, und auf der Leitung ist Stille.
        return {
          id,
          name,
          response: result.ok
            ? { output: result.result ?? 'Erledigt.' }
            : { error: result.error ?? 'Unbekannter Fehler.' }
        }
      })
    )

    // Zwischen Aufruf und Antwort kann aufgelegt worden sein.
    if (this.closed || !this.session) return
    try {
      this.session.sendToolResponse({ functionResponses: responses })
    } catch (err) {
      this.finish(`Tool-Antwort ließ sich nicht senden: ${String(err).slice(0, 160)}`)
    }
  }

  /** Ein Ergebnis, das nach der Frist kam, ins laufende Gespräch geben. */
  private deliverLate(name: string, result: { ok: boolean; result?: unknown; error?: string }): void {
    if (this.closed || !this.session) return
    const body = result.ok
      ? JSON.stringify(result.result ?? 'Erledigt.').slice(0, 1500)
      : `Fehlgeschlagen: ${result.error ?? 'unbekannt'}`
    try {
      this.session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: `[Ergebnis von ${name}: ${body}] Sag es dem Anrufer kurz.` }] }],
        turnComplete: true
      })
    } catch {
      // Aufgelegt, während es lief — dann bleibt es im Aktionslog.
    }
  }

  /** Ein µ-law-Paket vom Telefon an die Live-API weiterreichen. */
  pushCallerAudio(muLaw: Buffer): void {
    if (this.closed) return
    if (!this.session) {
      // Höchstens zwei Sekunden aufheben. Damit bleibt die erste Äußerung
      // vollständig, ohne dass eine hängende Verbindung unbegrenzt wächst.
      const limit = 2 * 8000
      this.pendingCallerAudio.push(Buffer.from(muLaw))
      this.pendingCallerBytes += muLaw.length
      while (this.pendingCallerBytes > limit && this.pendingCallerAudio.length > 0) {
        this.pendingCallerBytes -= this.pendingCallerAudio.shift()!.length
      }
      return
    }
    const pcm8k = muLawToPcm8k(muLaw)
    const { out, last } = upsample8kTo16k(pcm8k, this.lastUpsampled)
    this.lastUpsampled = last
    try {
      this.session.sendRealtimeInput({
        audio: { data: pcmToBytes(out).toString('base64'), mimeType: 'audio/pcm;rate=16000' }
      })
    } catch (err) {
      this.finish(`Audio ließ sich nicht senden: ${String(err).slice(0, 160)}`)
    }
  }

  private onMessage(msg: LiveMessage): void {
    if (this.closed) return

    // Die Mitschrift zuerst: Sie steckt manchmal in derselben Nachricht wie
    // die Unterbrechung, und wer hier zuerst zurückkehrt, verliert den Satz,
    // der gerade zu Ende gesprochen wurde. Ton ist davon nicht betroffen —
    // der wird unten nach dem Leeren des Puffers eingereiht.
    const callerSaid = msg.serverContent?.inputTranscription?.text
    if (callerSaid) {
      this.lastCallerText = callerSaid
      this.lastCallerTextAt = Date.now()
      this.events.onTranscript('caller', callerSaid)
    }

    const jarvisSaid = msg.serverContent?.outputTranscription?.text
    if (jarvisSaid) this.events.onTranscript('jarvis', jarvisSaid)

    // Barge-in. Muss vor dem Ton kommen: Was hier noch im Puffer liegt,
    // gehört zur unterbrochenen Äußerung und darf nicht mehr raus.
    if (msg.serverContent?.interrupted) {
      this.pacer.clear()
      this.events.onClear()
      return
    }

    const parts = msg.serverContent?.modelTurn?.parts ?? []
    for (const part of parts) {
      const data = part.inlineData?.data
      if (typeof data !== 'string') continue
      const pcm24k = bytesToPcm(Buffer.from(data, 'base64'))
      this.pacer.push(this.downsampler.push(pcm24k))
    }

    // Der Grund, warum die Werkzeuge am Telefon bisher nichts taten: Sie gingen
    // als Deklaration hinaus, aber der Rückweg fehlte. Das Modell rief auf und
    // wartete auf eine Antwort, die niemand schickte — für den Anrufer sah das
    // aus, als hätte James mitten im Satz aufgehört.
    const toolCall = msg.toolCall ?? msg.tool_call
    if (toolCall) {
      const calls = toolCall.functionCalls ?? toolCall.function_calls ?? []
      void this.handleToolCalls(calls)
    }
  }

  /** Wie viel gesprochene Ausgabe noch aussteht — für ein sauberes Auflegen. */
  pendingMs(): number {
    return this.pacer.pendingMs()
  }

  private finish(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.pacer.stop()
    this.downsampler.reset()
    this.pendingCallerAudio = []
    this.pendingCallerBytes = 0
    if (this.hardStop) clearTimeout(this.hardStop)
    this.hardStop = null
    try {
      this.session?.close()
    } catch {
      // Schon zu.
    }
    this.session = null
    this.events.onClosed(reason)
  }

  stop(reason = 'Aufgelegt.'): void {
    this.finish(reason)
  }
}
