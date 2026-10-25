import { createHash, randomBytes } from 'node:crypto'

/**
 * Verpackt den mitgelieferten Google-Client für den Build.
 *
 * Ohne das stünden Client-ID und Geheimnis als lesbarer Text in
 * out/main/index.js, und ein `findstr apps.googleusercontent.com` im
 * Installationsordner förderte sie zutage. Jetzt steht dort nur ein Klumpen
 * Base64: zufälliger Schlüssel pro Build, damit ein Strom aus SHA-256 erzeugt
 * und per XOR über das JSON gelegt.
 *
 * Das ist Verschleierung, keine Verschlüsselung — der Schlüssel liegt im selben
 * Klumpen, weil die App den Client zum Anmelden im Klartext braucht. Wer den
 * Hauptprozess zerlegt, findet ihn trotzdem. Google rechnet damit (ein
 * Desktop-Client gilt nicht als vertraulich); die Anmeldung selbst sichern PKCE
 * und `state`. Ziel ist nur, dass der Wert nicht beim Durchblättern auffällt
 * und nicht von Suchrobotern eingesammelt wird.
 */

export interface SealedPair {
  id: string
  secret: string
}

const KEY_BYTES = 16

function keystream(key: Buffer, length: number): Buffer {
  const out = Buffer.alloc(length)
  for (let block = 0; block * 32 < length; block++) {
    const counter = Buffer.alloc(4)
    counter.writeUInt32BE(block)
    createHash('sha256').update(key).update(counter).digest().copy(out, block * 32)
  }
  return out
}

function xor(data: Buffer, key: Buffer): Buffer {
  const stream = keystream(key, data.length)
  return Buffer.from(data.map((byte, i) => byte ^ stream[i]))
}

/** Für den Build: ein Paar in einen undurchsichtigen Base64-Text verwandeln. */
export function sealGoogleClient(pair: SealedPair, key: Buffer = randomBytes(KEY_BYTES)): string {
  const body = xor(Buffer.from(JSON.stringify({ i: pair.id, s: pair.secret }), 'utf8'), key)
  return Buffer.concat([key, body]).toString('base64url')
}

/** Zur Laufzeit: den Text wieder öffnen, oder `null`, wenn er leer oder kaputt ist. */
export function openGoogleClient(sealed: string): SealedPair | null {
  if (!sealed) return null
  try {
    const raw = Buffer.from(sealed, 'base64url')
    if (raw.length <= KEY_BYTES) return null
    const parsed = JSON.parse(xor(raw.subarray(KEY_BYTES), raw.subarray(0, KEY_BYTES)).toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const { i, s } = parsed as { i?: unknown; s?: unknown }
    return typeof i === 'string' && typeof s === 'string' ? { id: i, secret: s } : null
  } catch {
    return null
  }
}
