import { deflateRawSync } from 'node:zlib'

/**
 * Ein ZIP-Schreiber, gerade groß genug für Office-Dateien.
 *
 * Warum überhaupt selbst: docx, xlsx und pptx sind ZIP-Archive mit XML darin,
 * sonst nichts. Die üblichen Bibliotheken dafür — `docx`, `exceljs`,
 * `pptxgenjs` — bringen zusammen rund zehn Megabyte und je ein eigenes
 * Objektmodell mit, und benutzt würde davon der Bruchteil, der Überschriften,
 * Absätze, Zeilen und Aufzählungen schreibt. Was diese Dateien tatsächlich
 * brauchen, steht unten: hundertfünfzig Zeilen Kopfdaten und eine Prüfsumme.
 *
 * Bewusst ohne ZIP64 und ohne Verschlüsselung. Beides fängt erst bei vier
 * Gigabyte bzw. bei Passwörtern an, und weder das eine noch das andere kommt
 * hier vor: Was James schreibt, entsteht aus einem gesprochenen Satz.
 *
 * Was hier fehlt, ist Absicht — was hier steht, muss dafür stimmen. Ein ZIP
 * mit falscher Prüfsumme oder falschem Verzeichnis-Versatz öffnet Word nicht
 * mit einer Fehlermeldung, sondern mit der Frage, ob es die Datei reparieren
 * soll. Deshalb prüft `tests/office.test.ts` jede erzeugte Datei gegen den
 * ZIP-Leser von Windows selbst.
 */

/** Eine Datei im Archiv. */
export interface ZipEntry {
  /** Pfad im Archiv, immer mit Schrägstrich, nie mit führendem. */
  path: string
  data: Buffer
}

// ─────────────────────────────────────────────────────────────
// CRC-32
// ─────────────────────────────────────────────────────────────

/**
 * Die Tabelle wird einmal beim Laden gebaut.
 *
 * Node bringt keine öffentliche CRC-32-Funktion mit — `zlib.crc32` gibt es
 * erst ab Node 22 und auch dort nur unter Vorbehalt. Die Tabelle ist der
 * Standardweg und kostet einmalig 256 Schleifendurchläufe.
 */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let bit = 0; bit < 8; bit++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// ─────────────────────────────────────────────────────────────
// Zeitstempel
// ─────────────────────────────────────────────────────────────

/**
 * MS-DOS-Zeit und -Datum, wie das ZIP-Format sie verlangt.
 *
 * Zwei Eigenheiten, an denen man sich sonst stößt: Das Jahr zählt ab 1980, und
 * die Sekunden stecken in fünf Bit — sie laufen also in Zweierschritten. Ein
 * Datum vor 1980 lässt sich gar nicht ausdrücken; deshalb der Boden.
 */
function dosTimestamp(when: Date): { time: number; date: number } {
  const year = Math.max(1980, when.getFullYear())
  return {
    time:
      (when.getHours() << 11) | (when.getMinutes() << 5) | (Math.floor(when.getSeconds() / 2) & 0x1f),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()
  }
}

// ─────────────────────────────────────────────────────────────
// Das Archiv
// ─────────────────────────────────────────────────────────────

/**
 * Nur gesetzt, wenn Komprimieren sich lohnt.
 *
 * Bei sehr kurzen Teilen — eine Beziehungsdatei mit zwei Zeilen — ist das
 * Deflate-Ergebnis größer als die Eingabe. Dann wird die Datei unkomprimiert
 * abgelegt (Methode 0). Das ist kein Sonderfall des Formats, sondern
 * ausdrücklich vorgesehen.
 */
const STORE = 0
const DEFLATE = 8

/** Kennzeichnet den Dateinamen als UTF-8. Ohne das Bit raten Leser die Kodierung. */
const FLAG_UTF8 = 0x800

/**
 * Packt eine Liste von Dateien zu einem ZIP-Archiv.
 *
 * Die Reihenfolge bleibt, wie sie hereinkommt. Das ist für OPC nicht egal:
 * `[Content_Types].xml` gehört an den Anfang, weil ein Leser sonst erst das
 * ganze Archiv durchsuchen muss, bevor er weiß, was er überhaupt vor sich hat.
 * Dafür sorgt `pack()` in `ooxml.ts`, nicht diese Funktion.
 */
export function zip(entries: ZipEntry[], when: Date = new Date()): Buffer {
  const { time, date } = dosTimestamp(when)
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf-8')
    const raw = entry.data
    const sum = crc32(raw)

    const packed = deflateRawSync(raw, { level: 9 })
    // Nur nehmen, wenn es tatsächlich kleiner ist — siehe STORE oben.
    const useDeflate = packed.length < raw.length
    const body = useDeflate ? packed : raw
    const method = useDeflate ? DEFLATE : STORE

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // Kennung
    local.writeUInt16LE(20, 4) // benötigte Version: 2.0
    local.writeUInt16LE(FLAG_UTF8, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(sum, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // kein Extra-Feld
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    // Erzeugt unter „MS-DOS", Version 2.0. Absichtlich nicht Unix: sonst
    // erwarten manche Leser Dateirechte in den oberen externen Attributen.
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(FLAG_UTF8, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(sum, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // Extra
    central.writeUInt16LE(0, 32) // Kommentar
    central.writeUInt16LE(0, 34) // Datenträger
    central.writeUInt16LE(0, 36) // interne Attribute
    central.writeUInt32LE(0, 38) // externe Attribute
    central.writeUInt32LE(offset, 42) // wo der lokale Kopf steht
    centrals.push(central, name)

    offset += local.length + name.length + body.length
  }

  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4) // dieser Datenträger
  end.writeUInt16LE(0, 6) // Datenträger mit dem Verzeichnis
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16) // Versatz des Verzeichnisses
  end.writeUInt16LE(0, 20) // kein Archivkommentar

  return Buffer.concat([...locals, directory, end])
}

/** Nur zum Testen der Prüfsumme. */
export const __internals = { crc32, dosTimestamp }
