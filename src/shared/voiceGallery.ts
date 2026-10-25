import type { Settings, VoiceName } from './types'

/**
 * Die Stimmen-Galerie: klare, ruhige Assistentenstimmen nach dem Vorbild von Siri.
 *
 * Siris eigene Stimme gehört Apple und läuft nur auf Apple-Geräten; nachbauen
 * oder mitliefern lässt sie sich nicht. Was Siri ausmacht, lässt sich aber
 * auswählen: eine saubere, gleichmäßige Stimme ohne Rauschen, deutliche
 * Konsonanten, ruhiges Tempo, freundlich, ohne Schauspiel. Die Galerie sucht
 * dafür bei jedem Anbieter die passendsten Stimmen heraus und stellt die
 * Regler so, dass sie möglichst „clean“ klingen.
 *
 * Eine Auswahl ändert den Sprachweg (`speech.provider`) und die Stimme dieses
 * Wegs. Alles andere bleibt, wie es ist.
 */

export type GalleryProvider = 'gemini' | 'openai' | 'elevenlabs' | 'piper'

export interface GalleryVoice {
  id: string
  /** Kurzer Name auf der Karte. */
  label: string
  /** Wie die Stimme klingt, in einem halben Satz. */
  sound: string
  pitch: 'hell' | 'mittel' | 'tief'
  provider: GalleryProvider
  /** Stimmenname beim Anbieter: Gemini-Name, OpenAI-Stimme, ElevenLabs-Name oder piper-Kennung. */
  voice: string
  /** Bekannte Kennung der ElevenLabs-Standardstimme, falls das Konto sie nicht namentlich liefert. */
  elevenId?: string
  /** Am nächsten an Siri: oben in der Galerie und mit Abzeichen. */
  siriLike?: boolean
}

export const GALLERY_PROVIDER_LABELS: Record<GalleryProvider, { name: string; needs: string }> = {
  gemini: { name: 'Gemini Live', needs: 'Gemini-Schlüssel' },
  openai: { name: 'OpenAI', needs: 'OpenAI-API-Schlüssel' },
  elevenlabs: { name: 'ElevenLabs', needs: 'ElevenLabs-Schlüssel' },
  piper: { name: 'Lokal', needs: 'ohne Internet' }
}

export const VOICE_GALLERY: readonly GalleryVoice[] = [
  { id: 'gemini-erinome', label: 'Klar', sound: 'Hell, deutlich und ruhig — am nächsten an Siri', pitch: 'hell', provider: 'gemini', voice: 'Erinome', siriLike: true },
  { id: 'gemini-iapetus', label: 'Klar · tief', sound: 'Saubere Konsonanten, ruhige Männerstimme', pitch: 'tief', provider: 'gemini', voice: 'Iapetus', siriLike: true },
  { id: 'openai-marin', label: 'Marin', sound: 'Sehr natürlich und sauber, freundlich', pitch: 'mittel', provider: 'openai', voice: 'marin', siriLike: true },
  { id: 'openai-cedar', label: 'Cedar', sound: 'Natürlich, warm und gleichmäßig', pitch: 'tief', provider: 'openai', voice: 'cedar', siriLike: true },
  { id: 'eleven-sarah', label: 'Sarah', sound: 'Weich, sicher und klar', pitch: 'mittel', provider: 'elevenlabs', voice: 'Sarah', elevenId: 'EXAVITQu4vr4xnSDxMaL', siriLike: true },
  { id: 'eleven-eric', label: 'Eric', sound: 'Glatt, vertrauenswürdig, ruhig', pitch: 'tief', provider: 'elevenlabs', voice: 'Eric', elevenId: 'cjVigY5qzO86Huf0OWal' },
  { id: 'gemini-kore', label: 'Bestimmt', sound: 'Fest und klar, Google-Standard', pitch: 'mittel', provider: 'gemini', voice: 'Kore' },
  { id: 'gemini-achernar', label: 'Sanft', sound: 'Leise, zurückhaltend, angenehm nah', pitch: 'hell', provider: 'gemini', voice: 'Achernar' },
  { id: 'gemini-charon', label: 'Sonor', sound: 'Tief und ruhig wie eine Ansage', pitch: 'tief', provider: 'gemini', voice: 'Charon' },
  { id: 'gemini-sulafat', label: 'Warm', sound: 'Warm und voll, bisherige Voreinstellung', pitch: 'mittel', provider: 'gemini', voice: 'Sulafat' },
  { id: 'eleven-alice', label: 'Alice', sound: 'Britisch, klar und deutlich', pitch: 'hell', provider: 'elevenlabs', voice: 'Alice', elevenId: 'Xb7hH8MSUJpSbSDYk0k2' },
  { id: 'eleven-daniel', label: 'Daniel', sound: 'Britisch, gesetzt — klassischer Butler', pitch: 'tief', provider: 'elevenlabs', voice: 'Daniel', elevenId: 'onwK4e9ZLuTAKqWW03F9' },
  { id: 'piper-kerstin', label: 'Kerstin', sound: 'Hell, offline — hörbar synthetischer', pitch: 'hell', provider: 'piper', voice: 'de_DE-kerstin-low' },
  { id: 'piper-thorsten', label: 'Thorsten', sound: 'Voll, offline — hörbar synthetischer', pitch: 'tief', provider: 'piper', voice: 'de_DE-thorsten-high' }
]

export function galleryVoice(id: string): GalleryVoice | undefined {
  return VOICE_GALLERY.find((voice) => voice.id === id)
}

/**
 * Sprechweise für das Modell.
 *
 * Gemini Live und OpenAI Realtime sprechen selbst; ihre Betonung folgt dem
 * Systemtext. Der Satz ist für jede Galerie-Stimme gleich, damit der Anfang
 * des Systemtexts zwischengespeichert bleibt.
 */
export const CLEAN_DELIVERY =
  'Sprechweise: klar, ruhig und freundlich wie ein moderner Sprachassistent. Gleichmäßiges, ' +
  'mittleres Tempo, deutliche Aussprache, keine Füllwörter, kein Schauspiel, keine übertriebene ' +
  'Betonung. Kurze, natürlich gesprochene Sätze.'

/** Die Einstellungsänderung, die eine Galerie-Stimme auswählt. */
export function galleryPatch(settings: Settings, entry: GalleryVoice, elevenVoiceId?: string): Partial<Settings> {
  const speech = { ...settings.speech, voicePreset: entry.id }
  switch (entry.provider) {
    case 'gemini':
      return { voice: entry.voice as VoiceName, speech: { ...speech, provider: 'gemini' } }
    case 'openai':
      return { speech: { ...speech, provider: 'openai', realtimeVoice: entry.voice } }
    case 'elevenlabs':
      // Siri klingt gleichmäßig: mehr Stabilität, wenig Stil, Tempo eins.
      return {
        speech: {
          ...speech,
          provider: 'elevenlabs',
          elevenVoiceId: elevenVoiceId || entry.elevenId || '',
          stability: 0.55,
          similarity: 0.8,
          style: 0.15,
          speed: 1
        }
      }
    case 'piper':
      // Weniger Klangrauschen und gleichmäßigere Lautlängen klingen sauberer.
      return {
        speech: { ...speech, provider: 'piper' },
        piper: { ...settings.piper, noiseScale: 0.4, noiseW: 0.5, lengthScale: 1.02 }
      }
  }
}

/** Welche Galerie-Stimme gerade tatsächlich spricht. Eine geänderte Einzelstimme hebt die Auswahl auf. */
export function activeGalleryVoice(settings: Settings): GalleryVoice | undefined {
  const entry = galleryVoice(settings.speech.voicePreset)
  if (!entry || entry.provider !== settings.speech.provider) return undefined
  if (entry.provider === 'gemini' && settings.voice !== entry.voice) return undefined
  if (entry.provider === 'openai' && settings.speech.realtimeVoice !== entry.voice) return undefined
  if (entry.provider === 'piper' && !settings.piper.voicePath.includes(entry.voice)) return undefined
  return entry
}

export interface VoicePreviewRequest {
  provider: 'gemini' | 'openai'
  voice: string
  text: string
}

export interface VoicePreviewResult {
  ok: boolean
  /** base64 */
  audio?: string
  mime?: 'audio/wav' | 'audio/mpeg'
  error?: string
}

/** Rohes 16-Bit-PCM (Gemini-TTS liefert 24 kHz mono) in eine abspielbare WAV-Datei packen. */
export function pcmToWav(pcm: Uint8Array, sampleRate = 24000, channels = 1): Uint8Array {
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  const write = (offset: number, text: string): void => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)) }
  write(0, 'RIFF'); view.setUint32(4, 36 + pcm.length, true); write(8, 'WAVE')
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * 2, true)
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true)
  write(36, 'data'); view.setUint32(40, pcm.length, true)
  const out = new Uint8Array(44 + pcm.length)
  out.set(new Uint8Array(header), 0)
  out.set(pcm, 44)
  return out
}

/** Abtastrate aus einem MIME-Typ wie `audio/L16;codec=pcm;rate=24000`. */
export function pcmRate(mime: string | undefined): number {
  const match = /rate=(\d+)/i.exec(mime ?? '')
  const rate = match ? Number(match[1]) : 24000
  return rate >= 8000 && rate <= 48000 ? rate : 24000
}
