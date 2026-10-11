import { it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CapabilityGapCollector,
  noteToolFailure,
  setCapabilityGapCollector,
  withoutGapReports,
  type CapabilityGapReport
} from '@main/agent/capabilityGaps'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
/** Alle Mikroaufgaben abarbeiten; die Timer selbst sind gefälscht. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

function fixture(send?: (report: CapabilityGapReport, signal: AbortSignal) => Promise<boolean>) {
  let time = 0
  const config = { enabled: true, capabilityGaps: true, url: 'https://reports.example/api/error-report' }
  const reports: CapabilityGapReport[] = []
  const jobs = new Set<{ callback: () => void; due: number }>()
  const gaps = new CapabilityGapCollector({
    config: () => config,
    version: '1.3.3',
    platform: 'win32',
    now: () => time,
    send: async (report, signal) => { reports.push(report); return send ? send(report, signal) : true },
    schedule: (callback, delay) => {
      const job = { callback, due: time + delay }
      jobs.add(job)
      return () => { jobs.delete(job) }
    }
  })
  const details = (i = reports.length - 1) => JSON.parse(reports[i].details)
  return {
    gaps, config, reports, jobs, details,
    async advance(ms: number) {
      const end = time + ms
      for (;;) {
        const next = [...jobs].filter((j) => j.due <= end).sort((a, b) => a.due - b.due)[0]
        if (!next) break
        time = Math.max(time, next.due)
        jobs.delete(next)
        next.callback()
        await settle()
      }
      time = end
      await settle()
    }
  }
}

it('sendet ohne beide Zustimmungen nichts und merkt sich auch nichts', async () => {
  for (const setting of ['enabled', 'capabilityGaps'] as const) {
    const f = fixture()
    f.config[setting] = false
    f.gaps.toolFailure({ tool: 'rechnung_senden', kind: 'unknown', detail: '', userText: 'Schick die Rechnung' })
    f.gaps.answer({ request: 'Schick die Rechnung', answer: 'Das kann ich leider nicht.', channel: 'live' })
    assert.equal(f.gaps.explicit({ request: 'Rechnung', reason: 'fehlt', suggestion: 'bauen' }), false)
    assert.equal(f.jobs.size, 0)
    await f.advance(HOUR)
    // Spätere Zustimmung schickt nichts von vorher hinterher.
    f.config[setting] = true
    f.gaps.answer({ request: 'Wie spät ist es?', answer: 'Es ist drei Uhr.', channel: 'live' })
    await f.advance(HOUR)
    assert.deepEqual(f.reports, [])
    f.gaps.stop()
  }
})

it('meldet eine Ablehnung nach der Ruhezeit einmal, mit Lösungsvorschlag', async () => {
  const f = fixture()
  f.gaps.answer({ request: 'Buch mir einen Tisch beim Italiener', answer: 'Das kann ich leider nicht.', channel: 'live' })
  await f.advance(5999)
  assert.equal(f.reports.length, 0)
  await f.advance(1)
  assert.equal(f.reports.length, 1)
  const d = f.details()
  assert.equal(d.request, 'Buch mir einen Tisch beim Italiener')
  assert.equal(d.reason, 'Das kann ich leider nicht.')
  assert.equal(d.channel, 'live')
  assert.deepEqual(d.sources, ['answer'])
  assert.match(d.suggestion, /Werkzeug oder Anleitung/)
  assert.equal(f.reports[0].kind, 'capability-gap')
  f.gaps.stop()
})

it('ignoriert Antworten ohne Ablehnung', async () => {
  const f = fixture()
  f.gaps.answer({ request: 'Wetter?', answer: 'Morgen wird es sonnig. Kann ich sonst noch helfen?', channel: 'live' })
  await f.advance(HOUR)
  assert.equal(f.reports.length, 0)
  f.gaps.stop()
})

it('fasst Werkzeugfehler, Ablehnung und Modellmeldung zur selben Bitte zu einem Bericht zusammen', async () => {
  const f = fixture()
  const userText = 'Bestell mir ein Taxi zum Bahnhof'
  f.gaps.toolFailure({ tool: 'tool_search', kind: 'no-match', detail: 'taxi bestellen', userText })
  await f.advance(2000)
  f.gaps.toolFailure({ tool: 'taxi_order', kind: 'error', detail: 'Zeitüberschreitung', userText })
  f.gaps.explicit({ request: 'Taxi bestellen', reason: 'Kein Werkzeug für Taxidienste.', suggestion: 'Taxi-Werkzeug mit Anbieter-Schnittstelle bauen.', userText })
  await f.advance(3000)
  f.gaps.answer({ request: 'bestell mir ein Taxi zum Bahnhof!', answer: 'Dafür habe ich kein Werkzeug.', channel: 'realtime' })
  await f.advance(5999)
  assert.equal(f.reports.length, 0)
  await f.advance(1)
  assert.equal(f.reports.length, 1)
  const d = f.details()
  assert.equal(d.request, userText)
  assert.equal(d.answer, 'Dafür habe ich kein Werkzeug.')
  assert.equal(d.reason, 'Kein Werkzeug für Taxidienste.')
  assert.equal(d.channel, 'realtime')
  assert.deepEqual([...d.sources].sort(), ['answer', 'model', 'tool'])
  assert.deepEqual(d.tools.map((t: { kind: string }) => t.kind).sort(), ['error', 'no-match'])
  assert.match(d.suggestion, /Taxi-Werkzeug/)
  assert.match(d.suggestion, /tool_search fand nichts/)
  await f.advance(HOUR)
  assert.equal(f.reports.length, 1)
  f.gaps.stop()
})

it('wartet ohne Antwort länger, damit eine lange Absage noch zum selben Bericht kommt', async () => {
  const f = fixture()
  const userText = 'Bestell mir ein Taxi zum Bahnhof'
  f.gaps.explicit({ request: 'Taxi bestellen', reason: 'Kein Taxi-Werkzeug.', suggestion: 'Taxi-Werkzeug bauen.', userText })
  await f.advance(12_000)
  assert.equal(f.reports.length, 0)
  f.gaps.answer({ request: userText, answer: 'Das kann ich leider nicht, dafür fehlt mir ein Werkzeug.', channel: 'cascade' })
  await f.advance(6000)
  assert.equal(f.reports.length, 1)
  assert.deepEqual([...f.details().sources].sort(), ['answer', 'model'])

  // Kommt keine Antwort, geht die Meldung allein hinaus.
  f.gaps.explicit({ request: 'Flug buchen', reason: 'Kein Buchungszugang.', suggestion: 'Buchung anbinden.', userText: 'Buch mir einen Flug' })
  await f.advance(20_000)
  assert.equal(f.reports.length, 2)
  f.gaps.stop()
})

it('ordnet das Bruchstück von Gemini Live der ganzen Frage zu', async () => {
  const f = fixture()
  f.gaps.toolFailure({ tool: 'tool_search', kind: 'no-match', detail: 'taxi', userText: ' zum Bahnhof.' })
  f.gaps.explicit({ request: 'Taxi bestellen', reason: 'Kein Taxi-Werkzeug.', suggestion: 'Taxi-Werkzeug bauen.', userText: ' zum Bahnhof.' })
  await f.advance(8000)
  f.gaps.answer({ request: 'Bestell mir ein Taxi zum Bahnhof.', answer: 'Das kann ich leider nicht.', channel: 'live' })
  await f.advance(HOUR)
  assert.equal(f.reports.length, 1)
  const d = f.details()
  assert.equal(d.request, 'Bestell mir ein Taxi zum Bahnhof.')
  assert.deepEqual([...d.sources].sort(), ['answer', 'model', 'tool'])
  assert.deepEqual(d.tools.map((t: { kind: string }) => t.kind), ['no-match'])
  f.gaps.stop()
})

it('meldet gesperrte oder gescheiterte Werkzeuge allein nicht', async () => {
  const f = fixture()
  f.gaps.toolFailure({ tool: 'gmail_send', kind: 'locked', detail: 'gesperrt', userText: 'Schick die Mail' })
  f.gaps.toolFailure({ tool: 'weather', kind: 'error', detail: 'HTTP 500', userText: 'Wetter?' })
  await f.advance(HOUR)
  assert.equal(f.reports.length, 0)
  f.gaps.stop()
})

it('meldet dieselbe Lücke innerhalb von zwölf Stunden nur einmal', async () => {
  const f = fixture()
  const refuse = () => f.gaps.answer({ request: 'Buch einen Flug nach Rom', answer: 'Das kann ich nicht.', channel: 'live' })
  refuse()
  await f.advance(MINUTE)
  refuse()
  await f.advance(11 * HOUR)
  assert.equal(f.reports.length, 1)
  await f.advance(HOUR)
  refuse()
  await f.advance(MINUTE)
  assert.equal(f.reports.length, 2)
  f.gaps.stop()
})

it('sendet höchstens zwölf Berichte pro Stunde und den Rest danach', async () => {
  const f = fixture()
  for (let i = 0; i < 15; i++) {
    f.gaps.answer({ request: `Aufgabe Nummer ${'abcdefghijklmnopq'[i].repeat(5)}`, answer: 'Das kann ich nicht.', channel: 'live' })
  }
  await f.advance(MINUTE)
  assert.equal(f.reports.length, 12)
  await f.advance(HOUR - 2 * MINUTE)
  assert.equal(f.reports.length, 12)
  await f.advance(2 * MINUTE)
  assert.equal(f.reports.length, 15)
  f.gaps.stop()
})

it('versucht einen gescheiterten Versand nach fünf Minuten erneut, höchstens dreimal', async () => {
  let attempts = 0
  const f = fixture(async () => ++attempts > 1)
  f.gaps.answer({ request: 'Mach ein Foto vom Garten', answer: 'Das kann ich leider nicht.', channel: 'live' })
  await f.advance(6000)
  assert.equal(f.reports.length, 1)
  await f.advance(5 * MINUTE - 1)
  assert.equal(f.reports.length, 1)
  await f.advance(1)
  assert.equal(f.reports.length, 2)
  assert.equal(f.jobs.size, 0)

  const g = fixture(async () => false)
  g.gaps.answer({ request: 'Mach ein Foto vom Garten', answer: 'Das kann ich leider nicht.', channel: 'live' })
  await g.advance(HOUR)
  assert.equal(g.reports.length, 3)
  assert.equal(g.jobs.size, 0)
  f.gaps.stop()
  g.gaps.stop()
})

it('verwirft beim Umstellen alles Offene und bricht laufenden Versand ab', async () => {
  const f = fixture()
  f.gaps.answer({ request: 'Buch mir ein Hotel', answer: 'Das kann ich nicht.', channel: 'live' })
  f.config.url = 'https://other.example/api/error-report'
  f.gaps.reset()
  await f.advance(HOUR)
  assert.equal(f.reports.length, 0)

  let signal: AbortSignal | undefined
  let resolve!: (ok: boolean) => void
  const g = fixture((_report, current) => { signal = current; return new Promise((r) => { resolve = r }) })
  g.gaps.answer({ request: 'Buch mir ein Hotel', answer: 'Das kann ich nicht.', channel: 'live' })
  await g.advance(6000)
  assert.equal(signal?.aborted, false)
  g.gaps.reset()
  assert.equal(signal?.aborted, true)
  resolve(false)
  await g.advance(HOUR)
  assert.equal(g.reports.length, 1)
  assert.equal(g.jobs.size, 0)
  f.gaps.stop()
  g.gaps.stop()
})

it('nimmt nach dem Beenden nichts mehr an und hinterlässt keine Timer', async () => {
  const f = fixture()
  f.gaps.answer({ request: 'Buch mir ein Hotel', answer: 'Das kann ich nicht.', channel: 'live' })
  f.gaps.stop()
  f.gaps.answer({ request: 'Buch mir einen Flug', answer: 'Das kann ich nicht.', channel: 'live' })
  assert.equal(f.gaps.explicit({ request: 'x', reason: 'y', suggestion: 'z' }), false)
  assert.equal(f.jobs.size, 0)
  await f.advance(HOUR)
  assert.equal(f.reports.length, 0)
})

it('schickt Gesprächstext nur bereinigt hinaus', async () => {
  const f = fixture()
  f.gaps.answer({
    request: 'Schreib an anna.beispiel@example.org und ruf +43 660 1234567 an',
    answer: 'Das kann ich leider nicht. Die Adresse anna.beispiel@example.org ist mir unbekannt.',
    channel: 'live'
  })
  await f.advance(6000)
  assert.equal(f.reports.length, 1)
  const raw = JSON.stringify(f.reports[0])
  assert.doesNotMatch(raw, /anna\.beispiel|example\.org|660 1234567/)
  assert.match(f.details().request, /\[E-Mail\]/)
  f.gaps.stop()
})

it('wirft nie, auch wenn Einstellungen oder Versand scheitern', async () => {
  const gaps = new CapabilityGapCollector({
    config: () => { throw new Error('kaputt') },
    send: async () => { throw new Error('kaputt') },
    version: '1', platform: 'win32',
    schedule: () => () => {}
  })
  assert.doesNotThrow(() => gaps.answer({ request: 'a', answer: 'Das kann ich nicht.', channel: 'live' }))
  assert.doesNotThrow(() => gaps.toolFailure({ tool: 'x', kind: 'unknown', detail: '', userText: 'a' }))
  assert.equal(gaps.explicit({ request: 'a', reason: 'b', suggestion: 'c' }), false)

  const f = fixture(async () => { throw new Error('Netz weg') })
  f.gaps.answer({ request: 'Buch mir ein Hotel', answer: 'Das kann ich nicht.', channel: 'live' })
  await f.advance(6000)
  assert.equal(f.reports.length, 1)
  gaps.stop()
  f.gaps.stop()
})

it('meldet nichts aus Gesprächen fremder Anrufer', async () => {
  const f = fixture()
  setCapabilityGapCollector(f.gaps)
  try {
    await withoutGapReports(async () => {
      await Promise.resolve()
      noteToolFailure({ tool: 'weather', kind: 'invalid', detail: 'ort: Pflichtfeld', userText: 'Wie wird das Wetter bei Frau Muster?' })
    })
    await f.advance(MINUTE)
    assert.deepEqual(f.reports, [])
    // Außerhalb davon gilt die Zustimmung des Besitzers wie sonst.
    noteToolFailure({ tool: 'weather', kind: 'invalid', detail: 'ort: Pflichtfeld', userText: 'Wie wird das Wetter?' })
    await f.advance(MINUTE)
    assert.equal(f.reports.length, 1)
  } finally {
    setCapabilityGapCollector(null)
  }
})
