import { stripThinking } from './ollama'

/**
 * LM Studio als lokaler Textanbieter.
 *
 * LM Studio bringt einen eigenen Server mit OpenAI-kompatibler Schnittstelle
 * mit (Standard: http://127.0.0.1:1234/v1). Anders als bei Ollama gibt es
 * keine eigene Modellverwaltung über die Schnittstelle — geladen wird in
 * LM Studio selbst, James fragt nur `/models` und schreibt an
 * `/chat/completions`. Kein Schlüssel, alles bleibt auf dem Rechner.
 */

export const LMSTUDIO_DEFAULT_URL = 'http://127.0.0.1:1234/v1'

function base(baseUrl?: string): string {
  return (baseUrl?.trim() || LMSTUDIO_DEFAULT_URL).replace(/\/+$/, '')
}

const reachability = new Map<string, { ok: boolean; at: number }>()

/** Eine Minute gemerkt, damit nicht jede Textaufgabe zwei Sekunden auf einen leeren Port wartet. */
export async function lmStudioReachable(baseUrl?: string): Promise<boolean> {
  const url = base(baseUrl)
  const cached = reachability.get(url)
  if (cached && Date.now() - cached.at < 60_000) return cached.ok
  const ok = (await listLmStudioModels(url).catch(() => null)) !== null
  reachability.set(url, { ok, at: Date.now() })
  return ok
}

/** Die in LM Studio geladenen bzw. verfügbaren Modelle; `null` heißt: Server antwortet nicht. */
export async function listLmStudioModels(baseUrl?: string): Promise<string[] | null> {
  try {
    const res = await fetch(`${base(baseUrl)}/models`, { signal: AbortSignal.timeout(2500) })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: { id?: string }[] }
    return (body.data ?? []).map((m) => m.id ?? '').filter((id) => id && !/embed/i.test(id))
  } catch {
    return null
  }
}

export async function lmStudioThink(
  model: string,
  system: string,
  user: string,
  options: { baseUrl?: string; maxTokens?: number; signal?: AbortSignal } = {}
): Promise<string> {
  const url = base(options.baseUrl)
  // Ohne gewähltes Modell nimmt LM Studio das gerade geladene.
  const chosen = model.trim() || (await listLmStudioModels(url))?.[0]
  if (!chosen) throw new Error('In LM Studio ist kein Modell geladen.')
  const timeout = AbortSignal.timeout(180_000)
  const res = await fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: chosen,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: options.maxTokens ?? 1200,
      temperature: 0.4,
      stream: false
    }),
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  })
  if (!res.ok) {
    reachability.delete(url)
    throw new Error(`LM Studio antwortet mit ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
  }
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  return stripThinking(body.choices?.[0]?.message?.content ?? '')
}
