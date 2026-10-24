import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

/**
 * Ein kleiner WebSocket-Server, von Hand.
 *
 * Die naheliegende Wahl wäre `ws` gewesen. Das Paket liegt sogar schon im
 * Ordner — aber nur, weil eine andere Abhängigkeit es mitgebracht hat, und
 * darauf zu bauen heißt, sich an eine fremde Abhängigkeitsliste zu hängen, die
 * beim nächsten `npm update` anders aussehen darf. Als eigenen Eintrag
 * aufzunehmen wäre ehrlicher, kostet aber ein Paket für das, was hier gebraucht
 * wird: ein Handschlag und ein Rahmenformat.
 *
 * Der Umfang ist bewusst klein gehalten. Was fehlt, fehlt mit Absicht:
 * keine Erweiterungen (also insbesondere keine Kompression), keine
 * Teilnachrichten über die Grenze hinaus, kein TLS — das Ding lauscht im
 * Heimnetz. Was da ist, hält sich an RFC 6455, weil ein Safari auf einem
 * iPhone sich nicht darum schert, dass wir es eilig hatten.
 */

/**
 * Die Zeichenkette aus RFC 6455, Abschnitt 1.3. Sie ist keine Variable, und sie
 * ist auch keine gültige UUID — die letzte Gruppe hat zwölf Stellen und die
 * vorletzte vier, aber die Trennstriche sitzen nicht dort, wo man sie erwartet.
 * Genau daran ist der erste Anlauf gescheitert: aus `95CA-C5AB0DC85B11` wurde
 * beim Abschreiben `95CA-5AB0DC85B11F`, und der Handschlag scheiterte mit einer
 * Fehlermeldung, die von einem falschen Schlüssel nichts sagt.
 */
const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa
} as const

/**
 * Obergrenze für eine zusammengesetzte Nachricht.
 *
 * Ohne sie kann ein Gegenüber, das eine Länge von acht Byte ankündigt und dann
 * langsam liefert, den Hauptprozess mit einem einzigen Rahmen leerlaufen
 * lassen. Zwei Megabyte sind für Tonblöcke von 640 Byte und ein paar
 * JSON-Zeilen großzügig.
 */
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024

/**
 * Lebenszeichen auf Protokollebene.
 *
 * Ein Sockel, dessen Weg unterbrochen wurde, sieht von hier aus wie ein
 * gesunder: TCP schweigt jahrelang zufrieden vor sich hin, wenn niemand etwas
 * schickt. Ein Telefon, das in der U-Bahn den Empfang verliert, blieb deshalb in
 * `phones` stehen — der Kristall zählte es mit, hielt womöglich die Sprechtaste
 * für gedrückt, und das echte Mikrofon am Rechner blieb taub.
 *
 * Ein Ping alle fünfzehn Sekunden räumt damit auf. Beantworten muss ihn niemand
 * von Hand: Jeder Browser antwortet von sich aus mit einem Pong, ohne dass die
 * Seite davon erfährt. Kommt drei Runden lang gar nichts zurück, ist die
 * Gegenseite weg — und dann soll sie auch aus der Liste verschwinden.
 *
 * Nebenbei hält derselbe Ping die Übersetzungstabellen in Routern und im
 * Mobilfunknetz warm, die eine stille Verbindung nach ein paar Minuten
 * verwerfen.
 *
 * Diese Datei kennt bewusst nichts aus `@shared` — sie wird von den Tests roh
 * von Node geladen, und ein Alias, den nur der Bündler auflöst, wäre dort ein
 * Fehler beim Import. Die Zahlen für die Etage darüber stehen in
 * `shared/companion.ts` und dürfen andere sein; sie messen etwas anderes.
 */
const PING_INTERVAL_MS = 15_000
const SILENCE_LIMIT_MS = 45_000

export interface WsSocket {
  readonly id: string
  readonly open: boolean
  /** Woher die Verbindung kam — für das Protokoll und die Anzeige. */
  readonly remote: string
  sendText(text: string): void
  sendBinary(data: Uint8Array): void
  close(code?: number, reason?: string): void
  onText: ((text: string) => void) | null
  onBinary: ((data: Buffer) => void) | null
  onClose: (() => void) | null
}

/** Also protect rejected upgrades: they never reach the framed connection. */
export function guardSocket(socket: Duplex): void {
  socket.on('error', () => socket.destroy())
}

/**
 * Beantwortet den Upgrade-Handschlag und gibt die fertige Verbindung zurück.
 * `null` heißt: war keine gültige WebSocket-Anfrage, die Verbindung ist schon
 * abgewiesen.
 */
export function accept(req: IncomingMessage, socket: Duplex, head?: Buffer): WsSocket | null {
  guardSocket(socket)
  const key = req.headers['sec-websocket-key']
  const version = req.headers['sec-websocket-version']

  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    return null
  }
  // 13 ist die einzige Fassung, die es je in eine Freigabe geschafft hat.
  if (version !== '13') {
    socket.end('HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\n\r\n')
    return null
  }

  const accept = createHash('sha1')
    .update(key + HANDSHAKE_GUID)
    .digest('base64')

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  )

  return attach(socket, req, head)
}

function attach(socket: Duplex, req: IncomingMessage, head?: Buffer): WsSocket {
  /**
   * Node liefert beim Upgrade mit, was es über den Handschlag hinaus schon
   * gelesen hat. Meist ist das nichts — aber ein Client darf seinen ersten
   * Rahmen im selben Segment mitschicken, und dann steckt er hier drin. Wer
   * `head` ignoriert, verliert genau diesen einen Rahmen, und zwar nur
   * manchmal: der unangenehmste Fehler, den man sich einbauen kann.
   */
  let pending: Buffer = head && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0)
  let closed = false

  /**
   * Wann zuletzt überhaupt etwas hereinkam — Nachricht, Pong, gleich was.
   *
   * Gezählt wird auf der Ebene der Bytes und nicht der Nachrichten: Ein
   * Gegenüber, das nur Pongs schickt, ist am Leben, und ein Gegenüber, das
   * gerade einen großen Rahmen in Stücken liefert, erst recht.
   */
  let lastSeen = Date.now()

  /** Teile einer über mehrere Rahmen verteilten Nachricht. */
  let fragments: Buffer[] = []
  let fragmentOpcode = 0
  let fragmentBytes = 0

  // Nagle abschalten: Tonblöcke von 640 Byte sollen sofort raus und nicht
  // darauf warten, dass sich noch etwas dazugesellt. Genau dieses Warten wäre
  // im Gespräch als Verzögerung hörbar.
  if ('setNoDelay' in socket) (socket as { setNoDelay(v: boolean): void }).setNoDelay(true)

  const handle: WsSocket = {
    id: randomUUID(),
    remote: req.socket.remoteAddress ?? 'unbekannt',
    get open() {
      return !closed
    },
    sendText(text) {
      write(OPCODE.text, Buffer.from(text, 'utf-8'))
    },
    sendBinary(data) {
      write(OPCODE.binary, Buffer.from(data.buffer, data.byteOffset, data.byteLength))
    },
    close(code = 1000, reason = '') {
      if (closed) return
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason))
      payload.writeUInt16BE(code, 0)
      payload.write(reason, 2, 'utf-8')
      write(OPCODE.close, payload)
      finish()
    },
    onText: null,
    onBinary: null,
    onClose: null
  }

  function write(opcode: number, payload: Buffer): void {
    if (closed || socket.destroyed) return
    socket.write(frame(opcode, payload))
  }

  function finish(): void {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    socket.end()
    socket.destroy()
    handle.onClose?.()
  }

  const heartbeat = setInterval(() => {
    if (closed) return
    if (Date.now() - lastSeen > SILENCE_LIMIT_MS) {
      console.info(`[companion] ${handle.remote} antwortet nicht mehr — Verbindung aufgegeben`)
      finish()
      return
    }
    write(OPCODE.ping, Buffer.alloc(0))
  }, PING_INTERVAL_MS)
  // Ein Zeitgeber, der die Ereignisschleife am Leben hält, verzögert das Beenden
  // der App um bis zu fünfzehn Sekunden. Hier hängt nichts daran.
  heartbeat.unref?.()

  function fail(code: number, why: string): void {
    if (!closed) {
      const payload = Buffer.alloc(2 + Buffer.byteLength(why))
      payload.writeUInt16BE(code, 0)
      payload.write(why, 2, 'utf-8')
      write(OPCODE.close, payload)
    }
    finish()
  }

  /** In einem Rutsch können mehrere Rahmen ankommen — schleifen, bis keiner mehr ganz ist. */
  function drain(): void {
    for (;;) {
      if (closed) return
      const parsed = readFrame(pending)
      if (parsed === null) return
      if (parsed === 'invalid') {
        fail(1002, 'Ungueltiger Rahmen')
        return
      }

      pending = pending.subarray(parsed.consumed)
      dispatch(parsed)
    }
  }

  socket.on('data', (chunk: Buffer) => {
    lastSeen = Date.now()
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
    drain()
  })

  function dispatch(f: Frame): void {
    // Steuerrahmen dürfen jederzeit zwischen den Teilen einer Nachricht
    // stehen und werden für sich behandelt.
    if (f.opcode === OPCODE.close) {
      finish()
      return
    }
    if (f.opcode === OPCODE.ping) {
      write(OPCODE.pong, f.payload)
      return
    }
    if (f.opcode === OPCODE.pong) return

    if (f.opcode === OPCODE.continuation) {
      if (fragmentOpcode === 0) {
        fail(1002, 'Fortsetzung ohne Anfang')
        return
      }
    } else {
      if (fragmentOpcode !== 0) {
        fail(1002, 'Neue Nachricht vor dem Ende der alten')
        return
      }
      fragmentOpcode = f.opcode
    }

    fragmentBytes += f.payload.length
    if (fragmentBytes > MAX_MESSAGE_BYTES) {
      fail(1009, 'Nachricht zu gross')
      return
    }
    fragments.push(f.payload)

    if (!f.fin) return

    const complete = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments)
    const opcode = fragmentOpcode
    fragments = []
    fragmentOpcode = 0
    fragmentBytes = 0

    try {
      if (opcode === OPCODE.text) handle.onText?.(complete.toString('utf-8'))
      else if (opcode === OPCODE.binary) handle.onBinary?.(complete)
    } catch (err) {
      // Ein Fehler im Verarbeiten darf die Verbindung nicht mit in den Abgrund
      // ziehen — sonst legt eine kaputte Nachricht das Telefon lahm.
      console.error('[companion] Fehler beim Verarbeiten einer Nachricht:', err)
    }
  }

  socket.on('error', () => finish())
  socket.on('close', () => finish())

  // Erst jetzt, wo die Rückrufe stehen: Was in `head` lag, wird sonst
  // verarbeitet, bevor der Aufrufer `onText` setzen konnte.
  if (pending.length > 0) queueMicrotask(drain)

  return handle
}

interface Frame {
  fin: boolean
  opcode: number
  payload: Buffer
  consumed: number
}

/**
 * Liest genau einen Rahmen. `null` heißt "noch nicht genug Daten",
 * `'invalid'` heißt "so redet kein gültiger Gegenüber".
 */
function readFrame(buf: Buffer): Frame | null | 'invalid' {
  if (buf.length < 2) return null

  const first = buf[0]
  const second = buf[1]

  // Die Erweiterungsbits müssen null sein — wir haben keine ausgehandelt.
  if ((first & 0x70) !== 0) return 'invalid'

  const fin = (first & 0x80) !== 0
  const opcode = first & 0x0f
  const masked = (second & 0x80) !== 0
  let length = second & 0x7f
  let offset = 2

  const control = (opcode & 0x8) !== 0
  // Steuerrahmen müssen kurz und am Stück sein, sonst ist das Gegenüber kaputt.
  if (control && (length > 125 || !fin)) return 'invalid'

  if (length === 126) {
    if (buf.length < offset + 2) return null
    length = buf.readUInt16BE(offset)
    offset += 2
  } else if (length === 127) {
    if (buf.length < offset + 8) return null
    const big = buf.readBigUInt64BE(offset)
    // Über zwei Gigabyte kann ein Buffer ohnehin nicht, und so weit soll es
    // gar nicht erst kommen.
    if (big > BigInt(MAX_MESSAGE_BYTES)) return 'invalid'
    length = Number(big)
    offset += 8
  }

  // Vom Client zum Server ist die Maske Pflicht. Fehlt sie, ist das kein
  // Browser, sondern jemand, der von Hand auf den Port schreibt.
  if (!masked) return 'invalid'

  if (buf.length < offset + 4 + length) return null
  const mask = buf.subarray(offset, offset + 4)
  offset += 4

  const payload = Buffer.allocUnsafe(length)
  const source = buf.subarray(offset, offset + length)
  for (let i = 0; i < length; i++) payload[i] = source[i] ^ mask[i & 3]

  return { fin, opcode, payload, consumed: offset + length }
}

/** Rahmen vom Server sind unmaskiert — RFC 6455, Abschnitt 5.1. */
function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length
  let header: Buffer

  if (length < 126) {
    header = Buffer.allocUnsafe(2)
    header[1] = length
  } else if (length < 65_536) {
    header = Buffer.allocUnsafe(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode

  return Buffer.concat([header, payload])
}

/** Nur zum Prüfen des Rahmenformats. */
export const __internals = { readFrame, frame }
