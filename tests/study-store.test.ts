import assert from 'node:assert/strict'
import { it } from 'node:test'
import { app } from 'electron'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addCards, findDeck, listDecks, quizAnswer } from '@main/study/store'

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
  quizAnswer(deck.id, deck.cards[0].id, deck.cards[0].answer)
  assert.equal(findDeck(deck.id)?.cards[0].right, 1)
  assert.equal(JSON.parse(readFileSync(join(root, 'study.json'), 'utf8')).version, 1)
})
