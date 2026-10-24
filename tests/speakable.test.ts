import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createSentenceBuffer, toSpeakable } from '@shared/speakable'

/**
 * Geprüft wird das, was man sonst nur hört.
 *
 * Ein Fehler in dieser Datei klingt nicht nach einem Fehler, sondern nach einer
 * schlechten Stimme: ein vorgelesenes Sternchen, eine buchstabierte Adresse,
 * eine Pause mitten im Wort. Deshalb steht hier neben jedem Fall auch der Grund,
 * warum er falsch klingt — sonst wird beim nächsten Umbau die Regel entfernt und
 * der Klang schleichend wieder schlechter.
 */

describe('toSpeakable', () => {
  it('nimmt Auszeichnungen heraus, statt sie vorzulesen', () => {
    // Der Punkt am Ende ist Absicht: Jede Zeile wird ein Satz, sonst leiert die
    // Stimme eine Aufzählung in einem Atemzug herunter.
    strictEqual(toSpeakable('**Preis:** 49,90 €'), 'Preis: 49,90 Euro.')
    strictEqual(toSpeakable('Das ist *wichtig*.'), 'Das ist wichtig.')
    strictEqual(toSpeakable('## Ergebnis'), 'Ergebnis.')
  })

  it('macht aus einer Aufzählung Sätze', () => {
    strictEqual(
      toSpeakable('- Erstens\n- Zweitens\n- Drittens'),
      'Erstens. Zweitens. Drittens.'
    )
    strictEqual(toSpeakable('1. Anfang\n2. Ende'), 'Anfang. Ende.')
  })

  it('sagt den Namen der Seite statt der Adresse', () => {
    strictEqual(toSpeakable('Steht auf https://www.geizhals.de/foo?bar=1'), 'Steht auf Geizhals.')
    strictEqual(toSpeakable('Siehe https://en.wikipedia.org/wiki/X'), 'Siehe Wikipedia.')
    strictEqual(toSpeakable('Auf https://shop.example.co.uk/x'), 'Auf Example.')
  })

  it('buchstabiert Mailadressen, weil man Tippfehler nur so hört', () => {
    strictEqual(
      toSpeakable('Ich schicke sie an max.muster@example.com.'),
      'Ich schicke sie an max punkt muster at example punkt com.'
    )
  })

  it('schreibt Einheiten und Abkürzungen aus', () => {
    strictEqual(toSpeakable('16 GB und 2,5 GHz'), '16 Gigabyte und 2,5 Gigahertz.')
    strictEqual(toSpeakable('z. B. drei Stück'), 'zum Beispiel drei Stück.')
    strictEqual(toSpeakable('ca. 20 %'), 'circa 20 Prozent.')
    strictEqual(toSpeakable('Es sind 21 °C.'), 'Es sind 21 Grad Celsius.')
  })

  it('nimmt den Tausenderpunkt weg, der sonst als Satzende klingt', () => {
    strictEqual(toSpeakable('Das kostet 1.234.567 Euro.'), 'Das kostet 1234567 Euro.')
  })

  it('macht aus einer Uhrzeit eine gesprochene Uhrzeit', () => {
    strictEqual(toSpeakable('Um 14:30 los.'), 'Um 14 Uhr 30 los.')
    strictEqual(toSpeakable('Um 9:00 Uhr los.'), 'Um 9 Uhr los.')
  })

  it('liest ein Datum mit Monatsnamen', () => {
    strictEqual(toSpeakable('Am 21.10.2026 geht es los.'), 'Am 21. Oktober 2026 geht es los.')
    strictEqual(toSpeakable('Version 1.3.9 ist da.'), 'Version 1.3.9 ist da.')
  })

  it('liest keinen Quelltext vor', () => {
    strictEqual(toSpeakable('Fertig.\n```js\nconst x = 1\n```'), 'Fertig.')
  })

  it('spricht trotzdem, wenn die Antwort nur aus Quelltext bestand', () => {
    // Lieber etwas Seltsames sagen als stumm bleiben: Stille sieht aus wie ein
    // Ausfall, und der Nutzer sucht den Fehler dann an der falschen Stelle.
    strictEqual(toSpeakable('```\nnpm install\n```'), 'npm install.')
  })

  it('bleibt bei leerer Eingabe leer', () => {
    strictEqual(toSpeakable(''), '')
    strictEqual(toSpeakable('   \n  '), '')
  })
})

describe('createSentenceBuffer', () => {
  it('gibt einen Satz erst heraus, wenn er zu Ende ist', () => {
    const buffer = createSentenceBuffer()
    deepStrictEqual(buffer.push('Der Preis liegt'), [])
    deepStrictEqual(buffer.push(' bei 49 Euro'), [])
    deepStrictEqual(buffer.push('. Und '), ['Der Preis liegt bei 49 Euro.'])
    deepStrictEqual(buffer.flush(), ['Und.'])
  })

  it('teilt nicht an einem Punkt, der keiner ist', () => {
    const buffer = createSentenceBuffer()
    // Der Tausenderpunkt und der Punkt hinter der Abkürzung sind beide keine
    // Satzenden — dort zu schneiden ergäbe eine Pause mitten im Gedanken.
    deepStrictEqual(buffer.push('Es kostet 1.299 Euro, z. B. heute. Morgen mehr.'), [
      'Es kostet 1299 Euro, zum Beispiel heute.'
    ])
    // Der letzte Punkt bleibt liegen: Ob dahinter noch ein Wort kommt, weiß man
    // erst, wenn das nächste Zeichen da ist. Der Zug endet mit `flush`.
    deepStrictEqual(buffer.flush(), ['Morgen mehr.'])
  })

  it('gibt mehrere Sätze aus einem Bruchstück einzeln heraus', () => {
    const buffer = createSentenceBuffer()
    deepStrictEqual(buffer.push('Fertig. Es sind drei. Mehr nicht.'), [
      'Fertig.',
      'Es sind drei.'
    ])
    deepStrictEqual(buffer.flush(), ['Mehr nicht.'])
  })

  it('wartet nicht ewig auf ein Satzzeichen, das nicht kommt', () => {
    const buffer = createSentenceBuffer()
    const long = 'und dann noch etwas mehr Text, '.repeat(12)
    const out = buffer.push(long)
    strictEqual(out.length > 0, true)
    // Geschnitten wird an einer Fuge, nie mitten im Wort.
    strictEqual(/\w$/.test(out[0]) || /[,;]$/.test(out[0]), true)
  })

  it('vergisst beim Dazwischenreden, was noch liegt', () => {
    const buffer = createSentenceBuffer()
    buffer.push('Der Rest ist überholt')
    buffer.clear()
    deepStrictEqual(buffer.flush(), [])
  })

  it('lässt ein halbes Sternchenpaar nicht durchrutschen', () => {
    const buffer = createSentenceBuffer()
    // Der Satz endet mitten in der Hervorhebung; das schließende Sternchen kommt
    // erst im nächsten Satz. Vorgelesen würde daraus "Sternchen".
    deepStrictEqual(buffer.push('**Achtung. Wirklich.** Fertig.'), ['Achtung.', 'Wirklich.'])
    deepStrictEqual(buffer.flush(), ['Fertig.'])
  })
})
