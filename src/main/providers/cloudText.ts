import { getSecret } from '../secrets/keystore'

/**
 * OpenAI und Anthropic direkt, für reine Textaufgaben.
 *
 * Über OpenRouter kommt man an beide auch heran, aber wer schon einen
 * ChatGPT- oder Claude-Schlüssel hat, soll nicht erst ein drittes Konto
 * anlegen müssen. Beide Schnittstellen sind ein einziger POST — dafür lohnt
 * keine weitere Bibliothek.
 *
 * Wie bei OpenRouter gilt: Die Sprachschleife bleibt bei Gemini. Das hier
 * greift nur dort, wo Text hinein- und Text herausgeht, siehe `providers/text`.
 */

export type CloudTextProvider = 'openai' | 'anthropic'

export function cloudTextAvailable(provider: CloudTextProvider): boolean {
  return getSecret(provider) !== null
}

/** Die Fehlermeldung des Anbieters lesen, statt nur den Statuscode zu nennen. */
async function failure(res: Response, who: string): Promise<Error> {
  let detail = ''
  try {
    const body = (await res.json()) as { error?: { message?: string } }
    detail = body.error?.message ?? ''
  } catch {
    // Kein JSON — dann bleibt es beim Statuscode.
  }
  if (res.status === 401) return new Error(`${who} nimmt den Schlüssel nicht an.`)
  if (res.status === 429) return new Error(`${who}: Kontingent erschöpft oder zu viele Anfragen (429).`)
  return new Error(`${who} antwortet mit ${res.status}${detail ? `: ${detail}` : ''}.`)
}

export async function cloudThink(
  provider: CloudTextProvider,
  model: string,
  system: string,
  user: string,
  maxTokens = 1200,
  signal?: AbortSignal
): Promise<string> {
  const apiKey = getSecret(provider)
  if (!apiKey) {
    throw new Error(`Es ist kein ${provider === 'openai' ? 'OpenAI' : 'Anthropic'} Zugang hinterlegt.`)
  }

  if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        // Die neueren Modelle lehnen `max_tokens` ab und wollen diesen Namen.
        max_completion_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      })
    })
    if (!res.ok) throw await failure(res, 'OpenAI')
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return data.choices?.[0]?.message?.content ?? ''
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }]
    })
  })
  if (!res.ok) throw await failure(res, 'Anthropic')
  const data = (await res.json()) as { content?: { type: string; text?: string }[] }
  return (data.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
}
