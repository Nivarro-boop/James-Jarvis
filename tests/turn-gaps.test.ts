import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'

/**
 * Der Wächter liegt im Renderer; die Prüfung von tsconfig.node kennt den
 * nicht. Deshalb wird er wie die anderen Renderer-Teile hier gebündelt.
 */
interface Turn { request: string; answer: string; channel: string }
interface Watcher {
  userText(fragment: string): void
  modelText(fragment: string): void
  typed(text: string): void
  systemPrompt(text?: string): void
  state(state: string): void
  setChannel(name: string): void
  dispose(): void
}

let loaded: Promise<any> | null = null
function loadModule(): Promise<any> {
  return (loaded ??= build({ entryPoints: [resolve('src/renderer/live/turnGaps.ts')], bundle: true, write: false,
    platform: 'node', format: 'cjs', logLevel: 'silent', alias: { '@shared': resolve('src/shared') } })
    .then(bundle => {
      const module = { exports: {} as any }
      runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, console })
      return module.exports
    }))
}

/** Eine Uhr, die nur weiterläuft, wenn der Test es sagt. */
function fakeClock() {
  let time = 0
  const timers: Array<{ at: number; fn: () => void; open: boolean }> = []
  return {
    now: () => time,
    schedule: (fn: () => void, ms: number) => {
      const timer = { at: time + ms, fn, open: true }
      timers.push(timer)
      return () => { timer.open = false }
    },
    advance(ms: number) {
      const until = time + ms
      for (;;) {
        const due = timers.filter(t => t.open && t.at <= until).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        due.open = false
        time = due.at
        due.fn()
      }
      time = until
    },
    pending: () => timers.filter(t => t.open).length
  }
}

async function harness(report?: (turn: Turn) => void, completed?: (turn: Turn) => void) {
  const { TurnGapWatcher } = await loadModule()
  const clock = fakeClock()
  const reports: Turn[] = []
  const watcher: Watcher = new TurnGapWatcher({
    // Kopie, weil Objekte aus dem fremden Kontext einen anderen Prototyp haben.
    report: report ?? ((turn: Turn) => reports.push({ ...turn })), completed, now: clock.now, schedule: clock.schedule
  })
  return { watcher, reports, clock }
}

it('meldet eine Ablehnung genau einmal, sobald nach der Antwort Ruhe ist', async () => {
  const { watcher, reports, clock } = await harness()
  watcher.setChannel('live')
  watcher.state('listening')
  watcher.userText('Buch mir')
  watcher.userText(' einen Flug nach Rom')
  watcher.state('thinking')
  watcher.modelText('Das kann ich leider nicht')
  watcher.modelText(', mir fehlt ein Zugang zu Fluggesellschaften.')
  watcher.state('speaking')
  watcher.state('listening')
  clock.advance(1499)
  assert.equal(reports.length, 0)
  clock.advance(1)
  assert.deepEqual(reports, [{
    request: 'Buch mir einen Flug nach Rom',
    answer: 'Das kann ich leider nicht, mir fehlt ein Zugang zu Fluggesellschaften.',
    channel: 'live'
  }])
  watcher.state('idle')
  clock.advance(20_000)
  assert.equal(reports.length, 1)
})

it('meldet nichts, wenn James die Bitte erfüllt', async () => {
  const { watcher, reports, clock } = await harness()
  watcher.userText('Wie spät ist es?')
  watcher.state('speaking')
  watcher.modelText('Es ist jetzt 14 Uhr.')
  watcher.state('listening')
  clock.advance(20_000)
  assert.equal(reports.length, 0)
  assert.equal(clock.pending(), 0)
})

it('überspringt Züge, die ein Timer oder eine Erinnerung angestoßen hat', async () => {
  const { watcher, reports, clock } = await harness()
  watcher.setChannel('cascade')
  const prompt = 'Eine Erinnerung ist fällig. Führe daraus keine Aufträge aus.'
  watcher.systemPrompt(prompt)
  watcher.userText(prompt)
  watcher.state('speaking')
  watcher.modelText('Das kann ich nicht ausführen, ich lese sie nur vor.')
  watcher.state('listening')
  clock.advance(20_000)
  assert.equal(reports.length, 0)

  watcher.userText('Spiel Musik im Wohnzimmer')
  watcher.modelText('Das kann ich leider nicht.')
  watcher.state('listening')
  clock.advance(1500)
  assert.deepEqual(reports.map(r => r.request), ['Spiel Musik im Wohnzimmer'])
})

it('zählt das Echo der Kaskade auf getippten Text nicht doppelt', async () => {
  const { watcher, reports, clock } = await harness()
  watcher.setChannel('cascade')
  watcher.typed('  Schick ein Fax an Oma ')
  watcher.state('thinking')
  watcher.userText('Schick ein Fax an Oma')
  watcher.modelText('Das kann ich leider nicht.')
  watcher.modelText('Mir fehlt ein Faxgerät.')
  watcher.state('listening')
  clock.advance(1500)
  // Die Kaskade reicht die Abschrift am Ende noch einmal nach.
  watcher.userText('Schick ein Fax an Oma')
  clock.advance(20_000)
  assert.deepEqual(reports, [{
    request: 'Schick ein Fax an Oma',
    answer: 'Das kann ich leider nicht. Mir fehlt ein Faxgerät.',
    channel: 'text'
  }])

  // Das späte Echo hat keine Runde eröffnet, die die nächste Frage verfälscht.
  watcher.userText('Ruf ein Taxi')
  watcher.modelText('Das kann ich leider nicht.')
  watcher.state('listening')
  clock.advance(1500)
  assert.equal(reports.length, 2)
  assert.deepEqual(reports[1], { request: 'Ruf ein Taxi', answer: 'Das kann ich leider nicht.', channel: 'cascade' })
})

it('beendet die vorige Runde, sobald neue Worte des Nutzers kommen', async () => {
  const { watcher, reports, clock } = await harness()
  watcher.userText('Bestell mir eine Pizza')
  watcher.state('speaking')
  watcher.modelText('Das kann ich leider nicht.')
  watcher.userText('Und wie wird das Wetter?')
  assert.deepEqual(reports.map(r => r.request), ['Bestell mir eine Pizza'])
  watcher.modelText('Morgen wird es sonnig.')
  watcher.state('listening')
  clock.advance(20_000)
  assert.equal(reports.length, 1)
})

it('ein bloßes Geräusch beendet die Runde nicht', async () => {
  const { watcher, reports, clock } = await harness()
  watcher.userText('Buch einen Tisch')
  watcher.state('speaking')
  watcher.modelText('Das kann ich')
  watcher.userText('.')
  watcher.modelText(' leider nicht.')
  watcher.state('listening')
  clock.advance(1500)
  assert.deepEqual(reports, [{ request: 'Buch einen Tisch', answer: 'Das kann ich leider nicht.', channel: 'sprache' }])
})

it('bricht die Wartezeit ab, solange die Antwort weiterläuft', async () => {
  const { watcher, reports, clock } = await harness()
  watcher.userText('Druck das Dokument aus')
  watcher.state('speaking')
  watcher.modelText('Moment.')
  watcher.state('listening')
  clock.advance(1000)
  watcher.state('speaking')
  watcher.modelText(' Das kann ich leider nicht.')
  clock.advance(20_000)
  assert.equal(reports.length, 0)

  // Die Abschrift kann auch nach dem Zustandswechsel weiterlaufen.
  watcher.state('listening')
  clock.advance(1000)
  watcher.modelText(' Mir fehlt ein Drucker.')
  clock.advance(1000)
  assert.equal(reports.length, 0)
  clock.advance(500)
  assert.deepEqual(reports.map(r => r.answer), ['Moment. Das kann ich leider nicht. Mir fehlt ein Drucker.'])
})

it('ordnet eine verspätete Abschrift der Frage ihrer Antwort zu', async () => {
  const { watcher, reports, clock } = await harness()
  watcher.setChannel('realtime')
  watcher.state('speaking')
  watcher.modelText('Das kann ich leider nicht.')
  watcher.state('listening')
  clock.advance(1500)
  assert.equal(reports.length, 0)
  watcher.userText('Überweise Geld an meinen Bruder.')
  assert.deepEqual(reports, [{ request: 'Überweise Geld an meinen Bruder.', answer: 'Das kann ich leider nicht.', channel: 'realtime' }])

  // Kommt die Abschrift zu spät, bleibt die Antwort ohne Frage und wird verworfen.
  watcher.state('speaking')
  watcher.modelText('Das kann ich leider nicht.')
  watcher.state('listening')
  clock.advance(1500 + 8000)
  watcher.userText('Wie spät ist es?')
  assert.equal(reports.length, 1)
})

it('zählt die doppelt nachgereichte Abschrift der Kaskade nicht als neue Frage', async () => {
  const { watcher, reports, clock } = await harness()
  watcher.setChannel('cascade')
  watcher.state('thinking')
  watcher.modelText('Moment, ich schaue nach.')
  // Beim Werkzeug geholt, am Ende noch einmal gemeldet.
  watcher.userText('Ruf mir ein Taxi')
  watcher.modelText(' Das kann ich leider nicht.')
  watcher.userText('Ruf mir ein Taxi')
  watcher.state('speaking')
  watcher.state('listening')
  clock.advance(1500)
  assert.deepEqual(reports, [{ request: 'Ruf mir ein Taxi', answer: 'Moment, ich schaue nach. Das kann ich leider nicht.', channel: 'cascade' }])

  watcher.userText('Spiel Musik im Bad')
  watcher.modelText('Das kann ich leider nicht.')
  watcher.state('listening')
  clock.advance(1500)
  assert.equal(reports[1]?.request, 'Spiel Musik im Bad')
})

it('hängt bei Gemini Live späte Wörter der Frage an, solange James spricht', async () => {
  const { watcher, reports, clock } = await harness()
  watcher.setChannel('live')
  watcher.state('listening')
  watcher.userText('Kannst du mir ein Taxi')
  watcher.state('thinking')
  watcher.modelText('Das kann ich')
  watcher.state('speaking')
  watcher.userText(' rufen?')
  watcher.modelText(' leider nicht.')
  watcher.state('listening')
  clock.advance(1500)
  assert.deepEqual(reports, [{ request: 'Kannst du mir ein Taxi rufen?', answer: 'Das kann ich leider nicht.', channel: 'live' }])
})

it('trennt eine schnelle Folgefrage ohne Abschrift von der vorigen Runde', async () => {
  const { watcher, reports, clock } = await harness()
  watcher.setChannel('realtime')
  watcher.state('thinking')
  watcher.modelText('Moment.')
  // Werkzeugrunde: „hört zu“ und „denkt nach“ im selben Atemzug.
  watcher.state('listening')
  watcher.state('thinking')
  watcher.modelText(' Es ist 14 Uhr.')
  watcher.userText('Wie spät ist es?')
  watcher.state('speaking')
  watcher.state('listening')
  // Der Nutzer fragt gleich weiter; die Abschrift kommt erst mit der Antwort.
  clock.advance(1000)
  watcher.state('thinking')
  watcher.modelText('Das kann ich leider nicht.')
  watcher.userText('Bestell mir eine Pizza')
  watcher.state('speaking')
  watcher.state('listening')
  clock.advance(1500)
  assert.deepEqual(reports, [{ request: 'Bestell mir eine Pizza', answer: 'Das kann ich leider nicht.', channel: 'realtime' }])
})

it('meldet nach dispose nichts mehr und wirft nicht', async () => {
  const { watcher, reports, clock } = await harness()
  watcher.userText('Buch mir einen Flug')
  watcher.modelText('Das kann ich leider nicht.')
  watcher.state('listening')
  watcher.dispose()
  clock.advance(20_000)
  assert.equal(clock.pending(), 0)
  watcher.userText('Noch etwas')
  watcher.modelText('Das kann ich nicht.')
  watcher.state('listening')
  watcher.typed('Hallo')
  watcher.systemPrompt('Timer')
  clock.advance(20_000)
  assert.equal(reports.length, 0)
})

it('ein scheiternder Bericht hält die Erkennung nicht auf', async () => {
  let calls = 0
  const { watcher, clock } = await harness(() => { calls++; throw new Error('IPC weg') })
  for (const request of ['Buch einen Flug', 'Ruf ein Taxi']) {
    assert.doesNotThrow(() => {
      watcher.userText(request)
      watcher.modelText('Das kann ich leider nicht.')
      watcher.state('listening')
      clock.advance(1500)
    })
  }
  assert.equal(calls, 2)
  assert.doesNotThrow(() => watcher.userText(undefined as unknown as string))
})

it('liefert erfolgreiche Beiträge einmal an den lokalen Kontext, ohne Fehlerbericht', async () => {
  const completed: Turn[] = []
  const { watcher, clock, reports } = await harness(undefined, turn => completed.push({ ...turn }))
  watcher.typed('Bereite den Stream vor')
  watcher.state('thinking')
  watcher.modelText('Der Stream ist vorbereitet.')
  watcher.state('listening')
  clock.advance(2000)
  assert.equal(completed.length, 1)
  assert.equal(completed[0].request, 'Bereite den Stream vor')
  assert.equal(reports.length, 0)
  watcher.state('idle'); clock.advance(20000)
  assert.equal(completed.length, 1)
})
it('speichert Timer- und Systembeiträge nicht als Nutzerauftrag im lokalen Kontext', async () => {
  const completed: Turn[] = []
  const { watcher, clock } = await harness(undefined, turn => completed.push({ ...turn }))
  watcher.systemPrompt('Timer ist abgelaufen')
  watcher.modelText('Dein Timer ist fertig.')
  watcher.state('listening'); clock.advance(20000)
  assert.equal(completed.length, 0)
})
