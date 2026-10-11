import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describeError } from '@shared/errorText'
import { createStateGate } from '@shared/stateGate'
import { registerRemedy, report } from '@main/selfheal'
import { reportConfiguration } from '@main/selfheal/monitor'
import { friendlyTwilioError } from '@main/providers/twilio'
import { closeDb, countIncidents, initDb, openIncidents } from '@main/db'

describe('Fehlertext ohne Lücken', () => {
  it('nimmt den Namen, wenn die DOMException keinen Text hat', () => {
    // Genau der Fall aus dem Protokoll: „Mikrofon nicht verfügbar:“ und nichts dahinter.
    const empty = Object.assign(new Error(''), { name: 'NotAllowedError' })
    assert.equal(describeError(empty), 'NotAllowedError')
  })

  it('verbindet Name und Text, ohne den Namen doppelt zu schreiben', () => {
    const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })
    assert.equal(describeError(denied), 'NotAllowedError: Permission denied')
    const wrapped = new Error('NotFoundError: Requested device not found')
    assert.equal(describeError(wrapped), 'NotFoundError: Requested device not found')
  })

  it('nennt bei OverconstrainedError die betroffene Eigenschaft', () => {
    const constrained = Object.assign(new Error(''), { name: 'OverconstrainedError', constraint: 'deviceId' })
    assert.equal(describeError(constrained), 'OverconstrainedError (deviceId)')
  })

  it('fällt nur auf den Ersatztext zurück, wenn wirklich nichts da ist', () => {
    assert.equal(describeError(undefined, 'ohne Angabe'), 'ohne Angabe')
    assert.equal(describeError('   ', 'ohne Angabe'), 'ohne Angabe')
    assert.equal(describeError({}, 'ohne Angabe'), 'ohne Angabe')
    assert.equal(describeError(new Error(''), 'ohne Angabe'), 'ohne Angabe')
    assert.equal(describeError('kaputt'), 'kaputt')
    assert.equal(describeError(42), '42')
  })
})

describe('Zustand nur einmal melden', () => {
  it('schweigt bei gleichem Zustand, meldet bei neuem und nach Ablauf der Frist', () => {
    let now = 0
    const gate = createStateGate(1000, () => now)
    assert.equal(gate.changed('eleven', 'kein Schlüssel'), true)
    assert.equal(gate.changed('eleven', 'kein Schlüssel'), false)
    now = 500
    assert.equal(gate.changed('eleven', 'kein Schlüssel'), false)
    assert.equal(gate.changed('eleven', 'Kontingent leer'), true)
    now = 1600
    assert.equal(gate.changed('eleven', 'Kontingent leer'), true)
  })

  it('meldet nach forget und clear wieder, und trennt die Schlüssel', () => {
    const gate = createStateGate(1000, () => 0)
    assert.equal(gate.changed('a', 'x'), true)
    assert.equal(gate.changed('b', 'x'), true)
    gate.forget('a')
    assert.equal(gate.changed('a', 'x'), true)
    gate.clear()
    assert.equal(gate.changed('b', 'x'), true)
  })
})

describe('Twilio-Zugangsfehler', () => {
  it('übersetzt „The authorization with Key failed“ ohne Fehlernummer', () => {
    const text = friendlyTwilioError({ message: 'The authorization with Key failed' }, 401)
    assert.match(text, /lehnt die Zugangsdaten ab/)
    assert.match(text, /API-Key-SID/)
  })

  it('lässt andere Fehlernummern unberührt', () => {
    assert.match(friendlyTwilioError({ code: 21211 }, 400), /ungültig/)
    assert.equal(friendlyTwilioError({ message: 'Etwas anderes' }, 500), 'Etwas anderes')
  })
})

describe('Selbstheilung ohne Wiederholungslärm', () => {
  const dir = mkdtempSync(join(tmpdir(), 'void-jarvis-quiet-'))
  const previousTemp = process.env.TEMP
  process.env.TEMP = dir
  initDb()
  after(() => {
    closeDb()
    process.env.TEMP = previousTemp
    rmSync(dir, { recursive: true, force: true })
  })

  /** Fängt `console.warn`, solange `run` läuft. */
  async function warnings(run: () => Promise<void>): Promise<string[]> {
    const lines: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    try {
      await run()
    } finally {
      console.warn = original
    }
    return lines
  }

  it('meldet eine fehlende Voraussetzung nur einmal, solange sie offen ist', async () => {
    for (let i = 0; i < 5; i++) {
      await reportConfiguration('stimme', 'piper-nicht-bereit', false, 'piper.exe fehlt')
    }
    assert.equal(countIncidents('stimme:piper-nicht-bereit', 0), 1)
  })

  it('schließt die offene Störung, sobald die Voraussetzung da ist', async () => {
    assert.ok(openIncidents(0).some((i) => i.code === 'piper-nicht-bereit'))
    await reportConfiguration('stimme', 'piper-nicht-bereit', true, '')
    assert.equal(openIncidents(0).some((i) => i.code === 'piper-nicht-bereit'), false)
    // Ein Rückfall ist wieder eine Meldung wert.
    await reportConfiguration('stimme', 'piper-nicht-bereit', false, 'piper.exe fehlt wieder')
    assert.equal(openIncidents(0).some((i) => i.code === 'piper-nicht-bereit'), true)
  })

  it('lässt dem Gegenmittel nach Ablauf der Frist genau einen neuen Anlauf', async () => {
    const options = { retryAfterMs: 60 * 60 * 1000 }
    const before = countIncidents('stimme:whisper-nicht-bereit', 0)
    await reportConfiguration('stimme', 'whisper-nicht-bereit', false, 'fehlt', { ...options, now: 1_000 })
    assert.equal(countIncidents('stimme:whisper-nicht-bereit', 0), before + 1)
    // Noch innerhalb der Frist: still. `now` liegt zur Stunde der Meldung nahe.
    await reportConfiguration('stimme', 'whisper-nicht-bereit', false, 'fehlt', { ...options, now: Date.now() })
    assert.equal(countIncidents('stimme:whisper-nicht-bereit', 0), before + 1)
    // Eine Stunde später darf es wieder.
    await reportConfiguration('stimme', 'whisper-nicht-bereit', false, 'fehlt', {
      ...options,
      now: Date.now() + 2 * 60 * 60 * 1000
    })
    assert.equal(countIncidents('stimme:whisper-nicht-bereit', 0), before + 2)
  })

  it('schreibt „greift nicht mehr“ nur beim ersten Mal ins Protokoll', async () => {
    registerRemedy({
      name: 'ruhe-test-mittel',
      maxPerHour: 0,
      applies: (i) => i.code === 'ruhe-test-stoerung',
      apply: async () => false,
      describe: () => 'test'
    })
    const lines = await warnings(async () => {
      for (let i = 0; i < 4; i++) {
        await report({ area: 'stimme', code: 'ruhe-test-stoerung', message: 'kaputt' })
      }
    })
    assert.equal(lines.filter((l) => l.includes('greift nicht mehr')).length, 1)
    // Die Störung selbst wird trotzdem jedes Mal gezählt.
    assert.equal(countIncidents('stimme:ruhe-test-stoerung', 0), 4)
  })

  it('schreibt „kein Gegenmittel“ nur einmal je Wortlaut', async () => {
    const lines = await warnings(async () => {
      await report({ area: 'live', code: 'ruhe-ohne-mittel', message: 'Erste Meldung' })
      await report({ area: 'live', code: 'ruhe-ohne-mittel', message: 'Erste Meldung' })
      await report({ area: 'live', code: 'ruhe-ohne-mittel', message: 'Andere Meldung' })
    })
    assert.equal(lines.filter((l) => l.includes('kein Gegenmittel')).length, 2)
  })
})
