import type { Settings } from '@shared/types'

/**
 * Zwei Motoren, ein Anschluss.
 *
 * James kann auf zwei Arten sprechen, und sie sind grundverschieden gebaut:
 *
 * - `LiveSession` hält einen offenen Sockel zu Googles Live-API. Zuhören,
 *   Denken und Sprechen passieren dort in einem Stück, das Sprechpausen-Erkennen
 *   macht der Server, und der Ton kommt fertig zurück.
 *
 * - `CascadeSession` baut dasselbe aus Einzelteilen: Der Redebeitrag wird hier
 *   erkannt und gesammelt, als Ganzes an ein gewöhnliches Gemini-Modell
 *   geschickt, und was zurückkommt, liest ElevenLabs vor.
 *
 * Der Controller soll den Unterschied nicht kennen. Er kennt nur diese
 * Schnittstelle — und weil beide sie erfüllen, lässt sich mitten im Betrieb
 * umschalten: Geht ElevenLabs das Kontingent aus, tritt der Live-Motor an seine
 * Stelle, und der Nutzer merkt es an der Stimme, nicht an einem Ausfall.
 */
export interface VoiceEngine {
  isConnected(): boolean
  isStarting(): boolean
  /**
   * Nimmt dieser Motor gerade Ton entgegen?
   *
   * Nicht dasselbe wie `isConnected`, und der Unterschied entscheidet über den
   * ersten Satz: Der Live-Motor hebt auf, was während des Verbindungsaufbaus
   * ankommt, und reicht es nach — für ihn gilt „ja", lange bevor die Leitung
   * steht. Der Kaskaden-Motor kann das nicht und sagt es auch so. Der Regler
   * fragt deshalb hier und nicht nach der Verbindung.
   */
  isAcceptingAudio(): boolean
  start(): Promise<void>
  stop(): Promise<void>
  dispose(): Promise<void>
  /** 20-ms-Blöcke, 16 kHz, wie sie die Aufnahme liefert. */
  pushAudio(pcm: Int16Array): void
  /** Text als Nutzerbeitrag einspeisen — vom Telefon, aus einem Zeitplan. */
  sendText(text: string): boolean | void
  /** Sofort verstummen. */
  interrupt(): void
  /** Werkzeugliste oder Prompt haben sich geändert. */
  refreshConfig(): Promise<void>
  updateSettings(settings: Settings): void

  /**
   * Solange James spricht, soll nichts vom Mikrofon hochgeladen werden —
   * sonst hört er sich selbst und unterbricht sich in einer Endlosschleife.
   */
  onUploadGate: ((muted: boolean) => void) | null
  /** Abzweig der Sprachausgabe an das Telefon. */
  onOutputAudio: ((pcm: Int16Array) => void) | null
  /**
   * Dieser Motor kann nicht mehr und bittet um Ablösung.
   *
   * Der Weg zurück ist nicht seine Sache: Er weiß, dass er am Ende ist, aber
   * nicht, was stattdessen laufen soll. Das entscheidet der Controller.
   */
  onExhausted: ((reason: string) => void) | null
}

export type EngineState = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'idle'

export interface VoiceEngineEvents {
  onStateChange(state: EngineState): void
  onUserTranscript(text: string): void
  onModelTranscript(text: string): void
  onError(message: string): void
  onClosed(): void
}
