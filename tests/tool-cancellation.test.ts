import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as scheduleTimeout, clearTimeout as cancelTimeout } from 'node:timers'
import { app } from 'electron'
import { z } from 'zod'
import type { ToolContext } from '@main/tools/registry'

for (const stop of ['individual', 'all'] as const) it(`${stop} Stop releases a non-cooperative tool and suppresses its late output and result`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'james-tool-cancellation-'))
  t.mock.method(app, 'getPath', () => root)
  let runner: any
  t.after(() => {
    runner?.closeDb()
    assert.ok(root.startsWith(join(tmpdir(), 'james-tool-cancellation-')))
    rmSync(root, { recursive: true, force: true })
  })
  const sent: unknown[] = []
  const bundled = await build({
    stdin: {
      contents: [
        "export { runCancellableTool, cancelToolCall, abortAllTools, hasRunningTools } from './tools/runner'",
        "export { register } from './tools/registry'",
        "export { activitySnapshot } from './agent/activity'",
        "export { closeDb, listActions } from './db'"
      ].join('\n'),
      resolveDir: resolve('src/main'), loader: 'ts'
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
    alias: { '@shared': resolve('src/shared'), '@main': resolve('src/main') },
    plugins: [{ name: 'capture-ui', setup(b) {
      b.onResolve({ filter: /(^|\/)ipc\/emit$|^\.\/emit$/ }, () => ({ path: 'emit', namespace: 'fixture' }))
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export const sendToCrystal = (channel, value) => { sent.push([channel, value]); return true }
        export const sendToSettings = () => true
        export const broadcast = sendToCrystal
        export const speak = text => sendToCrystal('speak:request', text)
        export const crystalVisible = () => true
      ` }))
    } }]
  })
  const module = { exports: {} as any }
  runInNewContext(bundled.outputFiles[0].text, {
    module, exports: module.exports, require, console, process, Buffer, sent, structuredClone,
    AbortSignal, AbortController, setTimeout, clearTimeout, setInterval, clearInterval
  })
  runner = module.exports

  let complete!: (value: string) => void
  let context!: ToolContext
  let calls = 0
  runner.register({ name: 'test_noncooperative_tool', group: 'web', description: 'Test', schema: z.object({}),
    execute(_args: unknown, ctx: ToolContext) {
      if (++calls > 1) return Promise.resolve('fresh result')
      context = ctx
      return new Promise<string>((resolve, reject) => { complete = stop === 'all' ? reject : resolve })
    }
  })
  const request = { id: 'cancellable-id', name: 'test_noncooperative_tool', args: {} }
  const pending = runner.runCancellableTool(request)
  assert.equal(runner.hasRunningTools(), true)
  if (stop === 'all') runner.abortAllTools()
  else runner.cancelToolCall(request.id)
  let deadline: ReturnType<typeof scheduleTimeout> | undefined
  try {
    const cancelled = await Promise.race([pending, new Promise<undefined>(resolve => { deadline = scheduleTimeout(() => resolve(undefined), 200) })])
    assert.ok(cancelled, 'Stop must return even when the underlying operation ignores cancellation')
    assert.equal(cancelled.ok, false)
    assert.match(cancelled.error, /abgebrochen/)
    assert.equal(runner.hasRunningTools(), false)
    sent.length = 0
    const thought = runner.activitySnapshot().items.find((item: { id: string }) => item.id === request.id).thought
    context.say('stale speech')
    context.setState('research')
    context.annotate({ thought: 'stale activity' })
    assert.equal(runner.activitySnapshot().items.find((item: { id: string }) => item.id === request.id).thought, thought)
    assert.equal(context.show({ id: 'stale-card', kind: 'sources', query: 'stale', sources: [] }), false)
    assert.equal(await context.confirm('stale question', {}), false)
    assert.equal(sent.length, 0)

    const fresh = await runner.runCancellableTool(request)
    assert.equal(fresh.ok, true)
    assert.equal(fresh.result, 'fresh result')
  } finally {
    cancelTimeout(deadline)
    complete('late result')
    await pending
  }
  for (let n = 0; n < 10; n++) await Promise.resolve()
  const actions = runner.listActions().filter((action: { tool: string }) => action.tool === request.name)
  assert.equal(actions.length, 2)
  assert.equal(actions.filter((action: { ok: boolean }) => action.ok).length, 1)
  assert.equal(runner.hasRunningTools(), false)
})
