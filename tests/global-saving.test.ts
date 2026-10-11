import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { resolve, join } from 'node:path'
import { budgetCompletedHistory } from '@shared/conversationBudget'
import { readResponseStream } from '@main/providers/chatgptResponses'
import { app } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { getSettings, setSettings } from '@main/store/settings'
import { closeDb } from '@main/db'
import { defineTool, register, unregisterBuiltins, openAiToolSchemas } from '@main/tools/registry'
import { noteFinishedStep } from '@main/agent/learning'
import { z } from 'zod'

it('kürzt ChatGPT-Werkzeug- und Parametertexte und startet kein bezahltes Hintergrundlernen', t => {
  const root = mkdtempSync(join(tmpdir(), 'james-global-saving-'))
  t.mock.method(app, 'getPath', () => root)
  t.after(() => { unregisterBuiltins(); closeDb(); assert.ok(root.startsWith(join(tmpdir(), 'james-global-saving-'))); rmSync(root, { recursive: true, force: true }) })
  const description = 'Langer Werkzeugtext '.repeat(100)
  register(defineTool({ name: 'calculate', group: 'system', description,
    schema: z.object({ expression: z.string().describe(description) }), execute: async () => 'ok' }))
  setSettings({ tokenSaver: { ...getSettings().tokenSaver, enabled: false } })
  const full = openAiToolSchemas() as any[]
  setSettings({ learnSkills: true, tokenSaver: { ...getSettings().tokenSaver, enabled: true, slimDeclarations: true } })
  const small = openAiToolSchemas() as any[]
  assert.ok(JSON.stringify(small).length < JSON.stringify(full).length / 3)
  assert.ok(small[0].function.description.length <= 160)
  assert.ok(small[0].function.parameters.properties.expression.description.length <= 160)
  assert.deepEqual(small[0].function.parameters.required, ['expression'])
  t.mock.method(globalThis, 'setTimeout', () => { throw new Error('Verstecktes Hintergrundlernen gestartet') })
  for (let i = 0; i < 4; i++) noteFinishedStep({ source: 'jarvis', status: 'ok', tool: 'web_search', label: 'Recherche' } as any)
})

it('behält Werkzeugpaare zusammen und lädt alte Audiobeiträge nicht erneut hoch', () => {
  const messages = [
    { role: 'user', content: 'alte Frage' },
    { role: 'assistant', content: 'x'.repeat(10000), tool_calls: [{ function: { name: 'test' } }] },
    { role: 'tool', content: 'altes Ergebnis' },
    { role: 'user', content: 'neue Frage' },
    { role: 'assistant', content: 'neue Antwort' }
  ]
  assert.deepEqual(budgetCompletedHistory(messages, true), messages.slice(-2))
  assert.deepEqual(budgetCompletedHistory(messages, false), messages)
  assert.deepEqual(budgetCompletedHistory([
    { role: 'user', parts: [{ inlineData: { data: 'x'.repeat(10000) } }] },
    { role: 'model', parts: [{ text: 'Antwort' }] }
  ], true), [])
})

it('liest tatsächliche Eingabe-, Ausgabe-, Cache- und Denk-Token aus dem Antwortstrom', async () => {
  const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120,
    input_tokens_details: { cached_tokens: 80 }, output_tokens_details: { reasoning_tokens: 10 } }
  const response = new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { usage, output: [] } })}\n\n`)
  assert.deepEqual((await readResponseStream(response.body!)).usage, usage)
})

it('eine normale Frage braucht nur eine Anfrage; Werkzeugschleifen enden im Sparmodus nach vier', async () => {
  const bundle = await build({ entryPoints: [resolve('src/renderer/live/brain.ts')], bundle: true,
    write: false, format: 'cjs', platform: 'node', packages: 'external', logLevel: 'silent',
    alias: { '@shared': resolve('src/shared') } })
  const module = { exports: {} as any }
  const requests: any[] = []
  let endlessTools = false
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports,
    require: createRequire(join(process.cwd(), 'package.json')), AbortSignal, AbortController, setInterval, clearInterval,
    crypto: { randomUUID: () => String(requests.length) }, console,
    window: { jarvis: { on: () => () => {}, invoke: async (channel: string, args: any) => {
      if (channel === 'agent:systemPrompt') return 'System'
      if (channel === 'chatgpt:respond') {
        requests.push(args)
        return { ok: true, response: { text: endlessTools && args.tools ? '' : 'Hallo zurück', output: endlessTools && args.tools
          ? [{ type: 'function_call', name: 'jarvis.test', arguments: '{}', call_id: String(requests.length) }]
          : [] } }
      }
      throw new Error(`Unerwarteter Zusatzaufruf: ${channel}`)
    } } } })
  const brain = new module.exports.ChatGptBrain({ tokenSaver: { enabled: true }, speech: { provider: 'gemini' }, chatGptModel: 'selected' })
  let toolCalls = 0
  const texts: string[] = []
  const hooks = { onText(text: string) { texts.push(text) }, cancelled: () => false, transcript: async () => '', callTool: async () => { toolCalls++; return { ok: true, result: 'ok' } } }
  await brain.run({ text: 'Hallo' }, hooks)
  assert.equal(requests.length, 1)
  assert.deepEqual(texts, ['Hallo zurück'])
  requests.length = 0
  endlessTools = true
  await brain.run({ text: 'Führe Auftrag aus' }, hooks)
  assert.equal(requests.length, 4)
  assert.equal(toolCalls, 3)
  assert.equal(requests[3].tools, false)
  assert.equal(requests[3].input.at(-1).type, 'function_call_output')
})
