import type { Settings } from './types'

export type TransparencyStatus = 'active' | 'optional' | 'off' | 'unknown'
export type TransparencyGroup = 'storage' | 'models' | 'voice' | 'channels' | 'diagnostics'

export interface TransparencyItem {
  id: string
  group: TransparencyGroup
  title: string
  status: TransparencyStatus
  detail: string
}

/** Only exact loopback names count as local; LAN names and lookalike suffixes do not. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

/** Return a host only. Never expose URL credentials, path, query, fragment, or port. */
export function safeHostLabel(value: string): string | null {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    return hostname || null
  } catch {
    return null
  }
}

export function classifyServiceAddress(value: string): string {
  const host = safeHostLabel(value)
  if (!host) return 'Adresse nicht lesbar; keine URL-Details werden angezeigt.'
  return isLoopbackHost(host) ? `Loopback auf diesem Rechner (${host})` : `Host ${host} – extern/Netzwerk, nicht als lokal eingestuft`
}

function item(id: string, group: TransparencyGroup, title: string, status: TransparencyStatus, detail: string): TransparencyItem {
  return { id, group, title, status, detail }
}

const providerNames: Record<Settings['brainProvider'], string> = {
  gemini: 'Google Gemini', ollama: 'Ollama', openrouter: 'OpenRouter', openai: 'OpenAI',
  anthropic: 'Anthropic', chatgpt: 'ChatGPT', lmstudio: 'LM Studio'
}

function brainDestination(settings: Settings): string {
  switch (settings.brainProvider) {
    case 'ollama': return `${providerNames.ollama} (${classifyServiceAddress(settings.ollama.baseUrl)})`
    case 'lmstudio': return `${providerNames.lmstudio} (${classifyServiceAddress(settings.lmStudio.baseUrl)})`
    default: return providerNames[settings.brainProvider]
  }
}

function speechOutputName(provider: Settings['speech']['provider']): string {
  return ({ gemini: 'Gemini Live', openai: 'OpenAI Realtime', elevenlabs: 'ElevenLabs', piper: 'Piper', vibevoice: 'VibeVoice' })[provider]
}

/** Build disclosure rows from saved settings only; no credential values are required. */
export function deriveTransparencyItems(settings: Settings | null): TransparencyItem[] {
  if (!settings) return [
    item('local-records', 'storage', 'Lokale App-Daten', 'unknown', 'Einstellungen noch nicht geladen.'),
    item('credentials', 'storage', 'Zugänge', 'unknown', 'Einstellungen noch nicht geladen.'),
    item('model-context', 'models', 'Modell-Kontext', 'unknown', 'Einstellungen noch nicht geladen.'),
    item('text-brain', 'models', 'Textaufgaben / Denkmodell', 'unknown', 'Einstellungen noch nicht geladen.'),
    item('gemini-special', 'models', 'Gemini-Spezialfunktionen und Einbettungen', 'unknown', 'Einstellungen noch nicht geladen.'),
    item('learning', 'models', 'Hintergrundlernen', 'unknown', 'Einstellungen noch nicht geladen.'),
    item('speech-route', 'voice', 'Sprachweg', 'unknown', 'Einstellungen noch nicht geladen.'),
    item('calendar', 'channels', 'Kalender', 'unknown', 'Einstellungen noch nicht geladen.'),
    item('companion', 'channels', 'Companion / Telefon-Steuerung', 'unknown', 'Einstellungen noch nicht geladen.'),
    item('alexa', 'channels', 'Alexa / Echo', 'unknown', 'Einstellungen noch nicht geladen.'),
    item('sip', 'channels', 'SIP-Telefonie', 'unknown', 'Einstellungen noch nicht geladen.'),
    item('phone', 'channels', 'Telefon über Twilio', 'unknown', 'Einstellungen noch nicht geladen.'),
    item('diagnostics', 'diagnostics', 'Diagnosebericht', 'unknown', 'Einstellungen noch nicht geladen.'),
    item('auto-diagnostics', 'diagnostics', 'Automatische Diagnose', 'unknown', 'Einstellungen noch nicht geladen.'),
    item('capability-gaps', 'diagnostics', 'Funktionslücken-Meldungen', 'unknown', 'Einstellungen noch nicht geladen.')
  ]

  const rows: TransparencyItem[] = [
    item('local-records', 'storage', 'Lokale App-Daten', 'active', 'Aufgaben, Board-/Packzustände, Datenbank, Gesprächsverlauf und Arbeitsstand werden lokal in den App-Daten gespeichert. Lokal gespeichert heißt nicht, dass alle Verarbeitung offline bleibt.'),
    item('credentials', 'storage', 'Zugänge', 'active', 'Zugangsdaten liegen im geschützten Speicher. Verschlüsselung wird nur zugesagt, wenn Electron safeStorage des Betriebssystems verfügbar hat; sonst verweigert die App das Speichern neuer Schlüssel.'),
    item('model-context', 'models', 'Modell-Kontext', 'active', 'Ein Modell-Prompt kann deine Anfrage sowie dazu passende Erinnerungen, Arbeitsstand und Ergebnisse verwendeter Werkzeuge enthalten. Kontext-/Token-Limits begrenzen Länge, sind aber keine Datenschutzschranke.'),
    item('text-brain', 'models', 'Textaufgaben / Denkmodell', 'active', `Eingestellter Anbieter: ${brainDestination(settings)}. Reine Textanfragen gehen dorthin; je nach Aufgabe und Verfügbarkeit kann ein Rückfallanbieter verwendet werden. Das tatsächlich antwortende Modell kann daher abweichen.`),
    item('gemini-special', 'models', 'Gemini-Spezialfunktionen und Einbettungen', settings.brainProvider === 'gemini' ? 'active' : 'optional', 'Gemini bleibt für daran gebundene Funktionen wie Web-/Grounding, Seitenabruf, Bildaufgaben und bestimmte Sprachwege zuständig. Einbettungen für Gedächtnissuche versuchen unabhängig vom eingestellten Textmodell zunächst Gemini; bei Ausfall folgt ein lokaler Einbettungsweg, sonst Wortsuche.'),
    item('learning', 'models', 'Hintergrundlernen', settings.learnSkills ? 'optional' : 'off', settings.learnSkills ? 'Eingeschaltet: Nach erfolgreichen Werkzeugabläufen kann im Hintergrund eine Textanfrage mit Ablauf-/Werkzeugschritten an den konfigurierten Textanbieter gehen; daraus entstehen erst Vorschläge, die geprüft werden.' : 'Ausgeschaltet: Die Hintergrundprüfung erfolgreicher Abläufe läuft nicht.'),
    item('speech-route', 'voice', 'Sprachweg', 'active', speechRoute(settings)),
    item('calendar', 'channels', 'Kalender', 'optional', 'Das Tages-Cockpit liest Google-Kalender oder eine eingerichtete ICS-Quelle erst nach der dortigen Aktivierung und kann die Termine danach aktualisieren. Diese Anzeige allein sendet die Termine nicht an eine KI. Bei einem gezielten Kalender-Werkzeugaufruf können angeforderte Terminergebnisse anschließend Teil des Modell-Kontexts werden. Der Aktivierungszustand wird im Cockpit separat angezeigt.'),
    item('companion', 'channels', 'Companion / Telefon-Steuerung', settings.companion.enabled ? 'active' : 'off', settings.companion.enabled ? `Companion ist eingeschaltet (${settings.companion.certSource === 'tailscale' ? 'Tailscale' : 'lokales Zertifikat'}). Eingaben/Audio vom verbundenen Telefon werden über diesen Kanal an die App übermittelt und folgen dem oben gezeigten Modellweg.` : 'Companion ist ausgeschaltet; Telefonsteuerung über diesen Kanal ist nicht aktiv.'),
    item('alexa', 'channels', 'Alexa / Echo', settings.alexa.enabled ? 'active' : 'off', settings.alexa.enabled ? 'Alexa ist eingeschaltet: Amazon verarbeitet die am Echo gesprochene Anfrage. Der authentifizierte Alexa-Auftrag erreicht die App und kann dem Modellweg folgen; die Assistentenantwort geht zurück an Alexa/Amazon. Das ist kein rein lokaler Sprachweg.' : 'Die Alexa-Anbindung der App ist ausgeschaltet. Das schaltet die eigenständige Sprachverarbeitung eines Echo-Geräts nicht ab.'),
    item('sip', 'channels', 'SIP-Telefonie', settings.sip.enabled ? 'active' : 'off', settings.sip.enabled ? 'SIP ist eingeschaltet. Gesprächsinhalt läuft über das eingerichtete SIP-Konto und kann, sofern der Assistent verarbeitet, dem Modell-Kontext folgen.' : 'SIP-Telefonie ist ausgeschaltet.'),
    item('phone', 'channels', 'Telefon über Twilio', settings.telephony.conversation || settings.telephony.incoming ? 'active' : 'off', settings.telephony.conversation || settings.telephony.incoming ? `Telefon-Gesprächskanal ist eingeschaltet${settings.telephony.incoming ? ', einschließlich eingehender Anrufe' : ''}. Gesprächsinhalte werden über Twilio/Telefonnetz transportiert; KI-Verarbeitung folgt dem Sprachweg.` : 'Gesprächsmodus und eingehende Telefonate sind ausgeschaltet.'),
    item('diagnostics', 'diagnostics', 'Diagnosebericht', settings.diagnosticReporting.enabled ? 'optional' : 'off', settings.diagnosticReporting.enabled ? 'Berichtversand ist zugelassen, aber nicht automatisch durch diese Anzeige ausgelöst. Beim Senden gehen technische Meldungsdaten an den konfigurierten Diagnoseempfänger.' : 'Diagnose-Berichtversand ist ausgeschaltet.'),
    item('auto-diagnostics', 'diagnostics', 'Automatische Diagnose', settings.diagnosticReporting.enabled && settings.diagnosticReporting.automatic ? 'active' : 'off', settings.diagnosticReporting.enabled && settings.diagnosticReporting.automatic ? 'Automatischer Versand ist laut Einstellungen eingeschaltet; technische Diagnoseereignisse können an den Diagnoseempfänger gesendet werden.' : 'Automatischer Diagnoseversand ist laut Einstellungen nicht eingeschaltet.'),
    item('capability-gaps', 'diagnostics', 'Funktionslücken-Meldungen', settings.diagnosticReporting.enabled && settings.diagnosticReporting.capabilityGaps ? 'optional' : 'off', settings.diagnosticReporting.enabled && settings.diagnosticReporting.capabilityGaps ? 'Meldungen zu nicht unterstützten Fähigkeiten können an den Diagnoseempfänger gesendet werden.' : 'Meldungen zu Funktionslücken sind ausgeschaltet.')
  ]
  return rows
}

function speechRoute(settings: Settings): string {
  const speech = settings.speech
  if (speech.provider === 'gemini') return 'Gemini Live hört, verarbeitet und spricht in einem verbundenen externen Dienst; Audio und Gesprächsinhalte verlassen den Rechner. Bei einem Ausfall kann der Controller auf einen anderen Live-Weg wechseln.'
  if (speech.provider === 'openai') return 'OpenAI Realtime hört, verarbeitet und spricht in einem verbundenen externen Dienst; Audio und Gesprächsinhalte verlassen den Rechner. Wenn Realtime aufgibt, kann Gemini Live übernehmen.'
  const hear = speech.hearProvider === 'whisper' ? 'Whisper (lokale Audio-Erkennung)' : 'Gemini (Audio zur externen Transkription)'
  const think = speech.thinkProvider === 'ollama'
    ? `Ollama (${classifyServiceAddress(settings.ollama.baseUrl)})`
    : speech.thinkProvider === 'chatgpt' ? 'ChatGPT' : speech.thinkProvider === 'hermes'
      ? `Hermes (${classifyServiceAddress(settings.hermes.baseUrl)})` : 'Gemini'
  const speak = speech.provider === 'piper' ? 'Piper lokal' : speech.provider === 'vibevoice' ? 'VibeVoice lokal' : speech.provider === 'elevenlabs' ? 'ElevenLabs extern' : speechOutputName(speech.provider)
  return `Zusammengesetzter Weg: Hören über ${hear}; Denken über ${think}; Sprechen über ${speak}. Bei Gemini-Hören geht Audio hinaus; bei Whisper bleibt die Erkennung lokal. Gemini-/ChatGPT-Denken und ElevenLabs-Sprachausgabe übertragen jeweils die dafür nötigen Inhalte an diese Anbieter. Lokale Hörer-/Sprecher-Komponenten machen nicht automatisch Denken oder den gesamten Ablauf offline.`
}
