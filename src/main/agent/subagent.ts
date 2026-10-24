import { randomUUID } from 'node:crypto'
import { friendlyGeminiError, geminiAvailable, generateWithFallback } from '../providers/gemini'
import { getSettings } from '../store/settings'
import { allTools, toJsonSchema } from '../tools/registry'
import { permissionFor } from '../tools/permissions'
import { runTool } from '../tools/runner'
import { activityAnnotate, activityEnd, activityStart } from './activity'
import { modelTurn } from '../providers/geminiTurn'
import { chatGptResponse, chatGptTools } from '../providers/chatgptResponses'
import type { ChatGptItem } from '@shared/chatgpt'
import type { Settings } from '@shared/types'
import { slimDescription } from './tokenSaver'
import { toolRoundLimit } from '@shared/conversationBudget'
import { ToolLoopGuard, guardedCall } from '@shared/agentLoop'

/** Unteragenten arbeiten unbeaufsichtigt und dürfen mehr Runden als die Sprachschleife (wie Hermes' delegate_task). */
function subagentRounds(saver: boolean): number { return Math.max(toolRoundLimit(saver), saver ? 6 : 20) }

/**
 * Unteragenten — Teilaufgaben mit eigenem Kontext, parallel im Hintergrund.
 *
 * Nach dem Vorbild von Hermes' `delegate_task`: Eine große Aufgabe („vergleiche
 * drei Laptops und such mir für jeden den besten Preis") zerfällt in Stücke,
 * die nichts voneinander wissen müssen. Jedes Stück läuft als eigene
 * Textschleife mit Werkzeugen, und zurück kommt nur die Zusammenfassung — die
 * Sprachschleife bleibt frei und ihr Kontext klein.
 *
 * Was ein Unteragent darf, ist enger als bei James selbst:
 *
 * - Nur Werkzeuge, die ohne Rückfrage laufen. Nachfragen kann ein Unteragent
 *   niemanden — er spricht nicht, und eine Zusage, die keiner gegeben hat,
 *   gibt es nicht.
 * - Keine Bildschirm-, Fenster- und Browsersteuerung. Drei Agenten, die
 *   gleichzeitig die Maus bewegen, heben sich gegenseitig auf.
 * - Keine weiteren Unteragenten und keine Fertigkeiten schreiben — das bleibt
 *   bei James, der den Überblick hat.
 */

const TIMEOUT_MS = 4 * 60 * 1000
export const MAX_PARALLEL = 3

/** Werkzeuge, die ein Unteragent nie bekommt, egal was unter „Rechte" steht. */
const EXCLUDED_NAME = /^(computer_|desktop_|window_|screen|mouse|keyboard|camera_|website_login|delegate_|skill_|plan_|context_|memory_tidy|claude_design|self_repair|settings_|tool_)/
const EXCLUDED_GROUPS = new Set(['chrome', 'agent'])

function subagentTools(): { names: Set<string>; declarations: unknown[] } {
  const usable = allTools().filter(
    (t) =>
      !t.alwaysAsk &&
      !EXCLUDED_GROUPS.has(t.group) &&
      !EXCLUDED_NAME.test(t.name) &&
      permissionFor(t.name) === 'allow'
  )
  const declarations = usable.map((t) => {
    const schema = toJsonSchema(t.schema)
    return {
      name: t.name,
      description: slimDescription(t.description),
      ...(schema.properties && Object.keys(schema.properties).length > 0 ? { parameters: schema } : {})
    }
  })
  return {
    names: new Set(usable.map((t) => t.name)),
    declarations: declarations.length > 0 ? [{ functionDeclarations: declarations }] : []
  }
}

const SYSTEM = [
  'Du bist ein Unteragent von James, einem Desktop-Assistenten. Du bekommst genau eine',
  'Teilaufgabe und erledigst sie selbstständig mit den Werkzeugen, die dir zur Verfügung stehen.',
  '',
  '- Du sprichst mit niemandem. Frag nicht nach, sondern entscheide sinnvoll und nenne Annahmen.',
  '- Was du nicht erledigen kannst, weil ein Werkzeug fehlt, sagst du am Ende klar.',
  '- Deine letzte Antwort ist eine knappe Zusammenfassung auf Deutsch: Ergebnis zuerst, dann die',
  '  wichtigsten Fakten mit Quelle. Höchstens zehn Sätze. James liest sie vor oder fasst sie zusammen.',
  '- Erfinde nichts. Wenn ein Werkzeug nichts liefert, steht das in der Zusammenfassung.'
].join('\n')

interface Part {
  text?: string
  functionCall?: { name?: string; args?: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
}

export interface SubagentResult {
  goal: string
  ok: boolean
  summary: string
  steps: number
}

export async function runSubagent(goal: string, context: string | undefined, parentSignal?: AbortSignal): Promise<SubagentResult> {
  const id = randomUUID()
  activityStart({ id, label: `Unteragent — ${goal}`, source: 'agent', tool: 'delegate_tasks' })
  const settings = getSettings()
  const provider = ['chatgpt', 'ollama'].includes(settings.speech.thinkProvider)
    ? settings.speech.thinkProvider : settings.brainProvider
  const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS)
  // Unteragenten laufen über den gewählten Denkmotor; der externe Hermes-Agent ist entfernt.
  if (provider === 'chatgpt' || provider === 'ollama') {
    return runTextSubagent(id, goal, context, provider, settings, signal)
  }

  if (!geminiAvailable()) {
    activityEnd(id, false, 'Kein Gemini-Zugang.')
    return { goal, ok: false, summary: 'Kein Gemini-Zugang hinterlegt.', steps: 0 }
  }

  const { names, declarations } = subagentTools()
  const contents: { role: 'user' | 'model'; parts: Part[] }[] = [
    { role: 'user', parts: [{ text: context ? `${goal}\n\nKontext von James:\n${context}` : goal } ] }
  ]
  const deadline = Date.now() + TIMEOUT_MS
  const guard = new ToolLoopGuard()
  let steps = 0

  try {
    for (let round = 0; round < subagentRounds(settings.tokenSaver.enabled); round++) {
      if (signal?.aborted) throw new Error('Vom Nutzer abgebrochen.')
      if (Date.now() > deadline) throw new Error('Zeitlimit von vier Minuten erreicht.')

      const response = await generateWithFallback({
        model: getSettings().brainModel,
        contents: contents as never,
        config: {
          systemInstruction: SYSTEM,
          abortSignal: signal,
          ...(settings.tokenSaver.enabled ? { maxOutputTokens: 700 } : {}),
          ...(declarations.length > 0 && !guard.halted && round < subagentRounds(settings.tokenSaver.enabled) - 1 ? { tools: declarations as never } : {})
        }
      })

      const calls = response.functionCalls ?? []
      if (calls.length === 0) {
        const summary = response.text?.trim() || 'Ohne Ergebnis beendet.'
        activityEnd(id, true, summary)
        return { goal, ok: true, summary, steps }
      }

      contents.push(
        modelTurn(
          response,
          calls.map((call) => ({ functionCall: { name: call.name, args: call.args as Record<string, unknown> } }))
        )
      )

      const results: Part[] = []
      for (const call of calls) {
          signal.throwIfAborted()
          const name = call.name ?? ''
          steps++
          // Das Modell könnte ein Werkzeug nennen, das es nicht bekommen hat.
          if (!names.has(name)) {
            results.push({ functionResponse: { name, response: { fehler: `${name} steht dir nicht zur Verfügung.` } } })
            continue
          }
          const args = (call.args ?? {}) as Record<string, unknown>
          const result = await guardedCall(guard, name, args,
            () => runTool({ id: randomUUID(), name, args, parentId: id }, signal),
            { round, limit: subagentRounds(settings.tokenSaver.enabled) })
          results.push({
            functionResponse: {
              name,
              response: result.ok ? { result: result.result ?? 'Erledigt.' } : { fehler: result.error }
            }
          })
      }
      contents.push({ role: 'user', parts: results as Part[] })
    }
    throw new Error(`Nach ${subagentRounds(settings.tokenSaver.enabled)} Runden nicht fertig geworden.`)
  } catch (err) {
    const message = err instanceof Error ? friendlyGeminiError(err) : String(err)
    activityEnd(id, false, message)
    return { goal, ok: false, summary: message, steps }
  }
}

/** Selected account/local model, rather than requiring Gemini for every delegated task. */
async function runTextSubagent(id: string, goal: string, context: string | undefined,
  provider: 'chatgpt' | 'ollama', settings: Settings, signal: AbortSignal): Promise<SubagentResult> {
  const { names } = subagentTools()
  const schemas = allTools().filter(t => names.has(t.name)).map(t => ({ type: 'function', function: {
    name: t.name, description: slimDescription(t.description), parameters: toJsonSchema(t.schema)
  } }))
  const initial = context ? `${goal}\n\nKontext von James:\n${context}` : goal
  const items: ChatGptItem[] = [{ role: 'user', content: initial }]
  const messages: any[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: initial }]
  const guard = new ToolLoopGuard()
  let steps = 0
  try {
    for (let round = 0; round < subagentRounds(settings.tokenSaver.enabled); round++) {
      signal.throwIfAborted()
      let calls: { name: string; arguments: unknown; call_id?: string }[] = []
      let answer = ''
      if (provider === 'chatgpt') {
        const response = await chatGptResponse(settings.chatGptModel, SYSTEM, items,
          { tools: !guard.halted && round < subagentRounds(settings.tokenSaver.enabled) - 1 ? chatGptTools(schemas) : undefined, signal, purpose: 'deep' })
        answer = response.text.trim()
        items.push(...response.output.filter(item => item.type !== 'reasoning').map(({ id: _id, ...item }) => item))
        calls = response.output.filter(item => item.type === 'function_call').map(item => ({
          name: String(item.name ?? '').replace(/^jarvis\./, ''), arguments: item.arguments, call_id: String(item.call_id ?? '')
        }))
      } else {
        if (!settings.ollama.model) throw new Error('Für Unteragenten ist kein Ollama-Modell ausgewählt.')
        const response = await fetch(`${settings.ollama.baseUrl.replace(/\/+$/, '')}/api/chat`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
          body: JSON.stringify({ model: settings.ollama.model, stream: false, messages,
            ...(!guard.halted && round < subagentRounds(settings.tokenSaver.enabled) - 1 ? { tools: schemas } : {}),
            ...(settings.tokenSaver.enabled ? { options: { num_predict: 700 } } : {}) })
        })
        if (!response.ok) throw new Error(`Ollama-Anfrage abgelehnt (${response.status}).`)
        const data = await response.json() as { message?: { content?: string; tool_calls?: { function: { name: string; arguments: unknown } }[] }; error?: string }
        if (data.error || !data.message) throw new Error(data.error ?? 'Ollama hat keine Antwort geliefert.')
        messages.push({ ...data.message, role: 'assistant' })
        answer = (data.message.content ?? '').trim()
        calls = (data.message.tool_calls ?? []).map(call => ({ name: call.function.name, arguments: call.function.arguments }))
      }
      signal.throwIfAborted()
      if (!calls.length) {
        if (!answer) throw new Error('Der Unteragent hat keinen Ergebnistext geliefert.')
        activityEnd(id, true, answer)
        return { goal, ok: true, summary: answer, steps }
      }
      // Keep each worker's writes in model order; independent workers still run in parallel.
      for (const call of calls) {
        signal.throwIfAborted()
        let args: Record<string, unknown>
        try { args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : (call.arguments ?? {}) as Record<string, unknown> }
        catch { args = {} }
        const result = names.has(call.name)
          ? await guardedCall(guard, call.name, args,
            () => runTool({ id: randomUUID(), name: call.name, args, parentId: id }, signal),
            { round, limit: subagentRounds(settings.tokenSaver.enabled) })
          : { ok: false, error: `${call.name} steht dir nicht zur Verfügung.` }
        steps++
        const output = JSON.stringify(result)
        if (provider === 'chatgpt') items.push({ type: 'function_call_output', call_id: call.call_id, output })
        else messages.push({ role: 'tool', tool_name: call.name, content: output })
      }
    }
    throw new Error(`Nach ${subagentRounds(settings.tokenSaver.enabled)} Runden nicht fertig geworden.`)
  } catch (error) {
    const message = signal.aborted ? 'Unteragent abgebrochen oder Zeitlimit erreicht.' : error instanceof Error ? error.message : String(error)
    activityEnd(id, false, message)
    return { goal, ok: false, summary: message, steps }
  }
}

/** Mehrere Teilaufgaben gleichzeitig, höchstens drei. */
export async function runSubagents(
  tasks: { goal: string; context?: string }[],
  signal?: AbortSignal
): Promise<SubagentResult[]> {
  return Promise.all(tasks.slice(0, MAX_PARALLEL).map((t) => runSubagent(t.goal, t.context, signal)))
}
