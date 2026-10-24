import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BOX_DELAY_MS, checkAnswer, deckStats, grade, nextCard, type StudyCard, type StudyDeck } from '@shared/study'

const card = (over: Partial<StudyCard> = {}): StudyCard =>
  ({ id: 'a', question: 'Hauptstadt von Frankreich?', answer: 'Paris', box: 0, due: 0, right: 0, wrong: 0, ...over })

describe('Lernkarten', () => {
  it('verwechselt Zahlen, Vorzeichen und verneinte Antworten nicht mit Tippfehlern', () => {
    for (const [answer, given] of [['12345', '12346'], ['-12', '12'], ['1,5', '15'], ['Berlin Deutschland', 'nicht Berlin Deutschland']]) {
      assert.equal(checkAnswer(card({ answer }), given), false)
    }
    assert.equal(checkAnswer(card({ answer: '12', options: ['12', '13'] }), 'A'), true)
  })
  it('prüft Antworten ohne Modell, tolerant bei Groß-/Kleinschreibung und Tippfehlern', () => {
    assert.equal(checkAnswer(card(), 'paris'), true)
    assert.equal(checkAnswer(card({ answer: 'Mitochondrium' }), 'Mitochondrum'), true)
    assert.equal(checkAnswer(card(), 'Lyon'), false)
    assert.equal(checkAnswer(card(), ''), false)
  })

  it('lässt kurze Antworten nicht durch Tippfehler gelten', () => {
    assert.equal(checkAnswer(card({ answer: 'Bonn' }), 'Bern'), false)
  })

  it('akzeptiert Artikel und Umlaute in anderer Schreibweise', () => {
    assert.equal(checkAnswer(card({ answer: 'die Größe' }), 'Groesse'), true)
  })

  it('erkennt bei Auswahlkarten auch den Buchstaben', () => {
    const c = card({ options: ['Lyon', 'Paris', 'Nizza'] })
    assert.equal(checkAnswer(c, 'b'), true)
    assert.equal(checkAnswer(c, 'a'), false)
  })

  it('steigt bei Richtig ein Fach auf und fällt bei Falsch auf null', () => {
    const now = 1_000_000
    const up = grade(card({ box: 1 }), true, now)
    assert.equal(up.box, 2)
    assert.equal(up.due, now + BOX_DELAY_MS[2])
    const down = grade(card({ box: 4 }), false, now)
    assert.equal(down.box, 0)
    assert.equal(down.wrong, 1)
  })

  it('akzeptiert A als richtige Auswahl und verwirft ähnliche falsche Optionen', () => {
    assert.equal(checkAnswer(card({ options: ['Paris', 'Lyon'] }), ' A '), true)
    assert.equal(checkAnswer(card({ answer: '12345', options: ['12345', '12346'] }), '12346'), false)
    assert.equal(checkAnswer(card({ answer: '12345', options: ['12345', '12346'] }), 'b'), false)
  })

  it('fragt die letzte falsch beantwortete Karte erneut, statt fertig zu melden', () => {
    const failed = grade(card(), false, 100)
    const deck: StudyDeck = { id: 'd', title: 'Test', created: 0, cards: [failed] }
    assert.equal(nextCard(deck, 100, failed.id)?.id, failed.id)
    deck.cards = [grade(failed, true, 100)]
    assert.equal(nextCard(deck, 100, failed.id), null)
  })

  it('fragt fällige Karten aus niedrigen Fächern zuerst und überspringt die letzte', () => {
    const deck: StudyDeck = { id: 'd', title: 'Test', created: 0, cards: [
      card({ id: 'x', box: 2, due: 5 }), card({ id: 'y', box: 0, due: 9 }), card({ id: 'z', box: 0, due: 99 })
    ] }
    assert.equal(nextCard(deck, 10)?.id, 'y')
    assert.equal(nextCard(deck, 10, 'y')?.id, 'x')
    assert.equal(nextCard(deck, 1), null)
    assert.deepEqual(deckStats(deck, 10), { total: 3, due: 2, learned: 0, right: 0, wrong: 0 })
  })
})
