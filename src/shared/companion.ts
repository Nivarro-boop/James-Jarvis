import type { CrystalState } from './types'

/**
 * Der Vertrag zwischen Telefon, Hauptprozess und Kristall.
 *
 * Drei Beteiligte, zwei Verbindungen, ein Server in der Mitte:
 *
 *   Telefon  ──WebSocket──▶  Hauptprozess  ──WebSocket──▶  Kristall (Renderer)
 *
 * Warum der Umweg über zwei Verbindungen und nicht IPC in der zweiten Hälfte:
 * `shared/ipc.ts` sagt im ersten Absatz, dass Audio nicht über IPC läuft, und
 * das soll wahr bleiben. Der Renderer hängt sich deshalb als gewöhnlicher
 * Client an denselben Server, den auch das Telefon benutzt — nur eben über
 * 127.0.0.1. Die Tonblöcke wandern damit über einen Sockel statt durch die
 * strukturierte Klonung von Electron, und der Satz in `ipc.ts` bleibt stehen.
 *
 * Warum der Server überhaupt im Hauptprozess sitzt und nicht im Renderer:
 * Ein Renderer kann keinen Port aufmachen.
 *
 * Steuernachrichten sind JSON in Textrahmen. Ton geht als Binärrahmen mit einem
 * Byte davor — ein `JSON.stringify` mit base64 pro 20-ms-Block wäre dreimal so
 * viel Bytes und dreimal so viel Arbeit, sechzigmal in der Sekunde.
 */

// ─────────────────────────────────────────────────────────────
// Binärrahmen
// ─────────────────────────────────────────────────────────────

/**
 * Das erste Byte eines Binärrahmens sagt, was folgt. Dahinter steht rohes
 * PCM, 16 bit, ein Kanal, in der Bytereihenfolge der Maschine — beide Enden
 * sind Intel oder ARM, also little-endian, und ein Umsortieren pro Block wäre
 * Arbeit für einen Fall, den es nicht gibt.
 */
export const AUDIO_TAG = {
  /** Telefon → Rechner: Mikrofon, 16 kHz. Dieselbe Rate wie die Live-API. */
  mic: 0x01,
  /** Rechner → Telefon: James' Stimme, 24 kHz. */
  voice: 0x02
} as const

export const COMPANION_SAMPLE_RATE = {
  mic: 16_000,
  voice: 24_000
} as const

// ─────────────────────────────────────────────────────────────
// Pfade
// ─────────────────────────────────────────────────────────────

export const COMPANION_PATH = {
  /** Der Kristall. Nur von 127.0.0.1, mit `?key=` aus `companion:hostKey`. */
  host: '/ws/host',
  /** Das Telefon. Braucht `?token=`. */
  phone: '/ws/phone'
} as const

/** Voreingestellter Port. Hoch genug, dass nichts Übliches dort sitzt. */
export const COMPANION_DEFAULT_PORT = 8788

// ─────────────────────────────────────────────────────────────
// Lebenszeichen
// ─────────────────────────────────────────────────────────────

/**
 * Wie oft das Telefon nachfragt, ob die Leitung noch steht — und wie lange
 * Stille es hinnimmt.
 *
 * Ein WebSocket, dessen Weg unterbrochen wurde, meldet das nicht. Weder ein
 * eingeschlafenes Mobilfunknetz noch ein Tailnet, das die Route wechselt,
 * schickt ein Abschiedspaket; beide Enden halten einen Sockel offen, durch den
 * nichts mehr geht. Genau das ist das „manchmal geht es nicht": Die App sagt
 * „verbunden", der Rechner zählt ein Telefon, und der Druck auf die Sprechtaste
 * verschwindet im Nichts.
 *
 * Der Rechner erkennt das von sich aus über die Ping-Rahmen des Protokolls —
 * die beantwortet jeder Browser selbsttätig (siehe `main/companion/websocket.ts`).
 * Umgekehrt geht das nicht: Was der Browser selbsttätig beantwortet, bekommt der
 * Code auf der Seite nie zu sehen. Das Telefon braucht deshalb ein Lebenszeichen
 * eine Etage höher, in derselben Sprache wie alles andere.
 */
export const COMPANION_HEARTBEAT = {
  /** Abstand zwischen zwei Nachfragen des Telefons. */
  intervalMs: 15_000,
  /**
   * Kommt so lange gar nichts — kein `pong`, kein Zustand, kein Ton —, gilt die
   * Leitung als tot und wird neu aufgebaut. Drei Nachfragen dürfen also
   * verlorengehen, bevor jemand die Geduld verliert.
   */
  silenceMs: 45_000
} as const

// ─────────────────────────────────────────────────────────────
// Nachrichten
// ─────────────────────────────────────────────────────────────

/** Was das Telefon schicken darf. */
export type PhoneMessage =
  /** Beim Verbinden, damit die Übersicht einen Namen anzeigen kann. */
  | { t: 'hello'; name: string }
  /**
   * Der Kristalldruck, aus der Ferne. Bedeutet dasselbe wie am Rechner:
   * wecken, unterbrechen oder stilllegen, je nachdem was gerade läuft.
   */
  | { t: 'press' }
  /**
   * Sprechtaste. Anders als am Rechner gibt es auf dem Telefon kein Weckwort —
   * iOS lässt keine App dauerhaft im Hintergrund mithören. Gedrückt halten ist
   * der ehrliche Ersatz: Es ist sofort klar, wann etwas übertragen wird.
   */
  | { t: 'mic'; on: boolean }
  /** Getippt statt gesprochen — im Zug oder wenn jemand danebensitzt. */
  | { t: 'text'; text: string }
  | { t: 'pause'; paused: boolean }
  /**
   * Steht die Leitung noch? Wird beantwortet, ohne den Kristall zu behelligen —
   * auch dann, wenn gerade gar kein Kristallfenster offen ist. Sonst hinge die
   * Antwort an einer zweiten Bedingung, und ein geschlossenes Fenster sähe für
   * das Telefon aus wie ein abgerissenes Netz.
   */
  | { t: 'ping' }

/** Was das Telefon bekommt. */
export type ServerMessage =
  | { t: 'state'; state: CrystalState; paused: boolean; until: number | null }
  /** Einmal beim Verbinden: alles, was das Telefon zum Wecken braucht. */
  | { t: 'wake'; mac: string; broadcast: string; address: string; port: number }
  /** Der Rechner geht schlafen oder James wird beendet. */
  | { t: 'bye'; reason: string }
  | { t: 'error'; message: string }
  /** Damit auf dem Telefon steht, was er gerade tut, ohne Ton abzuwarten. */
  | { t: 'note'; text: string }
  /** Die Antwort auf `ping`. Ihr Inhalt ist gleichgültig, ihr Eintreffen nicht. */
  | { t: 'pong' }

/** Was der Kristall dem Server meldet. */
export type HostMessage =
  | { t: 'state'; state: CrystalState; paused: boolean; until: number | null }
  | { t: 'note'; text: string }

/** Was der Kristall vom Server bekommt — die Wünsche des Telefons. */
export type HostCommand =
  | { t: 'press' }
  | { t: 'mic'; on: boolean }
  | { t: 'text'; text: string }
  | { t: 'pause'; paused: boolean }
  /** Ein Telefon ist gekommen oder gegangen; der Kristall zeigt es an. */
  | { t: 'phones'; count: number }

/**
 * Was Windows über sein Aufwachverhalten preisgibt.
 *
 * Steht hier und nicht in `main/companion/wol.ts`, weil der IPC-Vertrag den Typ
 * braucht und `shared/` nichts aus dem Hauptprozess ziehen darf — der Renderer
 * würde sonst `node:dgram` mitschleppen wollen.
 */
export interface WakeReadiness {
  /** Ob Windows auf dem betreffenden Adapter auf das Zauberpaket hört. */
  armed: boolean | null
  /**
   * Der Schnellstart hält Windows beim Herunterfahren in einem Ruhezustand,
   * aus dem viele Netzwerkkarten nicht mehr aufwachen.
   */
  fastStartup: boolean | null
  adapter: string | null
  note: string
}

/**
 * Was dem Verbinden gerade im Weg steht — höchstens eines auf einmal.
 *
 * Alle gleichzeitig zu melden hätte den Nutzer vor eine Liste gestellt, aus der
 * er sich die Reihenfolge selbst hätte ableiten müssen. Es gibt aber nur eine
 * richtige, und die kennt der Rechner.
 */
export type CompanionBlocker =
  | 'none'
  /** Kein Netzwerk, also keine Adresse, auf die ein Zertifikat lauten könnte. */
  | 'no-address'
  | 'no-certificate'
  | 'server-off'
  /**
   * Die letzte Stufe, und die einzige, die der Rechner nicht selbst prüfen
   * kann: Ob das Telefon der eigenen Stelle traut, weiß nur das Telefon. Statt
   * zu raten, wird gefragt — und die Antwort bleibt stehen, bis jemand sie
   * zurücknimmt.
   */
  | 'ca-not-installed'
  // ── Nur wenn Tailscale als Quelle gewählt ist ────────────
  | 'no-tailscale'
  | 'not-logged-in'

export interface CompanionSetup {
  blocker: CompanionBlocker
  ready: boolean
  /** Eine Zeile, fett. */
  headline: string
  /** Zwei bis drei Sätze darunter, mit dem Warum. */
  detail: string
  /** Was der Knopf tut. `null` heißt: Es gibt nichts mehr zu tun. */
  action: CompanionBlocker | 'enable' | null
  actionLabel: string | null
  /**
   * Ob Tailscale auf diesem Rechner überhaupt vorhanden ist. Nur dann hat die
   * Wahl zwischen den beiden Wegen einen Sinn — sonst zeigte sie auf eine Tür,
   * hinter der nichts ist.
   */
  tailscaleAvailable: boolean
  status: CompanionStatus
}

/** Zustand für die Einstellungsseite. */
export interface CompanionStatus {
  running: boolean
  /**
   * Ob die erste Adresse über TLS läuft. Daran hängt mehr als ein Schloss in
   * der Adresszeile: Ohne sicheren Kontext gibt iOS das Mikrofon nicht frei,
   * und die Sprechtaste bleibt tot.
   */
  secure: boolean
  port: number
  /** Adressen, unter denen das Telefon die Seite erreicht. Die sichere zuerst. */
  urls: string[]
  /** Wie viele Telefone gerade verbunden sind. */
  phones: number
  /** Die Marke im Klartext — sie steht nur hier und im QR-Code. */
  token: string | null
  /**
   * Wo das Telefon die eigene Stelle abholt. `null`, wenn keine gebraucht wird
   * (Tailscale) oder der Zuhörer dafür nicht hochkam.
   */
  caUrl: string | null
  wake: { mac: string; broadcast: string } | null
}
