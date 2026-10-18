import type { ChatGptItem } from './chatgpt'
import { digestDropped } from './agentLoop'

export function toolRoundLimit(saver: boolean): number { return saver ? 4 : 10 }

type HistoryItem = { role: string; content?: unknown; parts?: Record<string, unknown>[] }
const TRUNCATED = '\n[… Kontext gekürzt; für den Wortlaut session_search verwenden …]\n'
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  const room = Math.max(0, limit - TRUNCATED.length)
  const head = Math.ceil(room * 0.6)
  return text.slice(0, head) + TRUNCATED + (room > head ? text.slice(-(room - head)) : '')
}

/** Preserve the newest request, never orphan calls or re-upload inline media. */
function compactLatest<T extends HistoryItem>(group: T[], max: number): T[] {
  const textOf = (item: T): string => typeof item.content === 'string' ? item.content
    : (item.parts ?? []).filter(part => typeof part.text === 'string').map(part => part.text).join('\n')
  const question = group.find(item => item.role === 'user' && textOf(item).trim())
  if (!question) return []
  if (group.length <= 12) {
    for (let width = 1500; width >= 90; width = Math.floor(width / 2)) {
      const compact = group.map(item => ({ ...item,
        ...(typeof item.content === 'string' ? { content: clip(item.content, width) } : {}),
        ...(item.parts ? { parts: item.parts.filter(part => !part.inlineData && !part.fileData).map(part => {
          if (typeof part.text === 'string') return { ...part, text: clip(part.text, width) }
          if (part.functionResponse && typeof part.functionResponse === 'object') {
            const response = part.functionResponse as Record<string, unknown>
            const serialized = JSON.stringify(response.response ?? {})
            return { ...part, functionResponse: { ...response, response: serialized.length <= width ? response.response : { contextTruncated: true, text: clip(serialized, width) } } }
          }
          return part
        }) } : {})
      })) as T[]
      if (JSON.stringify(compact).length <= max) return compact
    }
  }
  // Oversized call arguments cannot be clipped into valid arguments. Omit the
  // complete tool exchange and retain an explicitly lossy text note instead.
  const answer = [...group].reverse().find(item => ['assistant', 'model'].includes(item.role) && textOf(item).trim())
  const text = '[Aktueller Austausch gekürzt; Werkzeugdetails ausgelassen.]\n' + clip(textOf(question), Math.floor(max * 0.55)) + (answer ? '\nLetzte Antwort: ' + clip(textOf(answer), Math.floor(max * 0.25)) : '')
  let summary = text
  const note = (): T => (question.parts ? { role: 'user', parts: [{ text: summary }] } : { role: 'user', content: summary }) as T
  while (JSON.stringify([note()]).length > max) summary = clip(summary, Math.floor(summary.length / 2))
  return [note()]
}

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
    if ((saver && chars + size > 6000) || count + group.length > 12) {
      if (!kept.length) kept.push(compactLatest(group, saver ? 6000 : 18000))
      break
    }
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
  if (!digest || !dropped.length) return kept
  let note = digest
  while (saver && JSON.stringify([{ role: 'user', content: note }, ...kept]).length > 6000 && note.length > 40) note = note.slice(0, Math.floor(note.length / 2))
  return saver && JSON.stringify([{ role: 'user', content: note }, ...kept]).length > 6000 ? kept : [{ role: 'user', content: note }, ...kept]
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
    if (chars + size > 5500 || count + group.length > 12) {
      if (!kept.length) kept.push(compactLatest(group as HistoryItem[], 5500))
      break
    }
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
