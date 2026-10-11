import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { z } from 'zod'
import { __internals as officeInternals } from '@main/tools/impl/office'
import { __internals as homeInternals } from '@main/tools/impl/smarthome'
import { __internals as organizeInternals } from '@main/tools/impl/organize'
import { matchEntities, type HomeEntity } from '@main/smarthome/homeAssistant'
import { __internals as registryInternals } from '@main/tools/registry'
import { __internals as outlineInternals } from '@main/office/outline'

/**
 * Die Entscheidungen der neuen Werkzeuge, ohne die Werkzeuge selbst.
 *
 * Alles hier ist reine Rechnung: Aus welchem Text wird eine Zahl, welcher
 * Dienst gehört zu „Licht aus", in welchen Ordner kommt eine .heic. Genau
 * diese Stellen sind die, an denen ein Fehler nicht auffällt — er erzeugt
 * keinen Absturz, sondern eine Tabelle, in der die Summe null ergibt, oder
 * eine Lampe, die sich nicht rührt.
 */

// ─────────────────────────────────────────────────────────────

describe('Tabellenwerte aus dem Modell', () => {
  const { coerce } = officeInternals as { coerce: (raw: unknown) => unknown }

  it('macht aus deutschen Zahlen echte Zahlen', () => {
    assert.equal(coerce('1.240,50'), 1240.5)
    assert.equal(coerce('1240,50'), 1240.5)
    assert.equal(coerce('-12,5'), -12.5)
    assert.equal(coerce('1.000.000'), 1000000)
  })

  it('versteht auch die englische Schreibweise ohne Komma', () => {
    assert.equal(coerce('1240.5'), 1240.5)
    assert.equal(coerce('42'), 42)
    assert.equal(coerce('12.75'), 12.75)
    assert.equal(coerce('0.500'), 0.5)
  })

  it('liest den einen mehrdeutigen Punkt als Tausendertrenner', () => {
    // „1.234" ist deutsch eintausendzweihundertvierunddreißig. Die Form
    // entscheidet: drei Ziffern dahinter, keine Null davor.
    assert.equal(coerce('1.234'), 1234)
    assert.equal(coerce('999.000'), 999000)
    // Vier Stellen davor passen in keine Tausendergruppe — das ist ein Komma.
    assert.equal(coerce('1234.567'), 1234.567)
  })

  it('wirft Währungszeichen weg, ohne die Zahl zu verlieren', () => {
    assert.equal(coerce('€ 89,90'), 89.9)
    assert.equal(coerce('1 240,00 €'), 1240)
  })

  it('erkennt beide Datumsschreibweisen', () => {
    const iso = coerce('2026-08-11') as Date
    assert.ok(iso instanceof Date)
    assert.equal(iso.getFullYear(), 2026)
    assert.equal(iso.getMonth(), 7)
    assert.equal(iso.getDate(), 11)

    const german = coerce('11.08.2026') as Date
    assert.ok(german instanceof Date)
    assert.equal(german.getDate(), 11)
    assert.equal(german.getMonth(), 7)
  })

  it('lässt Text Text sein', () => {
    assert.equal(coerce('Miete & Strom'), 'Miete & Strom')
    // Prozentangaben bleiben Text: als Zahl gelesen wären 18 % plötzlich 18,
    // und die Spalte rechnete mit dem Achtzehnfachen.
    assert.equal(coerce('18 %'), '18 %')
    assert.equal(coerce('A1'), 'A1')
  })

  it('macht aus Leerem null und nicht die Zeichenkette', () => {
    assert.equal(coerce(''), null)
    assert.equal(coerce('   '), null)
    assert.equal(coerce(null), null)
    assert.equal(coerce(undefined), null)
  })

  it('reicht Zahlen und Wahrheitswerte unverändert durch', () => {
    assert.equal(coerce(42), 42)
    assert.equal(coerce(false), false)
  })
})

// ─────────────────────────────────────────────────────────────

describe('Smart-Home-Dienste', () => {
  const { serviceFor } = homeInternals as {
    serviceFor: (domain: string, action: 'an' | 'aus' | 'umschalten') => string | null
  }

  it('kennt die eigenen Namen der einzelnen Bereiche', () => {
    assert.equal(serviceFor('light', 'an'), 'turn_on')
    assert.equal(serviceFor('light', 'aus'), 'turn_off')
    // Ein Rollo geht auf und zu, kein turn_on.
    assert.equal(serviceFor('cover', 'an'), 'open_cover')
    assert.equal(serviceFor('cover', 'aus'), 'close_cover')
    // Ein Staubsauger startet und fährt zurück.
    assert.equal(serviceFor('vacuum', 'an'), 'start')
    assert.equal(serviceFor('vacuum', 'aus'), 'return_to_base')
    assert.equal(serviceFor('lock', 'an'), 'unlock')
    assert.equal(serviceFor('lock', 'aus'), 'lock')
  })

  it('lässt eine Szene auslösen, aber nicht ausschalten', () => {
    assert.equal(serviceFor('scene', 'an'), 'turn_on')
    assert.equal(serviceFor('scene', 'aus'), null)
    assert.equal(serviceFor('scene', 'umschalten'), null)
  })

  it('bietet Umschalten nur an, wo es das gibt', () => {
    assert.equal(serviceFor('light', 'umschalten'), 'toggle')
    assert.equal(serviceFor('vacuum', 'umschalten'), null)
  })

  it('gibt bei einem unbekannten Bereich nichts zurück statt zu raten', () => {
    assert.equal(serviceFor('sensor', 'an'), null)
    assert.equal(serviceFor('irgendwas', 'aus'), null)
  })

  it('hält Schloss, Alarm und Tor unter Verschluss', () => {
    const guarded = homeInternals.GUARDED as Set<string>
    for (const domain of ['lock', 'alarm_control_panel', 'cover']) {
      assert.ok(guarded.has(domain), `${domain} müsste gesichert sein.`)
    }
    assert.equal(guarded.has('light'), false)
  })
})

describe('Geräte über den gesprochenen Namen finden', () => {
  const entities: HomeEntity[] = [
    { entityId: 'light.wohnzimmer_decke', domain: 'light', name: 'Decke Wohnzimmer', state: 'on', unit: '' },
    { entityId: 'light.wohnzimmer_stehlampe', domain: 'light', name: 'Stehlampe Wohnzimmer', state: 'off', unit: '' },
    { entityId: 'switch.kaffee', domain: 'switch', name: 'Kaffeemaschine', state: 'off', unit: '' }
  ]

  it('nimmt die genaue Kennung, wenn sie dasteht', () => {
    const hit = matchEntities(entities, 'light.wohnzimmer_decke')
    assert.equal(hit.length, 1)
    assert.equal(hit[0].name, 'Decke Wohnzimmer')
  })

  it('findet über einen Teil des Namens', () => {
    assert.equal(matchEntities(entities, 'Kaffee').length, 1)
  })

  it('gibt bei mehreren Treffern alle zurück, statt einen zu wählen', () => {
    // Genau darauf beruht die Rückfrage im Werkzeug: Zwei Lampen im selben
    // Raum sind der Normalfall, und die falsche zu schalten fällt nicht auf.
    assert.equal(matchEntities(entities, 'wohnzimmer').length, 2)
  })

  it('findet auch bei umgestellten Wörtern', () => {
    const hit = matchEntities(entities, 'wohnzimmer stehlampe')
    assert.equal(hit.length, 1)
    assert.equal(hit[0].entityId, 'light.wohnzimmer_stehlampe')
  })

  it('erfindet nichts', () => {
    assert.equal(matchEntities(entities, 'Garage').length, 0)
    assert.equal(matchEntities(entities, '').length, 0)
  })
})

// ─────────────────────────────────────────────────────────────

describe('Aufräumen', () => {
  const { categoryByType, categoryByMonth, worthMoving, groupByCategory } = organizeInternals as {
    categoryByType: (name: string) => string
    categoryByMonth: (d: Date) => string
    worthMoving: (g: Map<string, unknown[]>, by: 'art' | 'monat') => Map<string, unknown[]>
    groupByCategory: (files: { category: string }[]) => Map<string, unknown[]>
  }

  it('sortiert nach Endung, ohne Rücksicht auf Groß- und Kleinschreibung', () => {
    assert.equal(categoryByType('urlaub.JPG'), 'Bilder')
    assert.equal(categoryByType('film.mkv'), 'Videos')
    assert.equal(categoryByType('rechnung.pdf'), 'Dokumente')
    assert.equal(categoryByType('haushalt.xlsx'), 'Tabellen')
    assert.equal(categoryByType('setup.exe'), 'Programme')
  })

  it('wirft Unbekanntes nicht in einen eigenen Ordner je Endung', () => {
    assert.equal(categoryByType('datei.qwertz'), 'Sonstiges')
    assert.equal(categoryByType('ohne-endung'), 'Sonstiges')
  })

  it('benennt Monatsordner sortierbar und lesbar zugleich', () => {
    // Die Zahl vorn, damit der Explorer richtig sortiert; der Name dahinter,
    // damit ein Mensch ihn liest.
    assert.equal(categoryByMonth(new Date(2026, 7, 11)), '2026-08 August')
    assert.equal(categoryByMonth(new Date(2026, 0, 2)), '2026-01 Januar')
  })

  it('lässt einzelne Dateien liegen, statt einen Ordner für eine anzulegen', () => {
    const groups = groupByCategory([
      { category: 'Bilder' },
      { category: 'Bilder' },
      { category: 'Schriften' }
    ])
    const kept = worthMoving(groups, 'art')
    assert.equal(kept.has('Bilder'), true)
    assert.equal(kept.has('Schriften'), false)
  })

  it('macht diese Ausnahme bei Monatsordnern nicht', () => {
    // Ein dünner Monat ist eine richtige Auskunft, keine Streuung.
    const groups = groupByCategory([{ category: '2026-08 August' }])
    assert.equal(worthMoving(groups, 'monat').size, 1)
  })
})

// ─────────────────────────────────────────────────────────────

describe('Schemata der neuen Werkzeuge', () => {
  const { zodToJsonSchema } = registryInternals

  it('übersetzt verschachtelte Listen, wie die Tabellenzeilen sie brauchen', () => {
    // `rows: string[][]` ist die Form, in der document_write und
    // spreadsheet_create ihre Zeilen entgegennehmen. Fiele die innere Liste
    // beim Übersetzen auf `string` zusammen, käme jede Zeile als eine einzige
    // Zelle an.
    const schema = zodToJsonSchema(z.array(z.array(z.string())))
    assert.equal(schema.type, 'array')
    assert.equal(schema.items?.type, 'array')
    assert.equal(schema.items?.items?.type, 'string')
  })

  it('behält bei Listen von Objekten die Felder', () => {
    const schema = zodToJsonSchema(
      z.array(z.object({ title: z.string(), bullets: z.array(z.string()) }))
    )
    assert.equal(schema.items?.type, 'object')
    assert.equal(schema.items?.properties?.title.type, 'string')
    assert.equal(schema.items?.properties?.bullets.type, 'array')
    // Beide Felder sind Pflicht — keines ist optional deklariert.
    assert.deepEqual(schema.items?.required, ['title', 'bullets'])
  })
})

// ─────────────────────────────────────────────────────────────

describe('Entwürfe aus dem Modell lesen', () => {
  const { parseJson, asStringArray } = outlineInternals as {
    parseJson: (text: string) => unknown
    asStringArray: (value: unknown, limit: number) => string[]
  }

  it('schält JSON aus einem Codezaun', () => {
    const parsed = parseJson('```json\n{"a":1}\n```') as { a: number }
    assert.equal(parsed.a, 1)
  })

  it('findet es auch hinter einem einleitenden Satz', () => {
    // Genau das tun Modelle, wenn man ihnen sagt, sie sollen es nicht tun.
    const parsed = parseJson('Klar, hier ist die Gliederung:\n{"title":"X"}\nViel Erfolg!') as {
      title: string
    }
    assert.equal(parsed.title, 'X')
  })

  it('sagt es deutlich, wenn gar kein JSON kam', () => {
    assert.throws(() => parseJson('Dazu fällt mir nichts ein.'), /nicht als JSON/)
    assert.throws(() => parseJson('{kaputt'), /nicht als JSON|kein gültiges/)
  })

  it('putzt Listen und begrenzt ihre Länge', () => {
    assert.deepEqual(asStringArray(['a', '', '  b  ', null], 10), ['a', 'b'])
    assert.equal(asStringArray(Array(50).fill('x'), 8).length, 8)
    assert.deepEqual(asStringArray('kein Feld', 5), [])
  })
})
