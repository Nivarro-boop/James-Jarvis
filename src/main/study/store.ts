import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { z } from 'zod'
import { join } from 'node:path'
import { checkAnswer, deckStats, grade, nextCard, type StudyCard, type StudyDeck, type StudyStats } from '@shared/study'
import type { QuizQuestion } from '@shared/ipc'

/** Lernstapel lokal in `study.json`. Kein Modellaufruf beim Abfragen. */

const file = (): string => join(app.getPath('userData'), 'study.json')
const count = z.number().int().nonnegative().safe()
export const studyStoreSchema = z.object({
  version: z.literal(1).optional(),
  decks: z.array(z.object({
    id: z.string().min(1), title: z.string().trim().min(1), created: count,
    cards: z.array(z.object({
      id: z.string().min(1), question: z.string().min(1), answer: z.string().min(1),
      options: z.array(z.string().min(1)).optional(), box: count.max(5), due: count, right: count, wrong: count
    }))
  }))
})

export function listDecks(): StudyDeck[] {
  let raw: string
  try { raw = readFileSync(file(), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error('Lernkarten können nicht gelesen werden. Die vorhandene Datei bleibt unverändert.')
  }
  try { return studyStoreSchema.parse(JSON.parse(raw)).decks }
  catch { throw new Error('Die Lernkartendatei ist beschädigt oder hat ein unbekanntes Format. Bitte study.json aus einer Sicherung wiederherstellen. Sie wurde nicht verändert.') }
}

function save(decks: StudyDeck[]): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  const staging = `${file()}.${randomUUID()}.tmp`
  try {
    writeFileSync(staging, JSON.stringify({ version: 1, decks }), { flag: 'wx', flush: true })
    renameSync(staging, file())
  } finally { try { unlinkSync(staging) } catch { /* already renamed */ } }
}

function lookup(decks: StudyDeck[], name: string): StudyDeck | undefined {
  const needle = name.trim().toLocaleLowerCase('de')
  if (!needle) return undefined
  return decks.find(d => d.id === name) ?? decks.find(d => d.title.toLocaleLowerCase('de') === needle)
}

export function findDeck(name: string): StudyDeck | undefined {
  const decks = listDecks()
  const exact = lookup(decks, name)
  if (exact || !name.trim()) return exact
  const matches = decks.filter(d => d.title.toLocaleLowerCase('de').includes(name.trim().toLocaleLowerCase('de')))
  if (matches.length > 1) throw new Error('Mehrere Lernstapel passen. Bitte den vollständigen Namen verwenden.')
  return matches[0]
}

export function addCards(title: string, cards: { question: string; answer: string; options?: string[] }[]): StudyDeck {
  const normalizedTitle = title.trim().slice(0, 80)
  if (!normalizedTitle) throw new Error('Bitte einen Namen für den Lernstapel angeben.')
  const decks = listDecks()
  let deck = lookup(decks, normalizedTitle)
  if (!deck) {
    deck = { id: randomUUID(), title: normalizedTitle, created: Date.now(), cards: [] }
    decks.push(deck)
  }
  const known = new Set(deck.cards.map(c => c.question.toLocaleLowerCase('de')))
  for (const c of cards) {
    const question = c.question.trim().slice(0, 400)
    const answer = c.answer.trim().slice(0, 300)
    if (!question || !answer || known.has(question.toLocaleLowerCase('de'))) continue
    const choices = c.options ? [...new Set(c.options.map(o => o.trim().slice(0, 300)).filter(Boolean))] : []
    const options = choices.includes(answer) ? choices.slice(0, 6) : choices.slice(0, 5)
    if (choices.length && !options.includes(answer)) options.splice(5, 1, answer)
    deck.cards.push({
      id: randomUUID(),
      question: question.slice(0, 400),
      answer: answer.slice(0, 300),
      options: options.length >= 2 ? options : undefined,
      box: 0, due: 0, right: 0, wrong: 0
    })
    known.add(question.toLocaleLowerCase('de'))
  }
  save(decks)
  return deck
}

export function deleteDeck(id: string): boolean {
  const decks = listDecks()
  const next = decks.filter(d => d.id !== id)
  if (next.length === decks.length) return false
  save(next)
  for (const [token, presentation] of presentations) if (presentation.deckId === id) presentations.delete(token)
  return true
}

type QuizResult = { correct: boolean; solution: string; card: StudyCard; stats: StudyStats }
const presentations = new Map<string, { deckId: string; cardId: string; at: number; answer?: string; result?: QuizResult }>()

export function quizNext(deckId: string, skip?: string): QuizQuestion {
  const deck = findDeck(deckId)
  if (!deck) throw new Error(`Kein Lernstapel „${deckId}“.`)
  // Die gerade beantwortete Karte nicht sofort wieder — außer sie ist die letzte fällige.
  const card = nextCard(deck, Date.now(), skip) ?? null
  const stats = deckStats(deck)
  for (const [token, pending] of presentations) {
    if (Date.now() - pending.at > 30 * 60_000 || (!pending.result && pending.deckId === deck.id)) presentations.delete(token)
  }
  while (presentations.size >= 512) presentations.delete(presentations.keys().next().value!)
  const questionToken = randomUUID()
  if (card) presentations.set(questionToken, { deckId: deck.id, cardId: card.id, at: Date.now() })
  return card
    ? { deckId: deck.id, deckTitle: deck.title, cardId: card.id, questionToken, question: card.question, options: card.options, stats }
    : { deckId: deck.id, deckTitle: deck.title, done: true, stats }
}

export function quizAnswer(deckId: string, cardId: string, answer: string, questionToken: string): QuizResult {
  if (typeof answer !== 'string' || !answer.trim() || answer.length > 5000) throw new Error('Bitte eine kurze Antwort eingeben.')
  const presentation = presentations.get(questionToken)
  if (!presentation || presentation.deckId !== deckId || presentation.cardId !== cardId || Date.now() - presentation.at > 30 * 60_000) throw new Error('Diese Quizfrage ist nicht mehr aktuell. Bitte die nächste Frage laden.')
  if (presentation.result) {
    if (presentation.answer !== answer.trim()) throw new Error('Diese Frage wurde bereits beantwortet.')
    return structuredClone(presentation.result)
  }
  const decks = listDecks()
  const deck = decks.find(d => d.id === deckId)
  const index = deck?.cards.findIndex(c => c.id === cardId) ?? -1
  if (!deck || index < 0) throw new Error('Diese Karte gibt es nicht mehr.')
  const correct = checkAnswer(deck.cards[index], answer)
  deck.cards[index] = grade(deck.cards[index], correct)
  save(decks)
  const result = { correct, solution: deck.cards[index].answer, card: deck.cards[index], stats: deckStats(deck) }
  presentation.answer = answer.trim(); presentation.result = structuredClone(result)
  return result
}
