/** Credentials stay in the main process. Only conversation items cross IPC. */
export interface ChatGptModel {
  id: string
  name: string
}

export interface ChatGptStatus {
  enabled: boolean
  connected: boolean
  email?: string
  reason?: string
}

export type ChatGptItem = Record<string, unknown>

export interface ChatGptResponse {
  text: string
  output: ChatGptItem[]
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } }
}

export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage'

/**
 * Die Warteliste für „Sign in with ChatGPT".
 *
 * OpenAI vergibt die nötige Client-ID derzeit nur an ausgewählte
 * Geschäftspartner. Ohne sie lässt sich die Anmeldung in der fertigen App
 * nicht einschalten — die Einstellungsseite verweist deshalb hierher.
 */
export const CHATGPT_SIGNIN_WAITLIST_URL = 'https://openai.com/form/sign-in-with-chatgpt-interest/'
