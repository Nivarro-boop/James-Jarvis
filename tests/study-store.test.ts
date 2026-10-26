import assert from 'node:assert/strict'
import { it } from 'node:test'
import { app } from 'electron'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addCards, findDeck, listDecks, quizAnswer, quizNext } from '@main/study/store'

it('grades each presented question once and rejects obsolete or mismatched presentations', t => {
  const root = mkdtempSync(join(tmpdir(), 'james-quiz-once-'))
  t.mock.method(app, 'getPath', () => root)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const deck = addCards('Quiz once', [{ question: 'Capital?', answer: 'Paris' }])
  const old = quizNext(deck.id), current = quizNext(deck.id)
  assert.ok(!('done' in old) && !('done' in current))
  assert.throws(() => quizAnswer(deck.id, old.cardId, 'Paris', old.questionToken), /nicht mehr aktuell/)
  assert.throws(() => quizAnswer('wrong-deck', current.cardId, 'Paris', current.questionToken), /nicht mehr aktuell/)
  const first = quizAnswer(deck.id, current.cardId, 'London', current.questionToken)
  const duplicate = quizAnswer(deck.id, current.cardId, 'London', current.questionToken)
  assert.deepEqual(duplicate, first)
  assert.equal(findDeck(deck.id)?.cards[0].wrong, 1)
  assert.throws(() => quizAnswer(deck.id, current.cardId, 'Paris', current.questionToken), /bereits/)
  const retry = quizNext(deck.id)
  assert.ok(!('done' in retry))
  quizAnswer(deck.id, retry.cardId, 'Paris', retry.questionToken)
  assert.equal(findDeck(deck.id)?.cards[0].right, 1)
})

it('erhält beschädigte und unbekannte Lernbestände unverändert', t => {
  const root = mkdtempSync(join(tmpdir(), 'james-study-'))
  t.mock.method(app, 'getPath', () => root)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.deepEqual(listDecks(), [])
  for (const raw of ['{broken', '{"decks":{}}', '{"version":2,"decks":[]}']) {
    writeFileSync(join(root, 'study.json'), raw)
    assert.throws(() => addCards('Neu', [{ question: 'Q', answer: 'A' }]), /beschädigt/)
    assert.equal(readFileSync(join(root, 'study.json'), 'utf8'), raw)
  }
})

it('schreibt nur in exakt passende Stapel und speichert konsistente Auswahlkarten', t => {
  const root = mkdtempSync(join(tmpdir(), 'james-study-'))
  t.mock.method(app, 'getPath', () => root)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  addCards('Biologie Grundlagen', [{ question: 'Lang', answer: 'Test' }])
  const deck = addCards('Biologie', [{ question: 'Q'.repeat(450), answer: 'X'.repeat(350), options: ['1','2','3','4','5','6','7'] }])
  addCards('Biologie', [{ question: 'Q'.repeat(450), answer: 'Anders' }])
  assert.equal(listDecks().length, 2)
  assert.equal(findDeck('Biologie')?.cards.length, 1)
  assert.equal(findDeck(''), undefined)
  assert.throws(() => findDeck('Bio'), /Mehrere/)
  assert.throws(() => addCards(' ', []), /Namen/)
  assert.equal(deck.cards[0].options?.length, 6)
  assert.ok(deck.cards[0].options?.includes(deck.cards[0].answer))
  const question = quizNext(deck.id)
  assert.ok(!('done' in question))
  quizAnswer(deck.id, deck.cards[0].id, deck.cards[0].answer, question.questionToken)
  assert.equal(findDeck(deck.id)?.cards[0].right, 1)
  assert.equal(JSON.parse(readFileSync(join(root, 'study.json'), 'utf8')).version, 1)
})
