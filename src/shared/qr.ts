/**
 * QR-Code, nur so viel wie gebraucht wird.
 *
 * Gebraucht wird genau ein Fall: eine Kopplungsadresse von rund hundert
 * Zeichen, einmal auf einem Bildschirm, damit ein Telefon sie abfotografieren
 * kann. Deshalb Byte-Modus, Fehlerkorrektur M und die Versionen 1 bis 10 —
 * das reicht bis 213 Zeichen und deckt jede Adresse ab, die dieser Server
 * hergibt. Kanji, Zahlenmodus, Micro-QR und die Versionen bis 40 fehlen, weil
 * sie hier nie vorkommen und jede Zeile davon eine Zeile wäre, die niemand
 * je ausführt.
 *
 * Warum von Hand und nicht als Paket: Der Renderer bündelt ohnehin, ein Paket
 * wäre also vertretbar gewesen. Den Ausschlag gab, dass Reed-Solomon prüfbar
 * ist, ohne das Ergebnis mit einer fremden Umsetzung vergleichen zu müssen —
 * rechnet man das fertige Codewort an den Nullstellen des Generatorpolynoms
 * aus, muss überall null herauskommen.
 *
 * Das Argument war richtig und trotzdem zu kurz gegriffen: Es deckt die
 * Rechnung ab, nicht das Blatt. Die Formatinformation stand fünfzehn Bit lang
 * um neunzig Grad verdreht auf dem Code, und weil Zeile 8 und Spalte 8 beim
 * Spiegeln ineinander übergehen, sah das Ergebnis tadellos aus: alle Module
 * gesetzt, Sucherquadrate an ihrem Platz, kein Byte falsch. Nur einlesen ließ
 * es sich von keinem Telefon. Wer diese Datei anfasst, prüft deshalb nicht die
 * Codewörter, sondern liest die ganze Matrix zurück — Format von den in der
 * Norm festgelegten Plätzen, Maske zurücknehmen, Zickzack, Entflechten — und
 * vergleicht mit dem, was hineinging.
 */

/** Fehlerkorrekturstufe M: verträgt rund fünfzehn Prozent Schaden. */
const EC_LEVEL_BITS = 0b00

/**
 * Aufbau je Version: Gesamtzahl der Codewörter, Fehlerkorrekturwörter je Block
 * und die Blockaufteilung. Zwei Gruppen, weil sich die Datenwörter nicht immer
 * gleichmäßig aufteilen lassen — die zweite Gruppe hat dann eines mehr.
 */
interface VersionSpec {
  totalCodewords: number
  ecPerBlock: number
  group1Blocks: number
  group1Data: number
  group2Blocks: number
  group2Data: number
  /** Mittelpunkte der Ausrichtungsmuster, leer bei Version 1. */
  alignment: number[]
}

const VERSIONS: Record<number, VersionSpec> = {
  1: { totalCodewords: 26, ecPerBlock: 10, group1Blocks: 1, group1Data: 16, group2Blocks: 0, group2Data: 0, alignment: [] },
  2: { totalCodewords: 44, ecPerBlock: 16, group1Blocks: 1, group1Data: 28, group2Blocks: 0, group2Data: 0, alignment: [6, 18] },
  3: { totalCodewords: 70, ecPerBlock: 26, group1Blocks: 1, group1Data: 44, group2Blocks: 0, group2Data: 0, alignment: [6, 22] },
  4: { totalCodewords: 100, ecPerBlock: 18, group1Blocks: 2, group1Data: 32, group2Blocks: 0, group2Data: 0, alignment: [6, 26] },
  5: { totalCodewords: 134, ecPerBlock: 24, group1Blocks: 2, group1Data: 43, group2Blocks: 0, group2Data: 0, alignment: [6, 30] },
  6: { totalCodewords: 172, ecPerBlock: 16, group1Blocks: 4, group1Data: 27, group2Blocks: 0, group2Data: 0, alignment: [6, 34] },
  7: { totalCodewords: 196, ecPerBlock: 18, group1Blocks: 4, group1Data: 31, group2Blocks: 0, group2Data: 0, alignment: [6, 22, 38] },
  8: { totalCodewords: 242, ecPerBlock: 22, group1Blocks: 2, group1Data: 38, group2Blocks: 2, group2Data: 39, alignment: [6, 24, 42] },
  9: { totalCodewords: 292, ecPerBlock: 22, group1Blocks: 3, group1Data: 36, group2Blocks: 2, group2Data: 37, alignment: [6, 26, 46] },
  10: { totalCodewords: 346, ecPerBlock: 26, group1Blocks: 4, group1Data: 43, group2Blocks: 1, group2Data: 44, alignment: [6, 28, 50] }
}

// ─────────────────────────────────────────────────────────────
// GF(256)
// ─────────────────────────────────────────────────────────────

/**
 * Das Rechenfeld von Reed-Solomon: 256 Elemente, Addition ist XOR,
 * Multiplikation läuft über Logarithmen zur Basis 2 mit dem Primpolynom 0x11D.
 */
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)

{
  let value = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = value
    LOG[value] = i
    value <<= 1
    if (value & 0x100) value ^= 0x11d
  }
  // Verdoppelt angelegt, damit die Summe zweier Logarithmen nie überläuft und
  // kein `% 255` in der inneren Schleife steht.
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}

function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a] + LOG[b]]
}

/** Generatorpolynom für `count` Fehlerkorrekturwörter: (x−α⁰)(x−α¹)… */
function generatorPolynomial(count: number): Uint8Array {
  let poly = new Uint8Array([1])
  for (let i = 0; i < count; i++) {
    const next = new Uint8Array(poly.length + 1)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]
      next[j + 1] ^= mul(poly[j], EXP[i])
    }
    poly = next
  }
  return poly
}

/** Polynomdivision; der Rest sind die Fehlerkorrekturwörter. */
function errorCorrection(data: Uint8Array, count: number): Uint8Array {
  const generator = generatorPolynomial(count)
  const remainder = new Uint8Array(data.length + count)
  remainder.set(data)

  for (let i = 0; i < data.length; i++) {
    const factor = remainder[i]
    if (factor === 0) continue
    for (let j = 0; j < generator.length; j++) {
      remainder[i + j] ^= mul(generator[j], factor)
    }
  }
  return remainder.subarray(data.length)
}

// ─────────────────────────────────────────────────────────────
// Bitstrom
// ─────────────────────────────────────────────────────────────

class BitWriter {
  private bits: number[] = []

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >> i) & 1)
  }

  get length(): number {
    return this.bits.length
  }

  toCodewords(count: number): Uint8Array {
    const out = new Uint8Array(count)
    for (let i = 0; i < this.bits.length; i++) {
      if (this.bits[i]) out[i >> 3] |= 0x80 >> (i & 7)
    }
    return out
  }
}

function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= 10; version++) {
    const spec = VERSIONS[version]
    const dataCodewords =
      spec.group1Blocks * spec.group1Data + spec.group2Blocks * spec.group2Data
    // Ab Version 10 ist das Längenfeld im Byte-Modus sechzehn statt acht Bit.
    const headerBits = 4 + (version >= 10 ? 16 : 8)
    if (dataCodewords * 8 >= headerBits + byteLength * 8) return version
  }
  throw new Error('Der Text ist zu lang für einen QR-Code dieser Bauart.')
}

// ─────────────────────────────────────────────────────────────
// Matrix
// ─────────────────────────────────────────────────────────────

export interface QrMatrix {
  size: number
  /** `true` heißt dunkel. Zeilenweise, ohne Ruhezone. */
  modules: boolean[][]
}

export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text)
  const version = chooseVersion(bytes.length)
  const spec = VERSIONS[version]
  const dataCodewords = spec.group1Blocks * spec.group1Data + spec.group2Blocks * spec.group2Data

  // ── Bitstrom bauen ──────────────────────────────────────
  const writer = new BitWriter()
  writer.push(0b0100, 4) // Byte-Modus
  writer.push(bytes.length, version >= 10 ? 16 : 8)
  for (const byte of bytes) writer.push(byte, 8)

  // Abschluss, höchstens vier Nullen, dann auf ganze Bytes auffüllen.
  const capacity = dataCodewords * 8
  writer.push(0, Math.min(4, capacity - writer.length))
  if (writer.length % 8 !== 0) writer.push(0, 8 - (writer.length % 8))

  const filled = writer.toCodewords(dataCodewords)
  // Die beiden Füllbytes sind in der Norm festgelegt, nicht frei wählbar.
  for (let i = writer.length / 8, pad = 0; i < dataCodewords; i++, pad++) {
    filled[i] = pad % 2 === 0 ? 0xec : 0x11
  }

  // ── Blöcke und Fehlerkorrektur ──────────────────────────
  const blocks: { data: Uint8Array; ec: Uint8Array }[] = []
  let offset = 0
  for (const [count, size] of [
    [spec.group1Blocks, spec.group1Data],
    [spec.group2Blocks, spec.group2Data]
  ]) {
    for (let i = 0; i < count; i++) {
      const data = filled.subarray(offset, offset + size)
      offset += size
      blocks.push({ data, ec: errorCorrection(data, spec.ecPerBlock) })
    }
  }

  // Verschränken: erst je das erste Datenwort aller Blöcke, dann das zweite …
  // Ohne das würde ein Kratzer quer über den Code einen Block komplett treffen,
  // statt sich auf alle zu verteilen — und Reed-Solomon rettet nur pro Block.
  const finalCodewords: number[] = []
  const maxData = Math.max(...blocks.map((b) => b.data.length))
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) if (i < block.data.length) finalCodewords.push(block.data[i])
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const block of blocks) finalCodewords.push(block.ec[i])
  }

  // ── Zeichnen ────────────────────────────────────────────
  const size = 17 + version * 4
  const modules: (boolean | null)[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => null)
  )
  const reserved: boolean[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => false)
  )

  placeFunctionPatterns(modules, reserved, size, spec.alignment, version)
  placeData(modules, reserved, size, finalCodewords)

  const mask = chooseMask(modules as boolean[][], reserved, size)
  applyMask(modules as boolean[][], reserved, size, mask)
  placeFormatInfo(modules as boolean[][], size, mask)
  if (version >= 7) placeVersionInfo(modules as boolean[][], size, version)

  return { size, modules: modules as boolean[][] }
}

function placeFunctionPatterns(
  modules: (boolean | null)[][],
  reserved: boolean[][],
  size: number,
  alignment: number[],
  version: number
): void {
  const set = (row: number, col: number, dark: boolean): void => {
    modules[row][col] = dark
    reserved[row][col] = true
  }

  // Sucherquadrate in drei Ecken, jeweils mit ihrem hellen Trennstreifen.
  for (const [top, left] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0]
  ]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const row = top + r
        const col = left + c
        if (row < 0 || row >= size || col < 0 || col >= size) continue
        const onRing = (r === 0 || r === 6) && c >= 0 && c <= 6
        const onSide = (c === 0 || c === 6) && r >= 0 && r <= 6
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4
        set(row, col, onRing || onSide || core)
      }
    }
  }

  // Taktlinien — an ihnen richtet der Leser das Raster aus.
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }

  // Ausrichtungsmuster, aber nicht dort, wo schon ein Sucherquadrat sitzt.
  for (const row of alignment) {
    for (const col of alignment) {
      const inFinder =
        (row <= 8 && col <= 8) || (row <= 8 && col >= size - 9) || (row >= size - 9 && col <= 8)
      if (inFinder) continue
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          set(row + r, col + c, Math.max(Math.abs(r), Math.abs(c)) !== 1)
        }
      }
    }
  }

  // Das eine Modul, das immer dunkel ist.
  set(size - 8, 8, true)

  // Plätze für die Formatinformation freihalten; gefüllt wird sie erst,
  // wenn die Maske feststeht.
  for (let i = 0; i < 9; i++) {
    if (modules[8][i] === null) {
      modules[8][i] = false
      reserved[8][i] = true
    }
    if (modules[i][8] === null) {
      modules[i][8] = false
      reserved[i][8] = true
    }
  }
  for (let i = 0; i < 8; i++) {
    if (modules[8][size - 1 - i] === null) {
      modules[8][size - 1 - i] = false
      reserved[8][size - 1 - i] = true
    }
    if (modules[size - 1 - i][8] === null) {
      modules[size - 1 - i][8] = false
      reserved[size - 1 - i][8] = true
    }
  }

  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        modules[size - 11 + j][i] = false
        reserved[size - 11 + j][i] = true
        modules[i][size - 11 + j] = false
        reserved[i][size - 11 + j] = true
      }
    }
  }
}

/** Der Zickzack von rechts unten nach oben, immer zwei Spalten breit. */
function placeData(
  modules: (boolean | null)[][],
  reserved: boolean[][],
  size: number,
  codewords: number[]
): void {
  let bitIndex = 0
  let upward = true

  for (let right = size - 1; right > 0; right -= 2) {
    // Die Spalte der senkrechten Taktlinie wird übersprungen.
    if (right === 6) right = 5

    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step
      for (const col of [right, right - 1]) {
        if (reserved[row][col]) continue
        const byte = codewords[bitIndex >> 3]
        // Hinter den Daten stehen die Restbits — sie bleiben hell.
        const bit = byte === undefined ? 0 : (byte >> (7 - (bitIndex & 7))) & 1
        modules[row][col] = bit === 1
        bitIndex++
      }
    }
    upward = !upward
  }
}

const MASKS: ((row: number, col: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
]

function applyMask(
  modules: boolean[][],
  reserved: boolean[][],
  size: number,
  mask: number
): void {
  const fn = MASKS[mask]
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (reserved[row][col]) continue
      if (fn(row, col)) modules[row][col] = !modules[row][col]
    }
  }
}

/**
 * Alle acht Masken durchrechnen und die mit der geringsten Strafe nehmen.
 *
 * Die Strafregeln bestrafen alles, was ein Leser mit den Sucherquadraten
 * verwechseln könnte: lange gleichfarbige Läufe, gleichfarbige Vierecke, das
 * Muster der Sucher irgendwo im Feld, und ein Bild, das insgesamt zu hell
 * oder zu dunkel ist.
 */
function chooseMask(modules: boolean[][], reserved: boolean[][], size: number): number {
  let best = 0
  let bestScore = Infinity

  for (let mask = 0; mask < 8; mask++) {
    applyMask(modules, reserved, size, mask)
    const score = penalty(modules, size)
    applyMask(modules, reserved, size, mask) // zurücknehmen
    if (score < bestScore) {
      bestScore = score
      best = mask
    }
  }
  return best
}

function penalty(modules: boolean[][], size: number): number {
  let score = 0

  // Regel 1: Läufe von fünf oder mehr gleichen Modulen, waagerecht und senkrecht.
  for (let i = 0; i < size; i++) {
    for (const horizontal of [true, false]) {
      let run = 1
      for (let j = 1; j < size; j++) {
        const current = horizontal ? modules[i][j] : modules[j][i]
        const previous = horizontal ? modules[i][j - 1] : modules[j - 1][i]
        if (current === previous) {
          run++
        } else {
          if (run >= 5) score += 3 + (run - 5)
          run = 1
        }
      }
      if (run >= 5) score += 3 + (run - 5)
    }
  }

  // Regel 2: jedes gleichfarbige Zweiergeviert.
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const v = modules[row][col]
      if (v === modules[row][col + 1] && v === modules[row + 1][col] && v === modules[row + 1][col + 1]) {
        score += 3
      }
    }
  }

  // Regel 3: das Sucher-ähnliche Muster, in beiden Richtungen und Leserichtungen.
  const pattern = [true, false, true, true, true, false, true]
  const check = (line: boolean[], at: number): boolean => {
    for (let i = 0; i < 7; i++) if (line[at + i] !== pattern[i]) return false
    const beforeClear = line.slice(Math.max(0, at - 4), at)
    const afterClear = line.slice(at + 7, at + 11)
    const clear = (part: boolean[]): boolean => part.length === 4 && part.every((v) => !v)
    return clear(beforeClear) || clear(afterClear)
  }
  for (let i = 0; i < size; i++) {
    const row = modules[i]
    const col = modules.map((r) => r[i])
    for (let j = 0; j + 7 <= size; j++) {
      if (check(row, j)) score += 40
      if (check(col, j)) score += 40
    }
  }

  // Regel 4: Abweichung vom halbe-halbe-Verhältnis.
  let dark = 0
  for (const row of modules) for (const v of row) if (v) dark++
  const percent = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(percent - 50) / 5) * 10

  return score
}

/**
 * Fünf Bit Information, fünfzehn Bit auf dem Code: BCH-gesichert und zusätzlich
 * mit einer festen Maske verodert, damit das Feld nie ganz hell wird.
 */
function placeFormatInfo(modules: boolean[][], size: number, mask: number): void {
  const data = (EC_LEVEL_BITS << 3) | mask
  let value = data << 10
  for (let i = 4; i >= 0; i--) {
    if (value & (1 << (i + 10))) value ^= 0x537 << i
  }
  const bits = ((data << 10) | value) ^ 0x5412

  const at = (i: number): boolean => ((bits >> i) & 1) === 1

  /**
   * Jede Formatinformation steht zweimal auf dem Code — fällt eine Ecke aus,
   * ist der Code trotzdem noch lesbar.
   *
   * Die niedrigen Bits stehen beim Sucherquadrat oben links **senkrecht**, die
   * hohen **waagerecht**; unten und rechts genau andersherum. Das ist keine
   * freie Wahl: Der Leser holt die fünfzehn Bit von festen Plätzen in fester
   * Reihenfolge. Vertauscht man die beiden Richtungen, wird zwar jedes
   * Formatmodul beschrieben — das L aus Zeile 8 und Spalte 8 geht beim
   * Spiegeln in sich selbst über —, aber mit den Werten der jeweils anderen
   * Achse. Herauskommen fünfzehn vertauschte Bit, und daran scheitert die
   * BCH-Sicherung: Sie richtet drei Fehler, nicht neun. Der Leser findet dann
   * die Sucherquadrate, kann aber weder Maske noch Fehlerkorrekturstufe
   * bestimmen und gibt auf — der Code sieht tadellos aus und lässt sich
   * trotzdem von keinem Telefon einlesen.
   */
  for (let i = 0; i <= 5; i++) modules[i][8] = at(i)
  modules[7][8] = at(6)
  modules[8][8] = at(7)
  modules[8][7] = at(8)
  for (let i = 9; i <= 14; i++) modules[8][14 - i] = at(i)

  // Die zweite Kopie: acht Bit waagerecht in Zeile 8 rechts, sieben senkrecht
  // in Spalte 8 unten. Das immer dunkle Modul sitzt bei (size−8, 8) und liegt
  // damit unterhalb beider Läufe — es bleibt unangetastet.
  for (let i = 0; i <= 7; i++) modules[8][size - 1 - i] = at(i)
  for (let i = 8; i <= 14; i++) modules[size - 15 + i][8] = at(i)
}

/** Ab Version 7 steht die Versionsnummer zweimal auf dem Code. */
function placeVersionInfo(modules: boolean[][], size: number, version: number): void {
  let value = version << 12
  for (let i = 5; i >= 0; i--) {
    if (value & (1 << (i + 12))) value ^= 0x1f25 << i
  }
  const bits = (version << 12) | value

  for (let i = 0; i < 18; i++) {
    const bit = ((bits >> i) & 1) === 1
    const row = Math.floor(i / 3)
    const col = i % 3
    modules[size - 11 + col][row] = bit
    modules[row][size - 11 + col] = bit
  }
}

// ─────────────────────────────────────────────────────────────
// Ausgabe
// ─────────────────────────────────────────────────────────────

/**
 * Als SVG-Pfad, nicht als tausend Rechtecke.
 *
 * Ein `<rect>` je dunklem Modul sind bei Version 6 über achthundert Knoten im
 * Baum — das rendert sichtbar träge und macht die Einstellungsseite ruckelig.
 * Ein einziger Pfad mit achthundert Teilstücken kostet nichts.
 */
export function qrToSvgPath(matrix: QrMatrix): string {
  const parts: string[] = []
  for (let row = 0; row < matrix.size; row++) {
    for (let col = 0; col < matrix.size; col++) {
      if (matrix.modules[row][col]) parts.push(`M${col} ${row}h1v1h-1z`)
    }
  }
  return parts.join('')
}

/** Nur zum Prüfen. */
export const __internals = { VERSIONS, errorCorrection, generatorPolynomial, mul, EXP, LOG, chooseVersion }
