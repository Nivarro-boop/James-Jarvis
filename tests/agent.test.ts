import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseSkill, serializeSkill, skillSlug } from '@main/agent/skills'
import { similarGroups } from '@main/agent/memoryCare'
import { describeTool } from '@main/agent/activity'

describe('Fertigkeiten', () => {
  it('liest zurück, was geschrieben wurde', () => {
    const skill = {
      name: 'Stream vorbereiten',
      description: 'Vor dem Livegehen: OBS, Szene, Titel.',
      steps: '1. obs_start\n2. Szene "Start" wählen\n3. Titel setzen',
      source: 'auto' as const,
      uses: 3,
      updated: '2026-10-01'
    }
    deepStrictEqual(parseSkill('stream-vorbereiten', serializeSkill(skill)), { slug: 'stream-vorbereiten', ...skill })
  })

  it('hält mehrzeilige Kopfwerte einzeilig, damit der Kopf nicht zerbricht', () => {
    const text = serializeSkill({
      name: 'A\nB',
      description: 'eins\r\nzwei',
      steps: 'x',
      source: 'manual',
      uses: 0,
      updated: ''
    })
    const parsed = parseSkill('a', text)
    strictEqual(parsed?.name, 'A B')
    strictEqual(parsed?.description, 'eins zwei')
  })

  it('macht aus Namen sichere Dateinamen', () => {
    strictEqual(skillSlug('Rechnung ablegen (Größe XL)'), 'rechnung-ablegen-groesse-xl')
    strictEqual(skillSlug('../../etc'), 'etc')
    strictEqual(skillSlug('!!!'), 'fertigkeit')
  })

  it('ignoriert Dateien ohne Kopf', () => {
    strictEqual(parseSkill('x', 'nur Text'), null)
  })
})

describe('Gedächtnis-Pflege', () => {
  const v = (...xs: number[]): Float32Array => new Float32Array(xs)

  it('gruppiert nur, was sich wirklich ähnelt', () => {
    const groups = similarGroups([
      { id: 1, text: 'Void streamt dienstags', embedding: v(1, 0, 0) },
      { id: 2, text: 'Dienstag ist Streamtag', embedding: v(0.99, 0.05, 0) },
      { id: 3, text: 'Lieblingsfarbe Blau', embedding: v(0, 1, 0) },
      { id: 4, text: 'ohne Vektor', embedding: null }
    ])
    deepStrictEqual(
      groups.map((g) => g.map((r) => r.id)),
      [[1, 2]]
    )
  })
})

describe('Live-Anzeige', () => {
  it('beschreibt Werkzeuge lesbar mit dem wichtigsten Argument', () => {
    strictEqual(
      describeTool('mcp_playwright_browser_navigate', { url: 'https://playwright.dev' }),
      'playwright: browser navigate — https://playwright.dev'
    )
    strictEqual(describeTool('web_search', { query: 'Wetter Wien' }), 'web search — Wetter Wien')
    ok(describeTool('x', { text: 'a'.repeat(200) }).endsWith('…'))
  })
})

describe('Schnelle Bildschirmsteuerung', async () => {
  const { appFromTitle, resolveStep, routineKey } = await import('@main/agent/desktopAgent')
  const tree = {
    fenster: 'Einstellungen - NoRisk Launcher',
    gefunden: 3,
    gezeigt: 3,
    elemente: [
      { ref: 1, rolle: 'Button', name: 'Speichern', kann: ['Invoke'] },
      { ref: 2, rolle: 'Edit', name: 'Name', kann: ['Value'] },
      { ref: 3, rolle: 'CheckBox', name: 'Speichern', kann: ['Toggle'] }
    ]
  }

  it('zählt die Knöpfe der Titelleiste nicht als Bedienbaum', async () => {
    const { actionable } = await import('@main/agent/desktopAgent')
    const leer = {
      ...tree,
      elemente: [
        { ref: 1, rolle: 'Button', name: 'Minimieren', kann: ['Invoke'] },
        { ref: 2, rolle: 'Button', name: 'Wieder\u00adher\u00adstellen', kann: ['Invoke'] },
        { ref: 3, rolle: 'Button', name: 'Schließen', kann: ['Invoke'] }
      ]
    }
    strictEqual(actionable(leer).length, 0)
    strictEqual(actionable(tree).length, 3)
  })

  it('merkt sich das Programm, nicht das Dokument', () => {
    strictEqual(appFromTitle('Rechnung März.docx - Word'), 'word')
    strictEqual(appFromTitle('Einstellungen — NoRisk Launcher'), 'norisk launcher')
  })

  it('erkennt dieselbe Aufgabe trotz Füllwörtern und Zahlen wieder', () => {
    strictEqual(routineKey('Mach bitte den Dunkelmodus an 2', 'Word'), routineKey('Dunkelmodus an, mach', 'word'))
    ok(routineKey('Dunkelmodus an', 'word') !== routineKey('Dunkelmodus an', 'excel'))
  })

  it('findet gespeicherte Schritte über Rolle und Namen wieder', () => {
    deepStrictEqual(resolveStep({ do: 'toggle', rolle: 'CheckBox', name: 'Speichern' }, tree), { do: 'toggle', ref: 3 })
    deepStrictEqual(resolveStep({ do: 'write', rolle: 'Edit', name: 'Name', text: 'Void' }, tree), { do: 'write', ref: 2, text: 'Void' })
    strictEqual(resolveStep({ do: 'press', rolle: 'Button', name: 'Abbrechen' }, tree), null)
    deepStrictEqual(resolveStep({ do: 'keys', keys: 'strg+s' }, tree), { do: 'keys', keys: 'strg+s' })
  })
})
