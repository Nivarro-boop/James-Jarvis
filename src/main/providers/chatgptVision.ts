import type { ChatGptItem, ChatGptResponse } from '@shared/chatgpt'
import { chatGptResponse, chatGptTools } from './chatgptResponses'

/** Gemini declares uppercase schema types; Responses uses JSON Schema. */
export function visionJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(visionJsonSchema)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key,
    key === 'type' && typeof inner === 'string' ? inner.toLowerCase() : visionJsonSchema(inner)
  ]))
}

export interface VisionImage { mimeType: string; base64: string }
interface Declaration { name: string; description?: string; parameters?: unknown }

/** Local actions remain ordinary function tools; no hosted computer-use tool. */
export async function chatGptVision(
  model: string, instructions: string, text: string, images: VisionImage[],
  declarations: Declaration[] = [], signal?: AbortSignal
): Promise<ChatGptResponse> {
  const content = [
    { type: 'input_text', text },
    ...images.map(image => ({ type: 'input_image', image_url: `data:${image.mimeType};base64,${image.base64}` }))
  ]
  const input: ChatGptItem[] = [{ role: 'user', content }]
  const tools = chatGptTools(declarations.map(def => ({ type: 'function', function: {
    ...def, parameters: visionJsonSchema(def.parameters ?? { type: 'OBJECT', properties: {} })
  } })))
  return chatGptResponse(model, instructions, input, { tools, signal, purpose: 'deep' })
}
