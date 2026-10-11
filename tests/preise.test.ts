import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePriceString } from '@main/automation/priceParser'

/**
 * Der Preisleser.
 *
 * Er steht hier allein, weil an ihm zwei Dinge hängen, die man nicht sieht:
 * Der Preiswächter vergleicht seine Zahl mit dem Zielpreis, und beim Alarm
 * setzt er ein Kennzeichen, das ein zweites Mal nicht mehr auslöst. Eine falsch
 * gelesene Zahl ist deshalb kein schiefer Satz, sondern eine Beobachtung, die
 * ab jetzt schweigt.
 *
 * Geprüft wird mit Zeichenketten, wie sie wirklich in Preisfeldern stehen —
 * mit Zusatz dahinter, mit durchgestrichenem Vergleichspreis daneben, mit
 * Artikelnummern davor.
 */
describe('parsePriceString', () => {
  describe('die beiden Schreibweisen', () => {
    it('liest die deutsche', () => {
      assert.equal(parsePriceString('1.299,00 €'), 1299)
      assert.equal(parsePriceString('12,99 €'), 12.99)
    })

    it('liest die englische', () => {
      assert.equal(parsePriceString('1,299.00'), 1299)
      assert.equal(parsePriceString('$12.99'), 12.99)
    })

    it('nimmt das Leerzeichen als Tausendertrenner', () => {
      assert.equal(parsePriceString('€ 1 299,00'), 1299)
      // Das geschützte Leerzeichen ist im Netz das häufigere.
      assert.equal(parsePriceString('1 299,00 €'), 1299)
    })
  })

  /**
   * Der mehrdeutige Fall: ein Trennzeichen, drei Stellen dahinter.
   * "1.299" ist ein Tausender, "0.750" ein Bruchteil.
   */
  describe('ein Trennzeichen, keine Nachkommastellen', () => {
    it('liest drei Stellen als Tausendergruppe', () => {
      assert.equal(parsePriceString('1.299 €'), 1299)
      assert.equal(parsePriceString('1,299'), 1299)
    })

    it('lässt die führende Null in Ruhe', () => {
      assert.equal(parsePriceString('0.750'), 0.75)
    })

    it('liest zwei Stellen als Nachkommastellen', () => {
      assert.equal(parsePriceString('12.99'), 12.99)
    })
  })

  /**
   * Der Text um die Zahl herum — und genau hier lag der Fehler: Vorher wurde
   * alles außer Ziffern und Trennzeichen weggeworfen, und der Punkt einer
   * Abkürzung blieb dabei stehen.
   */
  describe('Text um den Preis herum', () => {
    it('lässt sich vom Punkt einer Abkürzung nicht täuschen', () => {
      assert.equal(parsePriceString('12,99 € zzgl. Versand'), 12.99)
      assert.equal(parsePriceString('1.299,00 € inkl. MwSt.'), 1299)
    })

    it('nimmt bei zwei Preisen den vorderen', () => {
      // Der aktuelle steht vorn, der durchgestrichene dahinter.
      assert.equal(parsePriceString('ab 4,99 € statt 9,99 €'), 4.99)
      assert.equal(parsePriceString('1.299,00 €1.499,00 €'), 1299)
    })

    it('überliest Zahlen, die kein Preis sind', () => {
      assert.equal(parsePriceString('2er Pack — 1.299,00 €'), 1299)
      assert.equal(parsePriceString('Art.-Nr. 12345 — 49,90 €'), 49.9)
    })

    it('nimmt die Zahl am Währungszeichen, wenn keine Nachkommastellen da sind', () => {
      assert.equal(parsePriceString('iPhone 15 128 GB 999 €'), 999)
    })
  })

  describe('gar kein Preis', () => {
    it('gibt nichts zurück, wo keine Zahl steht', () => {
      assert.equal(parsePriceString(''), null)
      assert.equal(parsePriceString('Preis auf Anfrage'), null)
      assert.equal(parsePriceString('€'), null)
    })

    it('weist die Null ab', () => {
      // Ein Preis von null ist keiner — meist ein leeres Feld, das der Shop
      // mit einer Ziffer füllt, bevor der echte Wert nachgeladen wird.
      assert.equal(parsePriceString('0,00 €'), null)
    })
  })
})
