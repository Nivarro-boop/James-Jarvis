import type { ChatGptItem } from './chatgpt'
import { digestDropped } from './agentLoop'

export function toolRoundLimit(saver: boolean): number { return saver ? 4 : 10 }

/** Drop entire old exchanges, keeping tool calls and their responses together. */
export function budgetCompletedHistory<T extends { role: string; content?: unknown; parts?: Record<string, unknown>[] }>(history: T[], saver: boolean): T[] {
  const groups: T[][] = []
  for (const item of history) {
    const question = item.role === 'user' && (!item.parts || item.parts.some(p => p.text || p.inlineData))
    if (question) groups.push([])
    if (groups.length) groups.at(-1)!.push(item)
  }
  const kept: T[][] = []
  let chars = 0
  let count = 0
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i]
    const size = JSON.stringify(group).length
    // Normal mode also cuts at whole question boundaries, never in the middle of a tool exchange.
    if ((saver && chars + size > 6000) || count + group.length > 12) break
    kept.unshift(group)
    chars += size
    count += group.length
  }
  const tail = kept.flat()
  if (saver || tail.length === history.length) return tail
  const dropped = history.slice(0, history.length - tail.length)
  const digest = digestDropped(dropped.map(item => ({ role: item.role === 'model' ? 'assistant' : item.role,
    content: item.content ?? item.parts?.filter(p => typeof p.text === 'string').map(p => p.text).join(' ') })))
  if (!digest) return tail
  const note = history.some(item => item.parts) ? { role: 'user', parts: [{ text: digest }] } : { role: 'user', content: digest }
  return [note as T, ...tail]
}

/** ChatGPT session history contains completed text exchanges, never pending calls. */
export function budgetConversation(history: ChatGptItem[], saver: boolean): ChatGptItem[] {
  const summaries = history.filter(item => typeof item.content === 'string' && item.content.startsWith('[Früher im Gespräch]'))
  const exchanges = history.filter(item => !summaries.includes(item))
  const kept = trimConversation(exchanges, saver)
  // Hermes-Art: Weggefallenes als kurze Notiz voranstellen statt vergessen.
  const dropped = [...summaries, ...exchanges.slice(0, exchanges.length - kept.length)]
  const digest = digestDropped(dropped, saver ? 400 : 900)
  return digest && dropped.length ? [{ role: 'user', content: digest }, ...kept] : kept
}

function trimConversation(history: ChatGptItem[], saver: boolean): ChatGptItem[] {
  if (!saver) return trimToQuestion(history.slice(-12))
  const groups: ChatGptItem[][] = []
  for (const item of history) {
    if (item.role === 'user' || !groups.length) groups.push([])
    const content = typeof item.content === 'string' ? item.content : ''
    groups.at(-1)!.push(item.role === 'assistant' && content.length > 2000
      ? { ...item, content: `${content.slice(0, 2000)}\n[Ältere Antwort gekürzt]` } : item)
  }
  const kept: ChatGptItem[][] = []
  let chars = 0
  let count = 0
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i]
    const size = JSON.stringify(group).length
    if (chars + size > 6000 || count + group.length > 12) break
    kept.unshift(group)
    chars += size
    count += group.length
  }
  return kept.flat()
}

/** Ein abgeschnittener Verlauf soll mit einer Frage beginnen, nicht mitten in einer Antwort. */
function trimToQuestion(items: ChatGptItem[]): ChatGptItem[] {
  const start = items.findIndex((item) => item.role === 'user')
  return start <= 0 ? items : items.slice(start)
}
