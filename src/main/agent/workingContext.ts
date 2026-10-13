import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ActivityPlan } from '@shared/types'
import { emptyWorkingContext, normalizeWorkingContext, restoreWorkingContext, type WorkingContext } from '@shared/workingContext'
import { broadcast } from '../ipc/emit'

let state: WorkingContext | null = null
function file(): string { return join(app.getPath('userData'), 'working-context.json') }
export function workingContext(): WorkingContext {
  if (!state) {
    try { state = restoreWorkingContext(JSON.parse(readFileSync(file(), 'utf8'))) }
    catch { state = emptyWorkingContext() }
  }
  return structuredClone(state)
}
export function saveWorkingContext(input: WorkingContext): WorkingContext {
  const next = normalizeWorkingContext({ ...input, updatedAt: Date.now() })
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(`${file()}.tmp`, JSON.stringify(next), 'utf8')
  renameSync(`${file()}.tmp`, file())
  state = next
  broadcast('context:changed', workingContext())
  return workingContext()
}
export function checkpoint(input: Omit<WorkingContext, 'updatedAt' | 'plan'>): WorkingContext {
  const previous = workingContext()
  return saveWorkingContext({ ...input, updatedAt: Date.now(), plan: input.goal === previous.goal ? previous.plan : null })
}
export function saveContextPlan(plan: ActivityPlan | null): void {
  const previous = workingContext()
  if (!plan) { saveWorkingContext({ ...previous, plan: null }); return }
  const base = previous.goal === plan.title ? previous : emptyWorkingContext()
  saveWorkingContext({ ...base, goal: plan.title, plan, status: plan.steps.every(s => s.status === 'erledigt') ? 'done' : 'active',
    completed: plan.steps.filter(s => s.status === 'erledigt').map(s => s.text),
    next: plan.steps.filter(s => s.status === 'offen' || s.status === 'läuft').map(s => s.text),
    blockers: plan.steps.filter(s => s.status === 'fehlgeschlagen').map(s => s.text) })
}
export function clearWorkingContext(): void { saveWorkingContext(emptyWorkingContext()) }
