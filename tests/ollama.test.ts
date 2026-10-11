import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { stripThinking } from '@main/providers/ollama'

/**
 * Was das lokale Modell zurückschickt, bevor es jemand hört.
 *
 * Die kleinen Modelle, die als Reserve überhaupt in Frage kommen, sind
 * inzwischen fast alle Denkmodelle — qwen3, deepseek-r1, gpt-oss. Sie
 * schreiben ihre Überlegung mit in die Antwort, und ungeschnitten ist das
 * Ergebnis auf die unauffälligste Art kaputt: Die Übersetzung eines Satzes
 * kommt als drei Absätze Selbstgespräch zurück und wird dann vorgelesen.
 */
describe('Denkblöcke aus der Antwort schneiden', () => {
  it('lässt eine gewöhnliche Antwort unangetastet', () => {
    assert.equal(stripThinking('Der Zug fährt um acht.'), 'Der Zug fährt um acht.')
  })

  it('wirft einen geschlossenen Block weg', () => {
    assert.equal(
      stripThinking('<think>Der Nutzer will eine Übersetzung.</think>Der Zug fährt um acht.'),
      'Der Zug fährt um acht.'
    )
  })

  it('kommt mit Zeilenumbrüchen im Block zurecht', () => {
    assert.equal(
      stripThinking('<think>\nErst überlegen.\nDann antworten.\n</think>\n\nFertig.'),
      'Fertig.'
    )
  })

  it('wirft auch mehrere Blöcke weg', () => {
    assert.equal(stripThinking('<think>a</think>Erst.<think>b</think> Dann.'), 'Erst. Dann.')
  })

  it('versteht auch die lange Schreibweise', () => {
    assert.equal(stripThinking('<thinking>hm</thinking>Antwort.'), 'Antwort.')
  })

  it('nimmt die Schreibweise unabhängig von Groß- und Kleinschreibung', () => {
    assert.equal(stripThinking('<THINK>hm</THINK>Antwort.'), 'Antwort.')
  })

  /*
   * Ein offener Block ohne Ende heißt: Das Token-Budget war vor dem Abschluss
   * aufgebraucht. Dann ist alles ab dort Überlegung und nichts davon Ergebnis.
   * Stehen zu lassen wäre schlechter als wegzulassen — vorgelesen klingt es
   * wie eine Antwort.
   */
  it('wirft einen abgeschnittenen Block bis zum Ende weg', () => {
    assert.equal(stripThinking('Antwort.<think>Und jetzt überlege ich noch'), 'Antwort.')
  })

  it('liefert leer, wenn nur Überlegung ankam', () => {
    assert.equal(stripThinking('<think>ich denke noch nach'), '')
  })

  it('räumt die Leerzeichen auf, die der Schnitt hinterlässt', () => {
    assert.equal(stripThinking('  <think>x</think>  Antwort.  '), 'Antwort.')
  })

  /*
   * Ein einzelnes spitzes Klammerpaar ist kein Denkblock. Wer ein Modell
   * bittet, HTML zu übersetzen, bekommt sonst eine leere Antwort.
   */
  it('fasst gewöhnliche Zeichen mit spitzen Klammern nicht an', () => {
    assert.equal(stripThinking('Setze <b>fett</b> ein.'), 'Setze <b>fett</b> ein.')
  })

  it('bleibt bei einer leeren Antwort leer', () => {
    assert.equal(stripThinking(''), '')
  })
})
