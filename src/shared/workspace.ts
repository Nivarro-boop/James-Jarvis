export const WORKSPACE_WIDGET_IDS = ['today', 'calendar', 'tasks', 'next-steps', 'feature-packs'] as const
export type WorkspaceWidgetId = (typeof WORKSPACE_WIDGET_IDS)[number]

export interface WorkspaceTask {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  doneAt: number | null
}

export interface WorkspaceLayout {
  order: WorkspaceWidgetId[]
  hidden: WorkspaceWidgetId[]
  revision: number
}

export interface WorkspaceSnapshot {
  tasks: WorkspaceTask[]
  layout: WorkspaceLayout
  calendarEnabled: boolean
  nextSteps: string[]
  workingGoal: string
}

export interface WorkspaceCalendarEvent {
  id: string
  title: string
  start: number
  end?: number
  allDay: boolean
  calendar?: string
  location?: string
  source: 'google' | 'ical'
}

export type WorkspaceCalendarSourceState = 'not-configured' | 'idle' | 'ready' | 'error'
export interface WorkspaceCalendarSource {
  state: WorkspaceCalendarSourceState
  error?: string
  fetchedAt?: number
  events: WorkspaceCalendarEvent[]
}
export interface WorkspaceCalendarRead {
  enabled: boolean
  from: number
  to: number
  timezone: string
  sources: { google: WorkspaceCalendarSource; ical: WorkspaceCalendarSource }
}

/** Add these channels to IpcInvokeMap in src/shared/ipc.ts during central integration. */
export interface WorkspaceIpcMap {
  'workspace:get': { req: Record<string, never>; res: WorkspaceSnapshot }
  'workspace:task-create': { req: { title: string }; res: WorkspaceSnapshot }
  'workspace:task-set-done': { req: { id: string; done: boolean }; res: WorkspaceSnapshot }
  'workspace:task-delete': { req: { id: string }; res: WorkspaceSnapshot }
  'workspace:layout-set': { req: { order: WorkspaceWidgetId[]; hidden: WorkspaceWidgetId[]; revision: number }; res: WorkspaceLayout }
  'workspace:calendar-enabled': { req: { enabled: boolean }; res: WorkspaceSnapshot }
  'workspace:calendar-read': { req: Record<string, never>; res: WorkspaceCalendarRead }
}
