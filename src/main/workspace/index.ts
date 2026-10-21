import type { WorkspaceIpcMap, WorkspaceSnapshot } from '@shared/workspace'
import { workingContext } from '../agent/workingContext'
import { invalidateWorkspaceCalendarReads, readConfiguredWorkspaceCalendar } from './calendar'
import { getWorkspaceStore } from './store'

type WorkspaceHandlers = { [C in keyof WorkspaceIpcMap]: (payload: WorkspaceIpcMap[C]['req']) => WorkspaceIpcMap[C]['res'] | Promise<WorkspaceIpcMap[C]['res']> }

function snapshot(): WorkspaceSnapshot {
  const store = getWorkspaceStore().get()
  const context = workingContext()
  return {
    tasks: store.tasks,
    layout: store.layout,
    calendarEnabled: store.calendarEnabled,
    nextSteps: Array.isArray(context.next) ? context.next.filter((step): step is string => typeof step === 'string' && step.trim().length > 0).slice(0, 30) : [],
    workingGoal: typeof context.goal === 'string' ? context.goal.slice(0, 240) : ''
  }
}
function payloadRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Workspace-Anfrage ist ungültig.')
  return value as Record<string, unknown>
}

/** Register via the central IPC `handle` wrapper so its trusted-frame checks remain in force. */
export function registerWorkspaceHandlers(register: <C extends keyof WorkspaceIpcMap>(channel: C, handler: (payload: WorkspaceIpcMap[C]['req']) => WorkspaceIpcMap[C]['res'] | Promise<WorkspaceIpcMap[C]['res']>) => void): void {
  const handlers: WorkspaceHandlers = {
    'workspace:get': () => snapshot(),
    'workspace:task-create': (payload) => {
      const request = payloadRecord(payload)
      getWorkspaceStore().createTask(request.title)
      return snapshot()
    },
    'workspace:task-set-done': (payload) => {
      const request = payloadRecord(payload)
      getWorkspaceStore().setTaskDone(request.id, request.done)
      return snapshot()
    },
    'workspace:task-delete': (payload) => {
      const request = payloadRecord(payload)
      getWorkspaceStore().deleteTask(request.id)
      return snapshot()
    },
    'workspace:layout-set': (payload) => {
      const request = payloadRecord(payload)
      return getWorkspaceStore().setLayout(request)
    },
    'workspace:calendar-enabled': (payload) => {
      const request = payloadRecord(payload)
      if (request.enabled === false) invalidateWorkspaceCalendarReads()
      getWorkspaceStore().setCalendarEnabled(request.enabled)
      return snapshot()
    },
    'workspace:calendar-read': async () => {
      const state = getWorkspaceStore().get()
      return readConfiguredWorkspaceCalendar(state.calendarEnabled)
    }
  }
  for (const channel of Object.keys(handlers) as (keyof WorkspaceIpcMap)[]) {
    register(channel, handlers[channel] as (payload: WorkspaceIpcMap[typeof channel]['req']) => WorkspaceIpcMap[typeof channel]['res'] | Promise<WorkspaceIpcMap[typeof channel]['res']>)
  }
}

export { getWorkspaceStore, createWorkspaceStore, validateWorkspaceLayout, validateTask, DEFAULT_WORKSPACE_LAYOUT } from './store'
export { readWorkspaceCalendar, readConfiguredWorkspaceCalendar, localTodayBounds } from './calendar'
