import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'

const FILE_NAME = 'alexa-request-journal.json'
const MAX_FILE_BYTES = 64 * 1024
const MAX_ENTRIES = 512
const DEFAULT_TTL_MS = 10 * 60_000

export class ReplayAfterRestartError extends Error {
  constructor() {
    super('Diese Anfrage wurde bereits verarbeitet oder ihr Ausgang ist unklar.')
    this.name = 'ReplayAfterRestartError'
  }
}

export class RequestJournalError extends Error {
  constructor(message = 'Das Alexa-Anfragejournal ist nicht sicher verfügbar.') {
    super(message)
    this.name = 'RequestJournalError'
  }
}

interface Tombstone {
  digest: string
  expiresAt: number
}

interface JournalFile {
  version: 1
  entries: Tombstone[]
}

export interface RequestJournalOptions {
  /** Injectable clock for deterministic tests. */
  now?: () => number
  /** Replay lifetime; defaults to the deduper's ten-minute window. */
  ttlMs?: number
  /** Capacity, capped at the hard limit of 512. */
  maxEntries?: number
}

/**
 * Create a journal handle without touching disk. I/O begins only when claim is
 * called, normally after the Alexa signature and skill identity are validated.
 * Calls are synchronous and serialized within this process; the app's existing
 * single-instance lock excludes concurrent main processes sharing UserData.
 */
export function createRequestJournal(directory: string, options: RequestJournalOptions = {}) {
  const root = resolve(directory)
  const file = join(root, FILE_NAME)
  const now = options.now ?? Date.now
  const requestedTtl = options.ttlMs ?? DEFAULT_TTL_MS
  const requestedCapacity = options.maxEntries ?? MAX_ENTRIES
  const ttlMs = Number.isFinite(requestedTtl)
    ? Math.max(1, Math.min(DEFAULT_TTL_MS, requestedTtl))
    : DEFAULT_TTL_MS
  const maxEntries = Number.isFinite(requestedCapacity)
    ? Math.max(1, Math.min(MAX_ENTRIES, Math.floor(requestedCapacity)))
    : MAX_ENTRIES

  function readEntries(): Tombstone[] {
    try {
      const rootStat = lstatSync(root)
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('invalid root')

      let fileStat
      try {
        fileStat = lstatSync(file)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw err
      }
      if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.size > MAX_FILE_BYTES) {
        throw new Error('invalid journal file')
      }

      const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      let data: Buffer
      try {
        const openedStat = fstatSync(fd)
        if (!openedStat.isFile() || openedStat.size > MAX_FILE_BYTES) throw new Error('invalid journal file')
        if (process.platform !== 'win32' && (openedStat.mode & 0o077) !== 0) throw new Error('unsafe journal permissions')
        data = readFileSync(fd)
      } finally {
        closeSync(fd)
      }
      if (data.length > MAX_FILE_BYTES) throw new Error('oversize journal')

      const parsed = JSON.parse(data.toString('utf8')) as JournalFile
      if (
        !parsed ||
        Object.keys(parsed).length !== 2 ||
        !Object.hasOwn(parsed, 'version') ||
        !Object.hasOwn(parsed, 'entries') ||
        parsed.version !== 1 ||
        !Array.isArray(parsed.entries) ||
        parsed.entries.length > maxEntries
      ) {
        throw new Error('invalid journal structure')
      }
      const seen = new Set<string>()
      for (const entry of parsed.entries) {
        if (
          !entry ||
          Object.keys(entry).length !== 2 ||
          !Object.hasOwn(entry, 'digest') ||
          !Object.hasOwn(entry, 'expiresAt') ||
          typeof entry.digest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(entry.digest) ||
          !Number.isSafeInteger(entry.expiresAt) ||
          entry.expiresAt < 0 ||
          seen.has(entry.digest)
        ) {
          throw new Error('invalid journal entry')
        }
        seen.add(entry.digest)
      }
      return parsed.entries
    } catch (err) {
      if (err instanceof RequestJournalError) throw err
      throw new RequestJournalError()
    }
  }

  function persist(entries: Tombstone[]): void {
    let dirFd: number | undefined
    let temp: string | undefined
    let fd: number | undefined
    try {
      const rootStat = lstatSync(root)
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('invalid root')
      try {
        const existing = lstatSync(file)
        if (existing.isSymbolicLink() || !existing.isFile() || existing.size > MAX_FILE_BYTES) {
          throw new Error('invalid journal file')
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }

      const json = Buffer.from(JSON.stringify({ version: 1, entries } satisfies JournalFile), 'utf8')
      if (json.length > MAX_FILE_BYTES) throw new Error('oversize journal')
      temp = join(root, `.${FILE_NAME}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`)
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      writeFileSync(fd, json)
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(temp, file)
      temp = undefined

      // The file is durable before the operation may begin; syncing the parent
      // makes the atomic rename durable as well.
      if (process.platform !== 'win32') {
        dirFd = openSync(root, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
        fsyncSync(dirFd)
        closeSync(dirFd)
        dirFd = undefined
      }
    } catch {
      throw new RequestJournalError()
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd) } catch { /* best-effort cleanup */ }
      }
      if (dirFd !== undefined) {
        try { closeSync(dirFd) } catch { /* best-effort cleanup */ }
      }
      if (temp) {
        try { unlinkSync(temp) } catch { /* best-effort cleanup */ }
      }
    }
  }

  return {
    /** Claim a request ID durably; raw IDs are never written to disk or paths. */
    claim(requestId: string): void {
      if (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 512) {
        throw new RequestJournalError()
      }
      const time = now()
      if (!Number.isSafeInteger(time) || time < 0) throw new RequestJournalError()
      const digest = createHash('sha256').update(requestId, 'utf8').digest('hex')
      const existing = readEntries()
      const active = existing.filter((entry) => entry.expiresAt > time)
      const changed = active.length !== existing.length
      if (active.some((entry) => entry.digest === digest)) {
        if (changed) persist(active)
        throw new ReplayAfterRestartError()
      }
      if (active.length >= maxEntries) {
        if (changed) persist(active)
        throw new RequestJournalError('Das Alexa-Anfragejournal ist voll; es wurde nichts gestartet.')
      }
      const expiresAt = Math.floor(time + ttlMs)
      if (!Number.isSafeInteger(expiresAt)) throw new RequestJournalError()
      active.push({ digest, expiresAt })
      persist(active)
    }
  }
}
