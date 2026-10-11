import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { spawn } from 'node:child_process'
import { app } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, initDb, insertTimer, listTimers } from '@main/db'
import { isLockedError, retryWhileLocked } from '@main/db/lock'

const locked = (): Error => Object.assign(new Error('database is locked'), { name: 'SQLite3Error' })

describe('Wiederholen bei gesperrter Datenbank', () => {
  it('erkennt nur SQLITE_BUSY, nicht SQLITE_LOCKED oder andere Fehler', () => {
    assert.equal(isLockedError(locked()), true)
    assert.equal(isLockedError(new Error('SQLITE_BUSY: database is locked')), true)
    assert.equal(isLockedError(new Error('database table is locked')), false)
    assert.equal(isLockedError(new Error('UNIQUE constraint failed: contacts.email')), false)
    assert.equal(isLockedError('database is locked'), false)
  })

  it('wartet in wachsenden Abständen und liefert dann das Ergebnis', () => {
    const slept: number[] = []
    let calls = 0
    const result = retryWhileLocked(
      () => {
        if (++calls < 4) throw locked()
        return 'ok'
      },
      { delays: [1, 2, 3, 4, 5], sleep: (ms) => slept.push(ms) }
    )
    assert.equal(result, 'ok')
    assert.equal(calls, 4)
    assert.deepEqual(slept, [1, 2, 3])
  })

  it('gibt nach der letzten Wartezeit den ursprünglichen Fehler weiter', () => {
    const original = locked()
    let calls = 0
    assert.throws(
      () =>
        retryWhileLocked(
          () => {
            calls++
            throw original
          },
          { delays: [1, 1], sleep: () => {} }
        ),
      (err) => err === original
    )
    assert.equal(calls, 3)
  })

  it('wiederholt andere Fehler nicht', () => {
    let calls = 0
    assert.throws(
      () =>
        retryWhileLocked(
          () => {
            calls++
            throw new Error('no such table: x')
          },
          { sleep: () => assert.fail('kein Warten bei anderen Fehlern') }
        ),
      /no such table/
    )
    assert.equal(calls, 1)
  })

  it('ruft den Haken vor jeder Wiederholung und respektiert canRetry', () => {
    const attempts: number[] = []
    let calls = 0
    retryWhileLocked(
      () => {
        if (++calls < 3) throw locked()
      },
      { delays: [1, 1, 1], sleep: () => {}, onBusy: (attempt) => attempts.push(attempt) }
    )
    assert.deepEqual(attempts, [1, 2])

    calls = 0
    assert.throws(
      () =>
        retryWhileLocked(
          () => {
            calls++
            throw locked()
          },
          { delays: [1, 1], sleep: () => {}, canRetry: () => false }
        ),
      /database is locked/
    )
    assert.equal(calls, 1)
  })
})

describe('Datenbank im Betrieb', () => {
  it('räumt beim Start eine hinterlassene Sperre weg', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'james-dblock-'))
    t.mock.method(app, 'getPath', () => root)
    t.after(() => {
      closeDb()
      rmSync(root, { recursive: true, force: true })
    })
    mkdirSync(join(root, 'data'), { recursive: true })
    mkdirSync(join(root, 'data', 'jarvis.db.lock'))

    initDb()
    insertTimer('nach dem Absturz', Date.now() + 60_000)
    assert.equal(listTimers().length, 1)
    assert.equal(existsSync(join(root, 'data', 'jarvis.db.lock')), false)
  })

  it('behält nach einem gescheiterten Start kein halbfertiges Handle', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'james-dbbroken-'))
    t.mock.method(app, 'getPath', () => root)
    t.after(() => {
      closeDb()
      rmSync(root, { recursive: true, force: true })
    })
    const file = join(root, 'data', 'jarvis.db')
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(file, 'das ist keine Datenbank, nur genug Text, damit SQLite sie ablehnt'.repeat(40))

    // Beide Aufrufe müssen werfen. Früher lieferte der zweite das beim ersten
    // Mal übrig gebliebene Handle zurück, und jede Abfrage scheiterte danach.
    assert.throws(() => initDb(), /not a database|malformed|encrypted/i)
    assert.throws(() => initDb(), /not a database|malformed|encrypted/i)

    rmSync(file)
    initDb()
    insertTimer('wieder da', Date.now() + 60_000)
    assert.equal(listTimers().length, 1)
  })

  it('wartet, bis ein anderer Prozess seine Sperre löst, statt sofort zu scheitern', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'james-dbbusy-'))
    t.mock.method(app, 'getPath', () => root)
    initDb()
    const file = join(root, 'data', 'jarvis.db')

    // Ein zweiter Prozess hält die Sperre für einen Augenblick, wie es der
    // Rest eines beendenden Vorgängers oder ein fremder Zugriff täte.
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const { Database } = require('node-sqlite3-wasm')
         const db = new Database(process.argv[1])
         db.exec('BEGIN EXCLUSIVE')
         console.log('gesperrt')
         setTimeout(() => { db.exec('COMMIT'); db.close() }, 150)`,
        file
      ],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit'] }
    )
    t.after(() => {
      holder.kill()
      closeDb()
      rmSync(root, { recursive: true, force: true })
    })
    await new Promise<void>((resolve, reject) => {
      holder.stdout.once('data', () => resolve())
      holder.once('error', reject)
      holder.once('exit', (code) => reject(new Error(`Halter endete vorzeitig (${code})`)))
    })
    assert.equal(existsSync(`${file}.lock`), true, 'der Halter hat die Sperre')

    // Synchron, wie jeder Aufrufer: blockiert kurz, bis der Halter freigibt.
    insertTimer('trotz Sperre', Date.now() + 60_000)
    assert.equal(listTimers().length, 1)
  })
})
