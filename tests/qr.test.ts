import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { encodeQr, qrToSvgPath, __internals, type QrMatrix } from '@shared/qr'

/**
 * Der Kopf von `qr.ts` schreibt vor, wie diese Datei zu prüfen ist:
 *
 *   „Wer diese Datei anfasst, prüft deshalb nicht die Codewörter, sondern liest
 *    die ganze Matrix zurück — Format von den in der Norm festgelegten Plätzen,
 *    Maske zurücknehmen, Zickzack, Entflechten — und vergleicht mit dem, was
 *    hineinging."
 *
 * Genau das steht hier. Der Leser unten ist absichtlich nicht der Schreiber von
 * oben rückwärts gelesen, sondern zweimal aus der Norm heraus geschrieben: Die
 * Plätze der Formatinformation, die Reihenfolge des Zickzacks und die Aufteilung
 * der Blöcke stehen hier ein zweites Mal. Ein Tippfehler, der in beiden
 * Richtungen derselbe wäre, bliebe unentdeckt — deshalb kommt zusätzlich ein
 * fester Code aus einer fremden Umsetzung dazu, Zeile für Zeile abgeglichen.
 */

// ─────────────────────────────────────────────────────────────
// Der Leser
// ─────────────────────────────────────────────────────────────

/** Mittelpunkte der Ausrichtungsmuster, ISO/IEC 18004 Anhang E. */
const ALIGNMENT: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50]
}

/**
 * Welche Module zur Funktion gehören und damit keine Daten tragen.
 *
 * Aus der Norm, nicht aus dem Schreiber: drei Blöcke in den Ecken (Sucher,
 * Trennstreifen und Formatinformation zusammengefasst), die beiden Taktlinien,
 * die Ausrichtungsmuster und — ab Version 7 — die beiden Versionsfelder.
 */
function functionModules(version: number): boolean[][] {
  const size = 17 + version * 4
  const fn: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))

  const block = (top: number, left: number, height: number, width: number): void => {
    for (let r = top; r < top + height; r++) {
      for (let c = left; c < left + width; c++) {
        if (r >= 0 && r < size && c >= 0 && c < size) fn[r][c] = true
      }
    }
  }

  block(0, 0, 9, 9)
  block(0, size - 8, 9, 8)
  block(size - 8, 0, 8, 9)

  for (let i = 0; i < size; i++) {
    fn[6][i] = true
    fn[i][6] = true
  }

  for (const row of ALIGNMENT[version]) {
    for (const col of ALIGNMENT[version]) {
      const overlapsFinder =
        (row <= 8 && col <= 8) || (row <= 8 && col >= size - 9) || (row >= size - 9 && col <= 8)
      if (overlapsFinder) continue
      block(row - 2, col - 2, 5, 5)
    }
  }

  if (version >= 7) {
    block(size - 11, 0, 3, 6)
    block(0, size - 11, 6, 3)
  }

  return fn
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

interface FormatInfo {
  ecLevel: number
  mask: number
}

/**
 * Die fünfzehn Bit von den Plätzen der ersten Kopie holen — und von denen der
 * zweiten gleich mit. Beide müssen dasselbe ergeben; täte es nur eine, wäre der
 * Code für jeden Leser kaputt, der die andere Ecke nimmt.
 */
function readFormat(matrix: QrMatrix): FormatInfo {
  const { size, modules } = matrix

  const first: number[] = []
  for (let i = 0; i <= 5; i++) first[i] = modules[i][8] ? 1 : 0
  first[6] = modules[7][8] ? 1 : 0
  first[7] = modules[8][8] ? 1 : 0
  first[8] = modules[8][7] ? 1 : 0
  for (let i = 9; i <= 14; i++) first[i] = modules[8][14 - i] ? 1 : 0

  const second: number[] = []
  for (let i = 0; i <= 7; i++) second[i] = modules[8][size - 1 - i] ? 1 : 0
  for (let i = 8; i <= 14; i++) second[i] = modules[size - 15 + i][8] ? 1 : 0

  deepStrictEqual(first, second, 'Die beiden Kopien der Formatinformation weichen voneinander ab')

  let bits = 0
  for (let i = 0; i <= 14; i++) bits |= first[i] << i
  const data = (bits ^ 0x5412) >> 10

  // Die BCH-Sicherung muss aufgehen, sonst stünde dort Rauschen.
  let check = data << 10
  for (let i = 4; i >= 0; i--) if (check & (1 << (i + 10))) check ^= 0x537 << i
  strictEqual(((data << 10) | check) ^ 0x5412, bits, 'BCH-Sicherung der Formatinformation stimmt nicht')

  return { ecLevel: data >> 3, mask: data & 0b111 }
}

/** Der Zickzack von rechts unten nach links oben, zwei Spalten breit, Taktspalte ausgelassen. */
function readCodewords(matrix: QrMatrix, fn: boolean[][], mask: number): number[] {
  const { size, modules } = matrix
  const unmask = MASKS[mask]
  const bits: number[] = []
  let upward = true

  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step
      for (const col of [right, right - 1]) {
        if (fn[row][col]) continue
        const dark = modules[row][col] !== unmask(row, col)
        bits.push(dark ? 1 : 0)
      }
    }
    upward = !upward
  }

  const codewords: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]
    codewords.push(byte)
  }
  return codewords
}

/** Die Verschränkung rückgängig machen und die Fehlerkorrektur jedes Blocks nachrechnen. */
function deinterleave(codewords: number[], version: number): Uint8Array {
  const spec = __internals.VERSIONS[version]
  const sizes: number[] = [
    ...new Array<number>(spec.group1Blocks).fill(spec.group1Data),
    ...new Array<number>(spec.group2Blocks).fill(spec.group2Data)
  ]
  const data: number[][] = sizes.map(() => [])
  const ec: number[][] = sizes.map(() => [])

  let at = 0
  const maxData = Math.max(...sizes)
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < sizes.length; b++) {
      if (i < sizes[b]) data[b].push(codewords[at++])
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (let b = 0; b < sizes.length; b++) ec[b].push(codewords[at++])
  }

  for (let b = 0; b < sizes.length; b++) {
    const expected = __internals.errorCorrection(Uint8Array.from(data[b]), spec.ecPerBlock)
    deepStrictEqual(
      Array.from(expected),
      ec[b],
      `Die Fehlerkorrekturwörter von Block ${b} stimmen nicht mit den Daten überein`
    )
  }

  return Uint8Array.from(data.flat())
}

/** Kopfbits lesen und den Text herausholen. Nur Byte-Modus, mehr kann der Schreiber nicht. */
function decodePayload(data: Uint8Array, version: number): string {
  const bits: number[] = []
  for (const byte of data) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1)

  let at = 0
  const take = (count: number): number => {
    let value = 0
    for (let i = 0; i < count; i++) value = (value << 1) | bits[at++]
    return value
  }

  strictEqual(take(4), 0b0100, 'Der Modus ist nicht der Byte-Modus')
  const length = take(version >= 10 ? 16 : 8)
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) bytes[i] = take(8)

  // Was danach kommt, muss der Abschluss sein: höchstens vier Nullen, dann die
  // beiden festgelegten Füllbytes im Wechsel.
  const rest = bits.length - at
  const terminator = Math.min(4, rest)
  for (let i = 0; i < terminator; i++) strictEqual(bits[at + i], 0, 'Abschluss ist nicht null')
  at += terminator
  if (at % 8 !== 0) at += 8 - (at % 8)
  for (let pad = 0; at + 8 <= bits.length; pad++, at += 8) {
    let byte = 0
    for (let i = 0; i < 8; i++) byte = (byte << 1) | bits[at + i]
    strictEqual(byte, pad % 2 === 0 ? 0xec : 0x11, 'Füllbyte weicht von der Norm ab')
  }

  return new TextDecoder().decode(bytes)
}

/** Der ganze Weg zurück. */
function decodeQr(matrix: QrMatrix): { text: string; version: number; mask: number; ecLevel: number } {
  const version = (matrix.size - 17) / 4
  ok(Number.isInteger(version) && version >= 1 && version <= 10, `Unmögliche Größe ${matrix.size}`)

  const { ecLevel, mask } = readFormat(matrix)
  const fn = functionModules(version)
  const codewords = readCodewords(matrix, fn, mask)
  const data = deinterleave(codewords, version)
  return { text: decodePayload(data, version), version, mask, ecLevel }
}

// ─────────────────────────────────────────────────────────────
// Die Prüfungen
// ─────────────────────────────────────────────────────────────

describe('QR-Code', () => {
  const beispiele: string[] = [
    'a',
    'https://void-jarvis.example/',
    'https://rechner.tail1234.ts.net:8788/?token=Zm9vYmFyYmF6cXV4MTIzNA',
    'https://192.168.178.42:8788/?token=' + 'A'.repeat(60),
    'Umlaute und ein Emoji: äöüß 🜁',
    'x'.repeat(200)
  ]

  for (const text of beispiele) {
    const kurz = text.length > 40 ? text.slice(0, 37) + '…' : text
    it(`liest sich zurück: ${kurz}`, () => {
      const zurueck = decodeQr(encodeQr(text))
      strictEqual(zurueck.text, text)
      // Stufe M steht in der Norm als 0b00.
      strictEqual(zurueck.ecLevel, 0b00, 'Fehlerkorrekturstufe ist nicht M')
      ok(zurueck.mask >= 0 && zurueck.mask <= 7)
    })
  }

  it('nimmt die kleinste Version, die reicht', () => {
    // Version 1-M fasst 16 Datenwörter, davon gehen 4 Bit Modus und 8 Bit Länge
    // ab: 14 Byte Nutzlast. Das fünfzehnte erzwingt Version 2.
    strictEqual(__internals.chooseVersion(14), 1)
    strictEqual(__internals.chooseVersion(15), 2)
    strictEqual(decodeQr(encodeQr('x'.repeat(14))).version, 1)
    strictEqual(decodeQr(encodeQr('x'.repeat(15))).version, 2)
  })

  it('bricht ab, statt still abzuschneiden', () => {
    // Version 10-M fasst 216 Datenwörter minus 4 Bit Modus und 16 Bit Länge.
    const passt = 216 - 3
    strictEqual(decodeQr(encodeQr('x'.repeat(passt))).text.length, passt)
    throws(() => encodeQr('x'.repeat(passt + 1)), /zu lang/)
  })

  it('setzt das immer dunkle Modul', () => {
    const m = encodeQr('https://void-jarvis.example/')
    strictEqual(m.modules[m.size - 8][8], true)
  })

  it('zeichnet die Sucherquadrate mit ihrem Trennstreifen', () => {
    const m = encodeQr('https://void-jarvis.example/')
    const ecken: [number, number][] = [
      [0, 0],
      [0, m.size - 7],
      [m.size - 7, 0]
    ]
    for (const [top, left] of ecken) {
      strictEqual(m.modules[top][left], true, 'Ecke des Sucherquadrats ist hell')
      strictEqual(m.modules[top + 1][left + 1], false, 'Der helle Ring fehlt')
      strictEqual(m.modules[top + 3][left + 3], true, 'Der dunkle Kern fehlt')
    }
    // Der Trennstreifen zwischen Sucher und Daten, oben links.
    for (let i = 0; i <= 7; i++) strictEqual(m.modules[7][i], false, 'Trennstreifen ist nicht hell')
  })

  it('legt die Taktlinien im Wechsel', () => {
    const m = encodeQr('https://void-jarvis.example/')
    for (let i = 8; i < m.size - 8; i++) {
      strictEqual(m.modules[6][i], i % 2 === 0, `Taktlinie waagerecht bei ${i}`)
      strictEqual(m.modules[i][6], i % 2 === 0, `Taktlinie senkrecht bei ${i}`)
    }
  })

  it('wählt die Maske mit der geringsten Strafe', () => {
    // Ein gleichmäßiger Text ohne Struktur — die Wahl darf nicht immer auf
    // dieselbe Maske fallen, sonst wäre die Bewertung wirkungslos.
    const masken = new Set(
      ['a', 'ab', 'abc', 'abcd', 'abcde', 'abcdef', 'abcdefg', 'abcdefgh'].map(
        (t) => decodeQr(encodeQr(t)).mask
      )
    )
    ok(masken.size > 1, `Immer dieselbe Maske gewählt: ${[...masken]}`)
  })

  it('rechnet im Galois-Feld nach den Regeln', () => {
    const { mul, EXP, LOG } = __internals
    strictEqual(mul(0, 123), 0)
    strictEqual(mul(1, 123), 123)
    // α^8 = α^4 + α^3 + α^2 + 1 aus dem Primpolynom 0x11d.
    strictEqual(EXP[8], 0x1d)
    strictEqual(EXP[255], 1)
    for (let i = 1; i < 256; i++) strictEqual(EXP[LOG[i]], i, `Logarithmus von ${i}`)
    // Multiplikation ist kommutativ und assoziativ.
    strictEqual(mul(mul(7, 11), 13), mul(7, mul(11, 13)))
  })

  it('erzeugt ein Generatorpolynom mit den richtigen Nullstellen', () => {
    const { generatorPolynomial, mul, EXP } = __internals
    for (const count of [10, 16, 26]) {
      const poly = generatorPolynomial(count)
      strictEqual(poly.length, count + 1)
      strictEqual(poly[0], 1, 'Nicht normiert')
      // An jeder Nullstelle α^i muss das Polynom null werden.
      for (let i = 0; i < count; i++) {
        let value = 0
        for (const coefficient of poly) value = mul(value, EXP[i]) ^ coefficient
        strictEqual(value, 0, `α^${i} ist keine Nullstelle von g_${count}`)
      }
    }
  })

  it('gibt einen Pfad aus, der jedes dunkle Modul trifft', () => {
    const m = encodeQr('https://void-jarvis.example/')
    const dunkel = m.modules.flat().filter(Boolean).length
    strictEqual(qrToSvgPath(m).split('M').length - 1, dunkel)
  })
})
