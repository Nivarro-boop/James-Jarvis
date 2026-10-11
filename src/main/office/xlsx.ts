import {
  CONTENT_TYPE,
  REL,
  coreProperties,
  extendedProperties,
  pack,
  part,
  relationships,
  xml,
  type Part
} from './ooxml'

/**
 * Excel-Mappen schreiben.
 *
 * Bewusst mit `inlineStr` statt der sonst üblichen `sharedStrings.xml`. Der
 * gemeinsame Zeichenkettenspeicher lohnt sich, wenn dieselben Wörter tausendfach
 * vorkommen — bei einer Tabelle, die aus einem gesprochenen Satz entsteht, ist er
 * ein zusätzlicher Teil im Paket, ein zweiter Index, der stimmen muss, und keine
 * einzige gesparte Kilobyte.
 *
 * Zwei Dinge sind hier nicht verhandelbar und unten vermerkt: die Reihenfolge
 * der Kinder in `worksheet.xml` und die ersten beiden Füllungen in `styles.xml`.
 * Beides quittiert Excel sonst mit der Reparaturfrage statt mit einer Meldung,
 * die sagt, was los ist.
 */

const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

// ─────────────────────────────────────────────────────────────
// Das Modell
// ─────────────────────────────────────────────────────────────

/**
 * Was in einer Zelle stehen kann.
 *
 * `null` ist ausdrücklich erlaubt und bedeutet leer — nicht der Text „null".
 * Eine Tabelle mit Lücken ist der Normalfall, und ohne diesen Wert müsste
 * jeder Aufrufer sich einen eigenen Platzhalter ausdenken.
 */
export type CellValue = string | number | boolean | Date | null

export interface Sheet {
  /** Registername. Excel erlaubt 31 Zeichen und kein :\/?*[] — wird gekürzt. */
  name: string
  /** Erste Zeile, fett und hinterlegt. Leer heißt: keine Kopfzeile. */
  header: string[]
  rows: CellValue[][]
}

export interface Workbook {
  title: string
  sheets: Sheet[]
}

// ─────────────────────────────────────────────────────────────
// Zellen
// ─────────────────────────────────────────────────────────────

/** Spaltennummer zu Buchstaben: 1 → A, 27 → AA. */
export function columnName(index: number): string {
  let name = ''
  let n = index
  while (n > 0) {
    const rest = (n - 1) % 26
    name = String.fromCharCode(65 + rest) + name
    n = Math.floor((n - 1) / 26)
  }
  return name || 'A'
}

/**
 * Excels Datumszahl.
 *
 * Gezählt wird ab dem 30. Dezember 1899, nicht ab dem 31. — der eine Tag
 * Unterschied ist Lotus-1-2-3-Erbe: dort galt 1900 fälschlich als Schaltjahr,
 * und Excel hat den Fehler zur Wahrung der Kompatibilität übernommen. Wer ab
 * dem 31. rechnet, liegt bei jedem Datum nach dem 28. Februar 1900 um einen
 * Tag daneben.
 */
const EPOCH = Date.UTC(1899, 11, 30)

function serialDate(value: Date): number {
  const days = (value.getTime() - value.getTimezoneOffset() * 60_000 - EPOCH) / 86_400_000
  return Math.round(days * 100_000) / 100_000
}

/** Formatindizes aus `cellXfs` unten. */
const STYLE = { plain: 0, header: 1, date: 2, decimal: 3 } as const

function cell(reference: string, value: CellValue, styleIndex: number): string {
  if (value === null || value === undefined || value === '') {
    // Eine Zelle nur wegen ihrer Formatierung: ohne `s` wäre sie überflüssig,
    // mit `s` trägt sie den Rahmen der Kopfzeile weiter.
    return styleIndex === STYLE.plain ? '' : `<c r="${reference}" s="${styleIndex}"/>`
  }

  if (value instanceof Date) {
    return `<c r="${reference}" s="${STYLE.date}"><v>${serialDate(value)}</v></c>`
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const style = Number.isInteger(value) ? styleIndex : STYLE.decimal
    return `<c r="${reference}" s="${style}"><v>${value}</v></c>`
  }

  if (typeof value === 'boolean') {
    return `<c r="${reference}" s="${styleIndex}" t="b"><v>${value ? 1 : 0}</v></c>`
  }

  return (
    `<c r="${reference}" s="${styleIndex}" t="inlineStr">` +
    `<is><t xml:space="preserve">${xml(String(value))}</t></is></c>`
  )
}

function row(values: CellValue[], index: number, styleIndex: number): string {
  const cells = values
    .map((value, column) => cell(`${columnName(column + 1)}${index}`, value, styleIndex))
    .join('')
  return `<row r="${index}">${cells}</row>`
}

/**
 * Spaltenbreiten aus dem Inhalt schätzen.
 *
 * Ohne das steht in jeder Zahlenspalte `########` und jeder Text ist
 * abgeschnitten — die Mappe sieht dann kaputt aus, obwohl sie es nicht ist.
 * Gemessen wird in Zeichenbreiten der Standardschrift; zwei Zeichen Luft
 * kommen dazu, weil Calibri proportional ist und Großbuchstaben breiter sind.
 */
function columnWidths(sheet: Sheet): string {
  const columns = Math.max(sheet.header.length, ...sheet.rows.map((r) => r.length), 1)

  const entries: string[] = []
  for (let c = 0; c < columns; c++) {
    let widest = String(sheet.header[c] ?? '').length
    for (const r of sheet.rows) {
      const value = r[c]
      const text =
        value instanceof Date
          ? 10
          : value === null || value === undefined
            ? 0
            : String(value).length
      widest = Math.max(widest, typeof text === 'number' ? text : 0)
    }
    const width = Math.min(60, Math.max(9, widest + 2))
    entries.push(`<col min="${c + 1}" max="${c + 1}" width="${width}" customWidth="1"/>`)
  }
  return `<cols>${entries.join('')}</cols>`
}

function worksheet(sheet: Sheet): string {
  const hasHeader = sheet.header.length > 0
  const body =
    (hasHeader ? row(sheet.header, 1, STYLE.header) : '') +
    sheet.rows.map((values, i) => row(values, i + (hasHeader ? 2 : 1), STYLE.plain)).join('')

  const columns = Math.max(sheet.header.length, ...sheet.rows.map((r) => r.length), 1)
  const lastRow = sheet.rows.length + (hasHeader ? 1 : 0) || 1
  const span = `A1:${columnName(columns)}${lastRow}`

  /*
   * Kopfzeile festfrieren, damit sie beim Blättern stehen bleibt.
   *
   * `state="frozen"` allein reicht nicht — ohne `topLeftCell` und `activePane`
   * friert Excel zwar, springt aber beim Öffnen an eine andere Stelle.
   */
  const view = hasHeader
    ? '<sheetViews><sheetView workbookViewId="0">' +
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      '</sheetView></sheetViews>'
    : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'

  /*
   * Die Reihenfolge unten ist vom Schema vorgeschrieben und nicht frei:
   * dimension, sheetViews, sheetFormatPr, cols, sheetData, autoFilter.
   * Steht `cols` hinter `sheetData`, ist die Datei ungültig — und Excel sagt
   * dazu nur, dass es sie reparieren möchte.
   */
  return part(
    `<worksheet xmlns="${S}" xmlns:r="${R}">` +
      `<dimension ref="${span}"/>` +
      view +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      columnWidths(sheet) +
      `<sheetData>${body}</sheetData>` +
      (hasHeader && sheet.rows.length > 0 ? `<autoFilter ref="${span}"/>` : '') +
      '</worksheet>'
  )
}

/** Excel verbietet einige Zeichen im Registernamen und begrenzt ihn auf 31. */
function sheetName(name: string, index: number): string {
  const clean = String(name ?? '')
    .replace(/[:\\/?*[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31)
  return clean || `Tabelle${index + 1}`
}

// ─────────────────────────────────────────────────────────────
// Formate
// ─────────────────────────────────────────────────────────────

/**
 * Die Formattabelle.
 *
 * Füllung 0 muss `none` sein und Füllung 1 `gray125` — das ist keine
 * Konvention, sondern eine feste Annahme in Excel selbst. Steht dort etwas
 * anderes, bekommen alle folgenden Füllungen den falschen Index und die
 * Kopfzeile ist grau gestreift statt blau hinterlegt.
 */
const STYLES = part(
  `<styleSheet xmlns="${S}">` +
    '<fonts count="2">' +
    '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><b/><sz val="11"/><color rgb="FF1F3864"/><name val="Calibri"/><family val="2"/></font>' +
    '</fonts>' +
    '<fills count="3">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid">' +
    '<fgColor rgb="FFEDF2F8"/><bgColor indexed="64"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="2">' +
    '<border><left/><right/><top/><bottom/><diagonal/></border>' +
    '<border><left/><right/><top/>' +
    '<bottom style="thin"><color rgb="FF8EA9DB"/></bottom><diagonal/></border>' +
    '</borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="4">' +
    // 0 — gewöhnlich
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    // 1 — Kopfzeile
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" ' +
    'applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>' +
    // 2 — Datum, numFmtId 14 ist Excels eingebautes TT.MM.JJJJ
    '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    // 3 — Zahl mit zwei Nachkommastellen, numFmtId 4 ist #.##0,00
    '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Standard" xfId="0" builtinId="0"/></cellStyles>' +
    '<dxfs count="0"/>' +
    '</styleSheet>'
)

// ─────────────────────────────────────────────────────────────

export function buildXlsx(book: Workbook, when: Date = new Date()): Buffer {
  const sheets = book.sheets.length > 0 ? book.sheets : [{ name: 'Tabelle1', header: [], rows: [] }]

  const named = sheets.map((sheet, index) => ({
    ...sheet,
    name: sheetName(sheet.name, index)
  }))

  const workbook = part(
    `<workbook xmlns="${S}" xmlns:r="${R}"><sheets>` +
      named
        .map(
          (sheet, i) =>
            `<sheet name="${xml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
        )
        .join('') +
      '</sheets></workbook>'
  )

  // Die Blätter belegen rId1..rIdN, die Formattabelle bekommt die nächste
  // freie Nummer. Fest verdrahtet ginge das nur bei genau einem Blatt.
  const stylesId = `rId${named.length + 1}`

  const parts: Part[] = [
    {
      path: '_rels/.rels',
      content: relationships([
        { id: 'rId1', type: REL.officeDocument, target: 'xl/workbook.xml' },
        { id: 'rId2', type: REL.coreProperties, target: 'docProps/core.xml' },
        { id: 'rId3', type: REL.extendedProperties, target: 'docProps/app.xml' }
      ])
    },
    {
      path: 'xl/_rels/workbook.xml.rels',
      content: relationships([
        ...named.map((_, i) => ({
          id: `rId${i + 1}`,
          type: REL.worksheet,
          target: `worksheets/sheet${i + 1}.xml`
        })),
        { id: stylesId, type: REL.styles, target: 'styles.xml' }
      ])
    },
    {
      path: 'xl/workbook.xml',
      content: workbook,
      contentType: `${XLSX_CONTENT_TYPE}.main+xml`
    },
    ...named.map((sheet, i) => ({
      path: `xl/worksheets/sheet${i + 1}.xml`,
      content: worksheet(sheet),
      contentType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'
    })),
    {
      path: 'xl/styles.xml',
      content: STYLES,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml'
    },
    {
      path: 'docProps/core.xml',
      content: coreProperties(book.title, when),
      contentType: CONTENT_TYPE.core
    },
    {
      path: 'docProps/app.xml',
      content: extendedProperties('James-Jarvis'),
      contentType: CONTENT_TYPE.extended
    }
  ]

  return pack(parts, when)
}

/** Nur zum Testen. */
export const __internals = { columnName, serialDate, sheetName }
