/**
 * SIP-Nachrichten lesen und schreiben — nur so viel, wie ein einzelnes
 * Telefon braucht: Anmelden, anrufen, angerufen werden, auflegen.
 *
 * Über eine TLS-Verbindung kommen Nachrichten als Strom; `SipStreamParser`
 * schneidet sie an der Leerzeile und an `Content-Length` auseinander.
 */

export interface SipMessage {
  /** Anfrage: Methode, sonst null. */
  method: string | null
  /** Anfrage: Request-URI. */
  uri: string
  /** Antwort: Statuscode, sonst 0. */
  status: number
  reason: string
  /** Kopfzeilen in Reihenfolge; Namen klein geschrieben. */
  headers: [string, string][]
  body: string
}

const COMPACT: Record<string, string> = {
  v: 'via',
  f: 'from',
  t: 'to',
  i: 'call-id',
  m: 'contact',
  l: 'content-length',
  c: 'content-type',
  k: 'supported'
}

export function header(msg: SipMessage, name: string): string | undefined {
  const wanted = name.toLowerCase()
  return msg.headers.find(([n]) => n === wanted)?.[1]
}

export function headers(msg: SipMessage, name: string): string[] {
  const wanted = name.toLowerCase()
  return msg.headers.filter(([n]) => n === wanted).map(([, v]) => v)
}

export function parseMessage(head: string, body: string): SipMessage {
  const lines = head.split('\r\n')
  const first = lines.shift() ?? ''
  const parsed: [string, string][] = []
  for (const line of lines) {
    // Fortsetzungszeilen gehören zur vorigen Kopfzeile.
    if (/^[ \t]/.test(line) && parsed.length > 0) {
      parsed[parsed.length - 1][1] += ' ' + line.trim()
      continue
    }
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const raw = line.slice(0, colon).trim().toLowerCase()
    const name = COMPACT[raw] ?? raw
    const value = line.slice(colon + 1).trim()
    // Mehrere Werte in einer Via- oder Record-Route-Zeile einzeln führen.
    if (name === 'via' || name === 'record-route' || name === 'route') {
      for (const part of splitList(value)) parsed.push([name, part])
    } else {
      parsed.push([name, value])
    }
  }
  const status = /^SIP\/2\.0 (\d{3}) ?(.*)$/.exec(first)
  if (status) {
    return { method: null, uri: '', status: Number(status[1]), reason: status[2], headers: parsed, body }
  }
  const [method = '', uri = ''] = first.split(' ')
  return { method: method.toUpperCase(), uri, status: 0, reason: '', headers: parsed, body }
}

/** Komma-getrennte Liste, ohne innerhalb von <…> oder "…" zu trennen. */
export function splitList(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let quoted = false
  let start = 0
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch === '<') depth++
    else if (!quoted && ch === '>') depth--
    else if (!quoted && depth === 0 && ch === ',') {
      out.push(value.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(value.slice(start).trim())
  return out.filter(Boolean)
}

export function buildRequest(method: string, uri: string, hdrs: [string, string][], body = ''): string {
  return build(`${method} ${uri} SIP/2.0`, hdrs, body)
}

export function buildResponse(status: number, reason: string, hdrs: [string, string][], body = ''): string {
  return build(`SIP/2.0 ${status} ${reason}`, hdrs, body)
}

function build(first: string, hdrs: [string, string][], body: string): string {
  const lines = [first, ...hdrs.map(([n, v]) => `${n}: ${v}`)]
  lines.push(`Content-Length: ${Buffer.byteLength(body)}`)
  return `${lines.join('\r\n')}\r\n\r\n${body}`
}

/** Der Wert eines Parameters außerhalb von <…>, z. B. `tag` aus `<sip:a@b>;tag=xyz`. */
export function param(value: string | undefined, name: string): string | undefined {
  if (!value) return undefined
  const outside = value.replace(/<[^>]*>/g, '')
  const match = new RegExp(`;\\s*${name}=([^;,\\s]+)`, 'i').exec(outside)
  return match?.[1]
}

/** Die URI aus `"Name" <sip:a@b;x>;tag=1` oder `sip:a@b`. */
export function uriOf(value: string | undefined): string | undefined {
  if (!value) return undefined
  const angle = /<([^>]+)>/.exec(value)
  if (angle) return angle[1]
  return value.split(';')[0].trim()
}

/** `user@host` aus einer SIP-URI, klein geschrieben — zum Vergleichen. */
export function addressOf(uri: string | undefined): string {
  if (!uri) return ''
  const match = /^sips?:([^;?>]+)/i.exec(uri.trim())
  return (match?.[1] ?? '').toLowerCase()
}

/**
 * Zerlegt einen Byte-Strom in einzelne Nachrichten. Leerzeilen zwischen
 * Nachrichten sind Keep-alives (RFC 5626) und werden übergangen.
 *
 * Gearbeitet wird auf Bytes, nicht auf Text: `Content-Length` zählt Bytes,
 * und ein Umlaut im Rumpf verschöbe sonst jede folgende Nachricht.
 */
export class SipStreamParser {
  private buffer = Buffer.alloc(0)

  constructor(private readonly onMessage: (msg: SipMessage) => void) {}

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      let skip = 0
      while (this.buffer[skip] === 0x0d || this.buffer[skip] === 0x0a) skip++
      if (skip > 0) this.buffer = this.buffer.subarray(skip)
      const end = this.buffer.indexOf('\r\n\r\n')
      if (end < 0) {
        if (this.buffer.length > 64 * 1024) this.buffer = Buffer.alloc(0)
        return
      }
      const head = this.buffer.subarray(0, end).toString('utf8')
      const length = Number(/^(?:content-length|l)\s*:\s*(\d+)/im.exec(head)?.[1] ?? 0)
      const total = end + 4 + length
      if (this.buffer.length < total) return
      const body = this.buffer.subarray(end + 4, total).toString('utf8')
      this.buffer = this.buffer.subarray(total)
      try {
        this.onMessage(parseMessage(head, body))
      } catch (err) {
        console.warn('[sip] Unlesbare Nachricht übergangen:', String(err).slice(0, 160))
      }
    }
  }
}
