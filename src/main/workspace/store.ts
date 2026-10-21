import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, posix, resolve } from 'node:path'
import { WORKSPACE_WIDGET_IDS, type WorkspaceLayout, type WorkspaceTask, type WorkspaceWidgetId } from '@shared/workspace'

export interface WorkspacePersistedState {
  version: 1
  tasks: WorkspaceTask[]
  layout: WorkspaceLayout
  calendarEnabled: boolean
}

export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayout = {
  order: ['today', 'calendar', 'tasks', 'next-steps'],
  hidden: ['feature-packs'],
  revision: 0
}
const MAX_TASKS = 500
const MAX_TITLE = 160
const allowedWidgets = new Set<string>(WORKSPACE_WIDGET_IDS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
export function validateTask(value: unknown): WorkspaceTask {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^[\w-]{1,80}$/.test(value.id) ||
      typeof value.title !== 'string' || !value.title.trim() || value.title.length > MAX_TITLE ||
      !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt) ||
      !(value.doneAt === null || Number.isFinite(value.doneAt))) {
    throw new Error('Die gespeicherte Aufgabe ist ungültig.')
  }
  return { id: value.id, title: value.title.trim(), createdAt: Number(value.createdAt), updatedAt: Number(value.updatedAt), doneAt: value.doneAt === null ? null : Number(value.doneAt) }
}
export function validateWorkspaceLayout(value: unknown, revisionOverride?: number): WorkspaceLayout {
  if (!isRecord(value) || !Array.isArray(value.order) || !Array.isArray(value.hidden)) throw new Error('Die Widget-Anordnung ist ungültig.')
  const order = value.order
  const hidden = value.hidden
  if (order.length + hidden.length !== WORKSPACE_WIDGET_IDS.length ||
      !order.every((id) => typeof id === 'string' && allowedWidgets.has(id)) ||
      !hidden.every((id) => typeof id === 'string' && allowedWidgets.has(id)) ||
      new Set([...order, ...hidden]).size !== WORKSPACE_WIDGET_IDS.length) {
    throw new Error('Jedes Widget muss genau einmal sichtbar oder ausgeblendet sein.')
  }
  const revision = revisionOverride ?? value.revision
  if (!Number.isSafeInteger(revision) || Number(revision) < 0) throw new Error('Die Anordnungsrevision ist ungültig.')
  return { order: order as WorkspaceWidgetId[], hidden: hidden as WorkspaceWidgetId[], revision: Number(revision) }
}
interface BoardState { version: 1; layout: WorkspaceLayout; calendarEnabled: boolean }
interface TasksState { version: 1; tasks: WorkspaceTask[] }
function emptyBoard(): BoardState { return { version: 1, layout: structuredClone(DEFAULT_WORKSPACE_LAYOUT), calendarEnabled: false } }
function emptyTasks(): TasksState { return { version: 1, tasks: [] } }
function validateBoard(value: unknown): BoardState {
  if (!isRecord(value) || value.version !== 1 || typeof value.calendarEnabled !== 'boolean') throw new Error('Workspace-Board-Datei hat ein ungültiges Format.')
  return { version: 1, layout: validateWorkspaceLayout(value.layout), calendarEnabled: value.calendarEnabled }
}
function validateTasks(value: unknown): TasksState {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.tasks) || value.tasks.length > MAX_TASKS) throw new Error('Workspace-Aufgabendatei hat ein ungültiges Format.')
  const tasks = value.tasks.map(validateTask)
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) throw new Error('Workspace-Datei enthält doppelte Aufgaben-IDs.')
  return { version: 1, tasks }
}

/** Normalize only Apple's verified system aliases; never resolve arbitrary workspace roots. */
export function normalizeDarwinSystemAliasPath(
  file: string,
  platform: NodeJS.Platform = process.platform,
  canonicalize: (path: string) => string = realpathSync
): string {
  if (platform !== 'darwin') return resolve(file)
  // Darwin paths remain POSIX even when this pure helper is exercised by Windows CI.
  const absolute = posix.resolve(file)
  for (const [alias, expectedTarget] of [['/var', '/private/var'], ['/tmp', '/private/tmp']] as const) {
    if (absolute !== alias && !absolute.startsWith(`${alias}/`)) continue
    let actualTarget: string
    try { actualTarget = posix.resolve(canonicalize(alias)) }
    catch { throw new Error(`Workspace-Systempfadalias kann nicht sicher aufgelöst werden: ${alias}`) }
    if (actualTarget !== expectedTarget) throw new Error(`Workspace-Systempfadalias zeigt nicht auf das erwartete Ziel: ${alias}`)
    return posix.join(expectedTarget, absolute.slice(alias.length).replace(/^\/+/, ''))
  }
  return absolute
}

/** Reject links at every physical component so a workspace file cannot escape its selected profile. */
function assertNoSymlinkPath(file: string): void {
  const absolute = normalizeDarwinSystemAliasPath(file)
  const root = parse(absolute).root
  let current = root
  for (const part of absolute.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part)
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Workspace-Pfad darf keine symbolischen Links enthalten: ${current}`)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Workspace-Pfad')) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
function readJson(file: string): unknown {
  assertNoSymlinkPath(file)
  return JSON.parse(readFileSync(file, 'utf8')) as unknown
}
function safeFileExists(file: string): boolean {
  assertNoSymlinkPath(file)
  try { lstatSync(file); return true }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
function atomicJson(file: string, value: unknown): void {
  if (!isAbsolute(file)) throw new Error('Workspace-Pfade müssen absolut sein.')
  mkdirSync(dirname(file), { recursive: true })
  assertNoSymlinkPath(file)
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    // Re-check immediately before replacement: a symlink is never followed or silently replaced.
    assertNoSymlinkPath(file)
    renameSync(temp, file)
  } catch (error) {
    try { unlinkSync(temp) } catch { /* original file remains intact */ }
    throw error
  }
}

/** Synchronous operations serialize each file's read/modify/atomic-replace transaction in Electron's main event loop. */
export function createWorkspaceStore(file: string, taskFile = join(dirname(file), 'workspace-tasks.json')): {
  get(): WorkspacePersistedState
  save(state: WorkspacePersistedState): WorkspacePersistedState
  createTask(title: unknown, now?: number): WorkspacePersistedState
  setTaskDone(id: unknown, done: unknown, now?: number): WorkspacePersistedState
  deleteTask(id: unknown): WorkspacePersistedState
  setLayout(input: unknown): WorkspaceLayout
  setCalendarEnabled(enabled: unknown): WorkspacePersistedState
} {
  if (!isAbsolute(file) || !isAbsolute(taskFile) || resolve(file) === resolve(taskFile)) throw new Error('Workspace-Dateipfade sind ungültig.')
  const getBoard = (): BoardState => safeFileExists(file) ? validateBoard(readJson(file)) : emptyBoard()
  const getTasks = (): TasksState => safeFileExists(taskFile) ? validateTasks(readJson(taskFile)) : emptyTasks()
  const get = (): WorkspacePersistedState => {
    const board = getBoard()
    const tasks = getTasks()
    return { version: 1, tasks: tasks.tasks, layout: board.layout, calendarEnabled: board.calendarEnabled }
  }
  const save = (input: WorkspacePersistedState): WorkspacePersistedState => {
    if (!isRecord(input) || input.version !== 1) throw new Error('Workspace-Datei hat ein ungültiges Format.')
    const board = validateBoard({ version: input.version, layout: input.layout, calendarEnabled: input.calendarEnabled })
    const tasks = validateTasks({ version: input.version, tasks: input.tasks })
    // Validate both existing recovery files before either write, then atomically replace each independently.
    getBoard()
    getTasks()
    atomicJson(taskFile, tasks)
    atomicJson(file, board)
    return { version: 1, tasks: tasks.tasks, layout: board.layout, calendarEnabled: board.calendarEnabled }
  }
  const saveTasks = (tasks: WorkspaceTask[]): WorkspacePersistedState => {
    const next = validateTasks({ version: 1, tasks })
    const board = getBoard()
    atomicJson(taskFile, next)
    return { version: 1, tasks: next.tasks, layout: board.layout, calendarEnabled: board.calendarEnabled }
  }
  const saveBoard = (board: BoardState): WorkspacePersistedState => {
    const next = validateBoard(board)
    const tasks = getTasks()
    atomicJson(file, next)
    return { version: 1, tasks: tasks.tasks, layout: next.layout, calendarEnabled: next.calendarEnabled }
  }
  return {
    get,
    save,
    createTask(title, now = Date.now()) {
      if (typeof title !== 'string' || !title.trim() || title.trim().length > MAX_TITLE) throw new Error(`Eine Aufgabe braucht 1–${MAX_TITLE} Zeichen.`)
      if (!Number.isFinite(now)) throw new Error('Aufgabenzeitpunkt ist ungültig.')
      const state = get()
      if (state.tasks.length >= MAX_TASKS) throw new Error(`Höchstens ${MAX_TASKS} Aufgaben können gespeichert werden.`)
      const task: WorkspaceTask = { id: randomUUID(), title: title.trim(), createdAt: now, updatedAt: now, doneAt: null }
      return saveTasks([...state.tasks, task])
    },
    setTaskDone(id, done, now = Date.now()) {
      if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id) || typeof done !== 'boolean' || !Number.isFinite(now)) throw new Error('Aufgabenstatus ist ungültig.')
      const state = get()
      const existing = state.tasks.find((task) => task.id === id)
      if (!existing) throw new Error('Diese Aufgabe gibt es nicht mehr. Bitte aktualisieren.')
      return saveTasks(state.tasks.map((task) => task.id === id ? { ...task, updatedAt: now, doneAt: done ? now : null } : task))
    },
    deleteTask(id) {
      if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id)) throw new Error('Aufgaben-ID ist ungültig.')
      const state = get()
      if (!state.tasks.some((task) => task.id === id)) throw new Error('Diese Aufgabe gibt es nicht mehr. Bitte aktualisieren.')
      return saveTasks(state.tasks.filter((task) => task.id !== id))
    },
    setLayout(input) {
      const current = getBoard()
      if (!isRecord(input) || !Number.isSafeInteger(input.revision) || input.revision !== current.layout.revision) {
        throw new Error('Die Widget-Anordnung wurde inzwischen geändert. Bitte neu laden.')
      }
      const next = validateWorkspaceLayout(input, current.layout.revision + 1)
      const state = saveBoard({ ...current, layout: next })
      return state.layout
    },
    setCalendarEnabled(enabled) {
      if (typeof enabled !== 'boolean') throw new Error('Kalenderfreigabe ist ungültig.')
      return saveBoard({ ...getBoard(), calendarEnabled: enabled })
    }
  }
}

export function getWorkspaceStore(): ReturnType<typeof createWorkspaceStore> {
  return createWorkspaceStore(join(app.getPath('userData'), 'workspace-board.json'), join(app.getPath('userData'), 'workspace-tasks.json'))
}
