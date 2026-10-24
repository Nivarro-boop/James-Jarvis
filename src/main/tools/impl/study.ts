import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { addCards, deleteDeck, findDeck, listDecks, quizAnswer, quizNext } from '../../study/store'
import { deckStats } from '@shared/study'
import { sendToCrystal } from '../../ipc/emit'

/**
 * Lernen mit Quiz. Das Modell schreibt Karten einmal (study_add_cards);
 * Abfragen und Prüfen laufen lokal, die Antworten sind absichtlich kurz.
 * Auf dem Bildschirm (study_show) kostet ein Quiz gar keine Tokens.
 */

const addCardsTool = defineTool({
  name: 'study_add_cards',
  group: 'memory',
  description:
    'Legt Lernkarten in einem Stapel an (neu oder ergänzen). Für „hilf mir lernen“, „mach mir ein Quiz zu …“, ' +
    '„Vokabeln“. Kurze Fragen, kurze Antworten; optional 3–4 Auswahlmöglichkeiten. Höchstens 20 Karten pro Aufruf. ' +
    'Danach study_show (Quiz auf dem Bildschirm, spart Tokens) oder study_quiz für ein gesprochenes Quiz.',
  schema: z.object({
    stapel: z.string().min(1).describe('Thema, z. B. "Englisch Vokabeln" oder "Biologie Zelle"'),
    karten: z.array(z.object({
      frage: z.string().min(1),
      antwort: z.string().min(1),
      optionen: z.array(z.string()).max(6).optional()
    })).min(1).max(20)
  }),
  async execute({ stapel, karten }) {
    const deck = addCards(stapel, karten.map(k => ({ question: k.frage, answer: k.antwort, options: k.optionen })))
    return { stapel: deck.title, karten: deck.cards.length }
  }
}) as ToolDefinition

const quiz = defineTool({
  name: 'study_quiz',
  group: 'memory',
  description:
    'Gesprochenes Quiz: ohne antwort kommt die nächste fällige Frage; mit karte und antwort wird lokal geprüft ' +
    'und gleich die nächste Frage mitgeliefert. Lies nur Frage und Optionen vor, sag kurz richtig oder falsch.',
  schema: z.object({
    stapel: z.string().describe('Name oder ID des Stapels'),
    karte: z.string().optional().describe('ID der zuletzt gestellten Karte'),
    antwort: z.string().optional().describe('Antwort des Nutzers, wörtlich')
  }),
  async execute({ stapel, karte, antwort }) {
    const deck = findDeck(stapel)
    if (!deck) return { fehler: `Kein Stapel „${stapel}“.`, stapel: listDecks().map(d => d.title) }
    let result: Record<string, unknown> = {}
    if (karte && antwort !== undefined) {
      const r = quizAnswer(deck.id, karte, antwort)
      result = { richtig: r.correct, ...(r.correct ? {} : { loesung: r.solution }) }
    }
    const next = quizNext(deck.id, karte)
    if ('done' in next) return { ...result, fertig: true, gelernt: `${next.stats.learned}/${next.stats.total}` }
    return {
      ...result,
      karte: next.cardId,
      frage: next.question,
      ...(next.options ? { optionen: next.options.map((o, i) => `${String.fromCharCode(97 + i)}) ${o}`) } : {}),
      offen: next.stats.due
    }
  }
}) as ToolDefinition

const show = defineTool({
  name: 'study_show',
  group: 'memory',
  description: 'Öffnet das Quiz auf dem Bildschirm. Läuft dort ganz ohne Modell und spart Tokens. Ohne Stapel die Übersicht.',
  schema: z.object({ stapel: z.string().optional() }),
  async execute({ stapel }) {
    const deck = stapel ? findDeck(stapel) : undefined
    if (stapel && !deck) return { fehler: `Kein Stapel „${stapel}“.`, stapel: listDecks().map(d => d.title) }
    sendToCrystal('study:open', { deckId: deck?.id })
    return { ok: true }
  }
}) as ToolDefinition

const progress = defineTool({
  name: 'study_progress',
  group: 'memory',
  description: 'Lernstand: Stapel mit Kartenzahl, fälligen und gelernten Karten.',
  schema: z.object({}),
  async execute() {
    return listDecks().map(d => {
      const s = deckStats(d)
      return { stapel: d.title, karten: s.total, faellig: s.due, gelernt: s.learned }
    })
  }
}) as ToolDefinition

const remove = defineTool({
  name: 'study_delete',
  group: 'memory',
  description: 'Löscht einen Lernstapel samt Lernstand.',
  alwaysAsk: true,
  schema: z.object({ stapel: z.string() }),
  async execute({ stapel }) {
    const deck = findDeck(stapel)
    if (!deck) return { fehler: `Kein Stapel „${stapel}“.` }
    deleteDeck(deck.id)
    return { geloescht: deck.title }
  }
}) as ToolDefinition

export const studyTools: ToolDefinition[] = [addCardsTool, quiz, show, progress, remove]
