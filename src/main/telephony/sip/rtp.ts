import { createSocket, type Socket } from 'node:dgram'
import { randomBytes, randomInt } from 'node:crypto'
import {
  answerBindingRequest,
  candidateLine,
  isStun,
  parseCandidates,
  type IceCandidate,
  type IceCredentials
} from './ice'

/**
 * Der Ton eines SIP-Anrufs: RTP über UDP, G.711 µ-law, 8 kHz, 20 ms je Paket.
 *
 * Dasselbe Format, das Twilio über seinen WebSocket schickt — deshalb kann
 * `LiveCall` hier unverändert dranhängen.
 *
 * Gesendet wird gleichmäßig alle 20 ms, auch Stille, wenn gerade nichts zu
 * sagen ist: Ohne ständigen Verkehr schließt ein Router die UDP-Freigabe, und
 * Medienrelais legen eine stumme Leitung nach einiger Zeit still.
 *
 * Wohin gesendet wird, steht zuerst im SDP der Gegenseite. Kommt danach ein
 * Paket von einer anderen Adresse, gilt diese („symmetrisches RTP"): Hinter
 * einem Router stimmt die Adresse im SDP oft nicht, die Absenderadresse schon.
 *
 * Bis das erste Paket kommt, geht der Ton an alle Kandidaten der Gegenseite
 * zugleich. Das öffnet im eigenen Router die Tür für jede Adresse, von der das
 * Telefon antworten könnte — sonst wartete jede Seite auf die andere.
 */

const FRAME = 160
const SILENCE = 0xff
const PT_PCMU = 0

export interface RtpTarget {
  address: string
  port: number
}

export class RtpSession {
  private socket: Socket
  private seq = randomInt(0, 0xffff)
  private ts = randomInt(0, 0x7fffffff)
  private readonly ssrc = randomBytes(4).readUInt32BE(0)
  private queue = Buffer.alloc(0)
  private timer: NodeJS.Timeout | null = null
  private targets: RtpTarget[] = []
  private latched = false
  private closed = false
  private ice: IceCredentials | null = null
  /** Für das Protokoll nach dem Gespräch: kam überhaupt Ton an? */
  sent = 0
  received = 0

  private constructor(socket: Socket, private readonly onAudio: (muLaw: Buffer) => void) {
    this.socket = socket
    socket.on('message', (packet, from) => this.receive(packet, from.address, from.port))
    socket.on('error', (err) => console.warn('[sip] RTP-Fehler:', err.message))
  }

  /** Öffnet einen UDP-Port. Der Port steht danach in `port`. */
  static async open(onAudio: (muLaw: Buffer) => void): Promise<RtpSession> {
    const socket = createSocket('udp4')
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.bind(0, () => {
        socket.off('error', reject)
        resolve()
      })
    })
    return new RtpSession(socket, onAudio)
  }

  get port(): number {
    return this.socket.address().port
  }

  get udp(): Socket {
    return this.socket
  }

  /**
   * Wohin gesendet wird, laut SDP — eine Adresse oder alle Kandidaten.
   * Startet den Takt.
   */
  connect(target: RtpTarget | RtpTarget[]): void {
    const list = (Array.isArray(target) ? target : [target]).filter((t) => t.port > 0 && t.address !== '0.0.0.0')
    if (!this.latched) this.targets = list.slice(0, 8)
    if (this.timer || this.closed) return
    this.timer = setInterval(() => this.tick(), 20)
  }

  /** Prüfanfragen des Telefons beantworten (ICE-lite). */
  setIce(credentials: IceCredentials): void {
    this.ice = credentials
  }

  /** Wohin gerade gesendet wird — fürs Protokoll. */
  get destination(): string {
    return this.targets.map((t) => `${t.address}:${t.port}`).join(', ') || 'nirgendwohin'
  }

  /** µ-law in die Warteschlange. Beliebige Länge; gesendet wird in 160er-Stücken. */
  send(muLaw: Buffer): void {
    if (this.closed) return
    this.queue = Buffer.concat([this.queue, muLaw])
    // Mehr als zehn Sekunden Vorlauf heißt: Der Takt hängt. Dann lieber
    // vorne abschneiden, als minutenlang veraltetes Audio nachzuschieben.
    if (this.queue.length > FRAME * 500) this.queue = this.queue.subarray(this.queue.length - FRAME * 500)
  }

  /** Barge-in: Was noch nicht gesagt ist, verwerfen. */
  clear(): void {
    this.queue = Buffer.alloc(0)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    try {
      this.socket.close()
    } catch {
      // schon zu
    }
  }

  private tick(): void {
    if (this.targets.length === 0) return
    let payload: Buffer
    if (this.queue.length >= FRAME) {
      payload = this.queue.subarray(0, FRAME)
      this.queue = this.queue.subarray(FRAME)
    } else {
      payload = Buffer.alloc(FRAME, SILENCE)
      if (this.queue.length > 0) {
        this.queue.copy(payload)
        this.queue = Buffer.alloc(0)
      }
    }
    const header = Buffer.alloc(12)
    header[0] = 0x80
    header[1] = PT_PCMU
    header.writeUInt16BE(this.seq, 2)
    header.writeUInt32BE(this.ts >>> 0, 4)
    header.writeUInt32BE(this.ssrc, 8)
    this.seq = (this.seq + 1) & 0xffff
    this.ts = (this.ts + FRAME) >>> 0
    const packet = Buffer.concat([header, payload])
    for (const target of this.targets) this.socket.send(packet, target.port, target.address)
    this.sent++
  }

  private latch(address: string, port: number): void {
    this.latched = true
    this.targets = [{ address, port }]
  }

  private receive(packet: Buffer, address: string, port: number): void {
    if (isStun(packet)) {
      // Antworten auf eigene STUN-Fragen holt `publicAddress` selbst ab.
      if (!this.ice) return
      const answer = answerBindingRequest(packet, { address, port }, this.ice)
      if (!answer) return
      this.socket.send(answer.response, port, address)
      // Das Telefon hat diesen Weg gewählt: ab jetzt nur noch dorthin.
      if (answer.useCandidate) this.latch(address, port)
      return
    }
    if (packet.length < 12 || (packet[0] & 0xc0) !== 0x80) return
    const pt = packet[1] & 0x7f
    // RTCP auf demselben Port (rtcp-mux) hat Nutzlasttypen 200–204 im zweiten Byte.
    if (packet[1] >= 200 && packet[1] <= 204) return
    if (!this.latched) this.latch(address, port)
    if (pt !== PT_PCMU) return
    this.received++
    const csrc = packet[0] & 0x0f
    let offset = 12 + csrc * 4
    if (packet[0] & 0x10) {
      if (packet.length < offset + 4) return
      offset += 4 + packet.readUInt16BE(offset + 2) * 4
    }
    let end = packet.length
    if (packet[0] & 0x20) end -= packet[packet.length - 1]
    if (end <= offset) return
    this.onAudio(packet.subarray(offset, end))
  }
}

/**
 * Die eigene Adresse, wie sie von außen aussieht (STUN, RFC 5389).
 *
 * Über denselben UDP-Port, über den später der Ton läuft — nur so stimmt der
 * Port, den der Router dafür freigegeben hat.
 */
export async function publicAddress(socket: Socket, server = 'stun.linphone.org', port = 3478): Promise<RtpTarget | null> {
  const id = randomBytes(12)
  const request = Buffer.alloc(20)
  request.writeUInt16BE(0x0001, 0)
  request.writeUInt16BE(0, 2)
  request.writeUInt32BE(0x2112a442, 4)
  id.copy(request, 8)

  return new Promise((resolve) => {
    const done = (value: RtpTarget | null): void => {
      clearTimeout(timer)
      socket.off('message', onMessage)
      resolve(value)
    }
    const onMessage = (msg: Buffer): void => {
      if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0101 || !msg.subarray(8, 20).equals(id)) return
      let offset = 20
      while (offset + 4 <= msg.length) {
        const type = msg.readUInt16BE(offset)
        const length = msg.readUInt16BE(offset + 2)
        const value = msg.subarray(offset + 4, offset + 4 + length)
        if ((type === 0x0020 || type === 0x0001) && value.length >= 8 && value[1] === 0x01) {
          const xor = type === 0x0020
          const mappedPort = value.readUInt16BE(2) ^ (xor ? 0x2112 : 0)
          const raw = value.readUInt32BE(4) ^ (xor ? 0x2112a442 : 0)
          const address = [raw >>> 24, (raw >>> 16) & 0xff, (raw >>> 8) & 0xff, raw & 0xff].join('.')
          done({ address, port: mappedPort })
          return
        }
        offset += 4 + Math.ceil(length / 4) * 4
      }
    }
    const timer = setTimeout(() => done(null), 3000)
    socket.on('message', onMessage)
    socket.send(request, port, server, (err) => {
      if (err) done(null)
    })
  })
}

export interface SdpIce {
  credentials: IceCredentials
  candidates: IceCandidate[]
  /** Lokale Adresse, zu der ein srflx-Kandidat gehört. */
  base?: RtpTarget
}

/**
 * Das SDP-Angebot bzw. die Antwort: nur PCMU und Tastentöne.
 *
 * Mit `ice` kommen ICE-lite, die eigenen Kandidaten und rtcp-mux dazu. Ohne
 * rtcp-mux erwartete das Telefon für RTCP eine zweite Komponente mit eigenen
 * Kandidaten, und ICE schlüge dafür fehl.
 */
export function buildSdp(address: string, port: number, ice?: SdpIce): string {
  const session = Date.now()
  return [
    'v=0',
    `o=james ${session} ${session} IN IP4 ${address}`,
    's=James',
    `c=IN IP4 ${address}`,
    't=0 0',
    ...(ice ? ['a=ice-lite', `a=ice-ufrag:${ice.credentials.ufrag}`, `a=ice-pwd:${ice.credentials.pwd}`] : []),
    `m=audio ${port} RTP/AVP 0 101`,
    'a=rtpmap:0 PCMU/8000',
    'a=rtpmap:101 telephone-event/8000',
    'a=fmtp:101 0-15',
    'a=ptime:20',
    'a=sendrecv',
    ...(ice ? ['a=rtcp-mux', ...ice.candidates.map((c) => candidateLine(c, ice.base))] : []),
    ''
  ].join('\r\n')
}

export interface RemoteMedia {
  /** Wohin gesendet wird, die beste Adresse zuerst. */
  targets: RtpTarget[]
}

/** Was am SDP der Gegenseite nicht geht. */
export type SdpProblem = 'kein-pcmu' | 'srtp' | 'keine-ipv4' | 'kein-audio'

/** Als Satz, der sagt, was zu tun ist. */
export const SDP_PROBLEM_TEXT: Record<SdpProblem, string> = {
  'kein-pcmu': 'Das Telefon bietet G.711 (PCMU) nicht an. In Linphone unter Einstellungen, Audio, PCMU einschalten.',
  srtp:
    'Das Telefon verlangt verschlüsselten Ton (SRTP). In Linphone unter Einstellungen, Anrufe, die Medienverschlüsselung auf „Keine" stellen oder „Verschlüsselung erzwingen" ausschalten.',
  'keine-ipv4': 'Das Telefon nennt nur IPv6-Adressen. Mit WLAN statt Mobilfunk versuchen.',
  'kein-audio': 'Im Anruf steht keine Tonspur.'
}

/**
 * Wohin der Ton soll, aus dem SDP der Gegenseite.
 *
 * Die ICE-Kandidaten des Telefons zählen mit: Die Adresse in der c-Zeile ist
 * bei einem iPhone im WLAN die private, und im Mobilfunk oft IPv6. Früher
 * lehnte schon eine IPv6-c-Zeile den ganzen Anruf ab, ohne Protokollzeile.
 */
export function parseRemoteMedia(sdp: string): RemoteMedia | { problem: SdpProblem } {
  const media = /^m=audio (\d+) ([^\s]+) ([\d ]+)/m.exec(sdp)
  if (!media) return { problem: 'kein-audio' }
  const formats = media[3].trim().split(/\s+/)
  if (!formats.includes('0')) return { problem: 'kein-pcmu' }
  if (/SAVP/i.test(media[2])) return { problem: 'srtp' }

  const mediaBlock = sdp.slice(sdp.indexOf(media[0]))
  const session = /^c=IN IP4 ([^\s]+)/m.exec(sdp)?.[1]
  const address = /^c=IN IP4 ([^\s]+)/m.exec(mediaBlock)?.[1] ?? session
  const port = Number(media[1])

  const targets: RtpTarget[] = []
  const add = (t: RtpTarget): void => {
    if (t.port > 0 && t.address !== '0.0.0.0' && !targets.some((x) => x.address === t.address && x.port === t.port)) {
      targets.push({ address: t.address, port: t.port })
    }
  }
  // Die c-Zeile zuerst: Sie ist der Standard der Gegenseite und bei einer
  // Gegenstelle ohne ICE die einzige Angabe. Danach öffentliche Kandidaten,
  // private, und zuletzt das TURN-Relais des Telefons.
  const candidates = parseCandidates(mediaBlock)
  if (address) add({ address, port })
  for (const c of candidates.filter((c) => c.type === 'srflx' || c.type === 'prflx')) add(c)
  for (const c of candidates.filter((c) => c.type === 'host')) add(c)
  for (const c of candidates.filter((c) => c.type === 'relay')) add(c)
  if (targets.length === 0) return { problem: 'keine-ipv4' }
  return { targets }
}

/**
 * Die erste Adresse aus dem SDP, `null` wenn es keine gemeinsame Sprache gibt.
 * Für Stellen, die nur eine Adresse brauchen.
 */
export function parseSdp(sdp: string): RtpTarget | null {
  const media = parseRemoteMedia(sdp)
  return 'targets' in media ? media.targets[0] : null
}
