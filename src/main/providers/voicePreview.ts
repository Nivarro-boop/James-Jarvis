import { getSecret } from '../secrets/keystore'
import { VOICES } from '@shared/types'
import { CLEAN_DELIVERY, pcmRate, pcmToWav, type VoicePreviewRequest, type VoicePreviewResult } from '@shared/voiceGallery'

/**
 * Hörproben für die Stimmen-Galerie, ohne die laufende Sitzung anzufassen.
 *
 * Gemini Live und OpenAI Realtime sprechen nur innerhalb einer Sitzung. Für
 * eine Probe gibt es bei beiden einen gewöhnlichen Sprachendpunkt mit denselben
 * Stimmen: Gemini-TTS kennt die 30 Live-Stimmen beim Namen, `audio/speech` von
 * OpenAI die Realtime-Stimmen. Der Klang ist derselbe, die Betonung kann leicht
 * abweichen, weil im Gespräch ein anderes Modell spricht.
 */

/** Neuere Modelle zuerst; ein 404 heißt nur, dass dieses Konto es (noch) nicht hat. */
const GEMINI_TTS_MODELS = ['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts']
const OPENAI_VOICES = new Set(['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'])

export async function voicePreview(request: VoicePreviewRequest, fetcher: typeof fetch = fetch): Promise<VoicePreviewResult> {
  const text = String(request?.text ?? '').trim().slice(0, 400)
  if (!text) return { ok: false, error: 'Kein Text für die Hörprobe.' }
  if (request.provider === 'gemini') return geminiPreview(String(request.voice), text, fetcher)
  if (request.provider === 'openai') return openAiPreview(String(request.voice), text, fetcher)
  return { ok: false, error: 'Für diesen Anbieter gibt es hier keine Hörprobe.' }
}

async function geminiPreview(voice: string, text: string, fetcher: typeof fetch): Promise<VoicePreviewResult> {
  if (!VOICES.some((v) => v.name === voice)) return { ok: false, error: 'Unbekannte Gemini-Stimme.' }
  const key = getSecret('gemini')
  if (!key) return { ok: false, error: 'Für die Hörprobe fehlt der Gemini-Schlüssel (Einstellungen → Zugänge).' }
  let lastError = 'Gemini hat keine Hörprobe geliefert.'
  for (const model of GEMINI_TTS_MODELS) {
    try {
      const response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Sprich klar, ruhig und freundlich: ${text}` }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
          }
        })
      })
      if (response.status === 404) { lastError = 'Gemini-Sprachmodell für Hörproben nicht verfügbar.'; continue }
      if (response.status === 401 || response.status === 403) return { ok: false, error: 'Der Gemini-Schlüssel wird nicht akzeptiert.' }
      if (response.status === 429) return { ok: false, error: 'Gemini-Kontingent für Hörproben gerade erschöpft. Später noch einmal.' }
      if (!response.ok) { lastError = `Gemini-Hörprobe nicht möglich (HTTP ${response.status}).`; continue }
      const body = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }> }
      const part = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData
      if (!part?.data) continue
      const pcm = Buffer.from(part.data, 'base64')
      const wav = pcmToWav(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), pcmRate(part.mimeType))
      return { ok: true, audio: Buffer.from(wav).toString('base64'), mime: 'audio/wav' }
    } catch {
      lastError = 'Gemini ist für die Hörprobe nicht erreichbar.'
    }
  }
  return { ok: false, error: lastError }
}

async function openAiPreview(voice: string, text: string, fetcher: typeof fetch): Promise<VoicePreviewResult> {
  if (!OPENAI_VOICES.has(voice)) return { ok: false, error: 'Unbekannte OpenAI-Stimme.' }
  const key = getSecret('openai')
  if (!key) return { ok: false, error: 'Für diese Stimme fehlt der OpenAI-API-Schlüssel (Einstellungen → Zugänge). Das ChatGPT-Abo reicht dafür nicht.' }
  try {
    const response = await fetcher('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: text, instructions: CLEAN_DELIVERY, response_format: 'mp3' })
    })
    if (response.status === 401) return { ok: false, error: 'Der OpenAI-Schlüssel wird nicht akzeptiert.' }
    if (response.status === 429) return { ok: false, error: 'OpenAI-Guthaben oder Anfragelimit erreicht.' }
    if (!response.ok) return { ok: false, error: `OpenAI-Hörprobe nicht möglich (HTTP ${response.status}).` }
    return { ok: true, audio: Buffer.from(await response.arrayBuffer()).toString('base64'), mime: 'audio/mpeg' }
  } catch {
    return { ok: false, error: 'OpenAI ist für die Hörprobe nicht erreichbar.' }
  }
}
