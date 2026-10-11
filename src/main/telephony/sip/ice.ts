import { createHmac, randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { crc32 } from 'node:zlib'

/**
 * ICE-lite für den Ton eines Linphone-Anrufs (RFC 8445, STUN nach RFC 5389).
 *
 * Warum überhaupt: Ohne ICE schickt jede Seite ihren Ton an die Adresse aus
 * dem SDP der anderen. Beim iPhone im WLAN ist das eine private Adresse wie
 * 192.168.1.10 — von hier aus unerreichbar. Umgekehrt schickt das Telefon an
 * unsere öffentliche Adresse, aber der Router lässt nur herein, was zu einem
 * Paket passt, das vorher hinausging. Ergebnis: Das Gespräch steht, und beide
 * hören nichts.
 *
 * Linphone ist ein vollständiger ICE-Agent. Wir sind „lite": Wir nennen nur
 * unsere Kandidaten und beantworten die Prüfanfragen des Telefons. Das reicht,
 * damit das Telefon einen Weg findet, der wirklich durchgeht — notfalls über
 * seinen TURN-Server bei Linphone, weil es für unsere Kandidaten dort eine
 * Erlaubnis einrichtet.
 */

const MAGIC = 0x2112a442
const BINDING_REQUEST = 0x0001
const BINDING_SUCCESS = 0x0101
const ATTR_USERNAME = 0x0006
const ATTR_MESSAGE_INTEGRITY = 0x0008
const ATTR_XOR_MAPPED_ADDRESS = 0x0020
const ATTR_USE_CANDIDATE = 0x0025
const ATTR_FINGERPRINT = 0x8028
const FINGERPRINT_XOR = 0x5354554e

export interface IceCredentials {
  ufrag: string
  pwd: string
}

export interface IceCandidate {
  foundation: string
  component: number
  transport: string
  priority: number
  address: string
  port: number
  type: 'host' | 'srflx' | 'prflx' | 'relay'
}

export function newIceCredentials(): IceCredentials {
  // ufrag mindestens 4, pwd mindestens 22 Zeichen aus dem ICE-Zeichensatz.
  const chars = (n: number): string =>
    randomBytes(n)
      .toString('base64')
      .replace(/[^A-Za-z0-9]/g, 'x')
      .slice(0, n)
  return { ufrag: chars(8), pwd: chars(24) }
}

/** Ist das ein STUN-Paket? RTP beginnt mit Version 2 (0b10), STUN mit 0b00 und dem Magic Cookie. */
export function isStun(packet: Buffer): boolean {
  return packet.length >= 20 && (packet[0] & 0xc0) === 0 && packet.readUInt32BE(4) === MAGIC
}

interface StunAttr {
  type: number
  value: Buffer
}

function pad(value: Buffer, padByte: number): Buffer {
  const rest = value.length % 4
  return rest === 0 ? value : Buffer.concat([value, Buffer.alloc(4 - rest, padByte)])
}

function encodeAttr(attr: StunAttr, padByte = 0): Buffer {
  const head = Buffer.alloc(4)
  head.writeUInt16BE(attr.type, 0)
  head.writeUInt16BE(attr.value.length, 2)
  return Buffer.concat([head, pad(attr.value, padByte)])
}

/**
 * Eine STUN-Nachricht mit MESSAGE-INTEGRITY und FINGERPRINT.
 *
 * Die Längenangabe im Kopf muss beim Rechnen der Prüfsumme schon die
 * Prüfsumme selbst enthalten — das ist die Stelle, an der man es falsch
 * macht. `padByte` gibt es nur für den Testvektor aus RFC 5769.
 */
export function buildStun(
  type: number,
  transactionId: Buffer,
  attrs: StunAttr[],
  key: string,
  padByte = 0
): Buffer {
  const body = Buffer.concat(attrs.map((a) => encodeAttr(a, padByte)))
  const header = Buffer.alloc(20)
  header.writeUInt16BE(type, 0)
  header.writeUInt32BE(MAGIC, 4)
  transactionId.copy(header, 8, 0, 12)

  header.writeUInt16BE(body.length + 24, 2)
  const mac = createHmac('sha1', key).update(Buffer.concat([header, body])).digest()
  const withMac = Buffer.concat([body, encodeAttr({ type: ATTR_MESSAGE_INTEGRITY, value: mac })])

  header.writeUInt16BE(withMac.length + 8, 2)
  const crc = (crc32(Buffer.concat([header, withMac])) ^ FINGERPRINT_XOR) >>> 0
  const fp = Buffer.alloc(4)
  fp.writeUInt32BE(crc, 0)
  return Buffer.concat([header, withMac, encodeAttr({ type: ATTR_FINGERPRINT, value: fp })])
}

export function xorMappedAddress(address: string, port: number): Buffer {
  const value = Buffer.alloc(8)
  value[1] = 0x01
  value.writeUInt16BE(port ^ (MAGIC >>> 16), 2)
  const raw = address.split('.').reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0)
  value.writeUInt32BE((raw ^ MAGIC) >>> 0, 4)
  return value
}

function readAttrs(packet: Buffer): StunAttr[] {
  const attrs: StunAttr[] = []
  const end = Math.min(packet.length, 20 + packet.readUInt16BE(2))
  let offset = 20
  while (offset + 4 <= end) {
    const type = packet.readUInt16BE(offset)
    const length = packet.readUInt16BE(offset + 2)
    attrs.push({ type, value: packet.subarray(offset + 4, offset + 4 + length) })
    offset += 4 + Math.ceil(length / 4) * 4
  }
  return attrs
}

/**
 * Antwort auf eine Prüfanfrage des Telefons, oder `null`, wenn sie nicht an
 * uns gerichtet ist.
 *
 * Der Benutzername einer Prüfanfrage lautet „unser-ufrag:deren-ufrag". Was
 * nicht mit unserem ufrag beginnt, gehört zu einem anderen Gespräch.
 */
export function answerBindingRequest(
  packet: Buffer,
  from: { address: string; port: number },
  local: IceCredentials
): { response: Buffer; useCandidate: boolean } | null {
  if (!isStun(packet) || packet.readUInt16BE(0) !== BINDING_REQUEST) return null
  if (from.address.includes(':')) return null
  const attrs = readAttrs(packet)
  const username = attrs.find((a) => a.type === ATTR_USERNAME)?.value.toString('utf8') ?? ''
  if (!username.startsWith(`${local.ufrag}:`)) return null
  const response = buildStun(
    BINDING_SUCCESS,
    packet.subarray(8, 20),
    [{ type: ATTR_XOR_MAPPED_ADDRESS, value: xorMappedAddress(from.address, from.port) }],
    local.pwd
  )
  return { response, useCandidate: attrs.some((a) => a.type === ATTR_USE_CANDIDATE) }
}

/** Die eigenen IPv4-Adressen im Netz, ohne Loopback und ohne Link-local. */
export function localAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || entry.address.startsWith('169.254.')) continue
      out.push(entry.address)
    }
  }
  return out
}

function priority(type: IceCandidate['type'], localPref: number): number {
  const typePref = type === 'host' ? 126 : type === 'prflx' ? 110 : type === 'srflx' ? 100 : 0
  return typePref * 2 ** 24 + localPref * 2 ** 8 + 255
}

/** Unsere Kandidaten: alle Netzadressen dieses Rechners, dazu die öffentliche aus STUN. */
export function localCandidates(port: number, mapped: { address: string; port: number } | null): IceCandidate[] {
  const hosts = localAddresses()
  const candidates: IceCandidate[] = hosts.map((address, i) => ({
    foundation: String(i + 1),
    component: 1,
    transport: 'UDP',
    priority: priority('host', 65535 - i),
    address,
    port,
    type: 'host'
  }))
  if (mapped && !hosts.includes(mapped.address)) {
    candidates.push({
      foundation: String(hosts.length + 1),
      component: 1,
      transport: 'UDP',
      priority: priority('srflx', 65535),
      address: mapped.address,
      port: mapped.port,
      type: 'srflx'
    })
  }
  return candidates
}

export function candidateLine(c: IceCandidate, base?: { address: string; port: number }): string {
  const rel = c.type !== 'host' && base ? ` raddr ${base.address} rport ${base.port}` : ''
  return `a=candidate:${c.foundation} ${c.component} ${c.transport} ${c.priority} ${c.address} ${c.port} typ ${c.type}${rel}`
}

/** `a=candidate:` des Gegenübers lesen; nur UDP, Komponente 1, IPv4. */
export function parseCandidates(sdp: string): IceCandidate[] {
  const out: IceCandidate[] = []
  for (const match of sdp.matchAll(/^a=candidate:(\S+) (\d+) (\S+) (\d+) (\S+) (\d+) typ (\S+)/gm)) {
    const [, foundation, component, transport, prio, address, port, type] = match
    if (component !== '1' || transport.toUpperCase() !== 'UDP' || address.includes(':')) continue
    if (!['host', 'srflx', 'prflx', 'relay'].includes(type)) continue
    out.push({
      foundation,
      component: 1,
      transport: 'UDP',
      priority: Number(prio),
      address,
      port: Number(port),
      type: type as IceCandidate['type']
    })
  }
  return out.sort((a, b) => b.priority - a.priority)
}
