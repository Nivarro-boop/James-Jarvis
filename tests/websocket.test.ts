import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { __internals } from '@main/companion/websocket'

const { readFrame, frame } = __internals

/**
 * Der Rahmenparser ist von Hand geschrieben und liest, was ein fremdes Gerät
 * schickt — die einzige Stelle im Projekt, an der roher Netzverkehr auf eigenen
 * Code trifft. Was hier durchrutscht, rutscht in den Hauptprozess.
 *
 * Geprüft wird deshalb beides: dass gültige Rahmen ankommen, und dass ungültige
 * abgewiesen werden statt irgendetwas zu ergeben.
 */

const OPCODE = { text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024

interface Options {
  fin?: boolean
  masked?: boolean
  rsv?: number
  /** Erzwingt eine längere Längenkodierung, als der Inhalt bräuchte. */
  lengthBytes?: 0 | 2 | 8
  /** Behauptet eine andere Länge, als tatsächlich folgt. */
  declaredLength?: number
}

/** Baut einen Rahmen so, wie ihn ein Browser schickt: maskiert. */
function clientFrame(opcode: number, payload: Buffer, options: Options = {}): Buffer {
  const { fin = true, masked = true, rsv = 0, declaredLength } = options
  const length = declaredLength ?? payload.length
  const lengthBytes = options.lengthBytes ?? (length < 126 ? 0 : length < 65_536 ? 2 : 8)

  const header = [((fin ? 0x80 : 0) | (rsv << 4) | opcode) & 0xff]
  const short = lengthBytes === 0 ? length : lengthBytes === 2 ? 126 : 127
  header.push((masked ? 0x80 : 0) | short)

  const parts: Buffer[] = [Buffer.from(header)]
  if (lengthBytes === 2) {
    const extra = Buffer.alloc(2)
    extra.writeUInt16BE(length)
    parts.push(extra)
  } else if (lengthBytes === 8) {
    const extra = Buffer.alloc(8)
    extra.writeBigUInt64BE(BigInt(length))
    parts.push(extra)
  }

  if (!masked) {
    parts.push(payload)
    return Buffer.concat(parts)
  }

  const mask = Buffer.from([0xa3, 0x1f, 0x00, 0x7e])
  parts.push(mask)
  const scrambled = Buffer.allocUnsafe(payload.length)
  for (let i = 0; i < payload.length; i++) scrambled[i] = payload[i] ^ mask[i & 3]
  parts.push(scrambled)
  return Buffer.concat(parts)
}

function parsed(buffer: Buffer): Exclude<ReturnType<typeof readFrame>, null | 'invalid'> {
  const result = readFrame(buffer)
  ok(result !== null && result !== 'invalid', `Rahmen wurde nicht angenommen: ${String(result)}`)
  return result
}

describe('WebSocket-Rahmen', () => {
  describe('lesen', () => {
    it('holt eine kurze Nutzlast wieder heraus', () => {
      const payload = Buffer.from('Hallo James', 'utf-8')
      const raw = clientFrame(OPCODE.text, payload)
      const result = parsed(raw)
      strictEqual(result.fin, true)
      strictEqual(result.opcode, OPCODE.text)
      strictEqual(result.consumed, raw.length)
      deepStrictEqual(result.payload, payload)
    })

    it('nimmt eine leere Nutzlast an', () => {
      const result = parsed(clientFrame(OPCODE.text, Buffer.alloc(0)))
      strictEqual(result.payload.length, 0)
      strictEqual(result.consumed, 6)
    })

    it('trifft die Grenze zwischen kurzer und mittlerer Länge', () => {
      for (const length of [124, 125, 126, 127, 65_534, 65_535, 65_536, 65_537]) {
        const payload = Buffer.alloc(length, 0x5a)
        const raw = clientFrame(OPCODE.binary, payload)
        const result = parsed(raw)
        strictEqual(result.payload.length, length, `Länge ${length}`)
        strictEqual(result.consumed, raw.length, `Verbrauch bei Länge ${length}`)
        deepStrictEqual(result.payload, payload, `Inhalt bei Länge ${length}`)
      }
    })

    it('entmaskiert über die Blockgrenze hinweg richtig', () => {
      // Eine Nutzlast, deren Länge kein Vielfaches von vier ist, deckt einen
      // falsch gerechneten Maskenindex auf.
      const payload = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
      deepStrictEqual(parsed(clientFrame(OPCODE.binary, payload)).payload, payload)
    })

    it('verbraucht genau einen Rahmen, wenn mehrere ankommen', () => {
      const first = clientFrame(OPCODE.text, Buffer.from('eins'))
      const second = clientFrame(OPCODE.text, Buffer.from('zwei'))
      const both = Buffer.concat([first, second])

      const one = parsed(both)
      strictEqual(one.payload.toString(), 'eins')
      strictEqual(one.consumed, first.length)

      const two = parsed(both.subarray(one.consumed))
      strictEqual(two.payload.toString(), 'zwei')
      strictEqual(two.consumed, second.length)
    })

    it('wartet, solange der Rahmen nicht vollständig ist', () => {
      for (const length of [10, 300, 70_000]) {
        const raw = clientFrame(OPCODE.binary, Buffer.alloc(length, 0x11))
        for (const at of [0, 1, 2, 3, 4, 5, raw.length - 1]) {
          strictEqual(readFrame(raw.subarray(0, at)), null, `Länge ${length}, abgeschnitten bei ${at}`)
        }
        ok(readFrame(raw) !== null)
      }
    })

    it('reicht Steuerrahmen durch', () => {
      strictEqual(parsed(clientFrame(OPCODE.ping, Buffer.from('hoi'))).opcode, OPCODE.ping)
      strictEqual(parsed(clientFrame(OPCODE.pong, Buffer.alloc(0))).opcode, OPCODE.pong)
      const close = parsed(clientFrame(OPCODE.close, Buffer.from([0x03, 0xe8])))
      strictEqual(close.opcode, OPCODE.close)
      strictEqual(close.payload.readUInt16BE(0), 1000)
    })

    it('merkt sich, dass ein Rahmen noch nicht der letzte ist', () => {
      strictEqual(parsed(clientFrame(OPCODE.text, Buffer.from('teil'), { fin: false })).fin, false)
    })
  })

  describe('abweisen', () => {
    it('weist unmaskierte Rahmen ab', () => {
      // Vom Client zum Server ist die Maske Pflicht (RFC 6455, 5.1).
      strictEqual(readFrame(clientFrame(OPCODE.text, Buffer.from('hallo'), { masked: false })), 'invalid')
    })

    it('weist gesetzte Erweiterungsbits ab', () => {
      for (const rsv of [0b001, 0b010, 0b100, 0b111]) {
        strictEqual(readFrame(clientFrame(OPCODE.text, Buffer.from('x'), { rsv })), 'invalid', `RSV ${rsv}`)
      }
    })

    it('weist zu lange Steuerrahmen ab', () => {
      strictEqual(readFrame(clientFrame(OPCODE.ping, Buffer.alloc(126))), 'invalid')
      strictEqual(readFrame(clientFrame(OPCODE.close, Buffer.alloc(200))), 'invalid')
      // Genau an der Grenze ist er noch gültig.
      strictEqual(parsed(clientFrame(OPCODE.ping, Buffer.alloc(125))).payload.length, 125)
    })

    it('weist zerstückelte Steuerrahmen ab', () => {
      strictEqual(readFrame(clientFrame(OPCODE.ping, Buffer.from('x'), { fin: false })), 'invalid')
    })

    it('weist eine angekündigte Länge über der Obergrenze ab', () => {
      // Ohne diese Prüfung reserviert ein einziger Rahmen beliebig viel Speicher.
      const raw = clientFrame(OPCODE.binary, Buffer.alloc(0), {
        lengthBytes: 8,
        declaredLength: MAX_MESSAGE_BYTES + 1
      })
      strictEqual(readFrame(raw), 'invalid')
    })

    it('gibt bei einer riesigen angekündigten Länge nicht erst Speicher aus', () => {
      const raw = clientFrame(OPCODE.binary, Buffer.alloc(0), {
        lengthBytes: 8,
        declaredLength: Number.MAX_SAFE_INTEGER
      })
      strictEqual(readFrame(raw), 'invalid')
    })
  })

  describe('schreiben', () => {
    it('setzt FIN und lässt die Maske weg', () => {
      // Rahmen vom Server sind unmaskiert (RFC 6455, 5.1).
      const raw = frame(OPCODE.text, Buffer.from('hallo'))
      strictEqual(raw[0], 0x80 | OPCODE.text)
      strictEqual(raw[1] & 0x80, 0, 'Server-Rahmen darf nicht maskiert sein')
      strictEqual(raw[1] & 0x7f, 5)
      strictEqual(raw.subarray(2).toString(), 'hallo')
    })

    it('wechselt die Längenkodierung an den richtigen Stellen', () => {
      const kopf = (length: number): Buffer => frame(OPCODE.binary, Buffer.alloc(length))

      strictEqual(kopf(125)[1] & 0x7f, 125)
      strictEqual(kopf(125).length, 2 + 125)

      strictEqual(kopf(126)[1] & 0x7f, 126)
      strictEqual(kopf(126).readUInt16BE(2), 126)
      strictEqual(kopf(126).length, 4 + 126)

      strictEqual(kopf(65_535)[1] & 0x7f, 126)
      strictEqual(kopf(65_535).readUInt16BE(2), 65_535)

      strictEqual(kopf(65_536)[1] & 0x7f, 127)
      strictEqual(kopf(65_536).readBigUInt64BE(2), 65_536n)
      strictEqual(kopf(65_536).length, 10 + 65_536)
    })

    it('schreibt eine leere Nutzlast als zwei Byte', () => {
      strictEqual(frame(OPCODE.pong, Buffer.alloc(0)).length, 2)
    })
  })

  describe('hin und zurück', () => {
    it('liest, was der Schreiber ausgibt — sobald es maskiert ist', () => {
      // Der Schreiber ist für die Gegenrichtung gebaut, deshalb wird sein
      // Ergebnis hier nachträglich maskiert. Geprüft wird damit, dass beide
      // Seiten dieselbe Längenkodierung meinen.
      for (const length of [0, 5, 125, 126, 1000, 65_535, 65_536, 100_000]) {
        const payload = Buffer.alloc(length)
        for (let i = 0; i < length; i++) payload[i] = (i * 31) & 0xff
        const roh = frame(OPCODE.binary, payload)
        const kopfLaenge = length < 126 ? 2 : length < 65_536 ? 4 : 10
        strictEqual(roh.length, kopfLaenge + length, `Kopflänge bei ${length}`)
        deepStrictEqual(parsed(clientFrame(OPCODE.binary, payload)).payload, payload, `Inhalt bei ${length}`)
      }
    })
  })
})
