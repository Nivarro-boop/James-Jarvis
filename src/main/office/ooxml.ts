import { zip, type ZipEntry } from './zip'

/**
 * Was docx, xlsx und pptx gemeinsam haben.
 *
 * Alle drei sind OPC-Pakete: ein ZIP, in dem eine Datei sagt, welche Sorte
 * Inhalt wo liegt (`[Content_Types].xml`), und Beziehungsdateien sagen, welcher
 * Teil auf welchen zeigt. Erst darüber liegt das eigentliche Format. Diese
 * untere Hälfte ist für alle drei dieselbe und steht deshalb hier einmal.
 *
 * Die Regel, an der man sonst scheitert: Jeder Teil, der kein `.rels` und kein
 * schlichtes `.xml` ist, braucht einen Override im Content-Types — fehlt er,
 * öffnet Word die Datei nicht, sondern bietet an, sie zu reparieren. Deshalb
 * nimmt `pack()` die Overrides nicht entgegen, sondern leitet sie aus den
 * Teilen selbst ab.
 */

// ─────────────────────────────────────────────────────────────
// XML
// ─────────────────────────────────────────────────────────────

/**
 * Text so absichern, dass er in XML stehen darf.
 *
 * Die letzte Zeile ist die, die man vergisst: Steuerzeichen sind in XML 1.0
 * schlicht verboten — auch als Entität. Ein Modell, das eine vertikale
 * Tabulatur oder ein Nullbyte in einen Absatz schreibt, erzeugt sonst eine
 * Datei, die kein Leser aufmacht. Tabulator, Zeilenvorschub und Wagenrücklauf
 * sind erlaubt und bleiben.
 */
export function xml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
}

/** Der Kopf, den jeder Teil eines Office-Pakets trägt. */
export const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'

/** Ein XML-Teil aus Kopf und Rumpf. */
export function part(body: string): string {
  return XML_HEADER + body
}

// ─────────────────────────────────────────────────────────────
// Beziehungen
// ─────────────────────────────────────────────────────────────

const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'

/** Kurzform für die langen Beziehungstypen. */
export const REL = {
  officeDocument:
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  styles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
  numbering: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering',
  worksheet: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
  theme: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
  slideMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
  slideLayout: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
  slide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  coreProperties:
    'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  extendedProperties:
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties'
} as const

export interface Relationship {
  id: string
  type: string
  target: string
}

export function relationships(items: Relationship[]): string {
  const lines = items
    .map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${xml(r.target)}"/>`)
    .join('')
  return part(`<Relationships xmlns="${REL_NS}">${lines}</Relationships>`)
}

// ─────────────────────────────────────────────────────────────
// Content-Types
// ─────────────────────────────────────────────────────────────

const TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'

/**
 * Welcher Teil welche Sorte Inhalt ist.
 *
 * Der Schlüssel ist der Pfad im Paket ohne führenden Schrägstrich — genau so,
 * wie er auch im ZIP steht. Den Schrägstrich setzt `contentTypes()`, damit er
 * nicht an dreißig Stellen einzeln richtig sein muss.
 */
export type OverrideMap = Record<string, string>

function contentTypes(overrides: OverrideMap): string {
  const defaults = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    // Für eingebettete Bilder — noch schreibt niemand welche, aber der
    // Standardeintrag kostet nichts und fehlt sonst genau dann, wenn es soweit ist.
    '<Default Extension="png" ContentType="image/png"/>',
    '<Default Extension="jpeg" ContentType="image/jpeg"/>'
  ].join('')

  const lines = Object.entries(overrides)
    .map(([path, type]) => `<Override PartName="/${xml(path)}" ContentType="${type}"/>`)
    .join('')

  return part(`<Types xmlns="${TYPES_NS}">${defaults}${lines}</Types>`)
}

// ─────────────────────────────────────────────────────────────
// Dokumenteigenschaften
// ─────────────────────────────────────────────────────────────

export const CONTENT_TYPE = {
  core: 'application/vnd.openxmlformats-package.core-properties+xml',
  extended: 'application/vnd.openxmlformats-officedocument.extended-properties+xml'
} as const

/**
 * Titel und Urheber, wie sie in den Dateieigenschaften stehen.
 *
 * Kein Beiwerk: Ohne `docProps/core.xml` zeigt der Windows-Explorer in der
 * Spalte „Titel" nichts an und PowerPoint benennt die Datei in der Zuletzt-
 * geöffnet-Liste nach dem Dateinamen statt nach dem, worum es geht.
 */
export function coreProperties(title: string, when: Date): string {
  const stamp = when.toISOString().replace(/\.\d{3}Z$/, 'Z')
  return part(
    '<cp:coreProperties ' +
      'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
      'xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `<dc:title>${xml(title)}</dc:title>` +
      '<dc:creator>James-Jarvis</dc:creator>' +
      '<cp:lastModifiedBy>James-Jarvis</cp:lastModifiedBy>' +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>` +
      '</cp:coreProperties>'
  )
}

/** Das Programm, das die Datei geschrieben hat. */
export function extendedProperties(application: string): string {
  return part(
    '<Properties ' +
      'xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
      'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      `<Application>${xml(application)}</Application>` +
      '<Company></Company>' +
      '</Properties>'
  )
}

// ─────────────────────────────────────────────────────────────
// Packen
// ─────────────────────────────────────────────────────────────

/** Ein Teil des Pakets: Pfad, Inhalt und — falls nötig — sein Content-Type. */
export interface Part {
  path: string
  content: string | Buffer
  /** Fehlt er, gilt der Standardeintrag der Endung. Für `.rels` ist das richtig. */
  contentType?: string
}

/**
 * Aus Teilen ein fertiges Office-Paket machen.
 *
 * `[Content_Types].xml` entsteht dabei aus den Teilen selbst und steht als
 * erster Eintrag im Archiv. Beides ist keine Formsache: Ein Teil ohne Eintrag
 * ist für Word nicht vorhanden, und ein Content-Types, das erst hinter
 * hundert Folien steht, zwingt jeden Leser, das Archiv zweimal zu lesen.
 */
export function pack(parts: Part[], when: Date = new Date()): Buffer {
  const overrides: OverrideMap = {}
  for (const p of parts) {
    if (p.contentType) overrides[p.path] = p.contentType
  }

  const entries: ZipEntry[] = [
    { path: '[Content_Types].xml', data: Buffer.from(contentTypes(overrides), 'utf-8') },
    ...parts.map((p) => ({
      path: p.path,
      data: typeof p.content === 'string' ? Buffer.from(p.content, 'utf-8') : p.content
    }))
  ]

  return zip(entries, when)
}

/**
 * Ein Dateiname, der unter Windows auch wirklich anlegbar ist.
 *
 * Gedacht für Namen, die aus einem gesprochenen Satz stammen — „Angebot für
 * Müller & Söhne: Q3" ist ein plausibler Titel und ein unmöglicher Dateiname.
 * Die Endung hängt der Aufrufer an, nicht diese Funktion.
 */
export function safeFileName(title: string, fallback: string): string {
  const clean = String(title ?? '')
    .replace(/[<>:"/\\|?*]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows mag keinen Punkt am Ende und keine Leerzeichen davor.
    .replace(/[. ]+$/, '')

  if (!clean) return fallback
  // Der Pfad insgesamt darf 260 Zeichen haben; der Name allein bleibt deutlich
  // darunter, damit auch ein tief liegender Ordner noch passt.
  return clean.length > 120 ? clean.slice(0, 120).trim() : clean
}
