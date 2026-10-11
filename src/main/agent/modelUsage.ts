import type { ChatGptResponse } from '../../shared/chatgpt'

const calls: { model: string; total: number | null; input: number | null; output: number | null; ms: number; firstMs: number | null }[] = []
const count = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

export function recordModelUsage(model: string, usage: ChatGptResponse['usage'], ms: number, firstMs: number | null): void {
  calls.push({ model, total: count(usage?.total_tokens), input: count(usage?.input_tokens), output: count(usage?.output_tokens), ms, firstMs })
  if (calls.length > 100) calls.shift()
}

export function modelUsageReport() {
  const known = calls.filter(call => call.total !== null)
  return { calls: calls.length, knownCalls: known.length,
    totalTokens: known.length ? known.reduce((sum, call) => sum + call.total!, 0) : null,
    last: calls.at(-1) ?? null }
}
