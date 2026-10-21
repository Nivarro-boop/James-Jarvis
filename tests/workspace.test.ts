import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createWorkspaceStore, DEFAULT_WORKSPACE_LAYOUT, normalizeDarwinSystemAliasPath, validateTask, validateWorkspaceLayout } from '../src/main/workspace/store'
import { invalidateWorkspaceCalendarReads, localTodayBounds, readWorkspaceCalendar, workspaceCalendarReadIsCurrent } from '../src/main/workspace/calendar'
import { WORKSPACE_WIDGET_IDS, type WorkspaceTask } from '../src/shared/workspace'

const tempDirs: string[] = []
function fixture(): { dir: string; board: string; tasks: string; store: ReturnType<typeof createWorkspaceStore> } {
  const dir = mkdtempSync(join(tmpdir(), 'jj-workspace-test-'))
  tempDirs.push(dir)
  const board = join(dir, 'workspace-board.json')
  const tasks = join(dir, 'workspace-tasks.json')
  return { dir, board, tasks, store: createWorkspaceStore(board, tasks) }
}
function task(id: string, title = id, createdAt = 100): WorkspaceTask {
  return { id, title, createdAt, updatedAt: createdAt, doneAt: null }
}
function iso(value: Date): string { return value.toISOString() }
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Workspace storage and layout validation', () => {
  it('starts with a validated default layout and no tasks without creating files', () => {
    const { store, board, tasks } = fixture()
    assert.deepEqual(store.get(), { version: 1, tasks: [], layout: DEFAULT_WORKSPACE_LAYOUT, calendarEnabled: false })
    assert.equal(existsSync(board), false)
    assert.equal(existsSync(tasks), false)
  })
  it('writes the established recovery filenames and versioned JSON atomically', () => {
    const { store, board, tasks } = fixture()
    store.createTask('Notiz', 123)
    store.setCalendarEnabled(true)
    assert.equal(lstatSync(board).isFile(), true)
    assert.equal(lstatSync(tasks).isFile(), true)
    assert.equal(JSON.parse(readFileSync(board, 'utf8')).version, 1)
    assert.equal(JSON.parse(readFileSync(tasks, 'utf8')).tasks[0].title, 'Notiz')
    assert.deepEqual(store.get().tasks, store.get().tasks)
  })
  it('trims valid task titles and rejects blank, overlong, or non-finite timestamps without writes', () => {
    const { store, tasks } = fixture()
    assert.equal(store.createTask('  sauber  ', 10).tasks[0].title, 'sauber')
    const before = readFileSync(tasks, 'utf8')
    assert.throws(() => store.createTask('  '), /Aufgabe braucht/)
    assert.throws(() => store.createTask('x'.repeat(161)), /Aufgabe braucht/)
    assert.throws(() => store.createTask('bad', Number.NaN), /zeitpunkt/i)
    assert.equal(readFileSync(tasks, 'utf8'), before)
  })
  it('creates, completes, reopens, and deletes only the requested task', () => {
    const { store } = fixture()
    const first = store.createTask('A', 1).tasks[0]
    const second = store.createTask('B', 2).tasks[1]
    let state = store.setTaskDone(first.id, true, 9)
    assert.deepEqual(state.tasks.map((entry) => entry.doneAt), [9, null])
    state = store.setTaskDone(first.id, false, 12)
    assert.deepEqual(state.tasks.map((entry) => entry.doneAt), [null, null])
    assert.equal(state.tasks[0].updatedAt, 12)
    state = store.deleteTask(second.id)
    assert.deepEqual(state.tasks.map((entry) => entry.id), [first.id])
  })
  it('rejects task IDs, done values, and attempts to mutate missing tasks', () => {
    const { store } = fixture()
    assert.throws(() => store.setTaskDone('../x', true), /status/i)
    assert.throws(() => store.setTaskDone('x', 'yes'), /status/i)
    assert.throws(() => store.deleteTask('missing'), /gibt es nicht mehr/)
    assert.throws(() => store.setTaskDone('missing', false), /gibt es nicht mehr/)
  })
  it('enforces the 500-task cap', () => {
    const { store } = fixture()
    const tasks = Array.from({ length: 500 }, (_, index) => task(`task-${index}`))
    store.save({ version: 1, tasks, layout: DEFAULT_WORKSPACE_LAYOUT, calendarEnabled: false })
    assert.throws(() => store.createTask('too many'), /Höchstens 500/)
    assert.equal(store.get().tasks.length, 500)
  })
  it('validates task schemas and duplicate IDs on load', () => {
    assert.throws(() => validateTask({ ...task('bad'), id: '../bad' }), /ungültig/)
    assert.throws(() => validateTask({ ...task('bad'), title: ' ' }), /ungültig/)
    assert.throws(() => validateTask({ ...task('bad'), updatedAt: Infinity }), /ungültig/)
    const { tasks, store } = fixture()
    writeFileSync(tasks, JSON.stringify({ version: 1, tasks: [task('same'), task('same', 'duplicate')] }))
    assert.throws(() => store.get(), /doppelte Aufgaben-IDs/)
  })
  it('requires every known widget exactly once across order and hidden', () => {
    const valid = { order: [...WORKSPACE_WIDGET_IDS], hidden: [], revision: 2 }
    assert.deepEqual(validateWorkspaceLayout(valid).order, WORKSPACE_WIDGET_IDS)
    assert.throws(() => validateWorkspaceLayout({ ...valid, order: ['unknown'], hidden: [] }), /genau einmal/)
    assert.throws(() => validateWorkspaceLayout({ ...valid, order: [...valid.order, valid.order[0]] }), /genau einmal/)
    assert.throws(() => validateWorkspaceLayout({ ...valid, hidden: ['today'] }), /genau einmal/)
    assert.throws(() => validateWorkspaceLayout({ ...valid, order: valid.order.slice(1) }), /genau einmal/)
  })
  it('rejects an invalid revision without changing board state', () => {
    const { store, board } = fixture()
    const saved = store.setLayout({ ...DEFAULT_WORKSPACE_LAYOUT, order: [...DEFAULT_WORKSPACE_LAYOUT.order].reverse() })
    assert.equal(saved.revision, 1)
    const before = readFileSync(board, 'utf8')
    assert.throws(() => store.setLayout({ ...saved, revision: 0 }), /inzwischen geändert/)
    assert.equal(readFileSync(board, 'utf8'), before)
  })
  it('rejects duplicate/unknown widget IDs before writing', () => {
    const { store, board } = fixture()
    assert.throws(() => store.setLayout({ revision: 0, order: ['today', 'calendar', 'tasks', 'tasks'], hidden: ['feature-packs'] }), /genau einmal/)
    assert.throws(() => store.setLayout({ revision: 0, order: ['today', 'calendar', 'tasks', 'other'], hidden: ['feature-packs'] }), /genau einmal/)
    assert.equal(existsSync(board), false)
  })
  it('keeps board and task writes independent across store instances', () => {
    const { board, tasks, store } = fixture()
    const another = createWorkspaceStore(board, tasks)
    store.createTask('unabhängig', 5)
    another.setCalendarEnabled(true)
    store.setLayout({ ...DEFAULT_WORKSPACE_LAYOUT, order: ['calendar', 'today', 'tasks', 'next-steps'] })
    another.createTask('zweite Aufgabe', 6)
    const state = store.get()
    assert.equal(state.tasks.length, 2)
    assert.equal(state.calendarEnabled, true)
    assert.equal(state.layout.revision, 1)
    assert.deepEqual(state.layout.order.slice(0, 2), ['calendar', 'today'])
  })
  it('preserves tasks when changing only board preferences and preserves board when changing tasks', () => {
    const { store } = fixture()
    store.createTask('bleibt', 1)
    store.setCalendarEnabled(true)
    assert.equal(store.get().tasks[0].title, 'bleibt')
    store.setTaskDone(store.get().tasks[0].id, true, 2)
    assert.equal(store.get().calendarEnabled, true)
    assert.equal(store.get().layout.revision, 0)
  })
  it('fails closed on corrupt board JSON without replacing the corrupt file', () => {
    const { store, board, tasks } = fixture()
    writeFileSync(board, '{not-json')
    assert.throws(() => store.get())
    assert.throws(() => store.setCalendarEnabled(true))
    assert.throws(() => store.createTask('must not write'))
    assert.equal(existsSync(tasks), false)
    assert.equal(readFileSync(board, 'utf8'), '{not-json')
  })
  it('fails closed on malformed board state and never falls back to empty state', () => {
    const { store, board } = fixture()
    writeFileSync(board, JSON.stringify({ version: 8, layout: DEFAULT_WORKSPACE_LAYOUT, calendarEnabled: false }))
    const before = readFileSync(board, 'utf8')
    assert.throws(() => store.get(), /ungültiges Format/)
    assert.throws(() => store.setCalendarEnabled(true))
    assert.equal(readFileSync(board, 'utf8'), before)
  })
  it('fails closed on corrupt task JSON without replacing it during a board update', () => {
    const { store, board, tasks } = fixture()
    writeFileSync(tasks, '{broken')
    assert.throws(() => store.get())
    assert.throws(() => store.setLayout({ ...DEFAULT_WORKSPACE_LAYOUT, order: [...DEFAULT_WORKSPACE_LAYOUT.order].reverse() }))
    assert.equal(existsSync(board), false)
    assert.equal(readFileSync(tasks, 'utf8'), '{broken')
  })
  it('rejects symlinked board and task files instead of following them', () => {
    const { dir, board, tasks, store } = fixture()
    const outside = join(dir, 'outside.json')
    writeFileSync(outside, JSON.stringify({ version: 1, layout: DEFAULT_WORKSPACE_LAYOUT, calendarEnabled: false }))
    symlinkSync(outside, board)
    assert.throws(() => store.get(), /symbolischen Links/)
    rmSync(board)
    writeFileSync(board, JSON.stringify({ version: 1, layout: DEFAULT_WORKSPACE_LAYOUT, calendarEnabled: false }))
    symlinkSync(join(dir, 'nonexistent.json'), tasks)
    assert.throws(() => store.get(), /symbolischen Links/)
    assert.equal(readFileSync(outside, 'utf8').includes('calendarEnabled'), true)
  })
  it('rejects symlinked parent directories and non-absolute or aliased file paths', () => {
    const { dir } = fixture()
    const real = join(dir, 'real')
    const link = join(dir, 'linked')
    mkdirSync(real)
    symlinkSync(real, link)
    const linkedStore = createWorkspaceStore(join(link, 'workspace-board.json'))
    assert.throws(() => linkedStore.get(), /symbolischen Links/)
    assert.throws(() => createWorkspaceStore('relative.json'), /ungültig/)
    assert.throws(() => createWorkspaceStore(join(dir, 'same.json'), join(dir, 'same.json')), /ungültig/)
  })
  it('normalizes only verified Darwin /var and /tmp aliases and fails closed otherwise', () => {
    const resolvedAliases: string[] = []
    const canonicalize = (path: string): string => {
      resolvedAliases.push(path)
      if (path === '/var') return '/private/var'
      if (path === '/tmp') return '/private/tmp'
      throw new Error('unexpected alias')
    }
    assert.equal(normalizeDarwinSystemAliasPath('/var/folders/user/data.json', 'darwin', canonicalize), '/private/var/folders/user/data.json')
    assert.equal(normalizeDarwinSystemAliasPath('/tmp/workspace/data.json', 'darwin', canonicalize), '/private/tmp/workspace/data.json')
    assert.deepEqual(resolvedAliases, ['/var', '/tmp'])
    assert.equal(normalizeDarwinSystemAliasPath('/var/folders/user/data.json', 'linux', () => { throw new Error('must not resolve') }), resolve('/var/folders/user/data.json'))
    assert.equal(normalizeDarwinSystemAliasPath('/various/data.json', 'darwin', () => { throw new Error('must not resolve') }), '/various/data.json')
    assert.throws(() => normalizeDarwinSystemAliasPath('/var/folders/user/data.json', 'darwin', () => { throw new Error('missing') }), /kann nicht sicher aufgelöst werden/)
    assert.throws(() => normalizeDarwinSystemAliasPath('/tmp/workspace/data.json', 'darwin', () => '/unexpected/tmp'), /zeigt nicht auf das erwartete Ziel/)
  })
  it('does not touch a valid board when a task-file write is rejected by a symlink', () => {
    const { dir, board, tasks, store } = fixture()
    store.setCalendarEnabled(true)
    const before = readFileSync(board, 'utf8')
    const real = join(dir, 'outside-tasks.json')
    writeFileSync(real, JSON.stringify({ version: 1, tasks: [] }))
    rmSync(tasks, { force: true })
    symlinkSync(real, tasks)
    assert.throws(() => store.createTask('refused'), /symbolischen Links/)
    assert.equal(readFileSync(board, 'utf8'), before)
    assert.equal(JSON.parse(readFileSync(real, 'utf8')).tasks.length, 0)
  })
})

describe('Workspace calendar privacy and bounds', () => {
  it('does not call either calendar reader while access is disabled', async () => {
    let googleReads = 0, icalReads = 0
    const result = await readWorkspaceCalendar({
      enabled: false, googleConfigured: true, icalConfigured: true,
      readGoogle: async () => { googleReads++; return { events: [] } },
      readIcal: async () => { icalReads++; return { events: [] } },
      now: new Date('2024-01-01T12:00:00Z')
    })
    assert.equal(googleReads + icalReads, 0)
    assert.equal(result.enabled, false)
    assert.equal(result.sources.google.state, 'idle')
  })
  it('does not call a source that is not configured and reports it separately', async () => {
    let reads = 0
    const result = await readWorkspaceCalendar({
      enabled: true, googleConfigured: false, icalConfigured: true,
      readGoogle: async () => { reads++; return { events: [] } },
      readIcal: async () => ({ events: [] }), now: new Date('2024-01-01T12:00:00Z')
    })
    assert.equal(reads, 0)
    assert.equal(result.sources.google.state, 'not-configured')
    assert.equal(result.sources.ical.state, 'ready')
  })
  it('keeps Google and iCal successes/errors independent and removes secrets from provider errors', async () => {
    const result = await readWorkspaceCalendar({
      enabled: true, googleConfigured: true, icalConfigured: true,
      readGoogle: async () => { throw new Error('failed https://private.example/a access_token=SECRET') },
      readIcal: async () => ({ events: [{ id: 'ical-ok', title: 'Private event', start: Date.parse('2024-04-01T09:00:00Z'), allDay: false }] }),
      now: new Date('2024-04-01T08:00:00Z')
    })
    assert.equal(result.sources.google.state, 'error')
    assert.match(result.sources.google.error ?? '', /ausgeblendet/)
    assert.doesNotMatch(result.sources.google.error ?? '', /private\.example|SECRET/)
    assert.equal(result.sources.ical.state, 'ready')
    assert.equal(result.sources.ical.events[0].title, 'Private event')
  })
  it('isolates an iCal failure while keeping a configured Google result', async () => {
    const result = await readWorkspaceCalendar({
      enabled: true, googleConfigured: true, icalConfigured: true,
      readGoogle: async () => ({ events: [] }), readIcal: async () => { throw new Error('offline') },
      now: new Date('2024-01-01T12:00:00Z')
    })
    assert.equal(result.sources.google.state, 'ready')
    assert.equal(result.sources.ical.state, 'error')
    assert.equal(result.sources.ical.error, 'offline')
  })
  it('uses local midnight bounds with a 23-hour DST day and includes an all-day event', async () => {
    const original = process.env.TZ
    try {
      process.env.TZ = 'Europe/Vienna'
      const now = new Date('2024-03-31T12:00:00+02:00')
      const bounds = localTodayBounds(now)
      assert.equal(iso(bounds.from), '2024-03-30T23:00:00.000Z')
      assert.equal(iso(bounds.to), '2024-03-31T22:00:00.000Z')
      assert.equal((bounds.to.getTime() - bounds.from.getTime()) / 3_600_000, 23)
      const result = await readWorkspaceCalendar({
        enabled: true, googleConfigured: true, icalConfigured: false, now,
        readGoogle: async () => ({ events: [{ id: 'all-day', title: 'Feiertag', start: bounds.from.getTime(), end: bounds.to.getTime(), allDay: true }] })
      })
      assert.equal(result.timezone, 'Europe/Vienna')
      assert.equal(result.sources.google.events[0].allDay, true)
      assert.equal(result.sources.google.events[0].title, 'Feiertag')
    } finally {
      if (original === undefined) delete process.env.TZ
      else process.env.TZ = original
    }
  })
  it('calculates the 25-hour local day when daylight saving time ends', () => {
    const original = process.env.TZ
    try {
      process.env.TZ = 'Europe/Vienna'
      const bounds = localTodayBounds(new Date('2024-10-27T12:00:00+01:00'))
      assert.equal((bounds.to.getTime() - bounds.from.getTime()) / 3_600_000, 25)
      assert.equal(iso(bounds.from), '2024-10-26T22:00:00.000Z')
      assert.equal(iso(bounds.to), '2024-10-27T23:00:00.000Z')
    } finally {
      if (original === undefined) delete process.env.TZ
      else process.env.TZ = original
    }
  })
  it('treats the daily interval as half-open and includes overlapping multi-day events', async () => {
    const now = new Date('2024-04-01T10:00:00Z')
    const bounds = localTodayBounds(now)
    const result = await readWorkspaceCalendar({
      enabled: true, googleConfigured: true, icalConfigured: false, now,
      readGoogle: async () => ({ events: [
        { id: 'before', title: 'before', start: bounds.from.getTime() - 10, end: bounds.from.getTime() },
        { id: 'span', title: 'overlap', start: bounds.from.getTime() - 10, end: bounds.from.getTime() + 10 },
        { id: 'inside', title: 'inside', start: bounds.from.getTime(), end: bounds.to.getTime() },
        { id: 'at-end', title: 'tomorrow', start: bounds.to.getTime(), end: bounds.to.getTime() + 1000 }
      ] })
    })
    assert.deepEqual(result.sources.google.events.map((event) => event.id), ['span', 'inside'])
  })
  it('filters invalid event times and safely normalizes missing titles', async () => {
    const now = new Date('2024-04-01T10:00:00Z')
    const { from, to } = localTodayBounds(now)
    const result = await readWorkspaceCalendar({
      enabled: true, googleConfigured: true, icalConfigured: false, now,
      readGoogle: async () => ({ events: [
        { id: 'bad', title: 'bad', start: Number.NaN },
        { id: 'reverse', title: 'reverse', start: from.getTime() + 1000, end: from.getTime() },
        { id: 'valid', start: from.getTime() + 2000, end: to.getTime() }
      ] })
    })
    assert.deepEqual(result.sources.google.events.map((event) => event.title), ['Termin'])
  })
  it('stamps successful source data with the injected read time and sorts events', async () => {
    const now = new Date('2024-04-01T10:00:00Z')
    const result = await readWorkspaceCalendar({
      enabled: true, googleConfigured: true, icalConfigured: false, now,
      readGoogle: async () => ({ events: [
        { id: 'later', start: Date.parse('2024-04-01T12:00:00Z') },
        { id: 'earlier', start: Date.parse('2024-04-01T11:00:00Z') }
      ] })
    })
    assert.equal(result.sources.google.fetchedAt, now.getTime())
    assert.deepEqual(result.sources.google.events.map((event) => event.id), ['earlier', 'later'])
  })
  it('drops an in-flight successful result after explicit opt-out, even if access is later re-enabled', async () => {
    const current = workspaceCalendarReadIsCurrent()
    let finish!: (value: { events: Array<{ id: string; title: string; start: number }> }) => void
    const pending = new Promise<{ events: Array<{ id: string; title: string; start: number }> }>((resolve) => { finish = resolve })
    const read = readWorkspaceCalendar({
      enabled: true, googleConfigured: true, icalConfigured: false,
      now: new Date('2024-04-01T10:00:00Z'), isCurrent: current,
      readGoogle: async () => pending
    })
    invalidateWorkspaceCalendarReads()
    const reenabled = true // Re-enabling does not restore the old epoch predicate.
    finish({ events: [{ id: 'private', title: 'late private result', start: Date.parse('2024-04-01T11:00:00Z') }] })
    const result = await read
    assert.equal(reenabled, true)
    assert.equal(result.enabled, false)
    assert.equal(result.sources.google.events.length, 0)
    assert.equal(result.sources.google.fetchedAt, undefined)
    assert.equal(current(), false)
  })
  it('drops a late source error as well as late event data after opt-out', async () => {
    const current = workspaceCalendarReadIsCurrent()
    let finish!: (reason: Error) => void
    const pending = new Promise<{ events: never[] }>((_resolve, reject) => { finish = reject })
    const read = readWorkspaceCalendar({
      enabled: true, googleConfigured: true, icalConfigured: false,
      now: new Date('2024-04-01T10:00:00Z'), isCurrent: current,
      readGoogle: async () => pending
    })
    invalidateWorkspaceCalendarReads()
    finish(new Error('private provider details'))
    const result = await read
    assert.equal(result.enabled, false)
    assert.equal(result.sources.google.state, 'idle')
    assert.equal(result.sources.google.error, undefined)
  })
  it('returns no loaded results for a stale consent predicate before starting providers', async () => {
    let reads = 0
    const result = await readWorkspaceCalendar({
      enabled: true, googleConfigured: true, icalConfigured: true, isCurrent: () => false,
      readGoogle: async () => { reads++; return { events: [] } },
      readIcal: async () => { reads++; return { events: [] } }
    })
    assert.equal(reads, 0)
    assert.equal(result.enabled, false)
    assert.equal(result.sources.google.state, 'idle')
    assert.equal(result.sources.ical.state, 'idle')
  })
})
