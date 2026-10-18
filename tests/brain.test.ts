import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildGraph,
  findConflicts,
  freeSlots,
  parseProject,
  planTasks,
  renderProject,
  searchNotes,
  slugify,
  tidyFindings,
  type Project
} from '../src/shared/brain'
import { personaPreviewText, personalityBlock } from '../src/shared/prompts/system.de'

const h = (hour: number, minute = 0): number => Date.UTC(2026, 9, 18, hour, minute)

describe('Gehirn: Kalenderrechnung', () => {
  it('findet Überschneidungen und ignoriert ganztägige Termine', () => {
    const conflicts = findConflicts([
      { title: 'A', start: h(9), end: h(10) },
      { title: 'B', start: h(9, 30), end: h(11) },
      { title: 'C', start: h(11), end: h(12) },
      { title: 'Urlaub', start: h(0), end: h(23), allDay: true }
    ])
    assert.deepEqual(conflicts.map((c) => [c.a, c.b]), [['A', 'B']])
  })

  it('rechnet freie Zeiten und verteilt Aufgaben, ohne etwas zu streichen', () => {
    const slots = freeSlots([{ title: 'A', start: h(9), end: h(10) }], h(8), h(12))
    assert.deepEqual(slots, [{ start: h(8), end: h(9) }, { start: h(10), end: h(12) }])
    const plan = planTasks(slots, [{ title: 'Lang', minutes: 90 }, { title: 'Kurz', minutes: 30 }, { title: 'Zu lang', minutes: 300 }])
    assert.deepEqual(plan.placed.map((p) => p.title), ['Lang', 'Kurz'])
    assert.deepEqual(plan.leftover, ['Zu lang'])
  })
})

describe('Gehirn: Notizen', () => {
  it('liefert Datei und Zeile und nichts, wenn nichts passt', () => {
    const docs = [{ file: 'notizen/auto.md', text: '# Auto\n\nReifenwechsel im Oktober\nÖl ok' }]
    const hits = searchNotes(docs, 'Wann ist der Reifenwechsel?')
    assert.equal(hits[0].file, 'notizen/auto.md')
    assert.equal(hits[0].line, 3)
    assert.deepEqual(searchNotes(docs, 'Steuererklärung'), [])
  })

  it('verbindet Notizen über Verweise und Schlagworte', () => {
    const graph = buildGraph([
      { file: 'notizen/a.md', title: 'A', kind: 'notiz', text: 'siehe [[B]]' },
      { file: 'notizen/b.md', title: 'B', kind: 'notiz', text: '#garten' },
      { file: 'notizen/c.md', title: 'C', kind: 'notiz', text: 'auch #Garten' }
    ])
    assert.equal(graph.links.length, 2)
  })

  it('macht aus Umlauten lesbare Dateinamen', () => {
    assert.equal(slugify('Größe & Übung'), 'grosse-ubung')
  })
})

describe('Gehirn: Projekte', () => {
  const project: Project = {
    slug: 'garage', title: 'Garage', status: 'aktiv', updated: '2026-08-01T00:00:00.000Z', stand: 'Angebote eingeholt',
    decisions: [{ date: '2026-08-01', text: 'Holztor', reason: 'billiger' }],
    steps: [{ done: true, text: 'Maß nehmen' }, { done: false, text: 'Bestellen' }]
  }

  it('übersteht Schreiben und Lesen unverändert', () => {
    assert.deepEqual(parseProject('garage', renderProject(project)), project)
  })

  it('meldet veraltete und doppelte Projekte', () => {
    const findings = tidyFindings([project, { ...project, slug: 'garage-2', updated: new Date(h(0)).toISOString() }], h(12))
    assert.ok(findings.some((f) => f.includes('nicht angefasst')))
    assert.ok(findings.some((f) => f.includes('demselben Projekt')))
  })
})

describe('Persönlichkeit', () => {
  it('überstimmt die Anrede und nennt den Namen', () => {
    const block = personalityBlock('jarvis', { humor: 0, address: 'du', name: 'Friday' })
    assert.match(block, /Friday/)
    assert.match(block, /duzt/)
    assert.match(block, /Humor: keiner/)
  })

  it('Hörprobe folgt Anrede und Humor', () => {
    assert.match(personaPreviewText({ persona: 'jarvis', personality: { humor: 0, address: 'auto', name: 'James' } }), /Ihr Rechner/)
    assert.match(personaPreviewText({ persona: 'sachlich', personality: { humor: 3, address: 'auto', name: 'James' } }), /wetten/)
  })
})
