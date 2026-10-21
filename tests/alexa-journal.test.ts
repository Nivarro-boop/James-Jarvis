import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createRequestDeduper } from '@main/alexa/idempotency'
import {
  createRequestJournal,
  ReplayAfterRestartError,
  RequestJournalError
} from '@main/alexa/requestJournal'

async function withDirectory(run: (directory: string) => Promise<void> | void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'alexa-journal-'))
  try {
    await run(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function deduperFor(directory: string, options: Parameters<typeof createRequestJournal>[1] = {}) {
  const journal = createRequestJournal(directory, options)
  return createRequestDeduper({ claim: (requestId) => journal.claim(requestId) })
}

describe('Alexa persistent request tombstones', () => {
  it('blocks a restart replay before a second operation, while allowing a new ID', async () => {
    await withDirectory(async (directory) => {
      const first = deduperFor(directory)
      const second = deduperFor(directory)
      let calls = 0
      assert.equal(await first.run('same-authenticated-id', () => ++calls), 1)
      await assert.rejects(second.run('same-authenticated-id', () => ++calls), ReplayAfterRestartError)
      assert.equal(await second.run('new-authenticated-id', () => ++calls), 2)
      assert.equal(calls, 2)
      const stored = readFileSync(join(directory, 'alexa-request-journal.json'), 'utf8')
      assert.equal(stored.includes('same-authenticated-id'), false)
      assert.equal(statSync(join(directory, 'alexa-request-journal.json')).mode & 0o777, 0o600)
    })
  })

  it('allows a tombstone to be claimed again after expiry', async () => {
    await withDirectory((directory) => {
      let now = 10_000
      const journal = createRequestJournal(directory, { now: () => now, ttlMs: 100 })
      journal.claim('expires')
      now += 101
      assert.doesNotThrow(() => journal.claim('expires'))
    })
  })

  it('fails closed on corrupt or oversized journal data before calling the operation', async () => {
    await withDirectory(async (directory) => {
      writeFileSync(join(directory, 'alexa-request-journal.json'), '{broken')
      const deduper = deduperFor(directory)
      let calls = 0
      await assert.rejects(deduper.run('never-start', () => ++calls), RequestJournalError)
      assert.equal(calls, 0)
    })

    await withDirectory(async (directory) => {
      writeFileSync(join(directory, 'alexa-request-journal.json'), Buffer.alloc(64 * 1024 + 1))
      const deduper = deduperFor(directory)
      let calls = 0
      await assert.rejects(deduper.run('never-start', () => ++calls), RequestJournalError)
      assert.equal(calls, 0)
    })
  })

  it('fails closed on a symlinked journal file before calling the operation', async () => {
    await withDirectory(async (directory) => {
      const target = join(directory, 'outside.json')
      writeFileSync(target, JSON.stringify({ version: 1, entries: [] }))
      symlinkSync(target, join(directory, 'alexa-request-journal.json'))
      const deduper = deduperFor(directory)
      let calls = 0
      await assert.rejects(deduper.run('never-start', () => ++calls), RequestJournalError)
      assert.equal(calls, 0)
    })
  })

  it('fails closed on unsafe journal permissions before calling the operation', async () => {
    if (process.platform === 'win32') return
    await withDirectory(async (directory) => {
      const journalFile = join(directory, 'alexa-request-journal.json')
      writeFileSync(journalFile, JSON.stringify({ version: 1, entries: [] }), { mode: 0o600 })
      chmodSync(journalFile, 0o644)
      const deduper = deduperFor(directory)
      let calls = 0
      await assert.rejects(deduper.run('never-start', () => ++calls), RequestJournalError)
      assert.equal(calls, 0)
    })
  })

  it('fails closed when the UserData root is unavailable before calling the operation', async () => {
    await withDirectory(async (directory) => {
      const missingRoot = join(directory, 'missing')
      const deduper = deduperFor(missingRoot)
      let calls = 0
      await assert.rejects(deduper.run('never-start', () => ++calls), RequestJournalError)
      assert.equal(calls, 0)
    })
  })

  it('does not evict an unexpired tombstone when capacity is full', async () => {
    await withDirectory(async (directory) => {
      let now = 1000
      const journal = createRequestJournal(directory, { now: () => now, ttlMs: 100, maxEntries: 1 })
      const first = createRequestDeduper({ claim: (id) => journal.claim(id) })
      const second = createRequestDeduper({ claim: (id) => journal.claim(id) })
      assert.equal(await first.run('kept', () => 'done'), 'done')
      await assert.rejects(second.run('overflow', () => assert.fail('must not run')), RequestJournalError)
      await assert.rejects(second.run('kept', () => assert.fail('must not run')), ReplayAfterRestartError)
      now += 101
      assert.equal(await second.run('overflow', () => 'new'), 'new')
    })
  })
})
