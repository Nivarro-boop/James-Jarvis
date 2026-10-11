import { it } from 'node:test'
import assert from 'node:assert/strict'
import { AutomaticDiagnostics } from '../src/main/providers/automaticDiagnostics'
import { automaticDiagnosticReport } from '@shared/diagnosticReport'

function fixture(send?: (count: number, signal: AbortSignal) => Promise<boolean>) {
  let time = 0
  const config = { enabled: true, automatic: true, url: 'https://reports.example/api/error-report' }
  const calls: number[] = []
  const jobs = new Set<{ callback: () => void; due: number }>()
  const queue = new AutomaticDiagnostics({ config: () => config, now: () => time,
    send: async (count, signal) => { calls.push(count); return send ? send(count, signal) : true },
    schedule: (callback, delay) => {
      const job = { callback, due: time + delay }; jobs.add(job)
      return () => { jobs.delete(job) }
    }
  })
  return { queue, config, calls, jobs, async advance(ms: number) {
    time += ms
    for (const job of [...jobs]) if (job.due <= time) { jobs.delete(job); job.callback() }
    for (let i = 0; i < 5; i++) await Promise.resolve()
  } }
}

it('bündelt neue Fehler nach 30 Sekunden und unterdrückt doppelte Fingerabdrücke', async () => {
  const f = fixture()
  f.queue.notify('live:fehler'); f.queue.notify('live:fehler'); f.queue.notify('system:fehler')
  await f.advance(29_999); assert.deepEqual(f.calls, [])
  await f.advance(1); assert.deepEqual(f.calls, [2]); assert.equal(f.jobs.size, 0)
  f.queue.stop()
})

it('sendet nur mit beiden aktivierten Einstellungen und lädt keine alten Fehler nachträglich hoch', async () => {
  for (const setting of ['enabled', 'automatic'] as const) {
    const f = fixture(); f.config[setting] = false
    f.queue.notify('private-error'); await f.advance(60_000); assert.deepEqual(f.calls, [])
    f.config[setting] = true; await f.advance(60_000); assert.deepEqual(f.calls, [])
    f.queue.stop()
  }
})

it('begrenzt Uploads auf fünf Minuten und gleiche Fehler auf fünfzehn Minuten', async () => {
  const f = fixture()
  f.queue.notify('a'); await f.advance(30_000)
  f.queue.notify('a'); f.queue.notify('b'); await f.advance(299_999)
  assert.deepEqual(f.calls, [1]); await f.advance(1); assert.deepEqual(f.calls, [1, 1])
  await f.advance(570_000); f.queue.notify('a'); await f.advance(30_000)
  assert.deepEqual(f.calls, [1, 1, 1]); f.queue.stop()
})

it('versucht fehlgeschlagene Berichte begrenzt erneut und fasst neue Fehler dazu zusammen', async () => {
  let attempts = 0
  const f = fixture(async () => ++attempts > 1)
  f.queue.notify('a'); await f.advance(30_000); f.queue.notify('b')
  await f.advance(300_000); assert.deepEqual(f.calls, [1, 2]); assert.equal(f.jobs.size, 0)
  f.queue.stop()
})

it('verwirft die Warteschlange beim Ausschalten oder Empfängerwechsel', async () => {
  const f = fixture(); f.queue.notify('a'); f.config.url = 'https://other.example'; f.queue.reset()
  await f.advance(60_000); assert.deepEqual(f.calls, [])
  f.queue.notify('b'); f.config.automatic = false; f.queue.reset()
  await f.advance(60_000); assert.deepEqual(f.calls, []); f.queue.stop()
})

it('bricht laufende Uploads ab und übernimmt deren spätes Ergebnis nicht', async () => {
  let signal: AbortSignal | undefined
  let resolve!: (ok: boolean) => void
  const f = fixture(async (_count, current) => { signal = current; return new Promise(r => { resolve = r }) })
  f.queue.notify('a'); await f.advance(30_000); assert.equal(signal?.aborted, false)
  f.queue.reset(); assert.equal(signal?.aborted, true)
  resolve(false); await f.advance(60_000)
  assert.equal(f.jobs.size, 0); assert.deepEqual(f.calls, [1]); f.queue.stop()
})

it('beendet alle Timer beim App-Ende und lässt keine neuen Uploads zu', async () => {
  const f = fixture(); f.queue.notify('a'); f.queue.stop(); f.queue.notify('b')
  await f.advance(60_000); assert.deepEqual(f.calls, []); assert.equal(f.jobs.size, 0)
})

it('überträgt automatisch ausschließlich den festen Vertrag und technische Zähler', () => {
  const report = automaticDiagnosticReport('1.2.17', 'win32', 3)
  assert.deepEqual(Object.keys(report), ['level', 'message', 'source', 'details'])
  assert.deepEqual(JSON.parse(report.details), { appVersion: '1.2.17', platform: 'win32', incidents: 3, automatic: true })
  assert.equal(report.source, 'JARVIS'); assert.equal(report.level, 'error')
  assert.doesNotMatch(JSON.stringify(report), /fingerprint|stack|location|username|token|email/)
})
