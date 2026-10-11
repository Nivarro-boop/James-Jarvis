import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { classifyLogEntry } from '@main/selfheal/monitor'
import { healthReport } from '@main/selfheal'
import { redactLogText } from '@main/logging'
import {
  closeDb,
  initDb,
  insertIncident,
  openIncidents,
  updateIncidentOutcome
} from '@main/db'

describe('Automatische Fehlererkennung', () => {
  it('erhält den Anbieter bei Renderer-Fehlern und erkennt fehlende Weckwortmodelle', () => {
    const realtime = classifyLogEntry({ ts: 1, level: 'error', text: '[renderer:error] (crystal.js:42) [realtime] Socket-Fehler' })
    assert.equal(realtime?.area, 'live')
    assert.equal(realtime?.code, 'realtime-fehler')
    const wake = classifyLogEntry({ ts: 1, level: 'warn', text: '[renderer:warn] (crystal.js:43) [wakeword] Modelldateien fehlen: jarvis.onnx' })
    assert.equal(wake?.area, 'live')
    assert.equal(wake?.code, 'wakeword-fehler')
  })

  it('ordnet Fehler von Gemini und OpenAI ihren Bereichen zu', () => {
    const gemini = classifyLogEntry({ ts: 1, level: 'error', text: '[gemini] Kontingent aufgebraucht' })
    assert.equal(gemini?.area, 'gemini')
    assert.equal(gemini?.code, 'gemini-fehler')

    const openai = classifyLogEntry({ ts: 1, level: 'error', text: '[openai] Socket geschlossen' })
    assert.equal(openai?.area, 'live')
    assert.equal(openai?.code, 'openai-fehler')
  })
  it('entfernt Zugangsdaten vor Log und Störungsdatenbank', () => {
    const cleaned = redactLogText('Fehler mit sk-abcdefghijklmnopqrstuvwxyz123456')
    assert.equal(cleaned.includes('abcdefghijklmnopqrstuvwxyz'), false)
    assert.match(cleaned, /entfernt/)
  })

  it('erkennt einen abgestürzten Renderer als reparierbare Störung', () => {
    const incident = classifyLogEntry({
      ts: Date.now(),
      level: 'error',
      text: '[renderer] Prozess beendet: crashed 1'
    })

    assert.equal(incident?.area, 'live')
    assert.equal(incident?.code, 'renderer-beendet')
  })

  it('ordnet einen belegten Begleiter-Port dem richtigen Dienst zu', () => {
    const incident = classifyLogEntry({
      ts: Date.now(),
      level: 'warn',
      text: '[companion] Port 8788 ist belegt: EADDRINUSE'
    })

    assert.equal(incident?.area, 'fernbedienung')
    assert.equal(incident?.code, 'port-belegt')
  })

  it('erkennt beendete lokale Sprachdienste', () => {
    const incident = classifyLogEntry({
      ts: Date.now(),
      level: 'warn',
      text: '[piper] beendet (Code 1)'
    })

    assert.equal(incident?.area, 'stimme')
    assert.equal(incident?.code, 'piper-beendet')
  })

  it('macht aus erfolgreichen Schutzmaßnahmen keinen Defekt', () => {
    assert.equal(
      classifyLogEntry({
        ts: Date.now(),
        level: 'warn',
        text: '[telefonie] Eingehender Anruf ohne gültige Unterschrift abgewiesen.'
      }),
      null
    )
  })

  it('ignoriert sein eigenes Protokoll und verhindert so Rückkopplungen', () => {
    assert.equal(
      classifyLogEntry({
        ts: Date.now(),
        level: 'error',
        text: '[selbstheilung] Ein Gegenmittel ist selbst gescheitert.'
      }),
      null
    )
  })

  it('macht aus einer Node-Veraltungswarnung keinen Systemdefekt', () => {
    assert.equal(
      classifyLogEntry({
        ts: Date.now(),
        level: 'error',
        text:
          '(node:16956) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.'
      }),
      null
    )
  })
})

describe('Offene Störungen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'void-jarvis-selfheal-'))
  const previousTemp = process.env.TEMP
  process.env.TEMP = dir
  initDb()

  after(() => {
    closeDb()
    process.env.TEMP = previousTemp
    rmSync(dir, { recursive: true, force: true })
  })

  it('schließt einen alten Fehler, sobald die spätere Reparatur gelingt', () => {
    insertIncident({
      area: 'system',
      code: 'probe',
      fingerprint: 'system:probe',
      message: 'zuerst fehlgeschlagen',
      context: null,
      remedy: null,
      healed: null
    })
    const healedId = insertIncident({
      area: 'system',
      code: 'probe',
      fingerprint: 'system:probe',
      message: 'erneut geprüft',
      context: null,
      remedy: null,
      healed: null
    })
    updateIncidentOutcome(healedId, 'probe-reparatur', true)

    assert.equal(openIncidents(0).some((incident) => incident.fingerprint === 'system:probe'), false)
  })

  it('zeigt einen neuen Rückfall nach einer früheren Reparatur wieder offen', () => {
    const healedId = insertIncident({
      area: 'system',
      code: 'rueckfall',
      fingerprint: 'system:rueckfall',
      message: 'behoben',
      context: null,
      remedy: null,
      healed: null
    })
    updateIncidentOutcome(healedId, 'probe-reparatur', true)
    insertIncident({
      area: 'system',
      code: 'rueckfall',
      fingerprint: 'system:rueckfall',
      message: 'wieder da',
      context: null,
      remedy: null,
      healed: null
    })

    const incident = openIncidents(0).find((row) => row.fingerprint === 'system:rueckfall')
    assert.equal(incident?.message, 'wieder da')
    assert.equal(incident?.count, 2)
  })

  it('blendet bereits gespeicherte Node-Veraltungswarnungen aus', () => {
    insertIncident({
      area: 'system',
      code: 'system-fehler',
      fingerprint: 'system:system-fehler',
      message:
        '(node:16956) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.',
      context: null,
      remedy: null,
      healed: null
    })

    assert.equal(
      healthReport().problems.some((incident) => incident.code === 'system-fehler'),
      false
    )
  })
})
