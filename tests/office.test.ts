import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { inflateRawSync } from 'node:zlib'
import { buildDocx } from '@main/office/docx'
import { buildXlsx, __internals as xlsxInternals } from '@main/office/xlsx'
import { buildPptx } from '@main/office/pptx'
import { safeFileName, xml } from '@main/office/ooxml'
import { __internals as zipInternals } from '@main/office/zip'

/**
 * Die drei Office-Formate.
 *
 * Warum diese Datei nötig ist: Eine kaputte docx meldet sich nicht mit einer
 * Fehlermeldung, sondern mit Words Frage, ob es die Datei reparieren soll. Das
 * fällt beim Entwickeln nicht auf — es fällt dem Nutzer auf, Wochen später,
 * mit einer Datei in der Hand, die er gerade gebraucht hätte.
 *
 * Geprüft wird deshalb auf drei Ebenen, und zwar in der Reihenfolge, in der
 * ein Leser scheitert: Kommt das Archiv überhaupt wieder auf? Sind alle Teile
 * da, die das Format verlangt? Und zeigt jede Beziehung auf einen Teil, den es
 * wirklich gibt?
 *
 * Was hier ausdrücklich nicht geprüft wird, ist die Gültigkeit gegen das
 * XML-Schema — dafür bräuchte es Office selbst. Die Ebenen darunter fangen
 * jeden Fehler ab, den man beim Umbauen dieser Dateien tatsächlich macht.
 */

// ─────────────────────────────────────────────────────────────
// Ein ZIP-Leser, gerade groß genug zum Prüfen
// ─────────────────────────────────────────────────────────────

interface ReadEntry {
  path: string
  data: Buffer
  method: number
}

/**
 * Das Archiv über sein Zentralverzeichnis lesen, nicht über die lokalen Köpfe.
 *
 * Das ist der Weg, den auch jeder echte Leser nimmt — und nur so fällt auf,
 * wenn Versatz oder Länge im Verzeichnis nicht zu dem passen, was tatsächlich
 * in der Datei steht.
 */
function unzip(buffer: Buffer): ReadEntry[] {
  // Das Ende-Kennzeichen von hinten suchen; ein Archivkommentar gibt es hier
  // nicht, aber die Suche kostet nichts und ist der übliche Weg.
  let eocd = -1
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  assert.ok(eocd >= 0, 'Kein Ende-Kennzeichen gefunden — das ist kein ZIP.')

  const count = buffer.readUInt16LE(eocd + 10)
  const directorySize = buffer.readUInt32LE(eocd + 12)
  const directoryStart = buffer.readUInt32LE(eocd + 16)

  assert.equal(
    directoryStart + directorySize,
    eocd,
    'Verzeichnis und Ende-Kennzeichen stoßen nicht aneinander.'
  )

  const entries: ReadEntry[] = []
  let cursor = directoryStart

  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, `Eintrag ${i} hat keine Kennung.`)

    const method = buffer.readUInt16LE(cursor + 10)
    const crc = buffer.readUInt32LE(cursor + 16)
    const packedSize = buffer.readUInt32LE(cursor + 20)
    const rawSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const path = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf-8')

    // Jetzt dieselbe Datei über ihren lokalen Kopf.
    assert.equal(
      buffer.readUInt32LE(localOffset),
      0x04034b50,
      `${path}: lokaler Kopf steht nicht, wo das Verzeichnis ihn erwartet.`
    )
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const packed = buffer.subarray(dataStart, dataStart + packedSize)

    const data = method === 8 ? inflateRawSync(packed) : Buffer.from(packed)

    assert.equal(data.length, rawSize, `${path}: Länge stimmt nicht.`)
    assert.equal(zipInternals.crc32(data), crc, `${path}: Prüfsumme stimmt nicht.`)

    entries.push({ path, data, method })
    cursor += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

function asMap(buffer: Buffer): Map<string, string> {
  const map = new Map<string, string>()
  for (const entry of unzip(buffer)) map.set(entry.path, entry.data.toString('utf-8'))
  return map
}

/**
 * Jede Beziehung muss auf einen vorhandenen Teil zeigen.
 *
 * Das ist der Fehler, den man beim Umbauen wirklich macht: ein `../` zu viel
 * oder zu wenig im Ziel. Er fällt in keinem einzelnen Teil auf, sondern erst,
 * wenn PowerPoint dem Verweis folgen will.
 */
function checkRelationships(parts: Map<string, string>): void {
  for (const [path, content] of parts) {
    if (!path.endsWith('.rels')) continue

    // `word/_rels/document.xml.rels` beschreibt Ziele relativ zu `word/`.
    const base = path.slice(0, path.lastIndexOf('_rels/'))

    for (const match of content.matchAll(/Target="([^"]+)"/g)) {
      const target = match[1]
      if (/^https?:/.test(target)) continue

      // Relativen Pfad auflösen, ohne node:path — die Trennzeichen im Paket
      // sind immer Schrägstriche, auch unter Windows.
      const segments = (base + target).split('/')
      const stack: string[] = []
      for (const segment of segments) {
        if (segment === '..') stack.pop()
        else if (segment !== '.' && segment !== '') stack.push(segment)
      }
      const resolved = stack.join('/')

      assert.ok(
        parts.has(resolved),
        `${path}: Beziehung zeigt auf ${resolved}, aber der Teil fehlt im Paket.`
      )
    }
  }
}

/** Jeder Teil, der kein `.rels` ist, braucht einen Eintrag im Content-Types. */
function checkContentTypes(parts: Map<string, string>): void {
  const types = parts.get('[Content_Types].xml')
  assert.ok(types, 'Das Paket hat kein [Content_Types].xml.')

  for (const path of parts.keys()) {
    if (path === '[Content_Types].xml' || path.endsWith('.rels')) continue
    assert.ok(
      types!.includes(`PartName="/${path}"`),
      `${path} steht nicht im Content-Types und ist damit für Office nicht vorhanden.`
    )
  }
}

/**
 * Ein grober Blick auf die Wohlgeformtheit.
 *
 * Kein Parser — den bringt Node nicht mit —, aber die beiden Fehler, die beim
 * Zusammenbauen von XML aus Zeichenketten entstehen, findet er: eine
 * unterschlagene Entität und ein Steuerzeichen im Text.
 */
function checkXml(parts: Map<string, string>): void {
  for (const [path, content] of parts) {
    if (!path.endsWith('.xml') && !path.endsWith('.rels')) continue

    assert.ok(content.startsWith('<?xml '), `${path}: fehlender XML-Kopf.`)

    // Ein `&`, dem keine Entität folgt, ist immer ein Fehler.
    assert.equal(
      /&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);)/.test(content),
      false,
      `${path}: enthält ein nicht maskiertes Kaufmanns-Und.`
    )

    // eslint-disable-next-line no-control-regex
    assert.equal(
      /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(content),
      false,
      `${path}: enthält ein in XML verbotenes Steuerzeichen.`
    )

    const open = (content.match(/</g) ?? []).length
    const close = (content.match(/>/g) ?? []).length
    assert.equal(open, close, `${path}: spitze Klammern sind nicht ausgeglichen.`)
  }
}

/** Der Satz Prüfungen, den jedes der drei Formate bestehen muss. */
function checkPackage(buffer: Buffer, required: string[]): Map<string, string> {
  const parts = asMap(buffer)

  assert.equal(
    unzip(buffer)[0].path,
    '[Content_Types].xml',
    'Das Content-Types muss der erste Eintrag im Archiv sein.'
  )

  for (const path of required) {
    assert.ok(parts.has(path), `Der Teil ${path} fehlt im Paket.`)
  }

  checkContentTypes(parts)
  checkRelationships(parts)
  checkXml(parts)
  return parts
}

const WHEN = new Date('2026-08-11T10:00:00Z')

// ─────────────────────────────────────────────────────────────

describe('ZIP-Schreiber', () => {
  it('rechnet die Prüfsumme wie der Standard', () => {
    // Der bekannte CRC-32 von "123456789". Steht in jeder Beschreibung des
    // Verfahrens und fängt jeden vertauschten Schiebeoperator.
    assert.equal(zipInternals.crc32(Buffer.from('123456789')), 0xcbf43926)
    assert.equal(zipInternals.crc32(Buffer.alloc(0)), 0)
  })

  it('drückt Datum und Uhrzeit im MS-DOS-Format aus', () => {
    const { time, date } = zipInternals.dosTimestamp(new Date(2026, 7, 11, 13, 45, 30))
    assert.equal((date >> 9) + 1980, 2026)
    assert.equal((date >> 5) & 0x0f, 8)
    assert.equal(date & 0x1f, 11)
    assert.equal(time >> 11, 13)
    assert.equal((time >> 5) & 0x3f, 45)
  })

  it('kann kein Datum vor 1980 ausdrücken und rutscht nicht ins Negative', () => {
    const { date } = zipInternals.dosTimestamp(new Date(1971, 0, 1))
    assert.ok(date >= 0, 'Das Jahr lief unter 1980 in den negativen Bereich.')
  })
})

describe('XML-Absicherung', () => {
  it('maskiert alle fünf Sonderzeichen', () => {
    assert.equal(xml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;')
  })

  it('wirft Steuerzeichen weg, behält aber Umbruch und Tabulator', () => {
    assert.equal(xml('a bc'), 'abc')
    assert.equal(xml('a\tb\nc\rd'), 'a\tb\nc\rd')
  })

  it('macht aus einem gesprochenen Titel einen möglichen Dateinamen', () => {
    // Der Doppelpunkt wird zum Leerzeichen und fällt dann mit dem danach
    // zusammen — zwei Leerzeichen hintereinander wären selbst ein Schönheitsfehler.
    assert.equal(safeFileName('Angebot für Müller & Söhne: Q3', 'x'), 'Angebot für Müller & Söhne Q3')
    assert.equal(safeFileName('   ', 'Ersatz'), 'Ersatz')
    assert.equal(safeFileName('Bericht.', 'x'), 'Bericht')
    assert.ok(safeFileName('a'.repeat(400), 'x').length <= 120)
  })
})

describe('docx', () => {
  const buffer = buildDocx(
    {
      title: 'Bericht & "Ausblick"',
      subtitle: 'Untertitel',
      blocks: [
        { kind: 'heading', level: 1, text: 'Erster Abschnitt' },
        { kind: 'paragraph', text: 'Ein Absatz mit **fett** darin und <spitzen> Klammern.' },
        { kind: 'bullets', items: ['eins', 'zwei'] },
        { kind: 'numbered', items: ['erstens'] },
        { kind: 'table', header: ['A', 'B'], rows: [['1', '2']] },
        { kind: 'pagebreak' }
      ]
    },
    WHEN
  )

  const parts = checkPackage(buffer, [
    '_rels/.rels',
    'word/document.xml',
    'word/styles.xml',
    'word/numbering.xml',
    'word/_rels/document.xml.rels',
    'docProps/core.xml'
  ])

  const document = parts.get('word/document.xml')!

  it('setzt fetten Text als eigenen Lauf statt als Sternchen', () => {
    assert.ok(document.includes('<w:b/>'), 'Keine Fettauszeichnung erzeugt.')
    assert.equal(document.includes('**'), false, 'Die Sternchen stehen noch im Dokument.')
  })

  it('hängt hinter jede Tabelle einen Absatz', () => {
    // Ohne ihn hält Word das Dokument für beschädigt, wenn die Tabelle
    // unmittelbar vor `sectPr` steht.
    assert.ok(document.includes('</w:tbl><w:p/>'), 'Nach der Tabelle fehlt der leere Absatz.')
  })

  it('verweist Aufzählungen auf die beiden Nummerierungen', () => {
    assert.ok(document.includes('<w:numId w:val="1"/>'), 'Punkte fehlen.')
    assert.ok(document.includes('<w:numId w:val="2"/>'), 'Ziffern fehlen.')
    const numbering = parts.get('word/numbering.xml')!
    assert.ok(numbering.includes('w:numId="1"') && numbering.includes('w:numId="2"'))
  })

  it('schließt den Rumpf mit den Seitenmaßen ab', () => {
    assert.ok(document.includes('<w:sectPr>'), 'Ohne sectPr fehlt das Seitenformat.')
  })
})

describe('xlsx', () => {
  const buffer = buildXlsx(
    {
      title: 'Mappe',
      sheets: [
        {
          name: 'Ausgaben',
          header: ['Datum', 'Zweck', 'Betrag'],
          rows: [
            [new Date(2026, 7, 1), 'Miete & Strom', 1240.5],
            [null, 'Leerzeile', null]
          ]
        },
        { name: 'Zweites: Blatt/mit*Zeichen', header: [], rows: [['x']] }
      ]
    },
    WHEN
  )

  const parts = checkPackage(buffer, [
    '_rels/.rels',
    'xl/workbook.xml',
    'xl/worksheets/sheet1.xml',
    'xl/worksheets/sheet2.xml',
    'xl/styles.xml',
    'xl/_rels/workbook.xml.rels'
  ])

  it('gibt der Formattabelle eine Kennung hinter allen Blättern', () => {
    // Bei zwei Blättern belegen diese rId1 und rId2 — die Formattabelle muss
    // rId3 bekommen, sonst überschreibt sie eines davon.
    const rels = parts.get('xl/_rels/workbook.xml.rels')!
    assert.ok(rels.includes('Id="rId3"') && rels.includes('styles.xml'))
    assert.ok(rels.includes('worksheets/sheet2.xml'))
  })

  it('hält die vom Schema vorgeschriebene Reihenfolge im Blatt ein', () => {
    const sheet = parts.get('xl/worksheets/sheet1.xml')!
    const order = ['<dimension', '<sheetViews', '<sheetFormatPr', '<cols', '<sheetData', '<autoFilter']
    let last = -1
    for (const tag of order) {
      const at = sheet.indexOf(tag)
      assert.ok(at > last, `${tag} steht an der falschen Stelle — Excel lehnt das ab.`)
      last = at
    }
  })

  it('schreibt Zahlen und Datumsangaben als Werte, nicht als Text', () => {
    const sheet = parts.get('xl/worksheets/sheet1.xml')!
    assert.ok(sheet.includes('<v>1240.5</v>'), 'Die Zahl steht nicht als Zahl in der Zelle.')
    // 1. August 2026 ist Tag 46235 nach Excels Zählung ab dem 30.12.1899.
    assert.ok(sheet.includes('<v>46235</v>'), 'Das Datum wurde nicht in Excels Tageszahl umgerechnet.')
  })

  it('beginnt die Füllungen mit none und gray125', () => {
    // Excel nimmt diese beiden Plätze als gegeben an. Steht dort etwas
    // anderes, verrutschen alle folgenden Füllungen um einen Index.
    const styles = parts.get('xl/styles.xml')!
    const none = styles.indexOf('patternType="none"')
    const gray = styles.indexOf('patternType="gray125"')
    const solid = styles.indexOf('patternType="solid"')
    assert.ok(none >= 0 && gray > none && solid > gray)
  })

  it('putzt Registernamen, die Excel nicht annimmt', () => {
    // Nur die Namen selbst prüfen: Die Namensräume oben in der Datei sind
    // Adressen und stecken voller Schrägstriche.
    const workbook = parts.get('xl/workbook.xml')!
    const names = [...workbook.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1])

    assert.deepEqual(names, ['Ausgaben', 'Zweites Blatt mit Zeichen'])
    for (const name of names) {
      assert.equal(/[:\\/?*[\]]/.test(name), false, `"${name}" enthält ein verbotenes Zeichen.`)
      assert.ok(name.length <= 31)
    }
  })
})

describe('xlsx-Hilfen', () => {
  it('zählt Spaltenbuchstaben über Z hinaus weiter', () => {
    const { columnName } = xlsxInternals
    assert.equal(columnName(1), 'A')
    assert.equal(columnName(26), 'Z')
    assert.equal(columnName(27), 'AA')
    assert.equal(columnName(52), 'AZ')
    assert.equal(columnName(53), 'BA')
    assert.equal(columnName(702), 'ZZ')
  })

  it('rechnet Datumsangaben auf Excels Zählung um', () => {
    const { serialDate } = xlsxInternals
    // Der 1.1.1900 ist Tag 1 — und der 1.3.1900 ist Tag 61, weil Excel den
    // 29. Februar 1900 mitzählt, den es nie gab.
    assert.equal(serialDate(new Date(1900, 0, 1)), 2)
    assert.equal(serialDate(new Date(2026, 7, 11)), 46245)
  })

  it('kürzt Registernamen auf 31 Zeichen', () => {
    assert.equal(xlsxInternals.sheetName('x'.repeat(50), 0).length, 31)
    assert.equal(xlsxInternals.sheetName('   ', 2), 'Tabelle3')
  })
})

describe('pptx', () => {
  const buffer = buildPptx(
    {
      title: 'Titel',
      subtitle: 'Untertitel',
      slides: [
        { title: 'Erste Folie', bullets: ['- mit Strich davor', '* und Sternchen'] },
        { title: 'Ohne Punkte', bullets: [] }
      ]
    },
    WHEN
  )

  const parts = checkPackage(buffer, [
    '_rels/.rels',
    'ppt/presentation.xml',
    'ppt/_rels/presentation.xml.rels',
    'ppt/slideMasters/slideMaster1.xml',
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    'ppt/slideLayouts/slideLayout1.xml',
    'ppt/slideLayouts/slideLayout2.xml',
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    'ppt/slideLayouts/_rels/slideLayout2.xml.rels',
    'ppt/theme/theme1.xml',
    'ppt/slides/slide1.xml',
    'ppt/slides/slide3.xml',
    'ppt/slides/_rels/slide1.xml.rels'
  ])

  it('stellt der ersten Inhaltsfolie eine Titelfolie voran', () => {
    // Zwei genannte Folien plus die Titelfolie sind drei.
    assert.ok(parts.has('ppt/slides/slide3.xml'))
    assert.equal(parts.has('ppt/slides/slide4.xml'), false)
    assert.ok(parts.get('ppt/slides/slide1.xml')!.includes('ctrTitle'))
  })

  it('hängt die Titelfolie an das Titellayout und den Rest an das Inhaltslayout', () => {
    assert.ok(parts.get('ppt/slides/_rels/slide1.xml.rels')!.includes('slideLayout1.xml'))
    assert.ok(parts.get('ppt/slides/_rels/slide2.xml.rels')!.includes('slideLayout2.xml'))
  })

  it('nimmt Aufzählungszeichen aus dem Text — die kommen vom Master', () => {
    const slide = parts.get('ppt/slides/slide2.xml')!
    assert.ok(slide.includes('<a:t>mit Strich davor</a:t>'))
    assert.ok(slide.includes('<a:t>und Sternchen</a:t>'))
  })

  it('liefert im Design von jeder Stilliste genau drei Einträge', () => {
    // PowerPoint verlangt das. Bei zweien gilt die Datei als beschädigt.
    const theme = parts.get('ppt/theme/theme1.xml')!
    const between = (open: string, close: string): string =>
      theme.slice(theme.indexOf(open) + open.length, theme.indexOf(close))

    assert.equal((between('<a:fillStyleLst>', '</a:fillStyleLst>').match(/<a:(solid|grad)Fill/g) ?? []).length, 3)
    assert.equal((between('<a:lnStyleLst>', '</a:lnStyleLst>').match(/<a:ln /g) ?? []).length, 3)
    assert.equal((theme.match(/<a:effectStyle>/g) ?? []).length, 3)
    assert.equal((between('<a:bgFillStyleLst>', '</a:bgFillStyleLst>').match(/<a:(solid|grad)Fill/g) ?? []).length, 3)
  })

  it('vergibt Folienkennungen ab 256', () => {
    // Unter 256 lehnt PowerPoint sie ab.
    const presentation = parts.get('ppt/presentation.xml')!
    for (const match of presentation.matchAll(/<p:sldId id="(\d+)"/g)) {
      assert.ok(Number(match[1]) >= 256, `Foliennummer ${match[1]} ist zu klein.`)
    }
  })

  it('setzt das Folienformat auf 16 zu 9', () => {
    assert.ok(parts.get('ppt/presentation.xml')!.includes('cx="12192000" cy="6858000"'))
  })
})
