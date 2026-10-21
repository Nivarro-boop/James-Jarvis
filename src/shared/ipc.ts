import type { WebsiteAccountInfo, WebsiteAccountInput } from './websiteAccounts'
import type { WorkingContext } from './workingContext'
import type { SkillProposal } from './skillProposal'
import type { BrainGraph, Widget } from './brain'
/**
 * Typisierter IPC-Vertrag.
 *
 * Die Grundregel: Audio läuft nicht über IPC. Der Live-WebSocket und der
 * Sprech-Sockel zu ElevenLabs sitzen im Renderer, damit Mikrofon- und
 * Ausgabe-Blöcke keinen Prozesswechsel machen müssen.
 *
 * Die lokalen Wege sind die begründete Ausnahme, und zwar eine erzwungene:
 * whisper und piper sind fremde Programme, keine Netzverbindungen. Ein
 * Kindprozess lässt sich aus dem Renderer nicht starten, also müssen sie in den
 * Hauptprozess — und damit muss ihr Ton über diese Leitung. Der Aufpreis ist
 * eine Kopie je Block; gemessen an den Millisekunden, die piper zum Sprechen
 * braucht, fällt das nicht ins Gewicht. Die Blöcke tragen deshalb eine
 * Stromnummer: Beim Dazwischenreden muss der Empfänger wissen, welche Blöcke
 * noch zum abgebrochenen Satz gehören und weggeworfen werden müssen.
 */

import type { SipStatus } from './types'
import type { ChatGptItem, ChatGptModel, ChatGptResponse, ChatGptStatus } from './chatgpt'
import type { CompanionSetup, CompanionStatus, WakeReadiness } from './companion'
import type {
  AlexaStatus,
  AuditEntry,
  ConfirmationRequest,
  ConnectionStatus,
  Contact,
  CostSnapshot,
  CrystalState,
  ElevenQuota,
  ElevenVoice,
  LocalModelStatus,
  LocalAsset,
  McpServerStatus,
  ActivitySnapshot,
  DisplayCard,
  UpdateStatus,
  LocalAssetId,
  LocalInstallProgress,
  MemoryEntry,
  MusicStatus,
  OllamaHealth,
  PiperHealth,
  PauseState,
  PriceWatch,
  ResearchRun,
  SelfHealDashboard,
  ScheduleEntry,
  SavingKind,
  SecretKey,
  SecretStatus,
  Settings,
  SmartHomeStatus,
  TimerEntry,
  ReminderEntry,
  TokenReport,
  ToolCallRequest,
  ToolCallResult,
  ToolMeta,
  VoiceServiceStatus,
  TelephonyStatus,
  TwilioAccountInfo,
  WhisperHealth
} from './types'

/** Renderer → Main, mit Antwort. */
export interface IpcInvokeMap {
  'settings:get': { req: void; res: Settings }
  'brain:graph': { req: void; res: BrainGraph }
  'brain:note': { req: { file: string }; res: string | null }
  'brain:widgets': { req: void; res: Widget[] }
  'brain:removeWidget': { req: { id: string }; res: Widget[] }
  'persona:preview': { req: void; res: string }
  'wake:status': { req: void; res: { installed: boolean; missing: string[]; model: string } }
  /**
   * Die Bytes einer Weckwort-Datei: ein `.onnx`-Modell oder `runtime` für die
   * WASM-Binärdatei von onnxruntime. Nötig, weil Chromium im Fenster von
   * `file://` kein `fetch` erlaubt — `null`, wenn die Datei nicht lesbar ist.
   */
  'wake:asset': { req: { name: string }; res: Uint8Array | null }
  /**
   * Eine Vektorkachel von OpenFreeMap als rohes PBF, für den Kartenzeichner.
   *
   * Über den Hauptprozess, weil die CSP des Kristallfensters kein fremdes Netz
   * zulässt — und weil dort die Ablage auf der Platte und der User-Agent
   * sitzen, die der freie Dienst verlangt. `null`: keine Kachel (außerhalb,
   * leer, offline ohne Kopie). Zoom höchstens 14, darüber vergrößert der
   * Zeichner.
   */
  'maps:tile': { req: { z: number; x: number; y: number }; res: Uint8Array | null }
  'backup:list': { req: void; res: import('./types').BackupInfo[] }
  'backup:create': { req: void; res: import('./types').BackupInfo }
  'backup:openFolder': { req: void; res: void }
  'settings:set': { req: Partial<Settings>; res: Settings }
  'settings:reset': { req: void; res: Settings }

  'secrets:status': { req: void; res: SecretStatus[] }
  'secrets:set': { req: { key: SecretKey; value: string }; res: SecretStatus[] }
  'secrets:clear': { req: { key: SecretKey }; res: SecretStatus[] }
  /** Nur der Renderer der Kristall-Seite darf den Gemini-Key ziehen (für den Live-Socket). */
  'secrets:getGeminiForLive': { req: void; res: string | null }
  /**
   * Probiert einen Gemini-Schlüssel aus und speichert ihn nur, wenn er geht.
   *
   * Ohne diesen Schritt fällt ein vertippter oder halb kopierter Schlüssel
   * erst beim ersten Ansprechen auf — und zwar als Kristall, der kurz
   * aufleuchtet und wieder ausgeht. Das ist die Sorte Fehler, bei der niemand
   * auf die Idee kommt, in den Einstellungen nachzusehen. Ein Aufruf gegen die
   * billigste Endstelle der API beantwortet die Frage in einer Sekunde.
   */
  'secrets:checkGemini': { req: { value: string }; res: { ok: boolean; error?: string } }
  'secrets:checkEleven': { req: { value: string }; res: { ok: boolean; error?: string; note?: string } }
  'secrets:checkOpenai': { req: { value: string }; res: { ok: boolean; error?: string } }

  /**
   * Dasselbe für ElevenLabs, und aus demselben Grund: Der Sprech-Socket sitzt
   * im Renderer, weil dort der Ton hingehört.
   */
  'secrets:getElevenForLive': { req: void; res: string | null }

  /**
   * Kurzlebiger Zugang für die OpenAI-Realtime-API.
   *
   * Der eigentliche Schlüssel bleibt im Hauptprozess; der Renderer bekommt nur
   * ein Ein-Minuten-Token für genau einen Verbindungsaufbau.
   */
  'openai:realtimeSecret': { req: void; res: { ok: true; value: string } | { ok: false; error: string } }
  'openai:checkRealtime': { req: void; res: { ok: boolean; error?: string } }

  /**
   * Kontingent und Auswahl bei ElevenLabs.
   *
   * Diese drei laufen im Hauptprozess, obwohl der Renderer den Schlüssel
   * ohnehin bekommt. Der Grund ist nicht Geheimhaltung, sondern der
   * Zwischenspeicher: Die Kontingentfrage darf nicht bei jedem Satz erneut
   * über die Leitung gehen, und ein Zwischenspeicher im Renderer wäre nach
   * jedem Öffnen des Kristallfensters wieder leer.
   */
  'eleven:quota': { req: { fresh?: boolean }; res: ElevenQuota }
  'eleven:voices': { req: void; res: ElevenVoice[] }
  /** Kennung des sparsamsten oder natürlichsten Modells, das dieses Konto sprechen darf. */
  'eleven:bestModel': { req: { quality?: boolean }; res: string | null }
  /**
   * Was gerade gesprochen wurde, damit die gespeicherte Auskunft nicht zwei
   * Minuten lang zu großzügig bleibt — genau die Spanne, in der jemand seine
   * letzten Zeichen verspricht.
   */
  'eleven:spent': { req: { chars: number; creditMultiplier?: number }; res: void }
  /**
   * Einen Satz mit einer Stimme sprechen lassen, ohne die Sitzung anzufassen.
   *
   * Eine Stimme aus einer Liste zu wählen, ohne sie gehört zu haben, ist raten.
   * Zurück kommt MP3 in base64 — im Einstellungsfenster hängt kein Player,
   * sondern ein gewöhnliches Audio-Element.
   */
  'eleven:preview': {
    req: { voiceId: string; text: string }
    res: { ok: boolean; audio?: string; error?: string }
  }

  'tools:list': { req: void; res: ToolMeta[] }
  'tools:call': { req: ToolCallRequest; res: ToolCallResult }
  'tools:cancel': { req: { id: string }; res: void }

  'audit:list': { req: { limit?: number }; res: AuditEntry[] }
  'audit:clear': { req: void; res: void }
  'selfheal:status': { req: { hours?: number }; res: SelfHealDashboard }
  'selfheal:repair': { req: void | { restartVoice: boolean }; res: SelfHealDashboard }
  'diagnostics:send': { req: void; res: { ok: boolean; detail: string } }
  /**
   * Ein abgeschlossener Gesprächszug, in dem James abgelehnt hat.
   *
   * Der Renderer schickt nur Züge, die detectRefusal erkannt hat; der
   * Hauptprozess prüft erneut und meldet nur mit Zustimmung (capabilityGaps).
   */
  'gaps:turn': { req: { request: string; answer: string; channel: string }; res: void }
  'selfheal:clear': { req: void; res: void }

  'research:list': { req: void; res: ResearchRun[] }
  'research:get': { req: { id: string }; res: ResearchRun | null }

  'memory:list': { req: { limit?: number }; res: MemoryEntry[] }
  'memory:delete': { req: { id: number }; res: void }
  /**
   * Von Hand eintragen und berichtigen.
   *
   * Beides geht bis jetzt nur über die Stimme, und das ist die falsche
   * Richtung: Was James über jemanden gespeichert hat, kann falsch sein — ein
   * missverstandener Satz, eine Vorliebe von gestern, ein Name, den das
   * Mikrofon verschluckt hat. Bisher blieb dagegen nur Löschen und Neusagen,
   * und beim Neusagen entscheidet wieder das Mikrofon.
   *
   * Beide Wege gehen ausdrücklich über dieselbe Einbettung wie das
   * Gemerkte — eine von Hand berichtigte Erinnerung, die kein `recall` mehr
   * findet, wäre schlimmer als die falsche davor.
   */
  'memory:add': { req: { text: string; kind?: MemoryEntry['kind'] }; res: MemoryEntry[] }
  'memory:update': { req: { id: number; text: string }; res: MemoryEntry[] }

  /** Das Adressbuch, aus dem der Mailversand seine Empfänger auflöst. */
  'contacts:list': { req: void; res: Contact[] }
  'contacts:upsert': {
    req: { id?: number; name: string; email?: string; phone?: string; note?: string }
    res: Contact
  }
  'contacts:delete': { req: { id: number }; res: void }

  'schedule:list': { req: void; res: ScheduleEntry[] }
  'reminder:list': { req: void; res: ReminderEntry[] }
  'hermes:health': { req: void; res: { ok: boolean; detail: string } }
  'hermes:start': { req: void; res: { ok: boolean; detail: string } }
  'hermes:run': { req: { requestId: string; sessionId: string; input: string }; res: { ok: boolean; text?: string; error?: string } }
  'hermes:cancel': { req: { requestId: string }; res: void }
  'reminder:create': { req: { text: string; at?: string; inMinutes?: number; repeat?: ReminderEntry['repeat'] }; res: ReminderEntry }
  'reminder:update': { req: { id: number; text?: string; at?: string; inMinutes?: number; repeat?: ReminderEntry['repeat'] }; res: ReminderEntry }
  'reminder:done': { req: { id: number }; res: void }
  'reminder:snooze': { req: { id: number; minutes: number }; res: void }
  'schedule:upsert': { req: Partial<ScheduleEntry> & { cron: string; prompt: string }; res: ScheduleEntry }
  'schedule:delete': { req: { id: number }; res: void }

  'watch:list': { req: void; res: PriceWatch[] }
  'watch:delete': { req: { id: number }; res: void }

  'cost:get': { req: void; res: CostSnapshot }
  'budget:admit': { req: { budgetId: string }; res: void }
  'tokens:get': { req: void; res: TokenReport }
  'tokens:reset': { req: void; res: void }
  /** Der Renderer meldet, was er lokal eingespart hat — bislang nur Stille. */
  'tokens:record': { req: { kind: SavingKind; tokens: number }; res: void }

  'timers:list': { req: void; res: TimerEntry[] }
  'timers:cancel': { req: { id: number }; res: void }


  /** Ob Ollama läuft und welche Modelle dort liegen. */
  'local:status': { req: { baseUrl?: string } | void; res: LocalModelStatus }

  /** Zustand des lokalen Sprachdienstes; `start` fährt ihn dabei hoch. */
  'speech:status': { req: { start?: boolean } | void; res: VoiceServiceStatus }
  'speech:stop': { req: void; res: VoiceServiceStatus }

  /** Passive Statusabfrage; startet weder Telefonie noch Tunnel. */
  'control:status': { req: void; res: { telephony: TelephonyStatus; phoneConfigured: boolean; conversationEnabled: boolean; incomingEnabled: boolean; computer: { name: string; grund?: string } } }
  /** Tunnel und Telefondienst hochfahren, ohne zu telefonieren. */
  'telephony:test': { req: void; res: TelephonyStatus }
  'telephony:stop': { req: void; res: TelephonyStatus }
  /** Erreichbar werden: Tunnel hoch, Dienst hoch, Adresse bei Twilio eintragen. */
  'telephony:incoming': { req: void; res: TelephonyStatus }

  /**
   * Was gerade tatsächlich erreichbar ist — Browser, Gmail, Amazon, Eingabe.
   * `start` erlaubt der Prüfung, den James-Browser dafür hochzufahren.
   */
  'connect:status': { req: { start?: boolean } | void; res: ConnectionStatus[] }
  /** Macht den James-Browser auf einer Anmeldeseite sichtbar. */
  'connect:login': {
    req: { target: 'gmail' | 'yahoo' | 'amazon' | 'whatsapp' }
    res: { ok: boolean; error?: string }
  }

  'app:openSettings': { req: { section?: string } | void; res: void }
  'app:quit': { req: void; res: void }
  /**
   * Zeigt die Protokolldatei im Explorer.
   *
   * Wer die App nicht selbst gebaut hat, kann keine Entwicklerwerkzeuge
   * aufmachen. Ein Knopf, der den Ordner öffnet, ist für ihn der einzige Weg,
   * einen Fehlerbericht zu liefern, der mehr enthält als "geht nicht".
   */
  'app:showLog': { req: void; res: void }
  /**
   * Support-Meldung bauen und auf Wunsch öffnen oder kopieren. Geschickt wird
   * nie von hier — der Nutzer sendet im eigenen Mailprogramm oder auf GitHub.
   */
  'support:act': {
    req: { action: 'preview' | 'mail' | 'issue' | 'copy'; beschreibung: string; diagnose: boolean }
    res: { subject: string; body: string; tooLong?: boolean }
  }
  /** Öffnet die druckbare Kurzanleitung im Standardbrowser. */
  'app:openGuide': { req: void; res: void }
  /**
   * Der Kristall meldet dem Hauptprozess, ob er gerade stillgelegt ist.
   * Damit Tray und Hotkey dasselbe anzeigen wie das Fenster — und damit der
   * Wecker einer befristeten Pause im Hauptprozess läuft, wo er das
   * Stilllegen des Renderers überlebt. `until` trägt diese Frist mit.
   */
  'app:pauseState': { req: { paused: boolean; until?: number | null }; res: void }
  /**
   * Und die Gegenrichtung, einmal beim Start des Kristalls.
   *
   * Das Fenster darf geschlossen und über das Tray neu geöffnet werden; der
   * Renderer fängt dann bei „nicht stillgelegt" an, während der Hauptprozess
   * die Pause samt Frist weiterführt. Ohne diese Abfrage stünde nach dem
   * Wiederöffnen das Mikrofon offen, obwohl im Tray noch das Häkchen sitzt.
   */
  'app:pauseGet': { req: void; res: PauseState }
  /** Zieht die System-Prompt-Bausteine inkl. abgerufener Erinnerungen. */
  'agent:systemPrompt': { req: { query?: string } | void; res: string }
  /** Verfügbare Tools als Gemini-functionDeclarations für den Live-Socket. */
  'agent:toolDeclarations': { req: void; res: unknown[] }
  /**
   * Dieselben Werkzeuge im OpenAI-Format — das versteht Ollama.
   *
   * Zwei Formate für dieselbe Liste, weil die beiden Anbieter sie verschieden
   * schreiben. Erzeugt werden beide aus demselben Zod-Schema; auseinanderlaufen
   * können sie deshalb nicht.
   */
  'agent:toolSchemas': { req: void; res: unknown[] }

  /**
   * Die Fernbedienung auf dem Telefon. `companion:status` liefert auch die
   * Marke im Klartext — sie muss ins Einstellungsfenster, sonst kann man sie
   * weder abtippen noch als QR-Code zeigen.
   */
  'companion:status': { req: void; res: CompanionStatus }
  'companion:rotateToken': { req: void; res: CompanionStatus }
  /**
   * Der Schlüssel, mit dem sich der Kristall am inneren Zuhörer anmeldet.
   * Ohne ihn könnte sich jede Webseite im Browser dort einklinken.
   */
  'companion:hostKey': { req: void; res: string }
  /**
   * Die Einrichtungsleiter: was noch fehlt und welcher Knopf es behebt.
   * Ersetzt die frühere Einzelabfrage zu Tailscale — die sagte, wie es steht,
   * aber nicht, was zu tun ist.
   */
  'companion:setup': { req: void; res: CompanionSetup }
  'companion:runSetup': { req: { action: string }; res: CompanionSetup }
  /** Fragt Windows, ob es überhaupt auf ein Zauberpaket hört. */
  'companion:wakeReadiness': { req: void; res: WakeReadiness }
  /** Schaltet das Horchen ein. Braucht erhöhte Rechte, meldet ehrlich zurück. */
  'companion:armWake': { req: void; res: { ok: boolean; note: string } }

  /**
   * Die Antwort auf `camera:capture`.
   *
   * Läuft als Invoke und nicht als Ereignis, weil der Renderer wissen soll, ob
   * der Hauptprozess das Bild überhaupt noch erwartet — nach einer
   * Zeitüberschreitung erwartet er es nicht mehr, und dann ist es besser, das
   * gleich zu erfahren, als ein Megabyte Bilddaten ins Leere zu schicken.
   */
  'camera:frame': {
    req: {
      id: string
      frame?: { base64: string; mimeType: string; width: number; height: number; label: string }
      error?: string
    }
    res: void
  }
  /** Ob Home Assistant unter der eingetragenen Adresse antwortet. */
  'home:status': { req: void; res: SmartHomeStatus }

  /**
   * Was für Musik eingerichtet ist — beide Dienste und alle Ziele auf einmal.
   *
   * Eine Abfrage statt vier, weil die vier Antworten nur zusammen etwas
   * bedeuten: „Spotify verbunden" ohne die Geräteliste beantwortet nicht die
   * Frage, ob der Echo Dot erreichbar ist, und die ist die eigentliche.
   */
  'music:status': { req: void; res: MusicStatus }
  /** Öffnet die Spotify-Anmeldung im Systembrowser und wartet auf die Rückleitung. */
  'music:connectSpotify': { req: void; res: { ok: boolean; name?: string; error?: string } }
  'music:disconnectSpotify': { req: void; res: void }

  /**
   * Die Alexa-Skill: Dienst und Tunnel hoch, bzw. wieder zu.
   *
   * `alexa:status` fasst nichts an und sagt nur, wie es steht — `alexa:start`
   * baut den Tunnel auf und liefert die Adresse, die im Entwicklerbereich
   * eingetragen werden muss.
   */
  'alexa:status': { req: void; res: AlexaStatus }
  'alexa:start': { req: void; res: { ok: boolean; status: AlexaStatus; error?: string } }
  'alexa:stop': { req: void; res: AlexaStatus }

  'mcp:reload': { req: void; res: ToolMeta[] }
  /** Welche Schlüssel eines MCP-Servers hinterlegt sind — nur ja oder nein, nie der Wert. */
  'mcp:secretStatus': { req: { id: string }; res: Record<string, boolean> }
  /** Einen Schlüssel eines MCP-Servers ablegen; ein leerer Wert löscht ihn. */
  'mcp:setSecret': { req: { id: string; name: string; value: string }; res: Record<string, boolean> }
  /** Alle Schlüssel eines Servers wegwerfen, wenn er gelöscht wird. */
  'mcp:clearSecrets': { req: { id: string }; res: void }
  /** Zustand jedes Servers nach dem letzten Laden. */
  'mcp:status': { req: void; res: Record<string, McpServerStatus> }
  /** Stand der Live-Anzeige beim Öffnen des Fensters. */
  'context:get': { req: void; res: WorkingContext }
  'context:clear': { req: void; res: void }
  'context:turn': { req: { request: string; answer: string }; res: void }
  'accounts:list': { req: void; res: WebsiteAccountInfo[] }
  'accounts:save': { req: WebsiteAccountInput; res: WebsiteAccountInfo[] }
  'accounts:remove': { req: { origin: string }; res: WebsiteAccountInfo[] }
  'skills:list': { req: void; res: { name: string; description: string; uses: number; steps: string }[] }
  'skills:proposals': { req: void; res: SkillProposal[] }
  'skills:decide': { req: { id: string; accept: boolean }; res: void }
  'activity:get': { req: void; res: ActivitySnapshot }
  /** Bei einem fernen Server im Systembrowser anmelden, danach neu laden. */
  'mcp:login': { req: { id: string }; res: { ok: boolean; error?: string } }
  /** Die Anmeldung bei einem fernen Server vergessen. */
  'mcp:logout': { req: { id: string }; res: void }
  'diag:ping': { req: void; res: { ok: true; version: string } }

  /** Öffnet die Google-Anmeldung im Systembrowser und wartet auf die Rückleitung. */
  'google:connect': { req: void; res: { ok: boolean; email?: string; error?: string } }
  'google:disconnect': { req: void; res: void }
  /**
   * `calendar` sagt, ob die bestehende Anmeldung auch den Kalender abdeckt.
   *
   * Das ist nicht dasselbe wie `connected`: Wer sich angemeldet hat, bevor es
   * den Kalender gab, ist verbunden und hat trotzdem keinen Kalenderzugriff.
   * Ohne diese Angabe stünde in den Einstellungen „verbunden", während James
   * auf jede Terminfrage mit einer Fehlermeldung antwortet.
   */
  'google:status': { req: void; res: { connected: boolean; calendar: boolean } }
  /** „Sign in with ChatGPT". `enabled` ist falsch, solange OpenAI James nicht freigegeben hat. */
  'chatgpt:connect': { req: void; res: { ok: boolean; email?: string; error?: string } }
  'chatgpt:cancelSignIn': { req: void; res: void }
  'chatgpt:disconnect': { req: void; res: void }
  'chatgpt:status': { req: void; res: ChatGptStatus }
  /** Modelle, die das ChatGPT-Abo des angemeldeten Kontos anbietet. */
  'chatgpt:models': { req: void; res: ChatGptModel[] }
  /**
   * Eine Runde mit ChatGPT als Denkmotor. Die Anmeldung bleibt im
   * Hauptprozess; Textstücke kommen vorab über `chatgpt:delta`.
   */
  'chatgpt:respond': {
    req: { requestId: string; model: string; instructions: string; input: ChatGptItem[]; tools: boolean; budgetId?: string }
    res: { ok: true; response: ChatGptResponse } | { ok: false; error: string }
  }
  'chatgpt:cancel': { req: { requestId: string }; res: void }
  /** Linphone-Anmeldung: Zustand und Neuanmeldung. */
  'sip:status': { req: void; res: SipStatus }
  'sip:restart': { req: void; res: SipStatus }
  'update:get': { req: void; res: UpdateStatus }
  'update:installNow': { req: void; res: boolean }
  'update:postpone': { req: void; res: void }
  /** Ruft die eingetragene Adresse des Nutzers zur Probe an. */
  'sip:testCall': { req: void; res: { ok: boolean; message: string } }
  'openrouter:models': { req: void; res: { id: string; name: string; context: number }[] }
  'lmstudio:models': { req: { baseUrl?: string }; res: { reachable: boolean; models: string[] } }
  /** Was auf diesem Rechner liegt, und ob Ollama überhaupt antwortet. */
  'ollama:health': { req: void; res: OllamaHealth }

  /**
   * Die Ohren auf diesem Rechner.
   *
   * `whisper:health` startet den Dienst, wenn er nicht läuft, wärmt ihn auf und
   * meldet, wie lange das gedauert hat — die einzige ehrliche Auskunft über die
   * Wartezeit, die dieser Rechner der Antwort hinzufügt.
   */
  'whisper:health': { req: void; res: WhisperHealth }
  /**
   * Ein Beitrag wird abgetippt. `seconds` ist seine Länge und keine Beigabe:
   * Daraus rechnet der Dienst aus, wie viel vom Zeitfenster er überhaupt
   * anfassen muss, und das ist der einzige wirksame Hebel auf die Wartezeit.
   */
  'whisper:transcribe': {
    req: { wavBase64: string; seconds: number }
    res: { ok: boolean; text: string; ms: number; error: string | null }
  }

  /**
   * Der Mund auf diesem Rechner.
   *
   * `piper:speak` nimmt einen fertigen Satz, keinen Textbrocken: piper
   * synthetisiert einen Satz in einem Durchlauf und kann innerhalb davon nicht
   * streamen. Wer ihm Bruchstücke gibt, bekommt Bruchstücke zu hören.
   */
  'piper:health': { req: void; res: PiperHealth }
  /** Prozess und ONNX-Sitzung warmlaufen lassen, solange noch niemand wartet. */
  'piper:prewarm': { req: void; res: void }
  'piper:speak': { req: { stream: number; text: string }; res: void }
  /**
   * Dazwischengeredet: Alles ab dieser Stromnummer wird verworfen.
   *
   * Der Prozess wird dabei ausdrücklich nicht getötet — sein Start kostet je
   * nach Fassung mehrere hundert Millisekunden bis Sekunden, und danach ist die
   * ONNX-Sitzung wieder kalt.
   */
  'piper:abort': { req: { stream: number }; res: void }

  /**
   * Die Stücke, die zum lokalen Reden fehlen, und der Knopf, der sie holt.
   *
   * Geladen wird ausschließlich auf ausdrücklichen Klick, und die Herkunft
   * steht in `LocalAsset.url` sichtbar daneben. Was die App mitliefert, ist
   * nichts davon: Ein Sprachmodell von einer halben Gigabyte gehört nicht in
   * einen Installer, und fremde Binärdateien unter fremden Lizenzen sollen eine
   * Entscheidung sein.
   */
  'local:assets': { req: void; res: LocalAsset[] }
  'local:install': { req: { id: LocalAssetId; choice?: string }; res: LocalAsset[] }
}

/** Main → Renderer, ohne Antwort. */
export interface IpcEventMap {
  'state:set': { state: CrystalState; reason?: string }
  /** Die Kacheln auf der Startseite haben sich geändert. */
  'brain:widgets': Widget[]
  'confirm:request': ConfirmationRequest
  'confirm:resolved': { id: string; approved: boolean }
  /** James soll etwas von sich aus sagen (Zeitplan, Preisalarm, Research fertig). */
  'speak:request': { text: string; interrupt: boolean }
  'research:progress': { id: string; thought: string }
  'research:done': { id: string; summary: string }
  /** Die Live-Anzeige hat sich geändert: Schritte, Plan, Unteragenten. */
  'context:changed': WorkingContext
  'skills:proposed': SkillProposal[]
  'activity:update': ActivitySnapshot
  /** Ein Werkzeug zeigt etwas auf der Startseite, z. B. eine Aktienkarte. */
  'display:card': DisplayCard
  /** Ein Update wird gesucht, geladen oder liegt bereit. */
  'update:status': UpdateStatus
  'settings:changed': Settings
  'toast:error': { message: string }
  'session:forceReconnect': void | { repair: boolean }
  /**
   * Tray, Hotkey, Werkzeug oder abgelaufene Frist wollen James stilllegen
   * bzw. wieder aufwecken. Ohne `paused` ist es ein Umschalten. `until` ist
   * der Zeitpunkt des selbsttätigen Aufwachens, falls die Pause befristet ist.
   */
  'app:togglePause': { paused?: boolean; until?: number | null }
  /** Ein Timer ist abgelaufen — James soll es von sich aus sagen. */
  'timer:due': { id: number; label: string }
  'reminder:due': ReminderEntry
  'reminder:changed': void
  /**
   * Der Hauptprozess braucht ein Kamerabild.
   *
   * Nur der Kristall bekommt das: Er läuft immer, hat die Mikrofonfreigabe
   * ohnehin und ist das Fenster, dessen Schließen der Nutzer als „James ist
   * aus" versteht. `deviceId` ist `null` für die Standardkamera.
   */
  'camera:capture': { id: string; deviceId: string | null }

  /**
   * Ein Stück gesprochener Ton von piper.
   *
   * Die Stromnummer ist der ganze Trick am Abbrechen: Der Hauptprozess kann
   * nicht ungeschickt machen, was schon auf der Leitung ist, und ein Satz, der
   * beim Dazwischenreden bereits synthetisiert war, träfe sonst nach dem
   * Verstummen wieder ein. Der Empfänger wirft alles weg, was nicht zur
   * laufenden Nummer gehört.
   *
   * Die Rate ist immer die des Players — umgetastet wird im Hauptprozess, weil
   * dort bekannt ist, was die Stimme wirklich liefert.
   */
  'piper:audio': { stream: number; pcm: Int16Array }
  /** Dieser Strom hat alles Anstehende gesprochen. */
  'piper:idle': { stream: number }
  /**
   * piper kann nicht. `fatal` heißt: auch beim nächsten Versuch nicht — dann
   * soll der Aufrufer den Sprecher wechseln, statt stumm zu bleiben.
   */
  'piper:failed': { stream: number; reason: string; fatal: boolean }
  /** Wie weit ein Download ist. */
  'local:progress': LocalInstallProgress
  /** Ein Stück Antworttext aus `chatgpt:respond`, sobald es da ist. */
  'chatgpt:delta': { requestId: string; text: string }
  'hermes:delta': { requestId: string; text: string }
}

export type IpcInvokeChannel = keyof IpcInvokeMap
export type IpcEventChannel = keyof IpcEventMap

export const IPC_INVOKE_CHANNELS = [
  'settings:get',
  'brain:graph',
  'brain:note',
  'brain:widgets',
  'brain:removeWidget',
  'persona:preview',
  'wake:status',
  'wake:asset',
  'maps:tile',
  'backup:list',
  'backup:create',
  'backup:openFolder',
  'settings:set',
  'settings:reset',
  'secrets:status',
  'secrets:set',
  'secrets:clear',
  'secrets:getGeminiForLive',
  'secrets:checkGemini',
  'secrets:checkEleven',
  'secrets:checkOpenai',
  'secrets:getElevenForLive',
  'openai:realtimeSecret',
  'openai:checkRealtime',
  'eleven:quota',
  'eleven:voices',
  'eleven:bestModel',
  'eleven:spent',
  'eleven:preview',
  'tools:list',
  'tools:call',
  'tools:cancel',
  'audit:list',
  'audit:clear',
  'selfheal:status',
  'selfheal:repair',
  'diagnostics:send',
  'gaps:turn',
  'selfheal:clear',
  'research:list',
  'research:get',
  'memory:list',
  'memory:delete',
  'memory:add',
  'memory:update',
  'contacts:list',
  'contacts:upsert',
  'contacts:delete',
  'schedule:list',
  'reminder:list',
  'hermes:health',
  'hermes:start',
  'hermes:run',
  'hermes:cancel',
  'reminder:create',
  'reminder:update',
  'reminder:done',
  'reminder:snooze',
  'schedule:upsert',
  'schedule:delete',
  'watch:list',
  'watch:delete',
  'cost:get',
  'budget:admit',
  'tokens:get',
  'tokens:reset',
  'tokens:record',
  'timers:list',
  'timers:cancel',
  'local:status',
  'speech:status',
  'speech:stop',
  'telephony:test',
  'telephony:stop',
  'control:status',
  'telephony:incoming',
  'connect:status',
  'connect:login',
  'companion:status',
  'companion:rotateToken',
  'companion:hostKey',
  'companion:setup',
  'companion:runSetup',
  'companion:wakeReadiness',
  'companion:armWake',
  'app:openSettings',
  'app:quit',
  'app:showLog',
  'support:act',
  'app:openGuide',
  'app:pauseState',
  'app:pauseGet',
  'agent:systemPrompt',
  'agent:toolDeclarations',
  'camera:frame',
  'home:status',
  'music:status',
  'music:connectSpotify',
  'music:disconnectSpotify',
  'alexa:status',
  'alexa:start',
  'alexa:stop',
  'agent:toolSchemas',
  'mcp:reload',
  'mcp:secretStatus',
  'mcp:setSecret',
  'mcp:clearSecrets',
  'mcp:status',
  'context:get',
  'context:clear',
  'context:turn',
  'accounts:list',
  'accounts:save',
  'accounts:remove',
  'skills:list',
  'skills:proposals',
  'skills:decide',
  'activity:get',
  'mcp:login',
  'mcp:logout',
  'diag:ping',
  'google:connect',
  'google:disconnect',
  'google:status',
  'chatgpt:connect',
  'chatgpt:cancelSignIn',
  'chatgpt:disconnect',
  'chatgpt:status',
  'chatgpt:models',
  'chatgpt:respond',
  'chatgpt:cancel',
  'sip:status',
  'sip:restart',
  'update:get',
  'update:installNow',
  'update:postpone',
  'sip:testCall',
  'openrouter:models',
  'lmstudio:models',
  'ollama:health',
  'whisper:health',
  'whisper:transcribe',
  'piper:health',
  'piper:prewarm',
  'piper:speak',
  'piper:abort',
  'local:assets',
  'local:install'
] as const satisfies readonly IpcInvokeChannel[]

export const IPC_EVENT_CHANNELS = [
  'state:set',
  'brain:widgets',
  'confirm:request',
  'confirm:resolved',
  'speak:request',
  'research:progress',
  'research:done',
  'context:changed',
  'skills:proposed',
  'activity:update',
  'display:card',
  'update:status',
  'settings:changed',
  'toast:error',
  'session:forceReconnect',
  'app:togglePause',
  'timer:due',
  'reminder:due',
  'reminder:changed',
  'camera:capture',
  'piper:audio',
  'piper:idle',
  'piper:failed',
  'local:progress',
  'chatgpt:delta',
  'hermes:delta'
] as const satisfies readonly IpcEventChannel[]

/**
 * Vollständigkeitsprüfung zur Übersetzungszeit.
 *
 * `satisfies` allein prüft nur, dass jeder Eintrag der Liste ein gültiger Kanal
 * ist — nicht, dass jeder Kanal in der Liste steht. Genau diese Lücke hat
 * `connect:login` gekostet: der Kanal war typisiert und im Hauptprozess
 * behandelt, fehlte aber in der Liste, und die Preload-Brücke wies ihn zur
 * Laufzeit mit "IPC-Kanal nicht erlaubt" ab. Der Anmelde-Knopf unter
 * Verbindungen tat deshalb nichts.
 *
 * Fehlt künftig ein Kanal, nennt der Übersetzer ihn beim Namen:
 * "Type 'connect:login' does not satisfy the constraint 'never'".
 */
type AssertNever<T extends never> = T
type _NoMissingInvokeChannel = AssertNever<
  Exclude<IpcInvokeChannel, (typeof IPC_INVOKE_CHANNELS)[number]>
>
type _NoMissingEventChannel = AssertNever<
  Exclude<IpcEventChannel, (typeof IPC_EVENT_CHANNELS)[number]>
>
