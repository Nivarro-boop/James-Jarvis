/**
 * Lernkarten mit Wiederholung in Fächern (Leitner).
 *
 * Token sparen ist hier der Kern: Das Modell schreibt die Karten einmal,
 * Abfragen, Prüfen und Planen laufen danach lokal ohne Modellaufruf.
 */

export interface StudyCard {
  id: string
  question: string
  answer: string
  /** Mehrfachauswahl, wenn gesetzt; `answer` ist dann eine der Optionen. */
  options?: string[]
  /** Fach 0–5: höher heißt seltener abgefragt. */
  box: number
  /** Nächste Fälligkeit in Millisekunden. */
  due: number
  right: number
  wrong: number
}

export interface StudyDeck {
  id: string
  title: string
  created: number
  cards: StudyCard[]
}

export interface StudyStats { total: number; due: number; learned: number; right: number; wrong: number }

/** Abstände je Fach: sofort, 10 min, 1 Tag, 3 Tage, 1 Woche, 3 Wochen. */
export const BOX_DELAY_MS = [0, 10 * 60_000, 86_400_000, 3 * 86_400_000, 7 * 86_400_000, 21 * 86_400_000]

export function normalizeAnswer(text: string): string {
  return text.toLocaleLowerCase('de').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\b(der|die|das|ein|eine|the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = temp
    }
  }
  return row[b.length]
}

/**
 * Lokal prüfen: exakt nach Normalisierung, kleine Tippfehler in Wörtern erlaubt.
 * Zahlen werden streng verglichen; zusätzliche Erklärungen sind keine Kurzantwort. Bei Auswahlkarten
 * zählt auch der Buchstabe (a, b, c …) der richtigen Option.
 */
export function checkAnswer(card: Pick<StudyCard, 'answer' | 'options'>, given: string): boolean {
  if (given.length > 1000) return false
  const exact = (value: string): string => value.trim().toLocaleLowerCase('de').replace(/\s+/g, ' ')
  // Vorzeichen und Dezimalzeichen sind Bedeutung, keine Tippfehler.
  if (/\d/.test(given) || /\d/.test(card.answer)) {
    if (!card.options?.length || !/^[a-z]$/i.test(given.trim())) return exact(given) === exact(card.answer)
  }
  const want = normalizeAnswer(card.answer)
  const got = normalizeAnswer(given)
  if (card.options?.length) {
    // Auswahlbuchstaben vor der Artikel-Normalisierung prüfen (A = „a“).
    // Bei festen Optionen darf Tippfehlertoleranz keine falsche Wahl umwerten.
    const index = card.options.findIndex(o => normalizeAnswer(o) === want)
    const choice = given.trim().toLocaleLowerCase('de')
    if (/^[a-z]$/.test(choice)) return index >= 0 && choice === String.fromCharCode(97 + index)
    return Boolean(got) && got === want
  }
  if (!got || !want) return false
  if (got === want) return true
  const negation = /\b(nicht|kein|keine|keinen|nie|not|never|no)\b/
  if (negation.test(got) !== negation.test(want)) return false
  const tolerance = want.length <= 4 ? 0 : want.length <= 10 ? 1 : 2
  if (distance(got, want) <= tolerance) return true
  return false
}

export function grade(card: StudyCard, correct: boolean, now = Date.now()): StudyCard {
  const box = correct ? Math.min(card.box + 1, BOX_DELAY_MS.length - 1) : 0
  return { ...card, box, due: now + BOX_DELAY_MS[box], right: card.right + (correct ? 1 : 0), wrong: card.wrong + (correct ? 0 : 1) }
}

/** Die fälligste Karte; bei Gleichstand die aus dem niedrigsten Fach. */
export function nextCard(deck: StudyDeck, now = Date.now(), skip?: string): StudyCard | null {
  const allDue = deck.cards.filter(c => c.due <= now)
  const others = allDue.filter(c => c.id !== skip)
  const due = others.length ? others : allDue
  if (!due.length) return null
  return due.sort((a, b) => a.box - b.box || a.due - b.due)[0]
}

export function deckStats(deck: StudyDeck, now = Date.now()): StudyStats {
  return {
    total: deck.cards.length,
    due: deck.cards.filter(c => c.due <= now).length,
    learned: deck.cards.filter(c => c.box >= 3).length,
    right: deck.cards.reduce((n, c) => n + c.right, 0),
    wrong: deck.cards.reduce((n, c) => n + c.wrong, 0)
  }
}
