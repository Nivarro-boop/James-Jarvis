import { registerRemedy } from './index'
import { getSecret } from '../secrets/keystore'
import { getSettings, setSettings } from '../store/settings'
import {
  forgetOllamaReachability,
  listOllamaModels,
  ollamaReachable,
  startOllama
} from '../providers/ollama'
import { startIncoming, shutdownTelephony } from '../telephony'
import { forgetPiperWarmup, piperHealth } from '../providers/piper'
import { forgetWhisperWarmup, whisperHealth } from '../providers/whisper'
import { installLocalAsset, localAssets } from '../local/assets'

/**
 * Die Gegenmittel.
 *
 * Jedes einzelne behebt etwas, das sich zur Laufzeit beheben lässt — einen
 * abgestürzten Prozess, einen belegten Port, einen Anbieter, der nicht
 * antwortet. Keines ändert Quelltext.
 *
 * Die Reihenfolge ist die Suchreihenfolge: Das erste passende gewinnt.
 * Deshalb steht das Genaue vor dem Allgemeinen.
 */

export interface RuntimeRepairHooks {
  restartCompanion?(): Promise<boolean>
  reloadRenderer?(): Promise<boolean>
}

export function registerAllRemedies(hooks: RuntimeRepairHooks = {}): void {
  /**
   * Das Weckwort-Modell fehlt.
   *
   * Herunterladen lässt sich der Klassifikator nicht (Lizenz), aber James soll
   * trotzdem aufwachen: Weckwort aus, Klatschen an. Hotkey und Klick bleiben.
   * Wer später ein Modell ablegt, schaltet das Weckwort unter Zuhören wieder ein.
   */
  registerRemedy({
    name: 'weckwort-durch-klatschen-ersetzen',
    maxPerHour: 2,
    applies: (i) => i.area === 'live' && (i.code === 'wake-modell-fehlt' || i.code === 'wakeword-fehler'),
    async apply() {
      const wake = getSettings().wake
      // Schon umgestellt (früherer Lauf, späte Meldung des Fensters): nichts zu
      // tun — und vor allem kein Neuladen der Oberfläche, das eine laufende
      // Sitzung kappt und die nächste Meldung gleich wieder auslöst.
      if (!wake.enabled && wake.clap) return true
      setSettings({ wake: { ...wake, enabled: false, clap: true } })
      hooks.reloadRenderer?.().catch(() => undefined)
      return true
    },
    describe: (healed) =>
      healed
        ? 'Weckwort-Modell fehlt — James wacht jetzt auf zweimaliges Klatschen, Hotkey oder Klick auf.'
        : 'Weckwort-Modell fehlt.'
  })

  /**
   * Die gewählte Stimme hat keinen Zugang.
   *
   * Ohne ElevenLabs-Schlüssel schweigt James. Liegt ein Gemini- oder
   * OpenAI-Schlüssel vor, spricht James über den Live-Weg weiter.
   */
  registerRemedy({
    name: 'auf-live-stimme-wechseln',
    maxPerHour: 2,
    applies: (i) => i.area === 'stimme' && i.code === 'elevenlabs-zugang-fehlt',
    async apply() {
      const speech = getSettings().speech
      const provider = getSecret('gemini') ? 'gemini' : getSecret('openai') ? 'openai' : null
      if (!provider) return false
      setSettings({ speech: { ...speech, provider } })
      hooks.reloadRenderer?.().catch(() => undefined)
      return true
    },
    describe: (healed) =>
      healed
        ? 'ElevenLabs-Schlüssel fehlt — James spricht jetzt über den Live-Weg.'
        : 'ElevenLabs-Schlüssel fehlt und kein Gemini- oder OpenAI-Schlüssel als Ersatz vorhanden.'
  })

  /**
   * Der Port ist belegt.
   *
   * Passiert nach einem harten Ende der App: Der alte Prozess hält den Port
   * noch. Einen anderen zu nehmen ist billiger, als auf die Zeitüberschreitung
   * des Betriebssystems zu warten.
   */
  registerRemedy({
    name: 'anderer-port',
    maxPerHour: 5,
    applies: (i) => i.code === 'port-belegt',
    async apply(i) {
      if (i.area === 'telefonie') {
        const telephony = getSettings().telephony
        // Der öffentliche Eingang probiert fünf Ports. Sind wirklich alle
        // belegt, muss die nächste Suche dahinter beginnen statt im selben
        // belegten Fünferblock noch einmal anzusetzen.
        setSettings({ telephony: { ...telephony, port: telephony.port + 5 } })
        const status = await startIncoming()
        return status.running
      }
      if (i.area === 'fernbedienung') {
        const companion = getSettings().companion
        // Hauptseite, Kristall-Brücke und Zertifikatsstelle liegen auf drei
        // aufeinanderfolgenden Ports. Gemeinsam verschieben, nicht ineinander.
        setSettings({ companion: { ...companion, port: companion.port + 3 } })
        return hooks.restartCompanion ? hooks.restartCompanion() : true
      }
      return false
    },
    describe: (healed) =>
      healed ? 'Der Dienst läuft jetzt auf dem nächsten freien Port.' : 'Auch der nächste Port war belegt.'
  })

  /**
   * Piper fehlt etwas auf der Platte — Programm oder Stimme.
   *
   * Ein Neustart hilft dann nie, er lief früher trotzdem bis zu
   * zwanzigmal in der Stunde. Stattdessen holen, was fehlt. Geht das nicht
   * (kein Netz, Server weg), auf Geminis Stimme zurück, damit James nicht
   * stumm bleibt.
   */
  registerRemedy({
    name: 'piper-nachladen',
    maxPerHour: 2,
    applies: (i) =>
      i.area === 'stimme' &&
      i.code === 'piper-nicht-bereit' &&
      localAssets().some((a) => (a.id === 'piper-runtime' || a.id === 'piper-voice') && !a.present),
    async apply() {
      try {
        for (const asset of localAssets()) {
          if ((asset.id === 'piper-runtime' || asset.id === 'piper-voice') && !asset.present) {
            await installLocalAsset(asset.id)
          }
        }
        forgetPiperWarmup()
        if ((await piperHealth()).ok) return true
      } catch (err) {
        console.warn('[selbstheilung] piper nachladen fehlgeschlagen:', String(err).slice(0, 200))
      }
      const speech = getSettings().speech
      if (speech.provider === 'piper') setSettings({ speech: { ...speech, provider: 'gemini' } })
      return false
    },
    describe: (healed) =>
      healed
        ? 'Was Piper fehlte, wurde heruntergeladen. Die lokale Stimme spricht wieder.'
        : 'Piper ließ sich nicht vervollständigen. Die Stimme steht vorerst auf Gemini.'
  })

  registerRemedy({
    name: 'piper-neustart',
    maxPerHour: 3,
    applies: (i) => i.area === 'stimme' && ['piper-beendet', 'piper-nicht-bereit'].includes(i.code),
    async apply() {
      forgetPiperWarmup()
      return (await piperHealth()).ok
    },
    describe: (healed) =>
      healed ? 'Die lokale Piper-Stimme wurde neu gestartet.' : 'Piper ließ sich nicht neu starten.'
  })

  registerRemedy({
    name: 'whisper-neustart',
    maxPerHour: 3,
    applies: (i) => i.area === 'stimme' && ['whisper-beendet', 'whisper-nicht-bereit'].includes(i.code),
    async apply() {
      forgetWhisperWarmup()
      return (await whisperHealth()).ok
    },
    describe: (healed) =>
      healed ? 'Die lokale Spracherkennung wurde neu gestartet.' : 'Whisper ließ sich nicht neu starten.'
  })

  registerRemedy({
    name: 'telefonie-neustart',
    maxPerHour: 3,
    applies: (i) => i.area === 'telefonie' && i.code === 'dienst-beendet',
    async apply() {
      let status = await startIncoming()
      if (!status.running && /port[^.]*belegt/i.test(status.hint ?? '')) {
        const telephony = getSettings().telephony
        setSettings({ telephony: { ...telephony, port: telephony.port + 5 } })
        status = await startIncoming()
      }
      return status.running
    },
    describe: (healed) =>
      healed
        ? 'Der Dienst für eingehende Anrufe wurde neu gestartet.'
        : 'Der Dienst für eingehende Anrufe ließ sich nicht neu starten.'
  })

  registerRemedy({
    name: 'telefon-begleiter-neustart',
    maxPerHour: 3,
    applies: (i) => i.area === 'fernbedienung' && i.code === 'dienst-beendet',
    async apply() {
      return hooks.restartCompanion ? hooks.restartCompanion() : false
    },
    describe: (healed) =>
      healed
        ? 'Der Telefon-Begleiter wurde neu gestartet.'
        : 'Der Telefon-Begleiter ließ sich nicht neu starten.'
  })

  registerRemedy({
    name: 'oberflaeche-neuladen',
    maxPerHour: 2,
    disruptive: true,
    applies: (i) => i.area === 'live' && i.code === 'renderer-beendet',
    async apply() {
      return hooks.reloadRenderer ? hooks.reloadRenderer() : false
    },
    describe: (healed) =>
      healed ? 'Die Oberfläche wurde neu geladen.' : 'Die Oberfläche ließ sich nicht neu laden.'
  })

  /**
   * Ollama meldet sich nicht.
   *
   * Die gemerkte Erreichbarkeit verwerfen und nachsehen. Ist Ollama auf diesem
   * Rechner installiert, aber nicht gestartet, darf die Selbstheilung den
   * lokalen Dienst selbst hochfahren. Für eine fremde Adresse wird weiterhin
   * ausschließlich geprüft; ein lokaler Dienst wäre dafür kein Ersatz.
   */
  registerRemedy({
    name: 'ollama-neu-pruefen',
    maxPerHour: 10,
    applies: (i) =>
      i.area === 'gemini' &&
      ['reserve-nicht-erreichbar', 'denkmodell-nicht-erreichbar'].includes(i.code),
    async apply(incident) {
      forgetOllamaReachability()
      const fromContext = incident.context?.baseUrl
      const baseUrl =
        typeof fromContext === 'string' && fromContext.trim()
          ? fromContext
          : getSettings().localFallback.baseUrl
      if (await ollamaReachable(baseUrl)) return true
      return startOllama(baseUrl)
    },
    describe: (healed) =>
      healed
        ? 'Ollama ist jetzt erreichbar.'
        : 'Ollama läuft nicht — die Reserve steht nicht bereit.'
  })

  /**
   * Der Tunnel steht, aber Twilio kommt nicht durch.
   *
   * Zumachen und beim nächsten Anruf neu aufbauen. Einen halb offenen Tunnel
   * stehen zu lassen ist die schlechtere von zwei Möglichkeiten: Er sieht von
   * außen aus wie ein Angebot und ist keines.
   */
  registerRemedy({
    name: 'tunnel-neu-aufbauen',
    maxPerHour: 3,
    applies: (i) => i.area === 'telefonie' && i.code === 'tunnel-unerreichbar',
    async apply() {
      await shutdownTelephony()
      return true
    },
    describe: () => 'Der Tunnel wurde geschlossen und wird beim nächsten Anruf neu aufgebaut.'
  })

  /**
   * Geminis Kontingent ist leer.
   *
   * Dagegen hilft kein Neustart — nur die Reserve. Das Gegenmittel schaltet
   * sie ein, wenn Ollama läuft, und sagt sonst, was fehlt. Es ist damit
   * ausdrücklich kein Gegenmittel für die Sprachschleife: Die braucht natives
   * Audio, und dafür gibt es lokal nichts.
   */
  registerRemedy({
    name: 'reserve-einschalten',
    maxPerHour: 2,
    applies: (i) => i.area === 'gemini' && i.code === 'kontingent-leer',
    async apply() {
      const local = getSettings().localFallback
      if (local.enabled) return false
      forgetOllamaReachability()
      if (!(await ollamaReachable(local.baseUrl))) return false

      /*
       * Erreichbar allein reicht nicht.
       *
       * Vorher wurde hier nur der Schalter umgelegt und „läuft jetzt über
       * Ollama" gemeldet. Steht im Modellfeld aber nichts — der Auslieferstand
       * ist leer — oder ein Name, den es nicht mehr gibt, dann scheitert der
       * erste Rückfall an einem 404, und die Selbstheilung hat eine Meldung
       * abgegeben, die nicht stimmte. Also erst nachsehen, ob überhaupt
       * etwas da ist, das schreiben kann.
       */
      const usable = (await listOllamaModels(local.baseUrl)).filter((m) => !m.embedding)
      if (usable.length === 0) return false

      const model = usable.some((m) => m.name === local.model)
        ? local.model
        : (usable.find((m) => m.tools) ?? usable[0]).name

      setSettings({ localFallback: { ...local, enabled: true, model } })
      return true
    },
    describe: (healed) =>
      healed
        ? 'Die lokale Reserve wurde eingeschaltet — Übersetzen läuft jetzt über Ollama.'
        : 'Geminis Kontingent ist aufgebraucht und es steht keine lokale Reserve bereit.'
  })

  /**
   * Ein Werkzeug scheitert wiederholt an derselben Stelle.
   *
   * Hier gibt es bewusst keine Reparatur. Das Gegenmittel besteht darin, es
   * *nicht* weiter zu versuchen und die Störung stehen zu lassen, damit sie
   * im Bericht auftaucht. Ein drittes Mal dasselbe zu versuchen wäre keine
   * Selbstheilung, sondern Sturheit.
   */
  registerRemedy({
    name: 'werkzeug-aufgeben',
    maxPerHour: 0,
    applies: (i) => i.area === 'werkzeug',
    async apply() {
      return false
    },
    describe: () => 'Das Werkzeug scheitert wiederholt an derselben Stelle und wurde ausgesetzt.'
  })
}
