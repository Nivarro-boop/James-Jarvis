import { ok, strictEqual } from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { describe, it, type TestContext } from 'node:test'
import { accept } from '@main/companion/websocket'

/**
 * Die Totmannschaltung.
 *
 * Sie ist die Antwort auf den Fehler, der sich am schlechtesten von Hand
 * nachstellen lässt: ein Telefon, das in ein Funkloch fährt. TCP sagt darüber
 * nichts — beide Seiten halten einen Sockel offen, durch den nichts mehr geht.
 * Der Rechner zählte das Telefon weiter mit, und hielt es beim Verschwinden die
 * Sprechtaste, blieb auch das Mikrofon am Rechner stumm.
 *
 * Von Hand ist das eine Fahrt in den Keller. Mit angehaltener Uhr sind es ein
 * paar Zeilen, und deshalb steht es hier.
 */

const PING_INTERVAL_MS = 15_000
const SILENCE_LIMIT_MS = 45_000
const OPCODE = { text: 0x1, close: 0x8, ping: 0x9 } as const

/**
 * Ein Sockel, der nur so viel kann, wie `attach` von ihm verlangt.
 *
 * Ein echter `PassThrough` ginge nicht: Was der Server schreibt, käme dort auf
 * derselben Seite wieder heraus, und die Verbindung redete mit sich selbst.
 */
class FakeSocket extends EventEmitter {
  written: Buffer[] = []
  destroyed = false
  ended = false
  noDelay = false

  write(chunk: Buffer | string): boolean {
    this.written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    return true
  }

  end(chunk?: Buffer | string): void {
    if (chunk) this.write(chunk)
    this.ended = true
  }

  destroy(): void {
    this.destroyed = true
  }

  setNoDelay(value: boolean): void {
    this.noDelay = value
  }

  /** Was vom Gegenüber hereinkommt. */
  feed(chunk: Buffer): void {
    this.emit('data', chunk)
  }

  /** Alle Rahmen, die der Server geschickt hat — der Handschlag zählt nicht mit. */
  frames(): { opcode: number; length: number }[] {
    return this.written
      .filter((buffer) => !buffer.subarray(0, 4).toString('latin1').startsWith('HTTP'))
      .map((buffer) => ({ opcode: buffer[0] & 0x0f, length: buffer[1] & 0x7f }))
  }
}

function request(): IncomingMessage {
  return {
    headers: {
      upgrade: 'websocket',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13'
    },
    socket: { remoteAddress: '100.64.0.7' }
  } as unknown as IncomingMessage
}

/** Ein maskierter Rahmen, so wie ihn ein Browser schickt. */
function clientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44])
  const scrambled = Buffer.allocUnsafe(payload.length)
  for (let i = 0; i < payload.length; i++) scrambled[i] = payload[i] ^ mask[i & 3]
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, scrambled])
}

function connected(t: TestContext): { socket: FakeSocket; ws: NonNullable<ReturnType<typeof accept>> } {
  // `Date` muss mit angehalten werden: Die Wache vergleicht Zeitpunkte, und eine
  // laufende Uhr neben einem stehenden Zeitgeber ergäbe Unsinn.
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  const socket = new FakeSocket()
  const ws = accept(request(), socket as unknown as Duplex)
  ok(ws, 'Handschlag ist nicht zustande gekommen')
  socket.written.length = 0
  return { socket, ws }
}

describe('Lebenszeichen', () => {
  it('fragt in festem Takt nach', (t) => {
    const { socket } = connected(t)

    t.mock.timers.tick(PING_INTERVAL_MS - 1)
    strictEqual(socket.frames().length, 0, 'vor der Zeit darf nichts hinausgehen')

    t.mock.timers.tick(1)
    t.mock.timers.tick(PING_INTERVAL_MS)
    const frames = socket.frames()
    strictEqual(frames.length, 2)
    for (const sent of frames) {
      strictEqual(sent.opcode, OPCODE.ping)
      // Ein Ping ohne Nutzlast: Es geht um das Ankommen, nicht um den Inhalt.
      strictEqual(sent.length, 0)
    }
  })

  it('gibt eine Verbindung auf, aus der lange nichts mehr kommt', (t) => {
    const { socket, ws } = connected(t)
    let closed = false
    ws.onClose = () => {
      closed = true
    }

    t.mock.timers.tick(SILENCE_LIMIT_MS)
    strictEqual(closed, false, 'genau an der Grenze ist noch nichts verloren')
    ok(ws.open)

    t.mock.timers.tick(PING_INTERVAL_MS)
    strictEqual(closed, true, 'nach drei unbeantworteten Runden ist Schluss')
    strictEqual(ws.open, false)
    ok(socket.destroyed)
  })

  it('lässt eine Verbindung stehen, solange etwas hereinkommt', (t) => {
    const { socket, ws } = connected(t)
    let closed = false
    ws.onClose = () => {
      closed = true
    }

    // Ein Pong des Browsers reicht — er ist die übliche Antwort auf den Ping
    // und kommt, ohne dass die Seite davon erfährt.
    for (let elapsed = 0; elapsed < SILENCE_LIMIT_MS * 3; elapsed += PING_INTERVAL_MS) {
      t.mock.timers.tick(PING_INTERVAL_MS)
      socket.feed(clientFrame(0xa, Buffer.alloc(0)))
    }

    strictEqual(closed, false)
    ok(ws.open)
  })

  it('hört auf zu fragen, sobald die Verbindung zu ist', (t) => {
    const { socket, ws } = connected(t)
    ws.close()
    socket.written.length = 0

    t.mock.timers.tick(PING_INTERVAL_MS * 4)
    strictEqual(socket.frames().length, 0, 'ein geschlossener Sockel bekommt keine Pings mehr')
  })

  it('zählt jede eingehende Nachricht als Lebenszeichen, nicht nur den Pong', (t) => {
    const { socket, ws } = connected(t)
    let closed = false
    ws.onClose = () => {
      closed = true
    }

    t.mock.timers.tick(SILENCE_LIMIT_MS)
    socket.feed(clientFrame(OPCODE.text, Buffer.from('{"t":"ping"}')))
    t.mock.timers.tick(SILENCE_LIMIT_MS)

    strictEqual(closed, false)
  })

  it('schickt beim Schließen einen Abschiedsrahmen', (t) => {
    const { socket, ws } = connected(t)
    ws.close(1001, 'James beendet')
    const frames = socket.frames()
    strictEqual(frames.length, 1)
    strictEqual(frames[0].opcode, OPCODE.close)
  })
})


describe('Abgewiesene WebSocket-Verbindungen', () => {
  it('fängt einen Verbindungsreset auch vor dem erfolgreichen Handshake ab', () => {
    const socket = new FakeSocket()
    const req = request()
    req.headers['sec-websocket-version'] = '12'
    strictEqual(accept(req, socket as unknown as Duplex), null)
    socket.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
    strictEqual(socket.destroyed, true)
  })
})
