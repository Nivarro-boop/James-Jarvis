import { createHash, randomBytes } from 'node:crypto'
import { splitList } from './message'

/**
 * Digest-Anmeldung (RFC 2617 / RFC 8760). Der Server schickt eine oder
 * mehrere Aufforderungen; SHA-256 wird vor MD5 genommen, wenn beide kommen.
 */

export interface Challenge {
  realm: string
  nonce: string
  opaque?: string
  algorithm: 'MD5' | 'SHA-256'
  qop?: string
}

export function parseChallenges(values: string[]): Challenge[] {
  const out: Challenge[] = []
  for (const value of values) {
    if (!/^digest\s/i.test(value)) continue
    const fields: Record<string, string> = {}
    for (const part of splitList(value.replace(/^digest\s+/i, ''))) {
      const eq = part.indexOf('=')
      if (eq < 0) continue
      fields[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim().replace(/^"|"$/g, '')
    }
    const algorithm = (fields.algorithm ?? 'MD5').toUpperCase()
    if (algorithm !== 'MD5' && algorithm !== 'SHA-256') continue
    if (!fields.realm || !fields.nonce) continue
    out.push({ realm: fields.realm, nonce: fields.nonce, opaque: fields.opaque, algorithm, qop: fields.qop })
  }
  return out.sort((a, b) => Number(b.algorithm === 'SHA-256') - Number(a.algorithm === 'SHA-256'))
}

export function authorization(
  challenge: Challenge,
  method: string,
  uri: string,
  username: string,
  password: string,
  nc = 1,
  cnonce = randomBytes(8).toString('hex')
): string {
  const hash = (s: string): string =>
    createHash(challenge.algorithm === 'SHA-256' ? 'sha256' : 'md5').update(s).digest('hex')
  const ha1 = hash(`${username}:${challenge.realm}:${password}`)
  const ha2 = hash(`${method}:${uri}`)
  const parts = [
    `username="${username}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `algorithm=${challenge.algorithm}`
  ]
  const qop = challenge.qop?.split(',').map((q) => q.trim()).includes('auth') ? 'auth' : undefined
  if (qop) {
    const count = nc.toString(16).padStart(8, '0')
    parts.push(
      `response="${hash(`${ha1}:${challenge.nonce}:${count}:${cnonce}:${qop}:${ha2}`)}"`,
      `qop=${qop}`,
      `nc=${count}`,
      `cnonce="${cnonce}"`
    )
  } else {
    parts.push(`response="${hash(`${ha1}:${challenge.nonce}:${ha2}`)}"`)
  }
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`)
  return `Digest ${parts.join(', ')}`
}
