import { COMPANION_DEFAULT_PORT } from '../companion'
import type { Settings } from '../types'

export const DEFAULT_SETTINGS: Settings = {
  assistantRole: 'personal',
  language: 'de-DE',
  homeLocation: '',
  diagnosticReporting: { enabled: false, automatic: false, capabilityGaps: false, url: 'https://fastidious-pastelito-1f1564.netlify.app/api/error-report' },

  // Current documented Live model. Existing model choices remain selectable.
  liveModel: 'gemini-3.8-live',
  /*
   * Sulafat statt Charon.
   *
   * Charon ist bei Google als "informativ" geführt, und genau so klingt sie
   * auch: die Stimme einer Ansage. Für den Weg, auf dem Gemini selbst spricht,
   * ist das der falsche Eindruck — hier redet niemand mit einem Publikum.
   * Sulafat ist die einzige der dreißig, die als "warm" geführt wird.
   *
   * Nachgehört ist das nicht, sondern nach den Angaben des Anbieters gewählt.
   * Die vollständige Liste steht mitsamt ihren Beschreibungen in `VOICES` und
   * in den Einstellungen unter Stimme; ein anderer Eindruck ist dort eine
   * Auswahl weit.
   */
  voice: 'Sulafat',

  // Die Butler-Haltung ist die Voreinstellung, weil sie der Grund ist,
  // warum das Ding James heißt. Wem das zu viel Butler ist, stellt auf
  // sachlich um — der Inhalt bleibt derselbe, nur der Ton nicht.
  persona: 'jarvis',
  personality: { humor: 1, address: 'auto', name: 'James' },

  /**
   * Drei Wege, und sie stehen absichtlich nicht gleich.
   *
   * Gesprochen wird ab Werk hier, gehört und gedacht draußen. Das sieht nach
   * einem halben Bekenntnis aus und ist eine Frage des Rückwegs: Fehlt die
   * lokale Stimme, tritt der Live-Motor an ihre Stelle und Gemini spricht — zu
   * hören ist eine andere Stimme, kein Ausfall. Für Abschrift und Kopf gibt es
   * das nicht. Fehlt whisper, kommt ein leerer Wortlaut zurück; antwortet
   * Ollama nicht, steht der Beitrag. Beides sind Downloads von hunderten
   * Megabyte, die niemand gemacht hat, der die App gerade zum ersten Mal
   * öffnet, und eine Voreinstellung, die auf etwas Nichtvorhandenes zeigt,
   * macht aus dem ersten Satz eine Fehlersuche.
   *
   * Wer die Stücke geholt hat, stellt unter Stimme und Ohren um — und findet dort
   * auch, was der Wechsel kostet. Was gerade wirklich läuft, steht in den
   * Einstellungen; geraten wird nichts.
   */
  speech: {
    provider: 'piper',
    // Beide draußen, und warum, steht oben: Für sie gibt es keinen Rückweg.
    hearProvider: 'gemini',
    thinkProvider: 'gemini',
    // Klein und schnell. Auf diesem Weg wartet jemand mit offenem Mund, und
    // ein besseres Modell, das eine Sekunde länger braucht, ist hier das
    // schlechtere.
    brainModel: 'gemini-3.5-flash-lite',
    // Abtippen kann das kleinste Modell, und es passiert bei jedem Beitrag.
    transcribeModel: 'gemini-3.5-flash-lite',
    /**
     * 420 ms Stille, dann geht der Beitrag hinaus.
     *
     * Das ist die Wartezeit vor jeder Antwort und damit der Regler, an dem man
     * "zu langsam" merkt. Die 700 der Live-Sitzung wären hier zu viel: Dort
     * hört der Server schon während des Redens zu, hier fängt die Arbeit erst
     * nach der Stille an. Zu kurz gesetzt fällt er einem ins Wort, sobald man
     * mitten im Satz überlegt.
     */
    endpointMs: 420,
    elevenVoiceId: '',
    elevenModelId: '',
    // Flash kostet über die API nur halb so viele Credits je Zeichen. Zusammen
    // mit kurzen, sprachgerechten Antworten hält die Stimme damit ungefähr
    // doppelt so lange wie mit Multilingual v2.
    elevenPlan: 'saving',
    realtimeModel: 'gpt-realtime',
    realtimeVoice: 'marin',
    // Ein Sprachassistent soll lebendig klingen, aber nicht schwanken. Etwas
    // unter der Mitte ist der Punkt, an dem Betonung entsteht, ohne dass zwei
    // Sätze hintereinander verschieden klingen.
    stability: 0.35,
    similarity: 0.75,
    /*
     * Ein Drittel Stil.
     *
     * Hier stand null, mit der Begründung: Ein Butler betont, er spielt nicht.
     * Der Satz stimmt für einen Menschen und nicht für ein Modell — dessen
     * Null bedeutet nicht "zurückhaltend", sondern "gar keine Absicht in der
     * Betonung", und das Ergebnis ist die gleichmäßige Ansage einer Maschine.
     * Ein Drittel ist gerade so viel, dass Fragen wie Fragen klingen.
     *
     * Der Preis steht in `elevenVoice.ts`: Stil kostet auf der Gegenseite
     * Rechenzeit und damit Verzögerung, und über der Hälfte fangen die Sätze
     * an, untereinander zu schwanken.
     */
    style: 0.35,
    // Eine Spur unter eins. Gesetzt statt gehetzt, und verständlicher dazu.
    speed: 0.96,
    // Ungefähr zwei gesprochene Antworten Vorrat. Genau bei null umzuschalten
    // hieße, mitten im Satz zu verstummen.
    reserveChars: 600,

    // VibeVoice, falls jemand den dritten Weg wählt: lokal, ohne Kontingent,
    // dafür mit gut zwei Sekunden bis zum ersten Wort. Der Dienst wird nur
    // gestartet, wenn `provider` darauf steht.
    speaker: 'de-Spk0_man',
    port: 8791,
    pythonPath: '',
    voicesPath: ''
  },

  brainModel: 'gemini-3.6-flash',

  // Standard bleibt Gemini: der Schlüssel ist ohnehin da, und ein zweiter
  // Anbieter, den man erst einrichten muss, wäre als Voreinstellung nur eine
  // zusätzliche Fehlerquelle.
  brainProvider: 'gemini',
  chatGptModel: '',
  openRouterModel: 'anthropic/claude-3.5-haiku',
  lmStudio: { baseUrl: 'http://127.0.0.1:1234/v1', model: '' },
  // Jeweils das kleine, günstige Modell — Textaufgaben sind Übersetzen und
  // Verdichten, dafür braucht es kein Spitzenmodell.
  openAiModel: 'gpt-5-mini',
  anthropicModel: 'claude-haiku-4-5',
  // Ein kurzer Textaufruf nach getaner Arbeit — billig, und genau das, was
  // James mit der Zeit besser macht.
  learnSkills: true,

  // Die übliche Adresse eines laufenden Ollama. Ohne Modellnamen passiert
  // nichts — welches da ist, weiß nur der Rechner, und Geratenes wäre beim
  // ersten Versuch ein Fehler statt einer Antwort.
  ollama: {
    baseUrl: 'http://127.0.0.1:11434',
    model: '',
    keepAliveMin: 30
  },

  /**
   * Alle Pfade leer: Das heißt nicht "nicht eingerichtet", sondern "dort, wohin
   * die Beschaffung geladen hat". Ein fest eingebauter Pfad wäre auf einem
   * anderen Rechner falsch, und ein geratener wäre schlimmer als ein leerer —
   * er sähe eingerichtet aus.
   */
  whisper: {
    dir: '',
    modelPath: '',
    vadModelPath: '',
    // Nicht 8080: der ist unter Windows notorisch belegt, und ein Dienst, der
    // beim Start auf einen fremden Server trifft, meldet keinen Fehler — er
    // schickt seine Anfragen dorthin.
    port: 8642,
    // 0 heißt: aus der Kernzahl dieses Rechners ableiten. Die Vorgabe des
    // Servers ist min(4, Kerne) und lässt auf einem Achtkerner die Hälfte liegen.
    threads: 0,
    // Die Untergrenze, unterhalb derer die Erkennung kippt. Was ein konkreter
    // Beitrag davon braucht, rechnet der Dienst aus seiner Länge aus.
    audioCtx: 768,
    vad: true
  },

  piper: {
    // Erst die eigenständige Fassung, und bei Absturz Python. Siehe PiperSettings.
    backend: 'auto',
    exeDir: '',
    pythonPath: '',
    voicePath: '',
    lengthScale: 1
  },

  researchAgent: 'deep-research-preview-04-2026',
  visionModel: 'gemini-3.6-flash',

  audio: {
    inputDeviceId: null,
    outputDeviceId: null,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    outputEqEnabled: true,
    outputHighShelfGainDb: 3.5,
    outputCompressorEnabled: true,
    outputGain: 1.0,
    jitterBufferMs: 100,
    halfDuplex: true
  },

  vad: {
    // Der wichtigste Wert der ganzen App. Googles Default von 100 ms schneidet
    // dich ab, sobald du mitten im Satz kurz überlegst.
    silenceDurationMs: 700,
    prefixPaddingMs: 100,
    startSensitivity: 'HIGH',
    endSensitivity: 'LOW',
    localGateEnabled: true,
    // Auf derselben Skala wie der Kristallpegel. Normale Sprache landet bei
    // 0,4 bis 0,8, Raumgrundrauschen unter 0,1 — 0,15 trennt beides sicher.
    // Höher gesetzt schneidet er leise Satzanfänge ab.
    localGateThreshold: 0.15
  },

  wake: {
    enabled: true,
    threshold: 0.5,
    // Der mitgelieferte Klassifikator. Weitere legt `npm run wakeword` in
    // `src/renderer/public/wakeword/` ab — siehe Einstellungen → Zuhören.
    modelName: 'hey_james.onnx',
    clap: true,
    pushToTalkHotkey: 'Alt+Space',
    pauseHotkey: 'Alt+Shift+Space',
    idleDisconnectSec: 45
  },

  tokenSaver: {
    enabled: true,
    // 1400 Zeichen sind ungefähr das, was in einer gesprochenen Antwort
    // überhaupt vorkommen kann. Alles darüber zahlt man, ohne es je zu hören.
    maxResultChars: 1400,
    cacheTtlSec: 120,
    slimDeclarations: true
  },

  permissions: {},
  gamingMode: false,
  confirmActions: false,
  automaticBackups: true,
  hermes: { baseUrl: 'http://127.0.0.1:8642', model: 'hermes-agent' },
  mcpServers: [],
  dailyCostLimitUsd: 0,
  launchOnStartup: false,

  // Österreich als Vorgabe: Die App wird hier benutzt, und eine falsche
  // Landesvorwahl fällt erst auf, wenn ein Anruf ohne erkennbaren Grund
  // scheitert. Umstellbar in den Einstellungen.
  sip: {
    enabled: false,
    username: '',
    domain: 'sip.linphone.org',
    userAddress: '',
    fullAccess: false
  },
  telephony: {
    country: 'AT',
    voice: 'Polly.Vicki',

    // Aus: Das Gespräch braucht einen Tunnel aus dem offenen Netz auf diesen
    // Rechner. Wer das will, schaltet es ein und liest dabei, was es bedeutet.
    conversation: false,
    publicUrl: '',
    port: 8790,
    opening: 'Hallo, hier ist James. Was kann ich für Sie tun?',

    // Auch aus, und zwar getrennt vom Gespräch: Anrufe anzunehmen hält den
    // Tunnel offen, solange die App läuft. Das ist eine andere Zusage als
    // „einmal telefonieren", und sie gehört eigens gegeben.
    incoming: false,
    incomingGreeting: 'Hier ist James. Was brauchst du?'
  },

  // Aus, weil ein Rückfall auf ein Modell, das gar nicht installiert ist, nur
  // eine zweite Fehlerquelle wäre. Wer Ollama laufen hat, schaltet es ein und
  // sieht in den Einstellungen sofort, welche Modelle bereitstehen.
  localFallback: {
    enabled: false,
    baseUrl: 'http://127.0.0.1:11434',
    // Leer, nicht geraten. Hier stand `gemma4:latest` — ein Name, den es nicht
    // gibt. Wer die Reserve einschaltete und nicht von sich aus ins
    // Auswahlfeld sah, hatte damit eine Reserve, die im Ernstfall an einem
    // 404 scheitert, und der Ernstfall ist genau der Moment, in dem niemand
    // Lust auf eine zweite Fehlersuche hat. Leer heißt: Die Einstellung sucht
    // sich beim ersten erfolgreichen Nachsehen selbst ein vorhandenes Modell.
    model: ''
  },

  // Aus. Wer sein Telefon anschließen will, schaltet es ein und liest dabei,
  // was das bedeutet — siehe `CompanionSettings`.
  companion: {
    enabled: false,
    port: COMPANION_DEFAULT_PORT,
    certSource: 'local',
    caInstalled: false
  },

  // Die Adresse, unter der Home Assistant im Heimnetz erreichbar ist, sobald
  // es installiert wird — der Name wird von der Standardinstallation selbst
  // vergeben. Eingetragen zu sein heißt nicht, dass es etwas gibt: Ohne den
  // Token im Schlüsselspeicher wird die Gruppe gar nicht erst registriert.
  smartHome: {
    baseUrl: 'http://homeassistant.local:8123',
    // Licht, Steckdose, Schalter und Szene sind zurücknehmbar. Schloss, Tor
    // und Alarmanlage fehlen hier mit Absicht — die fragen nach.
    freeDomains: ['light', 'switch', 'scene', 'fan', 'media_player', 'input_boolean']
  },

  // Spotify als Vorgabe, weil nur dieser Dienst eine Fernbedienung hat: Damit
  // landet „spiel was" ohne weiteres Zutun auf dem Echo Dot im Wohnzimmer.
  // Apple Music kann das nicht — dort spielt immer dieser Rechner, siehe
  // `MusicSettings`. Beides bleibt ohne Einrichtung wirkungslos, und die
  // Werkzeuge sagen das dann auch, statt es zu versuchen.
  music: {
    preferred: 'spotify',
    // 8888, weil Spotify diesen Port in seinen eigenen Beispielen benutzt und
    // die meisten ihn deshalb ohnehin eintragen. Nicht 8788, 8790 oder 8791 —
    // die gehören der Fernbedienung, der Telefonie und dem Sprachdienst. Ein
    // belegter Port fiele erst bei der Anmeldung auf, und dann als Fehler, der
    // nichts mit Musik zu tun hat.
    spotifyRedirectPort: 8888,
    // Derselbe Grund wie bei der Landesvorwahl der Telefonie: Die App wird
    // hier benutzt, und ein falscher Laden liefert Titel, die es im eigenen
    // Abo gar nicht gibt.
    appleStorefront: 'at',
    // Leer heißt: dort, wo Spotify zuletzt lief. Wer den Echo Dot einträgt,
    // bekommt Musik ohne weiteres Zutun im Wohnzimmer statt am Rechner.
    defaultDevice: ''
  },

  // Aus, wie Telefonie und Fernbedienung. Eingeschaltet steht ein Endpunkt im
  // offenen Netz, hinter dem ein Assistent mit Zugriff auf Kalender, Musik und
  // Licht sitzt — das soll jemand entscheiden und dabei lesen, was es bedeutet.
  // Kein eigener Port: Der Endpunkt hängt als Pfad am Server der Telefonie,
  // weil es nur einen Weg von außen herein gibt (siehe `AlexaSettings`).
  alexa: {
    enabled: false,
    publicUrl: ''
  },

  // Die Kamera, die der Browser zuerst anbietet. An einem Notebook ist das die
  // eingebaute; wer eine zweite hat, wählt sie in den Einstellungen.
  cameraDeviceId: null,

  // Beim allerersten Start läuft der Einrichtungsassistent, nicht das volle
  // Einstellungsfenster.
  setupDone: false,

  // Und danach zeigt es nur, was gebraucht wird. Wer mehr will, schaltet es
  // unter „Über" ein — einmal, dann bleibt es.
  showAdvanced: false
}

/** Live API: 16 kHz rein, 24 kHz raus, 16-bit PCM little-endian, mono. */
export const AUDIO_CONSTANTS = {
  INPUT_SAMPLE_RATE: 16000,
  OUTPUT_SAMPLE_RATE: 24000,
  /** 20-ms-Chunks = 320 Samples bei 16 kHz. Guter Kompromiss aus Latenz und Overhead. */
  INPUT_CHUNK_SAMPLES: 320,
  /**
   * Ring-Buffer-Kapazität des Players in Sekunden.
   *
   * Muss zu `RING_SECONDS` in `renderer/worklets/player-worklet.js` passen —
   * ein Worklet kann nichts importieren, der Wert steht dort also ein zweites
   * Mal. Großzügig bemessen, weil die Live API eine Antwort viel schneller
   * schickt, als sie gesprochen wird: Was hier nicht hineinpasst, fehlt
   * hinterher mitten im Satz.
   */
  PLAYER_BUFFER_SEC: 60,
  /** Fade-out beim Barge-in. Hartschnitt erzeugt ein hörbares Klicken. */
  BARGE_IN_FADE_MS: 40
} as const

/**
 * ElevenLabs.
 *
 * Die Ausgaberate ist der wichtigste Wert hier: 24 kHz ist genau das, womit der
 * Player und die Leitung zum Telefon ohnehin laufen. Jede andere Rate hieße,
 * sechzigmal in der Sekunde umzurechnen — für nichts.
 */
export const ELEVEN = {
  api: 'https://api.elevenlabs.io/v1',
  socket: 'wss://api.elevenlabs.io/v1/text-to-speech',
  /** Roh-PCM, 16 bit, mono — dasselbe Format, das der Player erwartet. */
  outputFormat: 'pcm_24000',
  /**
   * Bevorzugte Modelle, in dieser Reihenfolge.
   *
   * Was davon das Konto wirklich hergibt, wird beim ersten Mal abgefragt statt
   * angenommen: Eine fest eingebaute Kennung, die es nicht mehr gibt, wäre ein
   * Fehler ohne Rückweg, und die Liste der Modelle liefert der Anbieter selbst.
   *
   * Flash steht vorn, und der Grund ist der Preis, nicht die Latenz.
   *
   * Nach Klang allein müsste Multilingual v2 hier stehen: Flash ist das auf
   * Geschwindigkeit getrimmte Modell — rund 75 ms bis zum ersten Ton, dafür die
   * flachste Betonung, und auf Deutsch hört man das. Nur zählt ElevenLabs
   * Multilingual mit einem Credit je Zeichen ab und Flash über die
   * Schnittstelle mit einem halben. Das ist keine Feinheit, sondern der
   * Unterschied zwischen ungefähr zehn und ungefähr zwanzig Minuten Sprechzeit
   * im Monat auf dem Gratistarif — bei einem Assistenten, den man täglich
   * anspricht, entscheidet das darüber, ob die Stimme überhaupt bis zum
   * Monatsende reicht.
   *
   * Was die Flachheit auffängt, kostet nichts: `style` und `stability` weiter
   * unten. Abgerechnet werden Zeichen, nicht Rechenzeit.
   *
   * Turbo v2.5 ist beim Anbieter abgekündigt und bleibt nur als Zwischenstufe
   * für Konten, die es noch haben. Nicht dabei: eleven_v3 und
   * eleven_v3_conversational, die ausdrucksstärkste Familie. Sie sprechen nicht
   * über diesen Sockel, sondern über den Text-to-Dialogue-WebSocket — ein
   * anderes Protokoll. Das wäre kein Eintrag in dieser Liste, sondern eine
   * zweite Fassung von `elevenVoice.ts`.
   */
  modelPreference: ['eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_multilingual_v2'],
  qualityModelPreference: ['eleven_multilingual_v2', 'eleven_turbo_v2_5', 'eleven_flash_v2_5'],
  /**
   * Mitgelieferte Stimmen, die zu James passen — tief, ruhig, britisch.
   *
   * Gebraucht an zwei Stellen: Solange keine gewählt ist, wird von diesen die
   * erste genommen, die das Konto hat; und in den Einstellungen stehen sie
   * markiert obenan. Vorher wurde schlicht die erste Stimme des Kontos
   * genommen, und die ist bei den meisten Konten eine junge Frauenstimme —
   * ein Assistent, der nach seinem Vorbild klingen soll, fängt damit denkbar
   * schlecht an.
   *
   * Gesucht wird nach dem Namen, nicht nach der Kennung: Kennungen ändern sich
   * je nach Konto, die Namen der mitgelieferten Stimmen nicht.
   */
  jarvisVoiceNames: ['George', 'Daniel', 'Brian', 'Charlie', 'Callum', 'Bill', 'Adam'],
  /**
   * George, eine mitgelieferte Stimme mit fester Kennung in jedem Konto.
   *
   * Gebraucht, wenn die Stimmenliste nicht abrufbar ist, etwa weil dem
   * Schlüssel die Berechtigung „Voices: read" fehlt. Sprechen darf er trotzdem,
   * und ohne diese Kennung blieb James in dem Fall stumm.
   */
  fallbackVoiceId: 'JBFqnCBsd6RMkjVDRZzb',
  /**
   * Ab wie vielen Zeichen ein Stück gesprochen wird.
   *
   * Klein anfangen, dann größer: Der erste Ton soll früh kommen, danach zählt
   * die Betonung, und die braucht Zusammenhang. Genau dafür ist der Zeitplan da.
   */
  chunkSchedule: [50, 140, 250, 290],
  /** So lange darf die Leitung still stehen, bevor der Anbieter sie schließt. */
  inactivityTimeoutSec: 60
} as const

/**
 * whisper.cpp.
 *
 * Die Zahlen hier sind nachgesehen, nicht geschätzt — Release v1.9.2 vom
 * 4. August 2026 und die Dateigrößen aus dem Verzeichnis von Hugging Face.
 * Sie stehen als Konstanten da, damit die Einstellungsseite sagen kann, was ein
 * Download kostet, bevor jemand ihn auslöst.
 */
export const WHISPER = {
  /** Nur die CPU-Fassung. Die CUDA-Pakete sind 257 bzw. 640 MB — kein Angebot. */
  runtimeUrl:
    'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip',
  runtimeBytes: 8_194_445,
  /**
   * `small` als Vorgabe.
   *
   * Eine belastbare Fehlerquote für Deutsch nach Modellgröße gibt es öffentlich
   * nicht — weder im Whisper-Aufsatz noch bei OpenAI, dort steht die
   * Aufschlüsselung nur für large. Was belegbar ist: Die Rechenzeit steigt
   * ungefähr mit der Modellgröße, und `small` gilt für deutsches Diktat als
   * untere brauchbare Grenze. Wem das zu langsam ist, stellt auf `base` um und
   * hört den Unterschied selbst — das ist ehrlicher als eine erfundene Tabelle.
   */
  models: [
    { file: 'ggml-base.bin', bytes: 147_951_465, label: 'base — am schnellsten, patzt bei Namen' },
    { file: 'ggml-small-q5_1.bin', bytes: 190_085_487, label: 'small, verkleinert — guter Tausch' },
    { file: 'ggml-small.bin', bytes: 487_601_967, label: 'small — die übliche Wahl' },
    { file: 'ggml-medium.bin', bytes: 1_533_763_059, label: 'medium — genauer, spürbar träger' }
  ],
  defaultModel: 'ggml-small-q5_1.bin',
  modelBaseUrl: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/',
  /** Silero. Klein genug, dass die Frage "brauche ich das?" sich nicht stellt. */
  vadUrl: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin',
  vadFile: 'ggml-silero-v6.2.0.bin',
  vadBytes: 885_098,
  /**
   * Was whisper sagt, wenn nichts gesagt wurde.
   *
   * Kein Randfall, sondern der Normalfall bei einem offenen Mikrofon: In den
   * Trainingsdaten standen Untertitel-Abspänne, und bei Stille gibt das Modell
   * genau die zurück — auf Deutsch mit erschütternder Beharrlichkeit denselben.
   * Die Sperre der Nicht-Sprach-Zeichen erwischt `[BLANK_AUDIO]` und `(Musik)`,
   * diese Sätze aber nicht: Sie sind gewöhnlicher Text.
   *
   * Geprüft wird gegen die getrimmte, kleingeschriebene Zeile.
   */
  hallucinations: [
    /^untertitel(ung)?( im auftrag)?( des)? zdf/,
    /^untertitel(ung)? von /,
    /^untertitel(ung)?\.?$/,
    /^copyright wdr/,
    /^amara\.org/,
    /^vielen dank\.?$/,
    /^\[.*\]$/,
    /^\(.*\)$/
  ],
  /**
   * So lange darf eine Abschrift dauern, bevor sie aufgegeben wird.
   *
   * Großzügig, weil ein kaltes `medium` auf einem müden Rechner wirklich so
   * lange braucht — und eine abgebrochene Abschrift heißt hier: kein Wortlaut,
   * also keine Bestätigung und beim lokalen Denken gar keine Antwort.
   */
  timeoutMs: 30_000,
  /** So lange wird nach dem Start auf `/health` gewartet. */
  startupMs: 60_000
} as const

/**
 * piper.
 *
 * Der Mund ist der unerfreulichere der beiden: Die einzige eigenständige
 * Windows-Datei stammt vom 14. November 2023 aus einem inzwischen archivierten
 * Projekt, und die gepflegte Fassung gibt es nur als Python-Paket. Beide Wege
 * stehen deshalb hier, und welcher genommen wird, entscheidet ein Versuch.
 */
export const PIPER = {
  /** MIT, eigenständig, alt. Enthält piper.exe, die DLLs und espeak-ng-data. */
  runtimeUrl:
    'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip',
  runtimeBytes: 22_477_236,
  /** Die gepflegte Fassung, GPL-3.0. Wird über pip geholt, nicht als Datei. */
  pythonPackage: 'piper-tts',
  voiceBaseUrl: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/',
  /**
   * Deutsche Stimmen.
   *
   * `low` spart bei Deutsch nichts — low und medium sind beide rund 63 MB, low
   * liefert dafür nur 16 kHz. Es gibt also keinen Grund, unter medium zu gehen,
   * außer man will die einzige weibliche Stimme, und die gibt es nur als x_low.
   */
  voices: [
    {
      id: 'de_DE-thorsten-medium',
      path: 'thorsten/medium/de_DE-thorsten-medium',
      bytes: 63_201_294,
      rate: 22050,
      license: 'CC0',
      label: 'Thorsten, medium — der Maßstab für deutsches piper'
    },
    {
      id: 'de_DE-thorsten-high',
      path: 'thorsten/high/de_DE-thorsten-high',
      bytes: 113_895_201,
      rate: 22050,
      license: 'CC0',
      label: 'Thorsten, high — voller, längerer Kaltstart'
    },
    {
      id: 'de_DE-eva_k-x_low',
      path: 'eva_k/x_low/de_DE-eva_k-x_low',
      bytes: 20_628_813,
      rate: 16000,
      license: 'M-AILABS',
      label: 'Eva, x_low — die einzige weibliche, hörbar synthetisch'
    },
    {
      id: 'de_DE-kerstin-low',
      path: 'kerstin/low/de_DE-kerstin-low',
      bytes: 63_104_526,
      rate: 16000,
      license: 'CC0',
      label: 'Kerstin, low — heller, 16 kHz'
    }
  ],
  defaultVoice: 'de_DE-thorsten-medium',
  /**
   * So lange darf ein Satz brauchen, bevor der Prozess als hängend gilt.
   *
   * Ein warmgelaufener piper synthetisiert einen Satz in Zehner-Millisekunden.
   * Zehn Sekunden sind deshalb keine Geduld, sondern eine Diagnose: So lange
   * dauert es nur, wenn etwas kaputt ist.
   */
  sentenceTimeoutMs: 10_000,
  /** Aufwärmsatz beim Start. Sein Ton wird verworfen. */
  warmupText: 'Bereit.'
} as const

/**
 * Ausweichmodelle für Gemini-Textaufrufe, nach dem eingestellten.
 *
 * Google zählt das Gratiskontingent je Modell. Ist es bei Flash für heute
 * aufgebraucht, hat Flash Lite meistens noch reichlich — und umgekehrt.
 * Gebraucht im Hauptprozess (`providers/gemini.ts`) und im Kaskadenweg.
 */
export const GEMINI_FALLBACK_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-flash-lite-latest',
  'gemini-flash-latest'
] as const

export const LIVE_LIMITS = {
  /** Harte Obergrenze der Live API für reine Audio-Sessions. */
  AUDIO_SESSION_MAX_MS: 15 * 60 * 1000,
  /** So früh vor dem Cut bauen wir die Nachfolgeverbindung auf. */
  RECONNECT_LEAD_MS: 20_000
} as const

/**
 * Kontextkompression für lange Sprachsitzungen.
 *
 * Ab `TRIGGER_TOKENS` kürzt der Server die ältesten Gesprächsteile, bis
 * `TARGET_TOKENS` übrig sind — lange bevor das Kontextfenster voll ist.
 */
export const LIVE_CONTEXT_COMPRESSION = {
  // Jede Runde bezahlt den ganzen Kontext. Seit Werkzeuge und Fachabschnitte
  // nachgeladen werden, ist der feste Teil klein (rund 5 000 Token) — die
  // Grenze darf deshalb tiefer liegen, ohne dass ständig gekürzt wird.
  // Bei 16 000 kostete eine späte Runde gut das Dreifache einer frühen; mit
  // 11 000 bleibt etwa das letzte Dutzend Wechsel im Gedächtnis.
  TRIGGER_TOKENS: 11_000,
  TARGET_TOKENS: 6_500
} as const

/**
 * Grober Umrechnungskurs für die Sparmodus-Anzeige.
 *
 * Exakt abrechnen können wir lokal nicht — es geht darum, eine Größenordnung
 * zu zeigen, nicht eine Rechnung zu stellen.
 */
export const COST_ESTIMATES = {
  /** Zeichen pro Token, Daumenwert für deutschen Text. */
  CHARS_PER_TOKEN: 4,
  /** Dollar pro Million Eingabe-Token. */
  USD_PER_MTOK_INPUT: 0.3,
  /** Live-Audio-Eingang: Token pro Sekunde. */
  AUDIO_TOKENS_PER_SECOND: 25
} as const
