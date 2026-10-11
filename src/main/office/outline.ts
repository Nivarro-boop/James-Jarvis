import { thinkText } from '../providers/text'
import type { DocxBlock } from './docx'
import type { Sheet, CellValue } from './xlsx'
import type { Slide } from './pptx'

/**
 * Aus einem Stichwort einen Entwurf machen.
 *
 * Der Grund, warum es diese Datei gibt: „Mach mir eine Präsentation über
 * Photosynthese" ist ein vollständiger Auftrag und enthält keinen einzigen
 * Folieninhalt. Das Sprachmodell am anderen Ende der Leitung könnte den
 * Entwurf selbst liefern — aber dann steckte er in den Argumenten eines
 * Werkzeugaufrufs, und die gehen über dieselbe Leitung wie das Audio: zwanzig
 * Folien als Funktionsargument sind teuer und werden bei jedem Verbindungs-
 * abbruch neu erzeugt.
 *
 * Also fragt der Hauptprozess hier ein zweites Mal — über `thinkText`, also
 * beim eingestellten Textanbieter, der auch Ollama sein darf. Das kostet eine
 * Runde Wartezeit und spart den teuren Weg.
 *
 * Der Aufrufer darf den Entwurf trotzdem mitgeben. Wenn das Modell die Inhalte
 * schon genannt hat — „schreib das, was wir gerade besprochen haben, in ein
 * Dokument" —, wäre ein zweiter Durchlauf nicht nur unnötig, sondern falsch:
 * Er wüsste vom Gespräch nichts.
 */

/**
 * JSON aus einer Modellantwort schälen.
 *
 * Kein Modell hält sich zuverlässig an „nur JSON". Es kommen Codezäune, ein
 * einleitender Satz, gelegentlich beides. Gesucht wird deshalb die äußerste
 * geschweifte Klammer statt auf Wohlverhalten zu hoffen.
 */
function parseJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced ? fenced[1] : text).trim()

  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new Error('Der Entwurf kam nicht als JSON zurück.')
  }

  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    throw new Error('Der Entwurf war kein gültiges JSON.')
  }
}

function asStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((v) => (v === null || v === undefined ? '' : String(v)).trim())
    .filter((v) => v.length > 0)
    .slice(0, limit)
}

/** Immer auf Deutsch und immer ohne Markdown — der Rest steht je Format darunter. */
const COMMON =
  'Du entwirfst den Inhalt für eine Datei, die gleich erzeugt wird. ' +
  'Antworte ausschließlich mit JSON, ohne Codezaun und ohne Vor- oder Nachwort. ' +
  'Schreib auf Deutsch, sachlich und knapp. Setz keine Sternchen, keine Rauten und ' +
  'keine Aufzählungsstriche in die Texte — die Formatierung macht die Datei selbst. ' +
  'Erfinde keine Zahlen, die wie Messwerte aussehen; bleib allgemein, wo du nichts weißt.'

// ─────────────────────────────────────────────────────────────
// Präsentation
// ─────────────────────────────────────────────────────────────

export interface DeckOutline {
  title: string
  subtitle: string
  slides: Slide[]
}

export async function outlineDeck(topic: string, wanted: number): Promise<DeckOutline> {
  const count = Math.min(20, Math.max(3, wanted))

  const answer = await thinkText({
    system:
      `${COMMON}\n\n` +
      'Form: {"title": "...", "subtitle": "...", "slides": [{"title": "...", "bullets": ["...", "..."]}]}\n' +
      `Genau ${count} Einträge in slides. Je Folie drei bis fünf bullets, jeder ein ` +
      'halber Satz, keine ganzen Absätze. Die Folientitel sind Substantive oder kurze ' +
      'Aussagen, nicht "Folie 1". Der subtitle ist eine Zeile für die Titelfolie.',
    user: `Thema: ${topic}`,
    maxTokens: 2000
  })

  const raw = parseJson(answer.text) as Record<string, unknown>
  const slides = Array.isArray(raw.slides) ? raw.slides : []

  const cleaned: Slide[] = slides
    .map((entry) => {
      const s = (entry ?? {}) as Record<string, unknown>
      return {
        title: String(s.title ?? '').trim(),
        bullets: asStringArray(s.bullets, 8)
      }
    })
    .filter((s) => s.title.length > 0)
    .slice(0, count)

  if (cleaned.length === 0) {
    throw new Error('Der Entwurf enthielt keine Folien.')
  }

  return {
    title: String(raw.title ?? topic).trim() || topic,
    subtitle: String(raw.subtitle ?? '').trim(),
    slides: cleaned
  }
}

// ─────────────────────────────────────────────────────────────
// Dokument
// ─────────────────────────────────────────────────────────────

export interface DocOutline {
  title: string
  subtitle: string
  blocks: DocxBlock[]
}

export async function outlineDocument(topic: string, length: 'kurz' | 'mittel' | 'lang'): Promise<DocOutline> {
  const sections = { kurz: '2 bis 3', mittel: '4 bis 5', lang: '6 bis 8' }[length]

  const answer = await thinkText({
    system:
      `${COMMON}\n\n` +
      'Form: {"title": "...", "subtitle": "...", "blocks": [...]}\n' +
      'Ein Block ist entweder {"kind":"heading","level":1,"text":"..."} oder ' +
      '{"kind":"paragraph","text":"..."} oder {"kind":"bullets","items":["...","..."]}.\n' +
      `Gliedere in ${sections} Abschnitte, jeder mit einer heading auf level 1 und ` +
      'ein bis drei Absätzen darunter. Absätze sind drei bis sechs Sätze, keine Stichworte. ' +
      'Höchstens eine Aufzählung je Abschnitt.',
    user: `Thema: ${topic}`,
    maxTokens: 3000
  })

  const raw = parseJson(answer.text) as Record<string, unknown>
  const blocks = Array.isArray(raw.blocks) ? raw.blocks : []

  const cleaned: DocxBlock[] = []
  for (const entry of blocks.slice(0, 80)) {
    const b = (entry ?? {}) as Record<string, unknown>
    const kind = String(b.kind ?? '')
    const text = String(b.text ?? '').trim()

    if (kind === 'heading' && text) {
      const level = Number(b.level ?? 1)
      cleaned.push({ kind: 'heading', level: level === 3 ? 3 : level === 2 ? 2 : 1, text })
    } else if (kind === 'paragraph' && text) {
      cleaned.push({ kind: 'paragraph', text })
    } else if (kind === 'bullets') {
      const items = asStringArray(b.items, 12)
      if (items.length > 0) cleaned.push({ kind: 'bullets', items })
    }
  }

  if (cleaned.length === 0) {
    throw new Error('Der Entwurf enthielt keinen Text.')
  }

  return {
    title: String(raw.title ?? topic).trim() || topic,
    subtitle: String(raw.subtitle ?? '').trim(),
    blocks: cleaned
  }
}

// ─────────────────────────────────────────────────────────────
// Tabelle
// ─────────────────────────────────────────────────────────────

export interface SheetOutline {
  title: string
  sheet: Sheet
}

/**
 * Eine Tabelle entwerfen.
 *
 * Anders als bei Text und Folien geht es hier meist um ein Gerüst und nicht um
 * Inhalt: „eine Tabelle für meine Ausgaben" will Spalten und ein, zwei
 * Beispielzeilen, keine erfundene Buchhaltung. Deshalb steht die Zurückhaltung
 * ausdrücklich in der Anweisung — sonst füllt das Modell zwölf Monate mit
 * Zahlen, die aussehen, als wären sie echt.
 */
export async function outlineSheet(topic: string): Promise<SheetOutline> {
  const answer = await thinkText({
    system:
      `${COMMON}\n\n` +
      'Form: {"title": "...", "sheetName": "...", "header": ["...","..."], "rows": [["...","..."]]}\n' +
      'header sind die Spaltenüberschriften, drei bis acht Stück. rows sind höchstens ' +
      'drei Beispielzeilen mit derselben Spaltenzahl — erkennbar als Beispiel, keine ' +
      'erfundenen echten Daten. Zahlen als Zahl, nicht als Text in Anführungszeichen. ' +
      'sheetName ist ein Wort für das Register.',
    user: `Gewünscht: ${topic}`,
    maxTokens: 1200
  })

  const raw = parseJson(answer.text) as Record<string, unknown>
  const header = asStringArray(raw.header, 20)
  if (header.length === 0) throw new Error('Der Entwurf enthielt keine Spalten.')

  const rows: CellValue[][] = (Array.isArray(raw.rows) ? raw.rows : [])
    .slice(0, 20)
    .map((row) =>
      (Array.isArray(row) ? row : [])
        .slice(0, header.length)
        .map((value): CellValue => {
          if (value === null || value === undefined) return null
          if (typeof value === 'number' || typeof value === 'boolean') return value
          return String(value)
        })
    )

  return {
    title: String(raw.title ?? topic).trim() || topic,
    sheet: {
      name: String(raw.sheetName ?? '').trim() || 'Tabelle1',
      header,
      rows
    }
  }
}

/** Nur zum Testen. */
export const __internals = { parseJson, asStringArray }
