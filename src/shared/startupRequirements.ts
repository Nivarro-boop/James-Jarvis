import type { Settings } from './types'

/** Only the configured voice pipeline determines whether startup needs Gemini. */
export function needsGeminiForVoice(settings: Settings): boolean {
  if (settings.speech.provider === 'gemini') return true
  if (settings.speech.provider === 'openai') return false
  return settings.speech.hearProvider === 'gemini' || settings.speech.thinkProvider === 'gemini'
}
