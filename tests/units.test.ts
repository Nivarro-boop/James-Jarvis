import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { __internals } from '@main/tools/impl/utility'

/**
 * Der Einheitenrechner.
 *
 * Der Grund für diese Datei steht in der ersten Gruppe: Kilogramm, Meter,
 * Liter, Quadratmeter und km/h haben alle den Faktor 1 auf ihre jeweils eigene
 * Basis. Ohne Dimensionsprüfung rechnete „5 Kilo in Meter" also glatt durch
 * und ergab 5 — kein Fehler, keine Auffälligkeit, eine falsche Auskunft.
 *
 * Gesprochen ist das die schlimmste Sorte Fehler: Es steht kein Ergebnis auf
 * einem Schirm, an dem der Unsinn auffiele. Und `unit_convert` steht auf der
 * Liste der Werkzeuge, die am Telefon erlaubt sind.
 */

const { convertUnit } = __internals as unknown as {
  convertUnit: (value: number, from: string, to: string) => number
}

/** Auf vier signifikante Stellen — Umrechnungsfaktoren sind selbst gerundet. */
function assertClose(actual: number, expected: number, label: string): void {
  const tolerance = Math.abs(expected) * 1e-4 + 1e-9
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual}, erwartet ${expected}`
  )
}

describe('convertUnit', () => {
  describe('weist Einheiten verschiedener Dimensionen ab', () => {
    const nonsense: [string, string][] = [
      ['kg', 'm'],
      ['l', 'm'],
      ['m2', 'kg'],
      ['km/h', 'liter'],
      ['gramm', 'ml'],
      ['celsius', 'meter'],
      ['hektar', 'liter']
    ]

    for (const [from, to] of nonsense) {
      it(`${from} → ${to}`, () => {
        assert.throws(() => convertUnit(5, from, to), /lässt sich nicht/)
      })
    }
  })

  it('kennt eine erfundene Einheit nicht', () => {
    assert.throws(() => convertUnit(1, 'furlong', 'm'), /kenne die Einheit/)
  })

  describe('Temperatur, mit Offset in beide Richtungen', () => {
    const cases: [number, string, string, number][] = [
      [100, 'fahrenheit', 'celsius', 37.7778],
      [0, 'celsius', 'fahrenheit', 32],
      [212, 'f', 'c', 100],
      // Der einzige Punkt, an dem beide Skalen zusammenfallen — er fällt auf,
      // sobald Faktor und Offset in der falschen Reihenfolge stehen.
      [-40, 'celsius', 'fahrenheit', -40],
      [0, 'celsius', 'kelvin', 273.15],
      [300, 'kelvin', 'celsius', 26.85],
      [32, 'fahrenheit', 'kelvin', 273.15]
    ]

    for (const [value, from, to, expected] of cases) {
      it(`${value} ${from} → ${to}`, () => {
        assertClose(convertUnit(value, from, to), expected, `${value} ${from} → ${to}`)
      })
    }
  })

  describe('die alltäglichen Umrechnungen', () => {
    const cases: [number, string, string, number][] = [
      [5, 'meilen', 'km', 8.0467],
      [1, 'kg', 'lbs', 2.20462],
      [100, 'mph', 'km/h', 160.934],
      [1, 'gallone', 'liter', 3.78541],
      [1, 'hektar', 'm2', 10000],
      [6, 'ft', 'cm', 182.88],
      [1, 'km', 'meter', 1000],
      [2, 'tonne', 'kg', 2000],
      [1, 'zoll', 'mm', 25.4],
      [1, 'knoten', 'km/h', 1.852],
      [1, 'm/s', 'km/h', 3.6],
      [500, 'gramm', 'kg', 0.5]
    ]

    for (const [value, from, to, expected] of cases) {
      it(`${value} ${from} → ${to}`, () => {
        assertClose(convertUnit(value, from, to), expected, `${value} ${from} → ${to}`)
      })
    }
  })

  it('ist in sich umkehrbar', () => {
    // Hin und zurück muss denselben Wert ergeben. Fängt einen vertauschten
    // Faktor, den eine einzelne Richtung durchgehen ließe.
    for (const [from, to] of [
      ['kg', 'lbs'],
      ['celsius', 'fahrenheit'],
      ['meilen', 'km'],
      ['liter', 'gallone']
    ]) {
      const there = convertUnit(7, from, to)
      assertClose(convertUnit(there, to, from), 7, `${from} → ${to} → ${from}`)
    }
  })

  it('ignoriert Groß- und Kleinschreibung und Leerzeichen', () => {
    assertClose(convertUnit(1, ' KG ', 'Gramm'), 1000, 'KG → Gramm')
  })
})
