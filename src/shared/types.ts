/**
 * Geteilte Typen zwischen Main, Preload und Renderer.
 * Dieses Modul darf keine Node- oder DOM-spezifischen Imports enthalten.
 */

// ─────────────────────────────────────────────────────────────
// Kristall-Zustände — die einzige visuelle Sprache der App
// ─────────────────────────────────────────────────────────────

export type CrystalState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'tool'
  | 'research'
  | 'confirm'
  | 'error'
  | 'offline'
  | 'connecting'
  /** Vom Nutzer stillgelegt: kein Mikrofon, kein Weckwort, keine Verbindung. */
  | 'paused'

/** Reihenfolge nach Priorität: höher gewinnt, wenn mehrere Quellen gleichzeitig setzen. */
export const CRYSTAL_STATE_PRIORITY: Record<CrystalState, number> = {
  idle: 0,
  connecting: 1,
  research: 2,
  listening: 3,
  thinking: 4,
  tool: 4,
  speaking: 5,
  offline: 6,
  // Über offline: dass Void ihn selbst stillgelegt hat, ist die wichtigere
  // Auskunft — sonst sucht er den Fehler im Netz statt am eigenen Klick.
  paused: 7,
  confirm: 8,
  error: 9
}

// ─────────────────────────────────────────────────────────────
// Einstellungen
// ─────────────────────────────────────────────────────────────

export type LiveModelId =
  | 'gemini-3.8-live'
  | 'gemini-3.1-flash-live-preview'
  | 'gemini-2.5-flash-native-audio-preview-12-2025'

export type ResearchAgentId =
  | 'deep-research-preview-04-2026'
  | 'deep-research-max-preview-04-2026'

/** Die 30 HD-Stimmen der Live API. Sortiert: klare/sonore zuerst. */
export const VOICES = [
  { name: 'Charon', trait: 'Informativ', hint: 'Ruhig, sonor — klingt nach Ansage' },
  { name: 'Alnilam', trait: 'Bestimmt', hint: 'Fest und klar, sehr verständlich' },
  { name: 'Rasalgethi', trait: 'Informativ', hint: 'Sachlich, gute Artikulation' },
  { name: 'Sadaltager', trait: 'Kenntnisreich', hint: 'Erklärend, ruhiges Tempo' },
  { name: 'Iapetus', trait: 'Klar', hint: 'Sehr saubere Konsonanten' },
  { name: 'Gacrux', trait: 'Reif', hint: 'Tiefer, gesetzter Klang' },
  { name: 'Algenib', trait: 'Rau', hint: 'Kiesig, markant' },
  { name: 'Orus', trait: 'Bestimmt', hint: 'Direkt, präsent' },
  { name: 'Erinome', trait: 'Klar', hint: 'Hell und deutlich' },
  { name: 'Kore', trait: 'Bestimmt', hint: 'Google-Standard' },
  { name: 'Zephyr', trait: 'Hell', hint: 'Leicht, freundlich' },
  { name: 'Puck', trait: 'Aufgeweckt', hint: 'Lebhaft, schnelleres Tempo' },
  { name: 'Fenrir', trait: 'Lebhaft', hint: 'Energisch' },
  { name: 'Autonoe', trait: 'Hell', hint: 'Freundlich-hell' },
  { name: 'Umbriel', trait: 'Gelassen', hint: 'Entspannt' },
  { name: 'Laomedeia', trait: 'Gut gelaunt', hint: 'Positiv' },
  { name: 'Schedar', trait: 'Ausgeglichen', hint: 'Neutral' },
  { name: 'Achird', trait: 'Freundlich', hint: 'Warm-zugewandt' },
  { name: 'Sadachbia', trait: 'Lebendig', hint: 'Dynamisch' },
  { name: 'Aoede', trait: 'Luftig', hint: 'Leicht' },
  { name: 'Enceladus', trait: 'Hauchig', hint: 'Weich, nah' },
  { name: 'Algieba', trait: 'Weich', hint: 'Glatt' },
  { name: 'Achernar', trait: 'Sanft', hint: 'Zurückhaltend' },
  { name: 'Zubenelgenubi', trait: 'Locker', hint: 'Umgangssprachlich' },
  { name: 'Leda', trait: 'Jugendlich', hint: 'Jung' },
  { name: 'Callirrhoe', trait: 'Gelassen', hint: 'Ruhig' },
  { name: 'Despina', trait: 'Weich', hint: 'Sanft-glatt' },
  { name: 'Pulcherrima', trait: 'Vorwärts', hint: 'Drängend' },
  { name: 'Vindemiatrix', trait: 'Sanft', hint: 'Mild' },
  { name: 'Sulafat', trait: 'Warm', hint: 'Warm-voll — Voreinstellung' }
] as const

export type VoiceName = (typeof VOICES)[number]['name']

export interface VadSettings {
  /**
   * Stille in ms bis der Server das Ende deiner Äußerung annimmt.
   * Googles Default (100) schneidet mitten im Satz ab. 700 ist der Sweet Spot
   * zwischen "lässt mich ausreden" und "reagiert schnell".
   */
  silenceDurationMs: number
  /** Audio-Puffer vor dem erkannten Sprechbeginn — verhindert abgeschnittene erste Silben. */
  prefixPaddingMs: number
  startSensitivity: 'HIGH' | 'LOW'
  endSensitivity: 'HIGH' | 'LOW'
  /** Lokales Silero-Gate: filtert Stille/Tastatur bevor etwas hochgeladen wird. */
  localGateEnabled: boolean
  localGateThreshold: number
}

export interface AudioSettings {
  inputDeviceId: string | null
  outputDeviceId: string | null
  /** Ohne AEC hört James sich selbst und unterbricht sich endlos. */
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
  /** Ausgabekette: macht Sprache auf normalen Boxen deutlich präsenter. */
  outputEqEnabled: boolean
  outputHighShelfGainDb: number
  outputCompressorEnabled: boolean
  outputGain: number
  /** Jitterbuffer in ms bevor die Wiedergabe startet. Höher = robuster, träger. */
  jitterBufferMs: number
  /**
   * Half-Duplex: Upload pausiert während James spricht. Ohne Headset nötig,
   * mit Headset ausschalten für echtes Barge-in.
   */
  halfDuplex: boolean
}

export interface WakeSettings {
  enabled: boolean
  /** openWakeWord-Schwelle. Höher = weniger Fehlauslöser, mehr verpasste. */
  threshold: number
  /**
   * Der Klassifikator aus `public/wakeword/`, gegen den die Stimme geprüft
   * wird. Mitgeliefert ist nur `hey_james.onnx`, selbst trainiert, siehe
   * scripts/wakeword-training. Die Mel- und
   * Embedding-Vorstufen sind für alle identisch.
   */
  modelName: string
  /** Zweimal Klatschen weckt James, ganz ohne Weckwort-Modell. */
  clap: boolean
  pushToTalkHotkey: string
  /** Legt James systemweit still bzw. holt ihn zurück. Leer = kein Kürzel. */
  pauseHotkey: string
  /** Session nach so vielen Sekunden Stille schließen — spart laufende Audio-Kosten. */
  idleDisconnectSec: number
}

export type ToolPermission = 'allow' | 'ask' | 'deny'

/**
 * Sparmodus.
 *
 * Live-Audio kostet pro Sekunde, alles andere pro Token. Die vier Stellen
 * hier sind die, an denen ohne Funktionsverlust am meisten übrig bleibt:
 * lange Werkzeugergebnisse, wortreiche Werkzeugbeschreibungen im
 * Verbindungsaufbau, wiederholte identische Aufrufe und hochgeladene Stille.
 */
export interface TokenSaverSettings {
  enabled: boolean
  /**
   * Werkzeugergebnisse auf so viele Zeichen kürzen, bevor sie ans Modell
   * gehen. Die Antwort wird ohnehin gesprochen — ein 6000-Zeichen-Mailtext
   * wird nie vollständig vorgelesen. 0 heißt: nicht kürzen.
   */
  maxResultChars: number
  /**
   * Derselbe Aufruf mit denselben Argumenten innerhalb dieser Zeit liefert das
   * gespeicherte Ergebnis. 0 heißt: kein Zwischenspeicher.
   */
  cacheTtlSec: number
  /**
   * Werkzeugbeschreibungen im Verbindungsaufbau auf den ersten Satz kürzen.
   * Die Deklarationen gehen bei jedem stillen Neuaufbau erneut über die
   * Leitung — alle fünfzehn Minuten.
   */
  slimDeclarations: boolean
}

/**
 * Wer spricht.
 *
 * Gemini kann von sich aus Ton ausgeben — Zuhören, Denken und Sprechen in einer
 * Sitzung, ohne dass der Text je sichtbar wird. Das ist der kürzeste Weg und
 * bleibt die Rückfallebene. ElevenLabs klingt hörbar besser, kostet dafür einen
 * Umweg: Gemini muss dann in Text antworten, und dieser Text wird hier
 * vorgelesen.
 *
 * Der Umweg ist der Grund, warum das eine Einstellung ist und kein Schalter, den
 * man beiläufig umlegt: Er ändert die Betriebsart der Live-Sitzung, nicht bloß
 * eine Klangfarbe.
 */
export interface SpeechSettings {
  /**
   * Wer den Text vorliest.
   *
   * `piper` ist die Voreinstellung und spricht auf diesem Rechner. `elevenlabs`
   * klingt besser und kostet Kontingent. `gemini` heißt: gar keinen fremden
   * Sprecher versuchen, sondern die Live-Sitzung selbst reden lassen — der
   * kürzeste Weg und die letzte Rückfallebene.
   */
  provider: 'gemini' | 'elevenlabs' | 'piper' | 'openai'
  /**
   * Modell für `provider: 'openai'` — die Realtime-API von OpenAI. Wie bei
   * Gemini Live hört, denkt und spricht es in einem Stück.
   */
  realtimeModel: string
  /** Stimme der OpenAI-Realtime-API, z. B. `marin` oder `cedar`. */
  realtimeVoice: string
  /**
   * Wer zuhört, also den Ton in Wortlaut übersetzt.
   *
   * Der Schalter, der aus „lokal" endlich lokal macht. Solange die Abschrift
   * über Gemini lief, verließ jeder Satz die Wohnung, auch wenn Denken und
   * Sprechen hierblieben — das stand als Einschränkung überall in den
   * Einstellungen und ist mit `whisper` weg.
   *
   * Der Preis steht offen dabei: whisper rechnet auf der eigenen CPU, und
   * diese Rechenzeit liegt vor jeder Antwort. Siehe `WhisperSettings`.
   */
  hearProvider: 'gemini' | 'whisper'
  /**
   * Wer auf dem zusammengesetzten Weg denkt.
   *
   * `gemini` schickt den Ton unverändert hin — das Modell hört selbst, es
   * braucht dann gar keine Abschrift, und es ist der kürzere Weg. `ollama`
   * denkt auf diesem Rechner: kostet nichts, verlässt die Wohnung nicht,
   * braucht dafür aber ein Modell mit Werkzeugunterstützung und eine Abschrift,
   * denn ein Textmodell hört nichts.
   */
  thinkProvider: 'gemini' | 'ollama' | 'chatgpt'
  /**
   * So lange Stille, bis ein Beitrag als beendet gilt.
   *
   * Der wichtigste Regler dieses Wegs, weil er unmittelbar die Wartezeit vor
   * jeder Antwort ist. Er steht eigens hier und nicht bei `vad`: Dort geht es
   * um die serverseitige Erkennung der Live-Sitzung, die schon beim Reden
   * zuhört und deshalb großzügiger sein darf. Hier wird erst nach der Stille
   * überhaupt etwas losgeschickt.
   */
  endpointMs: number
  /**
   * Das Modell, das den Ton in Wortlaut übersetzt.
   *
   * Getrennt vom Denkmodell, weil die Aufgabe eine andere ist: Abtippen kann
   * das kleinste Modell, und es passiert bei jedem einzelnen Beitrag.
   */
  transcribeModel: string
  /**
   * Das Modell, das auf dem ElevenLabs-Weg denkt.
   *
   * Nicht `liveModel`, und das ist der Kern der Sache: Kein Live-Modell gibt
   * Text aus, sie sprechen alle selbst. Wer eine fremde Stimme will, braucht
   * ein gewöhnliches Modell — und weil hier jemand auf eine Antwort wartet,
   * eines der schnellen.
   *
   * Nicht `brainModel`: Das ist für Hintergrundaufgaben gedacht, bei denen ein
   * paar Sekunden niemanden stören. Hier stören sie.
   */
  brainModel: string
  /**
   * Die Stimme bei ElevenLabs. Leer heißt "noch keine gewählt" — dann wird beim
   * ersten Mal die erste des Kontos genommen und hier eingetragen. Eine fest
   * eingebaute Kennung wäre geraten; welche Stimmen es gibt, weiß nur das Konto.
   */
  elevenVoiceId: string
  /** Leer heißt: beim ersten Mal das schnellste verfügbare Modell nehmen. */
  elevenModelId: string
  /**
   * Wie streng ElevenLabs-Kontingent geschont wird.
   *
   * `saving` nutzt das halb so teure Flash-Modell und bittet den Denkmotor um
   * kurze, gesprochene Antworten. `balanced` bleibt ebenfalls bei Flash, lässt
   * aber mehr Raum. `quality` bevorzugt das natürlichere Multilingual-Modell.
   */
  elevenPlan: 'saving' | 'balanced' | 'quality'
  /** 0 bis 1. Niedriger ist ausdrucksstärker, höher gleichmäßiger. */
  stability: number
  /** 0 bis 1. Wie eng an der Vorlage die Stimme bleibt. */
  similarity: number
  /**
   * 0 bis 1. Wie viel Schauspiel in der Betonung steckt.
   *
   * Kostet Rechenzeit auf der Gegenseite und damit Verzögerung — bei null wird
   * das Feld gar nicht erst mitgeschickt. Für einen Butler ist wenig richtig:
   * James betont, er spielt nicht.
   */
  style: number
  /** 0,7 bis 1,2. Unter eins bedächtiger, über eins hastiger. */
  speed: number
  /**
   * Ab wie viel verbleibendem Kontingent (in Zeichen) vorsichtshalber auf Gemini
   * ausgewichen wird. Genau bei null umzuschalten hieße, mitten im Satz
   * abgeschnitten zu werden.
   */
  reserveChars: number

}

/** Was das Konto bei ElevenLabs über sein Kontingent verrät. */
export interface ElevenQuota {
  ok: boolean
  /** Warum nicht — für die Einstellungsseite, in ganzen Sätzen. */
  reason: string | null
  used: number
  limit: number
  remaining: number
  /** Wann das Kontingent wieder aufgefüllt wird. Unix-Sekunden, `null` wenn unbekannt. */
  resetsAt: number | null
  /**
   * Das Kontingent ließ sich nicht abfragen, gesprochen wird trotzdem.
   *
   * Ein Schlüssel ohne die Berechtigung „User: read" oder ein kurzer Netzfehler
   * sagen nichts darüber, ob die Stimme geht. Ob sie geht, entscheidet der
   * Sprech-Sockel — und der meldet sich mit einem klaren Grund.
   */
  unverified?: boolean
}

export interface ElevenVoice {
  id: string
  name: string
  /** Woher sie stammt — die eigenen zuerst anzuzeigen ist freundlicher. */
  category: string
}

/**
 * Ein Modell auf diesem Rechner.
 *
 * Der Reiz ist nicht der Preis, sondern dass nichts hinausgeht: Was James über
 * Void weiß, bleibt dann in der Wohnung. Der Preis dafür ist Ehrlichkeit an
 * zwei Stellen — ein lokales Modell braucht Werkzeugunterstützung, sonst kann
 * es nichts tun außer reden, und hören kann es gar nicht. Die Abschrift kommt
 * weiterhin von Gemini.
 */
export interface OllamaSettings {
  /** Wo Ollama lauscht. Standard ist der eigene Rechner. */
  baseUrl: string
  /** Genau wie in `ollama list`, mit oder ohne Kennzeichnung. */
  model: string
  /**
   * So lange bleibt das Modell nach dem letzten Satz im Speicher.
   *
   * Ollamas Vorgabe sind fünf Minuten. Für einen Assistenten, den man alle
   * halbe Stunde anspricht, heißt das jedes Mal: mehrere Gigabyte von der
   * Platte, bevor das erste Wort kommt.
   */
  keepAliveMin: number
}

/**
 * Ob Ollama läuft und das eingestellte Modell kennt.
 *
 * Die Liste ist dieselbe wie bei der Reserve — `LocalModel`, mit Parameterzahl
 * und der Angabe, ob das Modell Werkzeuge beherrscht. Eine zweite Form mit nur
 * Name und Gigabyte stand hier einmal daneben; sie sagte weniger und musste
 * beim ersten Zusammentreffen ohnehin weichen.
 */
export interface OllamaHealth {
  /** Dienst da, Modell gewählt, Modell vorhanden. */
  ok: boolean
  /**
   * Und kann es auch Werkzeuge?
   *
   * Eigens neben `ok`, weil es zwei verschiedene Zustände sind: Ein Modell ohne
   * Werkzeuge ist nicht kaputt, es ist beschränkt. Es redet, es antwortet, es
   * kann nur nichts nachschlagen und nichts erledigen — das als Ausfall zu
   * zeigen wäre falsch, es zu verschweigen aber auch.
   */
  tools: boolean
  /** In ganzen Sätzen, für die Einstellungsseite. */
  detail: string
  models: LocalModel[]
}

/**
 * Die Ohren auf diesem Rechner.
 *
 * whisper.cpp läuft als eigener Dienst, nicht als Aufruf pro Satz. Der Grund
 * ist das Modell: `small` sind knapp fünfhundert Megabyte, und die bei jedem
 * Beitrag von der Platte zu holen hieße, eine halbe Sekunde Rechenzeit gegen
 * mehrere Sekunden Ladezeit zu tauschen. Der Dienst hält es im Speicher und
 * beantwortet eine Anfrage nach der anderen — mehr als eine kann er nicht, er
 * nimmt intern ein Schloss.
 */
export interface WhisperSettings {
  /**
   * Der Ordner mit `whisper-server.exe`.
   *
   * Ein Ordner und keine Datei, und das ist wichtig: Neben der ausführbaren
   * Datei liegen `whisper.dll` und mehrere `ggml-cpu-*.dll`, von denen erst zur
   * Laufzeit die zur CPU passende geladen wird. Wer nur die .exe kopiert,
   * bekommt einen Start, der ohne verständliche Meldung scheitert.
   *
   * Leer heißt: der Ordner, in den die Beschaffung geladen hat.
   */
  dir: string
  /** Die ggml-Datei. Leer heißt: die heruntergeladene unter `userData`. */
  modelPath: string
  /**
   * Silero, damit Stille das Modell gar nicht erst erreicht.
   *
   * Nicht nur eine Ersparnis: Whisper halluziniert bei Stille, und zwar auf
   * Deutsch mit erschütternder Beharrlichkeit denselben Untertitel-Abspann.
   * Die Sperrliste dahinter fängt den Rest.
   */
  vadModelPath: string
  /** Nicht 8080 — der ist unter Windows notorisch belegt. */
  port: number
  /**
   * Rechenfäden. Die Vorgabe des Servers ist `min(4, Kerne)` und verschenkt auf
   * einem Achtkerner die Hälfte. Sinnvoll ist die Zahl der physischen Kerne,
   * nicht die der logischen.
   */
  threads: number
  /**
   * Wie viel vom Zeitfenster gerechnet wird. 0 heißt: alles.
   *
   * Der einzige Hebel, der die Wartezeit wirklich senkt. Der Encoder rechnet
   * sonst immer dreißig Sekunden, auch für einen Beitrag von zweien — die
   * Eingabe wird schlicht mit Stille aufgefüllt. Wer hier kürzt, kürzt genau
   * diese Leerarbeit weg.
   *
   * Unter 768 kippt die Erkennung; darüber sind Vielfache von 64 richtig. Was
   * der Wert für einen konkreten Beitrag bedeutet, rechnet der Dienst selbst
   * aus — hier steht nur die Untergrenze.
   */
  audioCtx: number
  /** Die Erkennung von Sprache vor der Abschrift. Ausschalten heißt Halluzinieren. */
  vad: boolean
}

/** Ob whisper läuft und wie lange es für einen Satz braucht. */
export interface WhisperHealth {
  ok: boolean
  /** In ganzen Sätzen, für die Einstellungsseite. */
  detail: string
  /** Der Dateiname des Modells, ohne Pfad. Leer, wenn keines da ist. */
  model: string
  /**
   * Wie lange die Aufwärm-Anfrage gedauert hat, in Millisekunden.
   *
   * Die einzige ehrliche Auskunft über die Wartezeit, die dieser Rechner
   * einbringt. Eine Zahl aus dem Netz hilft hier nicht: Sie hängt an der CPU,
   * am Modell und daran, wie viel sonst noch läuft.
   */
  warmupMs: number | null
}

/**
 * Der Mund auf diesem Rechner.
 *
 * piper gibt es unter Windows in zwei Fassungen, und keine ist ohne Haken. Die
 * eigenständige `piper.exe` ist von November 2023, stammt aus einem
 * archivierten Projekt und stürzt auf manchen Windows-Ständen beim Laden des
 * Modells ab — unter anderem, gemeldet, auf genau dem Stand dieses Rechners.
 * Die gepflegte Fassung gibt es nur als Python-Paket.
 *
 * Deshalb zwei Rückseiten hinter einer Schnittstelle und `auto` als Vorgabe:
 * Erst wird die .exe versucht, und wenn sie stirbt, tritt Python an ihre Stelle.
 * Was tatsächlich läuft, steht danach in `PiperHealth` — geraten wird nicht.
 */
export interface PiperSettings {
  /** `auto` probiert die .exe und weicht auf Python aus, wenn sie nicht will. */
  backend: 'auto' | 'exe' | 'python'
  /** Der Ordner mit `piper.exe`, `espeak-ng-data` und den DLLs. */
  exeDir: string
  /** Python für die gepflegte Fassung. Leer heißt: das im Pfad gefundene. */
  pythonPath: string
  /** Die `.onnx`-Stimme. Die `.onnx.json` daneben trägt die Abtastrate. */
  voicePath: string
  /**
   * Sprechtempo. Über eins wird es langsamer, nicht schneller — der Wert
   * streckt die Laute. Eins ist die Vorgabe der Stimme.
   */
  lengthScale: number
  /**
   * Klangschwankung der Stimme (piper `noise_scale`). Niedriger klingt
   * klarer und ruhiger, zu niedrig flach. Null heißt Vorgabe der Stimme.
   */
  noiseScale: number
  /** Schwankung der Lautlängen (piper `noise_w`). Null heißt Vorgabe der Stimme. */
  noiseW: number
}

/** Ob piper spricht, und womit. */
export interface PiperHealth {
  ok: boolean
  detail: string
  /** Was tatsächlich läuft, nicht was eingestellt ist. `null` heißt: nichts. */
  backend: 'exe' | 'python' | null
  /** Dateiname der Stimme, ohne Pfad. */
  voice: string
  /** Aus der `.onnx.json` gelesen, nicht geraten: 22050 bei medium, 16000 bei low. */
  sampleRate: number
}

/**
 * Ein Stück, das die App zum lokalen Reden braucht und nicht mitliefert.
 *
 * Mitgeliefert wird nichts davon, und das hat zwei Gründe. Das Sprachmodell
 * allein wiegt eine halbe Gigabyte — in einen Installer gehört das nicht. Und
 * die Binärdateien stammen von fremden Projekten unter eigenen Lizenzen; sie
 * zu holen soll eine Entscheidung sein, die jemand trifft, und keine, die er
 * beim Auspacken geschenkt bekommt.
 */
export type LocalAssetId =
  | 'whisper-runtime'
  | 'whisper-model'
  | 'whisper-vad'
  | 'piper-runtime'
  | 'piper-voice'

export interface LocalAsset {
  id: LocalAssetId
  /** Für die Einstellungsseite, in ganzen Worten. */
  label: string
  /** Warum es gebraucht wird — ein Satz. */
  purpose: string
  /** Liegt es schon da? */
  present: boolean
  /** Wohin es gehört bzw. wo es liegt. */
  path: string
  /** Woher es käme. Steht sichtbar da, damit niemand blind auf Laden drückt. */
  url: string
  /** Ungefähre Größe des Downloads in Byte. */
  bytes: number
  /** Lizenz der fremden Datei, im Klartext. */
  license: string
}

/** Wie weit ein Download ist. Geht als Ereignis an die Einstellungsseite. */
export interface LocalInstallProgress {
  id: LocalAssetId
  received: number
  total: number
  /** Fertig — entpackt und an Ort und Stelle. */
  done: boolean
  /** In ganzen Sätzen. `null`, solange nichts schiefging. */
  error: string | null
}

/**
 * Wie er auftritt.
 *
 * `jarvis` ist die Butler-Haltung (interner Name, bleibt für gespeicherte Einstellungen): förmlich, knapp, trocken, und dabei
 * ohne jede Beflissenheit. `sachlich` lässt das Trockene weg — für alle, die
 * eine Auskunft wollen und keinen Butler.
 */
export type Persona = 'jarvis' | 'sachlich' | 'herzlich'

/**
 * Feinregler über der Haltung.
 *
 * `humor` 0 heißt kein Witz, 3 heißt öfter ein trockener Halbsatz — nie statt
 * der Antwort. `address` überstimmt die Anrede der Haltung; `auto` lässt sie,
 * wie die Haltung sie vorsieht. `name` ist, wie er sich nennt.
 */
export interface Personality {
  humor: number
  address: 'auto' | 'du' | 'sie'
  name: string
}

export interface Settings {
  language: 'de-DE' | 'en-US'
  homeLocation: string
  /** Echten Standort über die Windows-Ortung verwenden (vom Nutzer erlaubt). */
  useDeviceLocation: boolean
  /** PC lokal einlesen (Programme, Ordner, letzte Dateien, Textausschnitte), wenn James im Vordergrund ist. */
  pcProfile: boolean
  /** Beim ersten Öffnen am Tag ein kurzes Briefing zeigen und sprechen. */
  dailyBriefing: boolean
  diagnosticReporting: { enabled: boolean; automatic: boolean; url: string; capabilityGaps: boolean }
  liveModel: LiveModelId
  voice: VoiceName
  persona: Persona
  personality: Personality
  /** Wer den Text vorliest — siehe `SpeechSettings`. */
  speech: SpeechSettings
  /** Gemini-Modell für alles außerhalb der Sprachschleife. */
  brainModel: string
  /**
   * Wer die reinen Textaufgaben erledigt.
   *
   * Reine Textaufgabe heißt: Text rein, Text raus, ohne Netzzugriff des
   * Modells und ohne Bild. Übersetzen ist der Regelfall, dazu kommen die
   * Vektoren des Gedächtnisses.
   *
   * Die Einschränkung ist keine Bequemlichkeit. Websuche und Preisvergleich
   * hängen am googleSearch-Grounding, der Seitenabruf am urlContext, die
   * Bildschirmarbeit an Geminis Bildeingang, und die Sprachschleife an
   * nativem Audio über die Live API. Für nichts davon gibt es bei Ollama oder
   * über die OpenAI-kompatible Schnittstelle von OpenRouter ein Gegenstück —
   * ein Umschalten würde dort nicht langsamer, sondern gar nicht laufen.
   * Deshalb greift diese Einstellung genau dort, wo sie auch wirkt, und die
   * Oberfläche sagt das dazu, statt eine Wahlfreiheit vorzuspiegeln.
   */
  brainProvider: 'gemini' | 'ollama' | 'openrouter' | 'openai' | 'anthropic' | 'chatgpt' | 'lmstudio' | 'jarvis'
  /** Account-specific slug returned by Sign in with ChatGPT model discovery. */
  chatGptModel: string
  /** Modell, das bei `brainProvider: 'openrouter'` benutzt wird. */
  openRouterModel: string
  /** LM Studio: lokaler OpenAI-kompatibler Server; leeres Modell = das gerade geladene. */
  lmStudio: { baseUrl: string; model: string }
  /** Eigenes lokales Modell (GGUF unter ~/JamesJarvis/modelle), gerechnet von llama.cpp. */
  jarvisLocal: { model: string }
  /** Modell bei `brainProvider: 'openai'`. */
  openAiModel: string
  /** Modell bei `brainProvider: 'anthropic'`. */
  anthropicModel: string
  /**
   * Die Lernschleife: Nach Aufgaben mit mehreren Schritten prüft James im
   * Hintergrund, ob daraus eine Anleitung fürs nächste Mal werden soll.
   */
  learnSkills: boolean
  /** Der lokale Weg — für das Denken in der Sprachschleife und für Nebenaufgaben. */
  ollama: OllamaSettings
  /** Die Ohren auf diesem Rechner — siehe `WhisperSettings`. */
  whisper: WhisperSettings
  /** Der Mund auf diesem Rechner — siehe `PiperSettings`. */
  piper: PiperSettings
  researchAgent: ResearchAgentId
  visionModel: string
  audio: AudioSettings
  vad: VadSettings
  wake: WakeSettings
  tokenSaver: TokenSaverSettings
  gamingMode: boolean
  permissions: Record<string, ToolPermission>
  /** False runs permitted actions without asking again; explicit denials remain effective. */
  confirmActions: boolean
  /** Daily local database/settings/skills snapshots; keeps seven automatic copies. */
  automaticBackups: boolean
  mcpServers: McpServerConfig[]
  /**
   * Tageslimit in Dollar für die Posten mit bekanntem Preisschild — derzeit
   * die tiefe Recherche. 0 heißt aus. Geprüft wird vor der Ausgabe, siehe
   * `agent/budget.ts`.
   */
  dailyCostLimitUsd: number
  telephony: TelephonySettings
  /** Kostenlos telefonieren zwischen Nutzer und James über ein SIP-Konto (Linphone). */
  sip: SipSettings
  localFallback: LocalFallbackSettings
  /** Autostart mit Windows, ohne Fenster. Wirkt nur in der installierten Fassung. */
  launchOnStartup: boolean
  companion: CompanionSettings
  smartHome: SmartHomeSettings
  music: MusicSettings
  alexa: AlexaSettings
  /**
   * Welche Kamera `camera_look` benutzt.
   *
   * `null` heißt: die, die der Browser zuerst anbietet — bei einem Notebook
   * also die eingebaute. Ein eigener Eintrag ist nötig, weil an einem Rechner
   * mit Webcam *und* Aufnahmekarte die zuerst angebotene regelmäßig die
   * falsche ist, und weil die Kennung sich zwischen zwei Starts nicht ändert.
   */
  cameraDeviceId: string | null
  /**
   * Ob die Einrichtung einmal durchlaufen wurde.
   *
   * Steuert nur, ob der Assistent beim Start von selbst aufgeht — nicht, was
   * die App kann. Wer schon einen Gemini-Schlüssel hinterlegt hat, gilt als
   * eingerichtet, auch wenn hier noch `false` steht: Sonst bekäme jeder
   * bestehende Nutzer nach dem Update einmal einen Assistenten vorgesetzt für
   * etwas, das längst erledigt ist.
   */
  setupDone: boolean
  /**
   * Zeigt die selten gebrauchten Abschnitte und Felder.
   *
   * Aus heißt nicht abgeschaltet, sondern unsichtbar: Ports, Pfade, lokale
   * Modelle, Telefonie-Innereien. Das sind Stellschrauben für den, der weiß,
   * was er will — für alle anderen sind sie vierzehn Menüpunkte, unter denen
   * die drei stehen, um die es tatsächlich geht.
   */
  showAdvanced: boolean
}


/**
 * Was zuletzt schiefging und was dagegen getan wurde.
 *
 * Bewusst in Sätzen und nicht in Kennungen: Diese Auskunft wird vorgelesen.
 */
export interface SelfHealReport {
  hours: number
  total: number
  healed: number
  summary: string
  problems: {
    area: string
    code: string
    message: string
    count: number
    lastAt: number
    /** Was versucht wurde, oder null wenn kein Gegenmittel passte. */
    attempted: string | null
  }[]
}

/** Ein einzelner, technischer Eintrag für die Gesundheitsanzeige. */
export interface SelfHealIncidentEntry {
  id: number
  ts: number
  area: string
  code: string
  message: string
  remedy: string | null
  healed: boolean | null
}

/** Zustand und jüngste Reparaturhistorie für die Einstellungen. */
export interface SelfHealDashboard {
  report: SelfHealReport
  recent: SelfHealIncidentEntry[]
  automatic: boolean
  checking: boolean
}

/**
 * Ein lokales Modell als Reserve, wenn Gemini nicht antwortet.
 *
 * Kein zweiter Hauptweg und ausdrücklich kein Umschalter: Websuche,
 * Seitenabruf, Preisvergleich und Bildschirmarbeit hängen an
 * Gemini-Eigenheiten — Grounding, urlContext, Bildeingang —, für die es lokal
 * kein Gegenstück gibt, und die Sprachschleife braucht natives Audio über die
 * Live API. Was ein Textmodell auf diesem Rechner übernehmen kann, ist der
 * Rest: übersetzen, verdichten, umformulieren.
 *
 * Deshalb steht hier `enabled` und nicht `provider`. Ein Auswahlfeld würde
 * eine Wahlfreiheit vorspiegeln, die es nicht gibt; ein Schalter sagt, was
 * wirklich passiert — normalerweise Gemini, bei dessen Ausfall das lokale
 * Modell, und wenn auch das nichts liefert, der ehrliche Fehler.
 */
export interface LocalFallbackSettings {
  enabled: boolean
  /** Adresse des Ollama-Dienstes. Standard ist der lokale Port. */
  baseUrl: string
  /** Das Modell, das einspringt — etwa `gemma4:latest`. */
  model: string
}

/**
 * Ein Modell, das in Ollama liegt.
 *
 * Steht hier und nicht neben dem Anbieter, weil beide Seiten dieselbe Form
 * brauchen: Der Hauptprozess füllt sie, das Einstellungsfenster liest sie.
 * Vorher stand die Form zweimal da, und beim Hinzufügen von `embedding` fiel
 * genau das auf — die Oberfläche kannte das Feld nicht, das der Hauptprozess
 * längst mitschickte.
 */
export interface LocalModel {
  name: string
  /** Parameterzahl, etwa "8.0B". */
  parameterSize?: string
  /** Ob das Modell Werkzeugaufrufe beherrscht. */
  tools: boolean
  /**
   * Ob es nur Vektoren erzeugt und keinen Text schreibt.
   *
   * Solche Modelle gehören nicht in die Auswahl für die Reserve — sie können
   * keinen Satz übersetzen. Das Gedächtnis benutzt sie dafür von selbst.
   */
  embedding: boolean
}

/** Was gerade lokal erreichbar ist. */
export interface LocalModelStatus {
  reachable: boolean
  /**
   * Ob das Programm auf der Platte liegt, unabhängig davon ob es läuft.
   *
   * Trennt die beiden Fälle, die „nicht erreichbar" zusammenwirft: gar nicht
   * installiert (dann hilft nur ein Download) oder installiert und nicht
   * gestartet (dann hilft ein Doppelklick). Ohne diese Unterscheidung steht
   * dieselbe Meldung für zwei Dinge, von denen eines eine halbe Stunde dauert
   * und das andere zehn Sekunden.
   */
  installed: boolean
  baseUrl: string
  models: LocalModel[]
}

/**
 * Telefonie über Twilio.
 *
 * Das Land steht hier, weil eine im Adressbuch als `0664 1234567` notierte
 * Nummer ohne diese Angabe nicht auflösbar ist: dieselbe Ziffernfolge ist in
 * Österreich ein Handy und in Deutschland gar nichts. Vorher war Deutschland
 * fest verdrahtet — für jeden außerhalb Deutschlands schlug damit jeder Anruf
 * an eine national notierte Nummer fehl, mit einer Fehlermeldung von Twilio,
 * die den Grund nicht nennt.
 */
/** Wie weit ein Update ist — für die Leiste auf der Startseite. */
export interface UpdateStatus {
  state: 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'error'
  /** Die laufende Version. */
  current: string
  /** Die neue Version, sobald eine gefunden ist. */
  version?: string
  percent?: number
  error?: string
  /** „Später" gedrückt: nicht herunterzählen, beim Beenden einspielen. */
  postponed?: boolean
}

export interface SipStatus {
  enabled: boolean
  registered: boolean
  detail: string
  inCall: boolean
  /** Wie der letzte Anruf ausging — „Es hat geklingelt, aber …", „Abgenommen." */
  lastCall?: string
}

export interface SipSettings {
  /** Bei Linphone angemeldet bleiben, solange die App läuft. */
  enabled: boolean
  /** Benutzername von James' Konto, ohne @domain. */
  username: string
  /** SIP-Domain, bei Linphone `sip.linphone.org`. */
  domain: string
  /** Die Adresse des Nutzers in Linphone, z. B. `name@sip.linphone.org`. Nur sie darf anrufen, nur sie ruft James an. */
  userAddress: string
  /**
   * Am Telefon alles können wie am Rechner. Sicher, weil Linphone nur
   * angemeldete Konten unter ihrer eigenen Adresse anrufen lässt — trotzdem
   * eine eigene Entscheidung.
   */
  fullAccess: boolean
}

export interface TelephonySettings {
  /** Land, aus dem national notierte Nummern (führende 0) stammen. */
  country: PhoneCountry
  /**
   * Stimme für die vorgelesene Nachricht. Die Amazon-Polly-Stimmen der
   * TwiML-`<Say>`-Verb sind an die Sprache gebunden — `Polly.Vicki` ist
   * deutsch, eine englische Stimme liest deutschen Text unverständlich vor.
   */
  voice: string
  /**
   * Statt einer Ansage ein Gespräch.
   *
   * Standardmäßig aus, und das aus demselben Grund wie bei der Fernbedienung:
   * Es macht diesen Rechner über einen Tunnel aus dem offenen Netz erreichbar,
   * und dahinter sitzt etwas, das auf Kosten des Twilio-Kontos telefoniert.
   * Das soll eine Entscheidung sein, die jemand trifft.
   */
  conversation: boolean
  /**
   * Öffentliche Basisadresse des Tunnels, etwa `https://…trycloudflare.com`.
   * Leer heißt: Tailscale Funnel wird beim Anruf selbst eingeschaltet.
   */
  publicUrl: string
  /** Lokaler Port, auf dem der Telefondienst lauscht. Nur hinter dem Tunnel. */
  port: number
  /** Der erste Satz, sobald abgehoben wurde. */
  opening: string
  /**
   * Anrufe auch annehmen, nicht nur führen.
   *
   * Das ist die weitergehende Einstellung, und deshalb eine eigene: Ein
   * ausgehendes Gespräch beginnt damit, dass jemand am Rechner sitzt und es
   * auslöst. Ein eingehendes kommt, wann es will — der Tunnel muss also
   * dauerhaft offenstehen und der Dienst dauerhaft lauschen.
   *
   * Wer anrufen darf, steht im Adressbuch. Nicht als Bequemlichkeit, sondern
   * weil am anderen Ende ein Assistent mit Zugriff auf Kalender, Mail und
   * Dateien sitzt: Eine Telefonnummer ist öffentlich, sobald sie einmal
   * gewählt wurde, und Twilio-Nummern werden von Wählautomaten gefunden.
   */
  incoming: boolean
  /** Was James sagt, wenn er selbst abhebt. */
  incomingGreeting: string
}

/** Was für das Zweiweg-Gespräch bereitsteht — und was fehlt. */
export interface TelephonyStatus {
  /** Ob der Dienst gerade läuft. */
  running: boolean
  publicUrl: string | null
  source: 'tailscale' | 'cloudflared' | 'manuell' | null
  hint?: string
}

/**
 * Was für ein Twilio-Konto hinterlegt ist.
 *
 * Ohne diese Auskunft ist ein Testkonto von außen nicht zu erkennen: Anrufe
 * gehen raus, Twilio meldet `completed`, und trotzdem hört der Angerufene
 * zuerst eine englische Ansage und muss eine Taste drücken, bevor die eigene
 * Nachricht kommt. Wer das nicht weiß, sucht den Fehler im eigenen Code.
 */
export interface TwilioAccountInfo {
  ok: boolean
  trial?: boolean
  friendlyName?: string
  balance?: string
  currency?: string
  fromNumber?: string
  /** Bei Testkonten: die Nummern, die überhaupt erreichbar sind. */
  verifiedNumbers?: string[]
  error?: string
}

/** Länder mit Ziffern für die E.164-Umsetzung. */
export const PHONE_COUNTRIES = [
  { code: 'AT', dial: '+43', label: 'Österreich (+43)' },
  { code: 'DE', dial: '+49', label: 'Deutschland (+49)' },
  { code: 'CH', dial: '+41', label: 'Schweiz (+41)' }
] as const

export type PhoneCountry = (typeof PHONE_COUNTRIES)[number]['code']

/**
 * Die Fernbedienung auf dem Telefon.
 *
 * Aus gutem Grund standardmäßig aus: Sie macht einen Port im Heimnetz auf, und
 * dahinter sitzt etwas, das Mails verschickt. Das soll eine Entscheidung sein,
 * die jemand trifft, und keine, die er beim Auspacken geschenkt bekommt.
 */
export interface CompanionSettings {
  enabled: boolean
  port: number
  /**
   * Woher das Zertifikat kommt, ohne das iOS das Mikrofon sperrt.
   *
   * `local` ist die Vorgabe: eine eigene Stelle auf diesem Rechner, einmal am
   * Telefon eingetragen, danach nie wieder — dafür nur im Heimnetz.
   * `tailscale` gilt auch von unterwegs, verlangt aber ein Konto und eine
   * Installation auf beiden Geräten. Die Wahl erscheint in den Einstellungen
   * nur, wenn Tailscale überhaupt vorhanden ist; sonst wäre es eine Frage nach
   * etwas, das es nicht gibt.
   */
  certSource: 'local' | 'tailscale'
  /**
   * Ob die eigene Stelle am Telefon eingetragen ist.
   *
   * Der Rechner kann das nicht nachsehen — der Schalter dafür sitzt in den
   * iOS-Einstellungen, und von außen ist ihm nicht anzusehen, wie er steht.
   * Also merkt er sich, was der Nutzer bestätigt hat, und hört auf zu fragen.
   */
  caInstalled: boolean
}

/**
 * Smart Home über Home Assistant.
 *
 * Warum diese Brücke und nicht direkt: Der Nutzer dieses Rechners steuert sein
 * Zuhause über Apple Home. HomeKit hat keine Schnittstelle, die ein Programm
 * unter Windows ansprechen könnte — kein REST, keine Wolke, und ein Zubehör,
 * das schon in der Home-App gekoppelt ist, nimmt in aller Regel keinen zweiten
 * Steuernden mehr an. Das ist keine Lücke dieser App, sondern eine Entscheidung
 * von Apple.
 *
 * Home Assistant ist der eine Weg, der beide Seiten erreicht: Es spricht über
 * die HomeKit-Controller-Anbindung mit demselben Zubehör und stellt nach außen
 * eine gewöhnliche HTTP-Schnittstelle bereit. Wer es nicht laufen hat, trägt
 * hier nichts ein — dann gibt es die Werkzeuge schlicht nicht, statt dass sie
 * bei jedem Versuch scheitern.
 */
export interface SmartHomeSettings {
  /** Etwa `http://homeassistant.local:8123`. Ohne Schrägstrich am Ende. */
  baseUrl: string
  /**
   * Bereiche, in denen ohne Rückfrage geschaltet werden darf.
   *
   * Licht und Steckdose sind zurücknehmbar — wer sich vertut, sagt es noch
   * einmal andersherum. Ein Schloss, ein Garagentor und eine Alarmanlage sind
   * es nicht, und die stehen deshalb nicht in der Vorgabe.
   */
  freeDomains: string[]
}

/** Was unter der eingetragenen Adresse tatsächlich antwortet. */
export interface SmartHomeStatus {
  reachable: boolean
  /** Ob überhaupt ein Token hinterlegt ist — ohne ihn gibt es die Werkzeuge nicht. */
  hasToken: boolean
  baseUrl: string
  /** Version von Home Assistant, wenn es sich gemeldet hat. */
  version?: string
  /** Wie viele schaltbare Geräte gefunden wurden. */
  entities?: number
  /** Warum es nicht geht, in einem Satz. */
  error?: string
}

// ─────────────────────────────────────────────────────────────
// Musik
// ─────────────────────────────────────────────────────────────

/**
 * Musik hören — und zwar dort, wo man sie hören will.
 *
 * Zwei Dienste, und sie sind nicht dasselbe in Grün. Der Unterschied ist
 * keine Laune der beiden Firmen, sondern entscheidet, was hier überhaupt
 * möglich ist:
 *
 * **Spotify** hat eine Fernbedienung. Spotify Connect ist eine offene
 * Schnittstelle: Ein Programm kann sich die Geräte auflisten lassen, auf denen
 * das Konto angemeldet ist, und die Wiedergabe auf eines davon schieben. Der
 * Echo Dot steht dort ganz normal drin, sobald in der Alexa-App einmal ein
 * Spotify-Konto verknüpft wurde. Genau deshalb braucht das hier **kein** Home
 * Assistant: Der Ton geht nie über diesen Rechner, sondern Spotifys Wolke sagt
 * dem Lautsprecher direkt, was er spielen soll. Was James macht, ist das, was
 * auch der Knopf unten links in der Spotify-App macht.
 *
 * **Apple Music** hat das nicht. Es gibt keine Schnittstelle, mit der ein
 * fremdes Programm die Wiedergabe auf ein anderes Gerät schieben könnte —
 * AirPlay ist nicht öffentlich, und die Web-Schnittstelle kann Katalog und
 * Bibliothek lesen, aber nichts fernsteuern. Was geht: den richtigen Titel
 * über die Schnittstelle finden und ihn in der Apple-Music-App auf *diesem*
 * Rechner aufmachen. Der Ton kommt dann aus diesem Rechner.
 *
 * Damit auch Apple Music auf dem Echo Dot landet, gibt es den zweiten Weg:
 * das Ausgabegerät von Windows umstellen. Ein Echo Dot, der einmal über
 * Bluetooth gekoppelt wurde, ist für Windows ein Lautsprecher wie jeder
 * andere — und alles, was dieser Rechner abspielt, kommt dann dort heraus.
 * Das ist gröber als Spotify Connect (es betrifft auch James' eigene Stimme),
 * aber es ist der einzige Weg, der für beliebigen Ton funktioniert, und er
 * braucht ebenfalls keine Brücke im Heimnetz.
 */
export interface MusicSettings {
  /**
   * Welcher Dienst gemeint ist, wenn Void keinen nennt.
   *
   * „Spiel mal was von Bowie" muss ohne Rückfrage irgendwo landen, und die
   * Frage „bei Spotify oder bei Apple Music?" ist genau die Sorte Reibung,
   * die einen Sprachassistenten unbenutzbar macht.
   */
  preferred: MusicService
  /**
   * Der Port, auf dem die Spotify-Anmeldung zurückkommt.
   *
   * Anders als bei Google kann der nicht vom Betriebssystem gewürfelt werden:
   * Spotify vergleicht die Rückleitung Zeichen für Zeichen mit dem, was im
   * Entwicklerbereich hinterlegt ist — Port inklusive. Er steht deshalb hier
   * und wird in den Einstellungen zum Abtippen angezeigt.
   */
  spotifyRedirectPort: number
  /**
   * Der Apple-Music-Laden, aus dem gesucht wird — zwei Buchstaben, `at`, `de`.
   *
   * Ohne den passenden Laden fehlen Titel, die es in einem anderen Land nicht
   * gibt, und die Preise und Namen sind die des falschen Marktes.
   */
  appleStorefront: string
  /**
   * Wo ohne Angabe gespielt wird — der Name eines Geräts aus `music_devices`.
   *
   * Leer heißt: dort, wo Spotify zuletzt lief. Wer den Echo Dot einträgt,
   * bekommt „spiel was" ohne weiteres Zutun im Wohnzimmer statt am Rechner.
   */
  defaultDevice: string
}

export type MusicService = 'spotify' | 'apple'

/**
 * Ein Ziel, auf dem Musik landen kann.
 *
 * Die beiden Arten sind grundverschieden und werden deshalb auch nicht
 * vermischt: Bei `connect` spielt Spotifys Wolke direkt auf dem Gerät, dieser
 * Rechner ist gar nicht beteiligt. Bei `output` spielt dieser Rechner, und der
 * Ton geht an den eingestellten Windows-Ausgang — das betrifft dann alles,
 * auch James' Stimme.
 */
export interface MusicDevice {
  id: string
  name: string
  kind: 'connect' | 'output'
  /** Lautsprecher, Rechner, Telefon, Fernseher — wie Spotify es meldet. */
  type: string
  /** Ob dort gerade gespielt wird bzw. ob es der eingestellte Ausgang ist. */
  active: boolean
  /** Nur bei Spotify Connect bekannt. */
  volumePercent: number | null
}

/** Was gerade läuft. */
export interface NowPlaying {
  playing: boolean
  title: string
  artist: string
  album: string
  /** Woher die Auskunft stammt — Spotifys Schnittstelle oder Windows selbst. */
  source: MusicService | 'windows'
  /** Auf welchem Gerät, soweit bekannt. */
  device: string | null
  progressMs: number | null
  durationMs: number | null
}

/** Was für die Einstellungen eingerichtet ist — und was fehlt. */
export interface MusicStatus {
  spotify: {
    /** Ob eine Client-ID hinterlegt ist. Ohne sie geht die Anmeldung nicht. */
    hasClientId: boolean
    connected: boolean
    /**
     * Ob das Konto Premium ist.
     *
     * Die Unterscheidung gehört sichtbar an die Oberfläche, weil sie über
     * alles entscheidet: Spotify beantwortet jeden Steuerbefehl eines
     * Gratiskontos mit einem 403, und das sieht von außen aus wie ein Fehler
     * dieser App. Suchen und Nachsehen gehen auch ohne.
     */
    premium: boolean
    displayName: string | null
    /** Die Adresse, die im Entwicklerbereich stehen muss. Zum Abtippen. */
    redirectUri: string
    error?: string
  }
  apple: {
    /** Team-ID, Key-ID und der private Schlüssel — alle drei oder keiner. */
    hasDeveloperKey: boolean
    /** Ob die Apple-Music-App auf diesem Rechner liegt. */
    appInstalled: boolean
    storefront: string
    error?: string
  }
  devices: MusicDevice[]
  /** Warum die Geräteliste leer ist, falls sie es ist. */
  devicesError?: string
}

// ─────────────────────────────────────────────────────────────
// Alexa
// ─────────────────────────────────────────────────────────────

/**
 * James über den Echo Dot ansprechen.
 *
 * Eine Alexa-Skill, die auf diesen Rechner zeigt: „Alexa, frag James, was
 * heute ansteht" geht an Amazon, Amazon schickt die Wörter durch den Tunnel
 * hierher, James antwortet, der Echo liest vor.
 *
 * Zwei Dinge gehören dazugesagt, weil sie sich nicht ändern lassen:
 *
 * 1. **Das Weckwort bleibt „Alexa".** Amazon lässt Dritte es nicht ändern.
 *    Jede fremde Skill wird über „frag <Name>" angesprochen — es gibt keine
 *    Einstellung dafür und keinen Umweg. Wer „Hey James" sagen will, sagt es
 *    dem Rechner; dort gibt es das Weckwort.
 * 2. **Acht Sekunden.** So lange wartet Alexa auf eine Antwort. Was länger
 *    dauert, bekommt am Echo einen Satz und wird am Rechner zu Ende gebracht.
 *
 * Standardmäßig aus, aus demselben Grund wie Telefonie und Fernbedienung:
 * Eingeschaltet steht ein Endpunkt im offenen Netz, hinter dem ein Assistent
 * mit Zugriff auf Kalender, Musik und Licht sitzt.
 */
export interface AlexaSettings {
  enabled: boolean
  /**
   * Öffentliche Basisadresse, falls schon eine da ist — cloudflared, ngrok,
   * eine feste Adresse. Leer heißt: Es gilt die der Telefonie, und fehlt auch
   * die, baut der Tunnel sich beim Einschalten selbst auf.
   *
   * Einen eigenen Port gibt es hier bewusst nicht. Der Endpunkt hängt als
   * Pfad am selben Server wie die Telefonie, weil es nur einen Weg von außen
   * herein gibt: Tailscale Funnel bildet genau einen lokalen Port auf die
   * öffentliche 443 ab, und ein laufender cloudflared-Tunnel wird
   * wiederverwendet. Zwei Ports wären zwei Tunnel, von denen einer den
   * anderen still verdrängt — ein Feld dafür verspräche eine Wahl, die es
   * nicht gibt.
   */
  publicUrl: string
}

/** Was für die Skill bereitsteht — und was fehlt. */
export interface AlexaStatus {
  running: boolean
  enabled: boolean
  /**
   * Ob die Skill-Kennung hinterlegt ist.
   *
   * Ohne sie startet der Dienst nicht. Sie ist nicht Formsache, sondern die
   * letzte Prüfung an der Tür: Die Tunneladresse ist nicht geheim, und eine
   * fremde Skill könnte auf sie zeigen — deren Anfragen trügen echte
   * Amazon-Unterschriften. Nur die Kennung unterscheidet sie.
   */
  hasSkillId: boolean
  publicUrl: string | null
  source: 'tailscale' | 'cloudflared' | 'manuell' | null
  /** Die vollständige Adresse für den Entwicklerbereich, zum Abtippen. */
  endpoint: string | null
}

export interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  command: string
  args: string[]
  env?: Record<string, string>
  /**
   * Namen der Umgebungsvariablen, deren Werte im Keystore liegen.
   *
   * Nur die Namen stehen hier — die Werte selbst sind API-Keys und gehören
   * nicht in die Einstellungsdatei. Der Client holt sie beim Start dazu.
   */
  secretEnv?: string[]
  /**
   * Adresse eines fernen Servers (Streamable HTTP). Ist sie gesetzt, bleiben
   * `command` und `args` leer — gestartet wird dann nichts, nur verbunden.
   */
  url?: string
  /** HTTP headers contain only ${SECRET_ENV} references, never credentials. */
  headers?: Record<string, string>
}

export interface BackupInfo { file: string; createdAt: number; bytes: number; automatic: boolean }

/** Wie es einem MCP-Server beim letzten Laden ergangen ist. */
export interface McpServerStatus {
  /** ok = läuft, login = Anmeldung nötig, key = Schlüssel fehlt, off = abgeschaltet. */
  state: 'ok' | 'login' | 'key' | 'error' | 'off'
  tools: number
  error?: string
}

// ─────────────────────────────────────────────────────────────
// Secrets — nie im Klartext, nur über safeStorage
// ─────────────────────────────────────────────────────────────

export type SecretKey =
  | 'diagnosticReportToken'
  | 'gemini'
  | 'elevenlabs'
  | 'openrouter'
  /** ChatGPT-Schlüssel von platform.openai.com, für Textaufgaben. */
  | 'openai'
  /** Claude-Schlüssel aus der Anthropic Console, für Textaufgaben. */
  | 'anthropic'
  | 'higgsfield'
  | 'googleOAuthClientId'
  | 'googleOAuthClientSecret'
  | 'twilioAccountSid'
  | 'twilioAuthToken'
  | 'twilioPhoneNumber'
  | 'twilioApiKeySid'
  | 'twilioApiSecret'
  /** Passwort des Linphone-/SIP-Kontos, mit dem James telefoniert. */
  | 'sipPassword'
  /**
   * Die PIN, mit der sich der Nutzer am Telefon als Besitzer ausweist.
   *
   * Die Anrufernummer allein reicht dafür nicht: Sie lässt sich fälschen, und
   * wer die eigene vortäuscht, bekäme sonst Kalender, Gedächtnis und Kontakte
   * vorgelesen. Steht hier eine PIN, fragt Twilio sie per Tastenfeld ab, bevor
   * die Leitung zu James aufgeht.
   */
  | 'phonePin'
  /**
   * Langlebiger Zugriffstoken von Home Assistant.
   *
   * Er hängt hier und nicht in den Einstellungen, weil er genau das ist, was
   * sein Name sagt: ein Schlüssel, mit dem man im Wohnzimmer das Licht
   * ausmachen und die Tür aufsperren kann. Und weil die Werkzeuge über
   * `requiresSecret` daran hängen, taucht die Smart-Home-Gruppe gar nicht erst
   * auf, solange er fehlt — James kann dann nicht behaupten, er käme an die
   * Lampen.
   */
  | 'homeAssistant'
  /**
   * Die Client-ID der eigenen Spotify-Anwendung.
   *
   * Sie muss der Nutzer selbst anlegen, und das ist keine Schikane: Spotify
   * hängt Kontingent und Sperren an die Anwendung, nicht an den Nutzer. Eine
   * mitgelieferte ID wäre für alle dieselbe — einer verstößt gegen die
   * Nutzungsbedingungen, und die Musik ist bei allen aus.
   *
   * Ein Geheimnis gehört nicht dazu. Die Anmeldung läuft über PKCE, weil ein
   * Geheimnis, das auf einem fremden Rechner liegt, keines mehr ist.
   */
  | 'spotifyClientId'
  /** Apple-Entwicklerteam, zehn Zeichen — steht im Developer-Portal oben rechts. */
  | 'appleMusicTeamId'
  /** Die Kennung des MusicKit-Schlüssels, ebenfalls zehn Zeichen. */
  | 'appleMusicKeyId'
  /**
   * Der Inhalt der `.p8`-Datei, vollständig mit BEGIN- und END-Zeile.
   *
   * Damit wird der Entwickler-Token unterschrieben. Apple gibt die Datei genau
   * einmal heraus — wer sie verliert, legt einen neuen Schlüssel an.
   */
  | 'appleMusicPrivateKey'
  /** Öffentlicher Mapbox-Zugangsschlüssel (pk.…) für die 3D-Karten. */
  | 'mapbox'
  /**
   * Die Kennung der Alexa-Skill, `amzn1.ask.skill.…`.
   *
   * Sie steht hier und nicht in den Einstellungen, weil sie genau das tut, was
   * ein Schlüssel tut: Sie ist die letzte Prüfung an einem Endpunkt, der im
   * offenen Netz steht. Die Tunneladresse ist nicht geheim, und eine fremde
   * Skill könnte auf sie zeigen — deren Anfragen kämen mit echten
   * Amazon-Unterschriften an, weil sie wirklich von Amazon kommen. Nur diese
   * Kennung unterscheidet sie.
   */
  | 'alexaSkillId'
  /**
   * Privater iCal-Link eines Kalenders (Google, Outlook, iCloud).
   *
   * Wer ihn hat, kann den Kalender lesen. Deshalb verschlüsselt hier und
   * nicht im Klartext in den Einstellungen.
   */
  | 'calendarIcsUrl'

export interface SecretStatus {
  key: SecretKey
  present: boolean
}

// ─────────────────────────────────────────────────────────────
// Tools
// ─────────────────────────────────────────────────────────────

export interface ToolMeta {
  name: string
  /** Gruppe für die Rechte-Matrix in den Einstellungen. */
  group: ToolGroup
  description: string
  /** Erzwingt Rückfrage — von den Einstellungen nicht abschaltbar. */
  alwaysAsk: boolean
  /** Fehlt der Key, taucht das Tool gar nicht erst in der Registry auf. */
  requiresSecret?: SecretKey
  /** Kurzer gesprochener Satz während der Ausführung, z. B. "Ich schaue nach." */
  spokenHint?: string
}

export type ToolGroup =
  | 'research'
  | 'web'
  | 'system'
  | 'chrome'
  | 'shopping'
  | 'gmail'
  /** Google Kalender über dieselbe Anmeldung wie Gmail. */
  | 'calendar'
  /** Drive, Docs, Tabellen, Aufgaben und Kontakte über dieselbe Google-Anmeldung. */
  | 'workspace'
  /** Yahoo Mail über den James-Browser. */
  | 'mail'
  /** Das Adressbuch, aus dem Empfänger aufgelöst werden. */
  | 'contacts'
  | 'media'
  /** Word, Excel und PowerPoint — erzeugt, nicht bearbeitet. */
  | 'office'
  /**
   * Nachrichten über ein Konto, das dem Nutzer gehört — derzeit WhatsApp.
   *
   * Bewusst nicht bei `mail`: Eine Mail ist an eine Adresse gerichtet und
   * landet in einem Postfach, eine Chatnachricht erscheint sofort auf dem
   * Telefon eines Menschen. Das ist dieselbe Sorte Handlung mit einer anderen
   * Unmittelbarkeit, und die Rechte dafür soll man getrennt setzen können.
   */
  | 'messaging'
  /** Lampen, Steckdosen, Szenen — über Home Assistant als Brücke. */
  | 'smarthome'
  /**
   * Musik hören — Spotify, Apple Music, und wo der Ton herauskommt.
   *
   * Bewusst nicht bei `media`: Dort geht es ums Erzeugen von Bildern und
   * Videos, was Guthaben kostet und deshalb nachfragt. Musik anzumachen kostet
   * nichts und ist in dem Moment zurückgenommen, in dem man „aus" sagt.
   */
  | 'music'
  | 'minecraft'
  | 'memory'
  | 'schedule'
  | 'timer'
  /** Plan, Fertigkeiten, Unteragenten, Gedächtnis-Pflege, Claude Design. */
  | 'agent'
  | 'mcp'
  | 'twilio'

// ─────────────────────────────────────────────────────────────
// Live-Anzeige — was James gerade tut
// ─────────────────────────────────────────────────────────────

export interface ActivityItem {
  id: string
  /** Lesbare Zeile, z. B. „playwright: browser navigate — https://…". */
  label: string
  tool?: string
  /** waiting = wartet auf die Zusage des Nutzers. */
  status: 'running' | 'ok' | 'error' | 'waiting'
  startedAt: number
  durationMs?: number
  /** Fehlertext oder kurzes Ergebnis. */
  detail?: string
  /** Gehört zu einem Unteragenten — dessen Aktivitäts-Id. */
  parentId?: string
  /** jarvis = Sprachschleife, agent = Unteragent, learning = Lernschleife. */
  source: 'jarvis' | 'agent' | 'learning'
  /** Was James dabei denkt, als ganzer Satz für die Denkblase an der Kugel. */
  thought?: string
  /** Bild zum Schritt als Data-URL, etwa das echte Programmsymbol beim Öffnen. */
  icon?: string
}

export interface PlanStep {
  text: string
  status: 'offen' | 'läuft' | 'erledigt' | 'fehlgeschlagen'
}

/** Die Schrittliste, die James sich für eine längere Aufgabe selbst schreibt. */
export interface ActivityPlan {
  title: string
  steps: PlanStep[]
  updatedAt: number
}

/** Ein Punkt der Tageskurve: Zeit in Millisekunden, Preis. */
export interface StockPoint {
  t: number
  p: number
}

// ─────────────────────────────────────────────────────────────
// Geodaten
// ─────────────────────────────────────────────────────────────

/** Ein Punkt auf der Erde in Grad (WGS 84). */
export interface LatLon {
  lat: number
  lon: number
}

/** Ein benannter Punkt — das, was die Ortssuche liefert und eine Karte beschriftet. */
export interface GeoPoint extends LatLon {
  /** Zum Vorlesen und als Beschriftung: „Stephansplatz, Wien". */
  label: string
}

/** Ein Kartenausschnitt in Grad. `west > east` heißt: über die Datumsgrenze. */
export interface GeoBounds {
  south: number
  west: number
  north: number
  east: number
}

/**
 * Ein Linienpunkt in der Reihenfolge von GeoJSON und den Vektorkacheln:
 * erst Länge, dann Breite. Bewusst anders als `LatLon` — Linien kommen in
 * dieser Form aus dem Routing und gehen so in den Kartenzeichner.
 */
export type LonLat = [lon: number, lat: number]

// ─────────────────────────────────────────────────────────────
// Antwortkarten
// ─────────────────────────────────────────────────────────────

/**
 * Was ein Knopf auf einer Karte auslöst.
 *
 * `ask` schickt `prompt` als getippten Satz an James — kostet also einen
 * Gesprächszug. `open` öffnet `url` im Browser; nur https, der Renderer
 * rendert es als `<a target="_blank">`, und `guardExternalLinks` tut den Rest.
 */
export type CardAction =
  | { type: 'ask'; label: string; prompt: string }
  | { type: 'open'; label: string; url: string }

/** Was jede Karte trägt, gleich welcher Art. */
export interface CardBase {
  /**
   * Stabil für denselben Gegenstand. Eine Karte mit derselben Id ersetzt die
   * angezeigte — so kann ein Werkzeug eine Karte nachträglich ergänzen.
   */
  id: string
  /** Wann die Karte gezeigt wurde, in Millisekunden. Setzt der Runner. */
  at?: number
  /** Das Werkzeug, das sie geschickt hat. Setzt der Runner. */
  source?: string
  /** Feste Knöpfe unter der Karte; kosten keine Token, bis jemand klickt. */
  actions?: CardAction[]
}

/**
 * Eine Aktienkarte auf der Startseite, aufgebaut wie die Kurskarte bei Google.
 *
 * Alle Werte stammen aus derselben Abfrage wie der gesprochene Satz — Karte
 * und Stimme können sich deshalb nicht widersprechen.
 */
export interface StockCard extends CardBase {
  kind: 'stock'
  symbol: string
  name: string
  exchange: string
  currency: string
  price: number
  change: number
  changePct: number
  previousClose: number | null
  /** PRE, REGULAR, POST oder CLOSED — berechnet aus den Handelszeiten. */
  marketState: 'PRE' | 'REGULAR' | 'POST' | 'CLOSED'
  /** Zeitpunkt des Kurses in Millisekunden. */
  asOf: number
  /** Zeitzone der Börse, z. B. America/New_York. */
  timezone: string
  open: number | null
  high: number | null
  low: number | null
  yearHigh: number | null
  yearLow: number | null
  volume: number | null
  /** Vor- oder nachbörslicher Kurs, falls es einen gibt. */
  extended: { price: number; change: number; changePct: number; label: 'Vorbörse' | 'Nachbörse' } | null
  /** Beginn und Ende des regulären Handels in Millisekunden — trennen die Kurve farblich. */
  regularStart: number | null
  regularEnd: number | null
  points: StockPoint[]
}

/**
 * Das Wetter von Open-Meteo: jetzt, die nächsten 24 Stunden und sieben Tage.
 *
 * Die Karte bekommt immer die volle Woche, auch wenn das Modell nur zwei Tage
 * vorliest. Zeiten sind Ortszeit ohne Zone (`2026-10-09T14:00`), so wie
 * Open-Meteo sie mit `timezone=auto` liefert. `code` ist der WMO-Wettercode,
 * für ein gezeichnetes Symbol statt eines Emojis.
 */
export interface WeatherCard extends CardBase {
  kind: 'weather'
  place: string
  /** Wo der Ort liegt — für eine kleine Karte im eigenen Zeichner. */
  lat: number
  lon: number
  temperature: number
  /** Gefühlte Temperatur. */
  apparent: number
  humidity: number
  wind: number
  description: string
  code: number
  hourly: { time: string; temperature: number; rain: number; wind: number; code: number }[]
  daily: { date: string; description: string; code: number; max: number; min: number; rain: number }[]
}

/** Ein Treffer der Ortssuche: Geschäft, Einrichtung oder Adresse. */
export interface PlaceItem {
  name: string
  /** Straße, Hausnummer, Ort — ohne den Namen. */
  address?: string
  /** Deutsch, zum Anzeigen: „Apotheke", „Supermarkt". */
  category?: string
  /** Luftlinie bis zum Bezugsort in Metern. */
  distanceM?: number
  lat: number
  lon: number
}

/**
 * Treffer der Ortssuche, nach Entfernung sortiert.
 *
 * Koordinaten stehen nur hier und nie im Ergebnis fürs Modell: Dort kosten sie
 * Token und helfen beim Vorlesen nicht.
 */
export interface PlacesCard extends CardBase {
  kind: 'places'
  /** Was gesucht wurde, wie der Nutzer es gesagt hat. */
  query: string
  /** Der Bezugsort — fehlt, wenn weder einer genannt noch eingestellt ist. */
  around?: GeoPoint
  places: PlaceItem[]
}

/** Die Verkehrsmittel, wie `route_berechnen` sie annimmt. */
export type RouteMode = 'auto' | 'zu_fuss' | 'fahrrad'

/** Eine berechnete Strecke von A nach B. */
export interface RouteCard extends CardBase {
  kind: 'route'
  from: GeoPoint
  to: GeoPoint
  mode: RouteMode
  durationS: number
  distanceM: number
  /** Ankunft bei Abfahrt jetzt, in Millisekunden. */
  arrivalAt: number
  /** Die wichtigsten Straßen, „A2, S6". */
  summary?: string
  /** Die Linie, vereinfacht auf höchstens `ROUTE_PATH_MAX` Punkte. */
  path: LonLat[]
}

/** Höchstzahl der Punkte in `RouteCard.path` — die Karte geht über IPC, nicht ans Modell. */
export const ROUTE_PATH_MAX = 400

/** Termine eines Zeitraums, wie `calendar_agenda` sie liefert. */
export interface AgendaCard extends CardBase {
  kind: 'agenda'
  /** Gesprochen benannt: „heute", „morgen", „diese Woche". */
  range: string
  events: {
    title: string
    /** Beginn in Millisekunden. */
    start: number
    end?: number
    allDay: boolean
    calendar?: string
    location?: string
  }[]
}

/** Quellen einer Websuche — die Adressen stehen hier statt im Modellergebnis. */
export interface SourcesCard extends CardBase {
  kind: 'sources'
  query: string
  sources: { domain: string; url: string; title?: string }[]
}

/** Was ein Werkzeug auf der Startseite zeigen kann. */
export interface BrowserHandoffCard extends CardBase {
  kind: 'browser-handoff'
  query: string
  domain: string
  message: string
}
/** Tagesbriefing beim ersten Öffnen am Tag. */
export interface BriefingCard extends CardBase {
  kind: 'briefing'
  greeting: string
  sections: { title: string; items: string[] }[]
}
export type DisplayCard = StockCard | WeatherCard | PlacesCard | RouteCard | AgendaCard | SourcesCard | BrowserHandoffCard | BriefingCard
export type DisplayCardKind = DisplayCard['kind']

export interface ActivitySnapshot {
  items: ActivityItem[]
  plan: ActivityPlan | null
}

export interface ToolCallRequest {
  id: string
  name: string
  args: Record<string, unknown>
  /** Von einem Unteragenten ausgelöst — dessen Aktivitäts-Id, für die Live-Anzeige. */
  parentId?: string
  budgetId?: string
  /**
   * Was der Nutzer zuletzt gesagt hat und wann. Der Main-Prozess prüft damit,
   * ob ein `confirmed: true` durch eine echte Antwort gedeckt ist — das Modell
   * soll eine Zustimmung nicht erfinden können.
   */
  userTurn?: { lastUserTextAt: number; lastUserText: string }
}

export interface ToolCallResult {
  id: string
  name: string
  ok: boolean
  /** Wird dem Modell zurückgegeben. */
  result?: unknown
  error?: string
  durationMs: number
}

/**
 * Meldung an den Kristall, dass gerade eine Rückfrage offen ist.
 * Gestellt wird sie vom Modell selbst — hier geht es nur um den Farbwechsel.
 */
export interface ConfirmationRequest {
  id: string
  toolName: string
  spokenQuestion: string
  details: Record<string, unknown>
}

// ─────────────────────────────────────────────────────────────
// Audit
// ─────────────────────────────────────────────────────────────

export interface AuditEntry {
  id: number
  ts: number
  tool: string
  args: string
  ok: boolean
  result: string | null
  error: string | null
  durationMs: number
  confirmed: boolean | null
  screenshotPath: string | null
}

// ─────────────────────────────────────────────────────────────
// Research
// ─────────────────────────────────────────────────────────────

export type ResearchStatus = 'in_progress' | 'completed' | 'failed'

export interface ResearchRun {
  id: string
  query: string
  status: ResearchStatus
  agent: ResearchAgentId
  startedAt: number
  finishedAt: number | null
  /** Letzter Zwischenschritt — damit James auf Nachfrage sagen kann, woran er ist. */
  lastThought: string | null
  report: string | null
  sources: string[] | null
}

// ─────────────────────────────────────────────────────────────
// Preiswächter
// ─────────────────────────────────────────────────────────────

export interface PriceWatch {
  id: number
  url: string
  productName: string
  targetPrice: number
  currency: string
  lastPrice: number | null
  lastCheck: number | null
  notified: boolean
  active: boolean
}

export interface PriceOffer {
  vendor: string
  productName: string
  price: number
  currency: string
  shipping: number | null
  totalPrice: number
  availability: string | null
  url: string
}

// ─────────────────────────────────────────────────────────────
// Gedächtnis & Zeitplan
// ─────────────────────────────────────────────────────────────

export interface MemoryEntry {
  id: number
  text: string
  kind: 'fact' | 'preference' | 'person' | 'project'
  createdAt: number
  lastUsed: number | null
}

export interface ScheduleEntry {
  id: number
  cron: string
  prompt: string
  label: string
  active: boolean
  lastRun: number | null
  nextRun: number | null
}

// ─────────────────────────────────────────────────────────────
// Stilllegen
// ─────────────────────────────────────────────────────────────

export interface PauseState {
  paused: boolean
  /**
   * Zeitpunkt, an dem er von selbst zurückkommt, in Millisekunden seit der
   * Epoche. `null` heißt: auf unbestimmte Zeit, bis jemand ihn zurückholt.
   */
  until: number | null
}

// ─────────────────────────────────────────────────────────────
// Kosten
// ─────────────────────────────────────────────────────────────

export interface CostSnapshot {
  todayUsd: number
  monthUsd: number
  liveAudioSeconds: number
  researchRuns: number
}

// ─────────────────────────────────────────────────────────────
// Sparmodus
// ─────────────────────────────────────────────────────────────

export type SavingKind =
  /** Gekürztes Werkzeugergebnis. */
  | 'result'
  /** Aufruf aus dem Zwischenspeicher beantwortet. */
  | 'cache'
  /** Verkürzte Werkzeugbeschreibungen im Verbindungsaufbau. */
  | 'declarations'
  /** Nicht hochgeladene Stille, in Token umgerechnet. */
  | 'silence'
  /** Bildschirmfotos, die die Bildschirmsteuerung gar nicht erst geschickt hat. */
  | 'vision'

export interface TokenReport {
  todayTokens: number
  monthTokens: number
  totalTokens: number
  byKind: { kind: SavingKind; tokens: number }[]
  /** Nicht hochgeladene Mikrofonsekunden, heute. */
  silenceSecondsToday: number
  /** Grobe Ersparnis in Dollar, heute. */
  todayUsd: number
  usage?: { calls: number; knownCalls: number; totalTokens: number | null;
    last: { model: string; total: number | null; input: number | null; output: number | null; ms: number; firstMs: number | null } | null }
}

// ─────────────────────────────────────────────────────────────
// Verbindungen
// ─────────────────────────────────────────────────────────────

/**
 * Was gerade tatsächlich erreichbar ist.
 *
 * Bewusst nicht "ist ein Schlüssel hinterlegt", sondern "funktioniert es":
 * ein eingetragener OAuth-Client sagt nichts darüber, ob die Anmeldung noch
 * gilt, und ein laufendes Chrome nichts darüber, ob es fernsteuerbar ist.
 */
export interface ConnectionStatus {
  id: 'chrome' | 'gmailWeb' | 'yahoo' | 'amazon' | 'whatsapp' | 'gmailApi' | 'input' | 'ollama'
  label: string
  ok: boolean
  detail: string
  /** Was der Nutzer tun kann, wenn es nicht geht. */
  fix?: string
}

// ─────────────────────────────────────────────────────────────
// Adressbuch
// ─────────────────────────────────────────────────────────────

/**
 * Ein Eintrag im Kontaktbuch.
 *
 * Der Grund, warum es das überhaupt gibt: Eine Mailadresse ist gesprochen
 * nicht zuverlässig zu übermitteln. "max punkt muster at example punkt com"
 * kommt als Transkript zurück, das an drei Stellen falsch sein kann, und eine
 * Mail an eine falsche Adresse lässt sich nicht zurückholen. Der Nutzer trägt
 * die Adresse deshalb einmal von Hand ein; danach genügt der Vorname.
 */
export interface Contact {
  id: number
  name: string
  /** Optional: Ein Kontakt darf auch nur für Anrufe angelegt sein. */
  email: string
  /** Telefonnummer im internationalen oder lokalen Wählformat. */
  phone: string
  /** Freitext für den Nutzer — etwa "aus der Schule", um zwei Annas zu trennen. */
  note: string
  createdAt: number
}

// ─────────────────────────────────────────────────────────────
// Timer
// ─────────────────────────────────────────────────────────────

export interface TimerEntry {
  id: number
  label: string
  /** Zeitpunkt in Millisekunden seit der Epoche. */
  dueAt: number
  createdAt: number
  fired: boolean
}

export interface ReminderEntry {
  id: number
  text: string
  dueAt: number
  repeat: 'none' | 'daily' | 'weekly'
  state: 'pending' | 'notified' | 'done'
  createdAt: number
  lastNotifiedAt: number | null
}

// ─────────────────────────────────────────────────────────────
// Eigene lokale Modelle (Hugging Face + llama.cpp)
// ─────────────────────────────────────────────────────────────

/** Ein Suchtreffer auf huggingface.co (nur GGUF). */
export interface HubModel {
  id: string
  downloads: number
  likes: number
  license: string
  gated: boolean
}

/** Die GGUF-Dateien eines Modells, kleinste zuerst. */
export interface HubFiles {
  repo: string
  files: { path: string; size: number; quant: string; split: boolean }[]
  /** Q4_K_M, sonst die kleinste einzelne Datei. */
  recommended: string
}

export interface HubProgress {
  label: string
  received: number
  total: number
  done: boolean
  error: string | null
}

export interface JarvisLocalModel {
  path: string
  name: string
  /** Hugging-Face-Quelle, soweit aus dem Ordner ablesbar. */
  source: string
  size: number
}

export interface JarvisLocalStatus {
  /** llama-server.exe vorhanden. */
  runtime: boolean
  runtimePath: string
  modelsPath: string
  models: JarvisLocalModel[]
  /** Pfad des gerade laufenden Modells, sonst leer. */
  running: string
  downloading: boolean
}
