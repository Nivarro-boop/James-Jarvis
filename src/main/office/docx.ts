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
 * Word-Dokumente schreiben.
 *
 * Der Umfang folgt dem, was aus einem gesprochenen Auftrag entstehen kann:
 * Titel, Überschriften, Absätze, Aufzählungen, Tabellen. Kein Satzspiegel, kein
 * Inhaltsverzeichnis, keine Bilder — dafür sagt niemand einen Satz, und jedes
 * dieser Dinge zöge einen weiteren Teil ins Paket.
 *
 * Zwei Fallen stecken im Format selbst und sind unten einzeln vermerkt: Eine
 * Aufzählung ohne `numbering.xml` erscheint in Word ohne Punkte, und eine
 * Tabelle als letztes Element vor `sectPr` lässt Word die Datei für beschädigt
 * halten.
 */

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

export const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

// ─────────────────────────────────────────────────────────────
// Das Modell
// ─────────────────────────────────────────────────────────────

export type DocxBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'numbered'; items: string[] }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'pagebreak' }

export interface DocxDocument {
  title: string
  /** Steht unter dem Titel, in Grau. Leer heißt: gibt es nicht. */
  subtitle?: string
  blocks: DocxBlock[]
}

// ─────────────────────────────────────────────────────────────
// Läufe: fetter Text innerhalb eines Absatzes
// ─────────────────────────────────────────────────────────────

/**
 * `**fett**` in echte Auszeichnung übersetzen.
 *
 * Kein Markdown-Ehrgeiz, sondern Schadensbegrenzung: Ein Sprachmodell, das
 * einen Absatz schreiben soll, setzt Sternchen — auch wenn im Auftrag steht,
 * es solle keine setzen. Ohne diese Stelle stünden sie wörtlich im Dokument.
 * Alles andere an Markdown bleibt unbehandelt, weil es selten genug vorkommt,
 * um nicht aufzufallen.
 */
function runs(text: string): string {
  const pieces = String(text ?? '').split(/\*\*/)
  return pieces
    .map((piece, index) => {
      if (!piece) return ''
      // Jedes zweite Stück lag zwischen einem Sternchenpaar.
      const bold = index % 2 === 1 ? '<w:rPr><w:b/></w:rPr>' : ''
      return `<w:r>${bold}<w:t xml:space="preserve">${xml(piece)}</w:t></w:r>`
    })
    .join('')
}

function paragraph(text: string, style?: string): string {
  const properties = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''
  return `<w:p>${properties}${runs(text)}</w:p>`
}

/**
 * Ein Punkt einer Aufzählung.
 *
 * `numId` verweist auf `numbering.xml`: 1 sind Punkte, 2 sind Ziffern. Ohne
 * den `numPr`-Block wäre das ein eingerückter Absatz ohne Zeichen davor —
 * genau das, was man bekommt, wenn man die Nummerierungsdatei weglässt.
 */
function listItem(text: string, numId: number): string {
  return (
    '<w:p><w:pPr><w:pStyle w:val="ListParagraph"/>' +
    `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>` +
    `</w:pPr>${runs(text)}</w:p>`
  )
}

const BORDER = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
  .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`)
  .join('')

function table(header: string[], rows: string[][]): string {
  const columns = Math.max(header.length, ...rows.map((r) => r.length), 1)

  const cell = (text: string, bold: boolean): string =>
    '<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>' +
    // Kopfzeile hinterlegt: ohne Zellfarbe ist bei einer Tabelle ohne
    // Linienstärkenunterschied nicht zu sehen, wo die Überschrift aufhört.
    (bold ? '<w:shd w:val="clear" w:color="auto" w:fill="EDF2F8"/>' : '') +
    '</w:tcPr>' +
    `<w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${runs(bold ? `**${text}**` : text)}</w:p></w:tc>`

  const row = (cells: string[], bold: boolean): string => {
    const filled = Array.from({ length: columns }, (_, i) => cells[i] ?? '')
    return `<w:tr>${filled.map((c) => cell(c, bold)).join('')}</w:tr>`
  }

  const grid = Array.from({ length: columns }, () => '<w:gridCol w:w="2000"/>').join('')

  return (
    '<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>' +
    `<w:tblBorders>${BORDER}</w:tblBorders>` +
    '<w:tblLayout w:type="fixed"/></w:tblPr>' +
    `<w:tblGrid>${grid}</w:tblGrid>` +
    (header.length > 0 ? row(header, true) : '') +
    rows.map((r) => row(r, false)).join('') +
    '</w:tbl>' +
    // Der leere Absatz ist Pflicht, nicht Geschmack: Steht eine Tabelle
    // unmittelbar vor `sectPr` oder direkt vor einer zweiten Tabelle, hält
    // Word das Dokument für beschädigt und bietet an, es zu reparieren.
    '<w:p/>'
  )
}

function block(b: DocxBlock): string {
  switch (b.kind) {
    case 'heading':
      return paragraph(b.text, `Heading${b.level}`)
    case 'paragraph':
      return paragraph(b.text)
    case 'bullets':
      return b.items.map((item) => listItem(item, 1)).join('')
    case 'numbered':
      return b.items.map((item) => listItem(item, 2)).join('')
    case 'table':
      return table(b.header ?? [], b.rows ?? [])
    case 'pagebreak':
      return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
  }
}

// ─────────────────────────────────────────────────────────────
// Die festen Teile
// ─────────────────────────────────────────────────────────────

/** A4 in Twips, Ränder wie in Words eigener Vorlage. */
const SECTION =
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1417" w:right="1417" w:bottom="1134" w:left="1417" ' +
  'w:header="708" w:footer="708" w:gutter="0"/>' +
  '<w:cols w:space="708"/><w:docGrid w:linePitch="360"/></w:sectPr>'

/**
 * Eine Formatvorlage.
 *
 * `w:uiPriority` und `w:qFormat` sind nicht bloß Zierde: Ohne sie taucht die
 * Vorlage im Vorlagenkatalog von Word nicht auf, und wer das Dokument
 * weiterbearbeitet, kann eine Überschrift nicht mehr als solche anwählen.
 */
function style(id: string, name: string, properties: string, runProperties: string): string {
  return (
    `<w:style w:type="paragraph" w:styleId="${id}">` +
    `<w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:qFormat/>` +
    (properties ? `<w:pPr>${properties}</w:pPr>` : '') +
    (runProperties ? `<w:rPr>${runProperties}</w:rPr>` : '') +
    '</w:style>'
  )
}

/** Halbe Punkte — Word rechnet Schriftgrößen in `w:sz` doppelt. */
const size = (points: number): string => `<w:sz w:val="${points * 2}"/><w:szCs w:val="${points * 2}"/>`

const STYLES = part(
  `<w:styles xmlns:w="${W}">` +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>' +
    size(11) +
    '<w:lang w:val="de-DE"/>' +
    '</w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    '</w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    style(
      'Title',
      'Title',
      '<w:spacing w:after="120"/><w:contextualSpacing/>',
      `<w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light"/>${size(28)}<w:color w:val="1F3864"/>`
    ) +
    style('Subtitle', 'Subtitle', '<w:spacing w:after="360"/>', `${size(13)}<w:color w:val="595959"/><w:i/>`) +
    style(
      'Heading1',
      'heading 1',
      '<w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/>',
      `<w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light"/>${size(18)}<w:color w:val="2F5496"/>`
    ) +
    style(
      'Heading2',
      'heading 2',
      '<w:keepNext/><w:spacing w:before="280" w:after="100"/><w:outlineLvl w:val="1"/>',
      `<w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light"/>${size(14)}<w:color w:val="2F5496"/>`
    ) +
    style(
      'Heading3',
      'heading 3',
      '<w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="2"/>',
      `${size(12)}<w:b/><w:color w:val="1F3864"/>`
    ) +
    style('ListParagraph', 'List Paragraph', '<w:spacing w:after="60"/><w:contextualSpacing/>', '') +
    '</w:styles>'
)

/**
 * Die Nummerierung.
 *
 * Zwei Definitionen, mehr braucht es nicht: Punkte und Ziffern, je eine Ebene.
 * Das Aufzählungszeichen ist U+F0B7 in der Schrift Symbol — der Kringel aus dem
 * privaten Bereich, den Word selbst benutzt. Steht dort ein gewöhnlicher
 * Bullet-Punkt ohne die passende `rFonts`-Angabe, zeigt Word je nach
 * Schriftinstallation ein Kästchen.
 */
const NUMBERING = part(
  `<w:numbering xmlns:w="${W}">` +
    '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>' +
    '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/>' +
    '<w:lvlText w:val="&#xF0B7;"/><w:lvlJc w:val="left"/>' +
    '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>' +
    '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr>' +
    '</w:lvl></w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>' +
    '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/>' +
    '<w:lvlText w:val="%1."/><w:lvlJc w:val="left"/>' +
    '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>' +
    '</w:lvl></w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
    '</w:numbering>'
)

// ─────────────────────────────────────────────────────────────

export function buildDocx(doc: DocxDocument, when: Date = new Date()): Buffer {
  const body =
    paragraph(doc.title, 'Title') +
    (doc.subtitle ? paragraph(doc.subtitle, 'Subtitle') : '') +
    doc.blocks.map(block).join('') +
    SECTION

  const document = part(
    `<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`
  )

  const parts: Part[] = [
    {
      path: '_rels/.rels',
      content: relationships([
        { id: 'rId1', type: REL.officeDocument, target: 'word/document.xml' },
        { id: 'rId2', type: REL.coreProperties, target: 'docProps/core.xml' },
        { id: 'rId3', type: REL.extendedProperties, target: 'docProps/app.xml' }
      ])
    },
    {
      path: 'word/_rels/document.xml.rels',
      content: relationships([
        { id: 'rId1', type: REL.styles, target: 'styles.xml' },
        { id: 'rId2', type: REL.numbering, target: 'numbering.xml' }
      ])
    },
    {
      path: 'word/document.xml',
      content: document,
      contentType: `${DOCX_CONTENT_TYPE}.main+xml`
    },
    {
      path: 'word/styles.xml',
      content: STYLES,
      contentType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'
    },
    {
      path: 'word/numbering.xml',
      content: NUMBERING,
      contentType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml'
    },
    {
      path: 'docProps/core.xml',
      content: coreProperties(doc.title, when),
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
