import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ActivityPlan } from '@shared/types'
import { emptyWorkingContext, normalizeWorkingContext, restoreWorkingContext, type WorkingContext } from '@shared/workingContext'
import { broadcast } from '../ipc/emit'

let state: WorkingContext | null = null
const listeners = new Set<() => void>()
function file(): string { return join(app.getPath('userData'), 'working-context.json') }
function readContext(path: string): WorkingContext {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof (raw as Record<string, unknown>).goal !== 'string') {
    throw new Error('Ungültiger gespeicherter Arbeitsstand.')
  }
  return restoreWorkingContext(raw)
}
export function workingContext(): WorkingContext {
  if (!state) {
    try { state = readContext(file()) }
    catch {
      // A crash between writing and renaming leaves a complete checkpoint here.
      // Prefer the committed file whenever it can be read; recovery never runs tools.
      try { state = readContext(`${file()}.tmp`) }
      catch { state = emptyWorkingContext() }
    }
  }
  return structuredClone(state)
}

export function onWorkingContextChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function saveWorkingContext(input: WorkingContext): WorkingContext {
  const next = normalizeWorkingContext({ ...input, updatedAt: Date.now() })
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(`${file()}.tmp`, JSON.stringify(next), 'utf8')
  renameSync(`${file()}.tmp`, file())
  state = next
  broadcast('context:changed', workingContext())
  for (const listener of listeners) listener()
  return workingContext()
}
export function checkpoint(input: Omit<WorkingContext, 'updatedAt' | 'plan'>): WorkingContext {
  const previous = workingContext()
  const next = normalizeWorkingContext(input)
  return saveWorkingContext({ ...next, plan: next.goal === previous.goal ? previous.plan : null })
}
export function saveContextPlan(plan: ActivityPlan | null): ActivityPlan | null {
  const previous = workingContext()
  if (!plan) return saveWorkingContext({ ...previous, plan: null }).plan
  const clean = normalizeWorkingContext({ goal: plan.title, plan }).plan
  if (!clean) throw new Error('Ein Plan braucht einen Titel und mindestens einen gültigen Schritt.')
  const base = previous.goal === clean.title ? previous : emptyWorkingContext()
  return saveWorkingContext({ ...base, goal: clean.title, plan: clean, status: clean.steps.every(s => s.status === 'erledigt') ? 'done' : 'active',
    completed: clean.steps.filter(s => s.status === 'erledigt').map(s => s.text),
    next: clean.steps.filter(s => s.status === 'offen' || s.status === 'läuft').map(s => s.text),
    blockers: clean.steps.filter(s => s.status === 'fehlgeschlagen').map(s => s.text) }).plan
}
export function clearWorkingContext(): void { saveWorkingContext(emptyWorkingContext()) }
