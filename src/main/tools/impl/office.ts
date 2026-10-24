import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { buildDocx, type DocxBlock } from '../../office/docx'
import { buildXlsx, type CellValue, type Sheet } from '../../office/xlsx'
import { buildPptx, type Slide } from '../../office/pptx'
import { outlineDeck, outlineDocument, outlineSheet } from '../../office/outline'
import { OFFICE_FOLDERS, saveOfficeFile, type OfficeFolder } from '../../office/save'

/**
 * Word, Excel und PowerPoint aus einem Satz.
 *
 * Jedes der drei Werkzeuge kennt zwei Wege, und die Unterscheidung ist der
 * eigentliche Entwurf hier:
 *
 * Nennt der Aufrufer den Inhalt mit — weil er im Gespräch schon besprochen
 * wurde —, wird genau der genommen. Nennt er nur ein Thema, entsteht der
 * Entwurf über `office/outline.ts` bei einem zweiten Modell. Der Umweg spart
 * die teure Leitung: Zwanzig Folien als Funktionsargument gehen durch denselben
 * Kanal wie das Audio und werden nach jedem Verbindungsabbruch neu erzeugt.
 *
 * Was hier nicht passiert: bestehende Dateien ändern. Ein docx zu lesen, zu
 * verstehen und wieder zu schreiben ist eine andere Aufgabe als eines
 * anzulegen — und „häng das noch an die Präsentation an" ist kein Satz, der
 * gesprochen zuverlässig genug ankommt, um eine fertige Datei anzufassen.
 */

const folderField = z
  .enum(OFFICE_FOLDERS)
  .optional()
  .describe('Wohin die Datei kommt. Standard Dokumente.')

const openField = z
  .boolean()
  .optional()
  .describe('Datei danach öffnen. Standard ja.')

// ─────────────────────────────────────────────────────────────
// Werte aus dem Modell in Tabellenwerte übersetzen
// ─────────────────────────────────────────────────────────────

/** Tag.Monat.Jahr — die Schreibweise, die im deutschen Sprachraum ankommt. */
const GERMAN_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Aus dem Text einer Zelle den Wert machen, der gemeint ist.
 *
 * Ohne diese Stelle steht jede Zahl als Text in der Mappe. Das sieht gleich
 * aus und ist es nicht: Eine Summe darüber ergibt null, die Spalte sortiert
 * alphabetisch, und der Nutzer sieht in der Ecke jeder Zelle das grüne
 * Dreieck, mit dem Excel auf genau diesen Fehler hinweist.
 *
 * Die Regel für Trennzeichen ist bewusst einfach gehalten: Steht ein Komma
 * drin, ist es die deutsche Schreibweise — Punkte sind dann Tausender. Steht
 * keines drin, gilt der Punkt als Dezimaltrennzeichen. „1.234" wird damit zu
 * eintausendzweihundertvierunddreißig Komma nichts, und das ist die Lesart,
 * die bei einer deutschen Tabelle in neun von zehn Fällen stimmt.
 */
function coerce(raw: unknown): CellValue {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw
  if (raw instanceof Date) return raw

  const text = String(raw).trim()
  if (!text) return null

  const iso = ISO_DATE.exec(text)
  if (iso) {
    // Ortszeit und nicht UTC: `serialDate` rechnet den Versatz wieder heraus,
    // und ein Datum ohne Uhrzeit soll nicht je nach Zeitzone einen Tag
    // zurückspringen.
    return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
  }

  const german = GERMAN_DATE.exec(text)
  if (german) {
    return new Date(Number(german[3]), Number(german[2]) - 1, Number(german[1]))
  }

  // Währungszeichen und Tausenderleerzeichen weg, Vorzeichen behalten.
  const bare = text.replace(/[€$£\s']/g, '')
  if (/^[+-]?[\d.,]+$/.test(bare) && /\d/.test(bare)) {
    const sign = bare.startsWith('-') ? -1 : 1
    const digits = bare.replace(/^[+-]/, '')
    const value = Number(withoutGrouping(digits))
    if (Number.isFinite(value)) return sign * value
  }

  return text
}

/**
 * Punkte und Kommas auseinanderhalten.
 *
 * Die drei sicheren Fälle zuerst, der unsichere zuletzt:
 *
 * Steht irgendwo ein Komma, ist es die deutsche Schreibweise — Punkte sind
 * dann Tausendertrenner. Stehen zwei oder mehr Punkte drin, ebenfalls: Eine
 * Dezimalzahl hat nie zwei.
 *
 * Bleibt der eine Punkt ohne Komma, und der ist mehrdeutig. „1.234" heißt in
 * Wien eintausendzweihundertvierunddreißig und in London eins Komma zwei drei
 * vier. Entschieden wird nach der Form: genau drei Ziffern hinter dem Punkt,
 * höchstens drei davor, und vorn keine Null — das ist eine Tausendergruppe und
 * keine Nachkommastelle, denn „0.500" schreibt niemand als Tausender und
 * „1.5" hat nur eine Stelle. Alles andere bleibt Dezimalpunkt.
 *
 * Falsch liegen kann diese Regel nur bei einer englischen Zahl mit genau drei
 * Nachkommastellen in einer sonst deutschen Tabelle. Dafür stimmt sie bei
 * jedem Betrag, der aus einem gesprochenen Satz hier ankommt.
 */
function withoutGrouping(digits: string): string {
  if (digits.includes(',')) return digits.replace(/\./g, '').replace(',', '.')
  if ((digits.match(/\./g) ?? []).length >= 2) return digits.replace(/\./g, '')
  if (/^[1-9]\d{0,2}\.\d{3}$/.test(digits)) return digits.replace('.', '')
  return digits
}

function toRows(rows: unknown, width: number): CellValue[][] {
  if (!Array.isArray(rows)) return []
  return rows.slice(0, 5000).map((row) => {
    const cells = Array.isArray(row) ? row : [row]
    return cells.slice(0, Math.max(width, 1)).map(coerce)
  })
}

// ─────────────────────────────────────────────────────────────
// Präsentation
// ─────────────────────────────────────────────────────────────

const presentation = defineTool({
  name: 'presentation_create',
  group: 'office',
  description:
    'Erstellt eine PowerPoint-Präsentation und öffnet sie. Für "mach mir eine Präsentation über ' +
    'X" oder "bau ein paar Folien zu Y". Nenne slides nur, wenn die Inhalte im Gespräch schon ' +
    'feststehen — sonst genügt topic, die Folien entstehen dann hier.',
  schema: z.object({
    topic: z.string().describe('Worum es geht, in einem Satz.'),
    title: z.string().optional().describe('Titel der Präsentation. Ohne Angabe aus topic.'),
    subtitle: z.string().optional().describe('Zeile unter dem Titel, etwa Anlass oder Datum.'),
    count: z.number().optional().describe('Wie viele Inhaltsfolien, Standard sechs, höchstens zwanzig.'),
    slides: z
      .array(
        z.object({
          title: z.string().describe('Überschrift der Folie.'),
          bullets: z.array(z.string()).describe('Drei bis fünf Stichpunkte, je ein halber Satz.')
        })
      )
      .optional()
      .describe('Nur angeben, wenn die Folien schon besprochen sind.'),
    folder: folderField,
    open: openField
  }),
  spokenHint: 'Mhm.',
  async execute({ topic, title, subtitle, count, slides, folder, open }, ctx) {
    ctx.setState('thinking')

    let deck: { title: string; subtitle: string; slides: Slide[] }

    if (slides && slides.length > 0) {
      deck = {
        title: (title ?? topic).trim(),
        subtitle: (subtitle ?? '').trim(),
        slides: slides
          .map((s) => ({ title: String(s.title ?? '').trim(), bullets: s.bullets ?? [] }))
          .filter((s) => s.title.length > 0)
      }
    } else {
      const drafted = await outlineDeck(topic, count ?? 6)
      deck = {
        title: title?.trim() || drafted.title,
        subtitle: subtitle?.trim() || drafted.subtitle,
        slides: drafted.slides
      }
    }

    if (deck.slides.length === 0) throw new Error('Es kam keine einzige Folie zustande.')

    const file = await saveOfficeFile(
      buildPptx(deck),
      deck.title,
      '.pptx',
      folder as OfficeFolder | undefined,
      open ?? true
    )

    return {
      datei: file.name,
      ordner: file.folder,
      folien: deck.slides.length + 1,
      geöffnet: open ?? true,
      hinweis:
        'Sag, wie viele Folien es geworden sind und wie die Datei heißt. Nenne nicht den Pfad ' +
        'und zähl nicht die Folientitel auf — der Nutzer sieht sie gerade.'
    }
  }
}) as ToolDefinition

// ─────────────────────────────────────────────────────────────
// Dokument
// ─────────────────────────────────────────────────────────────

const document = defineTool({
  name: 'document_write',
  group: 'office',
  description:
    'Schreibt ein Word-Dokument mit Überschriften, Absätzen, Aufzählungen und Tabellen und öffnet ' +
    'es. Für "schreib mir einen Bericht über X", "mach ein Angebot", "fass das als Dokument zusammen". ' +
    'Für eine reine Notiz nimm file_write — das hier ist für alles mit Gliederung.',
  schema: z.object({
    topic: z.string().describe('Worum es geht, in einem Satz.'),
    title: z.string().optional().describe('Überschrift des Dokuments.'),
    subtitle: z.string().optional().describe('Zeile darunter, etwa Datum oder Verfasser.'),
    length: z
      .enum(['kurz', 'mittel', 'lang'])
      .optional()
      .describe('Wie ausführlich, wenn der Inhalt hier entsteht. Standard mittel.'),
    blocks: z
      .array(
        z.object({
          kind: z
            .enum(['heading', 'paragraph', 'bullets', 'numbered', 'table', 'pagebreak'])
            .describe('Art des Abschnitts.'),
          text: z.string().optional().describe('Für heading und paragraph.'),
          level: z.number().optional().describe('Für heading: 1, 2 oder 3.'),
          items: z.array(z.string()).optional().describe('Für bullets und numbered.'),
          header: z.array(z.string()).optional().describe('Für table: die Spaltenüberschriften.'),
          rows: z
            .array(z.array(z.string()))
            .optional()
            .describe('Für table: je Zeile eine Liste von Zellen.')
        })
      )
      .optional()
      .describe('Nur angeben, wenn der Inhalt schon feststeht.'),
    folder: folderField,
    open: openField
  }),
  spokenHint: 'Okay.',
  async execute({ topic, title, subtitle, length, blocks, folder, open }, ctx) {
    ctx.setState('thinking')

    let doc: { title: string; subtitle: string; blocks: DocxBlock[] }

    if (blocks && blocks.length > 0) {
      const converted: DocxBlock[] = []
      for (const b of blocks) {
        switch (b.kind) {
          case 'heading': {
            const text = String(b.text ?? '').trim()
            const level = Number(b.level ?? 1)
            if (text) {
              converted.push({ kind: 'heading', level: level === 3 ? 3 : level === 2 ? 2 : 1, text })
            }
            break
          }
          case 'paragraph': {
            const text = String(b.text ?? '').trim()
            if (text) converted.push({ kind: 'paragraph', text })
            break
          }
          case 'bullets':
          case 'numbered': {
            const items = (b.items ?? []).map((i) => String(i).trim()).filter(Boolean)
            if (items.length > 0) converted.push({ kind: b.kind, items })
            break
          }
          case 'table': {
            const header = (b.header ?? []).map((h) => String(h))
            const rows = (b.rows ?? []).map((r) => (Array.isArray(r) ? r.map(String) : [String(r)]))
            if (header.length > 0 || rows.length > 0) {
              converted.push({ kind: 'table', header, rows })
            }
            break
          }
          case 'pagebreak':
            converted.push({ kind: 'pagebreak' })
            break
        }
      }

      doc = {
        title: (title ?? topic).trim(),
        subtitle: (subtitle ?? '').trim(),
        blocks: converted
      }
    } else {
      const drafted = await outlineDocument(topic, length ?? 'mittel')
      doc = {
        title: title?.trim() || drafted.title,
        subtitle: subtitle?.trim() || drafted.subtitle,
        blocks: drafted.blocks
      }
    }

    if (doc.blocks.length === 0) throw new Error('Es kam kein Inhalt zustande.')

    const file = await saveOfficeFile(
      buildDocx(doc),
      doc.title,
      '.docx',
      folder as OfficeFolder | undefined,
      open ?? true
    )

    // Was der Nutzer als „Länge" wahrnimmt, sind Absätze — nicht Blöcke.
    const paragraphs = doc.blocks.filter((b) => b.kind === 'paragraph').length

    return {
      datei: file.name,
      ordner: file.folder,
      abschnitte: doc.blocks.filter((b) => b.kind === 'heading').length,
      absätze: paragraphs,
      geöffnet: open ?? true,
      hinweis:
        'Sag in einem Satz, dass es fertig ist und wie die Datei heißt. Nicht vorlesen — ' +
        'der Nutzer hat das Dokument gerade vor sich.'
    }
  }
}) as ToolDefinition

// ─────────────────────────────────────────────────────────────
// Tabelle
// ─────────────────────────────────────────────────────────────

const spreadsheet = defineTool({
  name: 'spreadsheet_create',
  group: 'office',
  description:
    'Legt eine Excel-Mappe mit Kopfzeile, Spaltenbreiten und Filter an und öffnet sie. Für ' +
    '"mach mir eine Tabelle für X" oder "schreib das in eine Excel". Zahlen und Datumsangaben ' +
    'werden als solche eingetragen, nicht als Text.',
  schema: z.object({
    topic: z.string().describe('Wofür die Tabelle ist, in einem Satz.'),
    title: z.string().optional().describe('Name der Datei.'),
    sheetName: z.string().optional().describe('Name des Registers, höchstens 31 Zeichen.'),
    header: z.array(z.string()).optional().describe('Die Spaltenüberschriften.'),
    rows: z
      .array(z.array(z.string()))
      .optional()
      .describe('Je Zeile eine Liste von Zellen, in der Reihenfolge der Spalten.'),
    folder: folderField,
    open: openField
  }),
  spokenHint: 'Mhm.',
  async execute({ topic, title, sheetName, header, rows, folder, open }, ctx) {
    ctx.setState('thinking')

    let name: string
    let sheet: Sheet

    if (header && header.length > 0) {
      sheet = {
        name: sheetName?.trim() || 'Tabelle1',
        header: header.map(String),
        rows: toRows(rows, header.length)
      }
      name = (title ?? topic).trim()
    } else {
      const drafted = await outlineSheet(topic)
      sheet = {
        ...drafted.sheet,
        name: sheetName?.trim() || drafted.sheet.name
      }
      name = title?.trim() || drafted.title
    }

    const file = await saveOfficeFile(
      buildXlsx({ title: name, sheets: [sheet] }),
      name,
      '.xlsx',
      folder as OfficeFolder | undefined,
      open ?? true
    )

    return {
      datei: file.name,
      ordner: file.folder,
      spalten: sheet.header.length,
      zeilen: sheet.rows.length,
      geöffnet: open ?? true,
      hinweis:
        'Nenne die Spalten in einem Halbsatz und sag, wie die Datei heißt. Wenn nur ein Gerüst ' +
        'entstanden ist, sag dazu, dass die Zeilen Beispiele sind.'
    }
  }
}) as ToolDefinition

export const officeTools: ToolDefinition[] = [presentation, document, spreadsheet]

/** Nur zum Testen. */
export const __internals = { coerce }
