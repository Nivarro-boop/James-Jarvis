import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import { __internals } from '@main/tools/impl/window'

/**
 * Die zwei Wächter der Fenstersteuerung.
 *
 * Der Bedienbaum selbst hängt an Windows und wird von Hand geprüft. Was hier
 * steht, ist die Buchführung darum herum — und die entscheidet, ob die
 * Sperrliste ein Schutz ist oder nur so aussieht.
 *
 * Der Grund: Der Baum eines Fensters wird gelesen, bevor sein Titel geprüft
 * werden kann. Die Verweistabelle des Servers steht danach auf dem gesperrten
 * Fenster, auch wenn das Lesen abgewiesen wurde — und ihre Nummern fangen bei
 * jedem Lesen wieder bei eins an. Ohne die Menge der bekannten Nummern
 * genügte deshalb eine geratene Zahl, um an einem Fenster zu handeln, dessen
 * Inhalt das Modell nie zu sehen bekam.
 */

const { pruefeFenster, merkeRefs, vergissRefs, refBekannt } = __internals

describe('die Sperrliste gilt auch für den Bedienbaum', () => {
  const gesperrt = [
    'Sparkasse — Onlinebanking',
    'PayPal',
    'Bitwarden',
    'Kennwort ändern',
    'Kasse — Amazon.de',
    'Systemsteuerung',
    'ELSTER — Mein Finanzamt'
  ]

  for (const titel of gesperrt) {
    it(`weist "${titel}" ab`, () => {
      assert.throws(() => pruefeFenster(titel), /fasse ich nicht an/)
    })
  }

  const erlaubt = ['Editor', 'Ollama', 'James-Jarvis — Einstellungen', 'Notizen.txt']

  for (const titel of erlaubt) {
    it(`lässt "${titel}" durch`, () => {
      assert.doesNotThrow(() => pruefeFenster(titel))
    })
  }
})

describe('welche Nummern bedienbar sind', () => {
  beforeEach(() => vergissRefs())

  it('kennt nach dem Lesen genau die gelesenen', () => {
    merkeRefs([1, 2, 3])
    assert.equal(refBekannt(1), true)
    assert.equal(refBekannt(3), true)
    assert.equal(refBekannt(4), false)
  })

  it('kennt ohne Lesen gar keine — auch nicht die erste', () => {
    assert.equal(refBekannt(1), false)
  })

  it('behält nur den letzten Stand, nicht die Summe aller', () => {
    merkeRefs([1, 2, 3, 4, 5])
    merkeRefs([1, 2])
    assert.equal(refBekannt(2), true)
    assert.equal(refBekannt(5), false)
  })

  /**
   * Der eigentliche Fall. Nachgestellt wird die Reihenfolge aus `read_window`:
   * erst vergessen, dann lesen, und die Prüfung des Titels kommt danach.
   */
  it('lässt nach einem abgewiesenen Fenster nichts mehr übrig', () => {
    merkeRefs([1, 2, 3, 4, 5])

    vergissRefs()
    assert.throws(() => pruefeFenster('Sparkasse — Onlinebanking'))

    for (const ref of [1, 2, 3, 4, 5]) {
      assert.equal(refBekannt(ref), false)
    }
  })

  it('lässt auch nach einem fehlgeschlagenen Lesen nichts übrig', () => {
    merkeRefs([1, 2, 3])
    // Kein Titel zu prüfen: Der Server hat gar nicht geantwortet.
    vergissRefs()
    assert.equal(refBekannt(1), false)
  })
})
