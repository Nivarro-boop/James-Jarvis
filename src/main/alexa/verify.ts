import { createVerify, X509Certificate } from 'node:crypto'

/**
 * Der Türsteher.
 *
 * Diese Datei ist der Grund, warum die Alexa-Anbindung überhaupt vertretbar
 * ist. Dahinter sitzt ein Assistent mit Zugriff auf Kalender, Gedächtnis,
 * Musik und das Licht im Wohnzimmer, und der Endpunkt steht im offenen Netz —
 * er muss, sonst kommt Amazon nicht heran. Ohne Prüfung könnte jeder, der die
 * Tunneladresse errät, ihm Befehle schicken.
 *
 * Amazon unterschreibt deshalb jede Anfrage. Geprüft wird in dieser
 * Reihenfolge, und jede Stufe für sich lehnt ab:
 *
 * 1. Die Adresse der Zertifikatskette. Sie muss bei Amazons S3 unter
 *    `/echo.api/` liegen — dort kann nur Amazon etwas ablegen. Das ist die
 *    wichtigste Prüfung von allen: Ohne sie könnte ein Angreifer seine eigene
 *    Kette unterschieben und alles Weitere selbst unterschreiben.
 * 2. Das Zertifikat: gültiger Zeitraum, und es muss auf
 *    `echo-api.amazon.com` ausgestellt sein.
 * 3. Die Kette: jedes Zertifikat vom nächsten unterschrieben.
 * 4. Die Unterschrift über den *rohen* Rumpf.
 * 5. Der Zeitstempel, gegen das Wiedereinspielen alter Anfragen.
 * 6. Die Skill-Kennung, damit eine fremde Skill nicht mitreden kann.
 *
 * ── Was hier bewusst fehlt ──
 *
 * Die Kette wird nicht bis zu einer Wurzel im Zertifikatsspeicher von Windows
 * verankert — Node gibt den Speicher für eine Einzelprüfung nicht her, ohne
 * eine TLS-Verbindung aufzubauen. Getragen wird die Sicherheit stattdessen von
 * Stufe 1: Die Kette kommt nachweislich von Amazons S3, weil sie von dort
 * geladen wurde und die Adresse geprüft ist. Wer dort etwas ablegen kann, hat
 * ohnehin gewonnen.
 */

/** Wie lange eine Anfrage höchstens alt sein darf. Amazons eigene Vorgabe. */
const MAX_AGE_MS = 150_000

/**
 * Geladene Ketten merken.
 *
 * Amazon wechselt das Zertifikat selten und schickt bei jeder Äußerung
 * dieselbe Adresse mit. Sie jedes Mal zu laden hieße: ein Netzaufruf nach
 * Irland, bevor James auch nur anfängt nachzudenken — und das innerhalb von
 * acht Sekunden, die Alexa insgesamt gewährt.
 */
const chainCache = new Map<string, X509Certificate[]>()

export interface VerifyResult {
  ok: boolean
  /** Warum nicht — landet im Protokoll, nie in der Antwort an Amazon. */
  reason?: string
}

/**
 * Ist die Adresse der Kette eine, der man trauen kann?
 *
 * Amazons eigene Vorgabe, Zeichen für Zeichen: https, Host `s3.amazonaws.com`,
 * Port 443, Pfad beginnt mit `/echo.api/`. Der Pfadvergleich ist die Stelle,
 * an der Schludrigkeit teuer wird — `startsWith('/echo.api')` ohne Schrägstrich
 * ließe auch `/echo.api.angreifer.de/` durch.
 */
export function certUrlAllowed(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }

  if (url.protocol !== 'https:') return false
  if (url.hostname.toLowerCase() !== 's3.amazonaws.com') return false
  if (url.port && url.port !== '443') return false

  // Doppelte Schrägstriche und `..` wegnormalisieren, bevor verglichen wird.
  const path = url.pathname.replace(/\/+/g, '/')
  if (path.includes('..')) return false
  return path.startsWith('/echo.api/')
}

/** Die einzelnen Zertifikate aus einer PEM-Datei holen. */
function splitPem(pem: string): X509Certificate[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []
  return blocks.map((block) => new X509Certificate(block))
}

async function loadChain(url: string): Promise<X509Certificate[]> {
  const cached = chainCache.get(url)
  if (cached) return cached

  const response = await fetch(url, { signal: AbortSignal.timeout(4000) })
  if (!response.ok) throw new Error(`Amazons Zertifikat war nicht abrufbar (${response.status}).`)

  const chain = splitPem(await response.text())
  if (chain.length === 0) throw new Error('Unter der Adresse lag kein Zertifikat.')

  chainCache.set(url, chain)
  return chain
}

/**
 * Die Kette prüfen: Gültigkeit, Name, und wer wen unterschrieben hat.
 *
 * Die Schleife hört bewusst vor dem letzten auf: Das letzte Zertifikat ist die
 * Wurzel und unterschreibt sich selbst.
 */
function chainValid(chain: X509Certificate[], now: Date): VerifyResult {
  const leaf = chain[0]

  if (new Date(leaf.validFrom) > now) return { ok: false, reason: 'Zertifikat noch nicht gültig.' }
  if (new Date(leaf.validTo) < now) return { ok: false, reason: 'Zertifikat abgelaufen.' }

  // Amazon stellt das Blatt auf diesen Namen aus. Fehlt er, gehört das
  // Zertifikat zu irgendetwas anderem bei S3 — und damit nicht hierher.
  if (!leaf.checkHost('echo-api.amazon.com')) {
    return { ok: false, reason: 'Zertifikat gehört nicht zu echo-api.amazon.com.' }
  }

  for (let i = 0; i < chain.length - 1; i++) {
    if (!chain[i].verify(chain[i + 1].publicKey)) {
      return { ok: false, reason: 'Die Zertifikatskette ist nicht durchgehend unterschrieben.' }
    }
  }

  return { ok: true }
}

export interface AlexaEnvelope {
  version?: string
  session?: { application?: { applicationId?: string } }
  context?: { System?: { application?: { applicationId?: string } } }
  request?: { type?: string; timestamp?: string; intent?: { name?: string; slots?: Record<string, { value?: string }> } }
}

/**
 * Eine eingegangene Anfrage vollständig prüfen.
 *
 * `rawBody` muss der Rumpf sein, wie er über die Leitung kam — nicht das
 * Ergebnis von `JSON.parse` und erneutem `JSON.stringify`. Amazon unterschreibt
 * die Bytes, und schon eine andere Reihenfolge der Felder oder ein Leerzeichen
 * mehr macht die Unterschrift ungültig. Diese Falle ist der häufigste Grund,
 * warum eine selbst gehostete Skill „funktioniert" und trotzdem jede echte
 * Anfrage ablehnt.
 */
export async function verifyAlexaRequest(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  expectedSkillId: string,
  now: Date = new Date()
): Promise<VerifyResult> {
  const header = (name: string): string => {
    const value = headers[name]
    return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
  }

  const certUrl = header('signaturecertchainurl')
  // Amazon schickt beides: `signature` mit SHA-1 und `signature-256`. SHA-1
  // gilt seit Jahren als gebrochen — genommen wird ausschließlich die zweite.
  const signature = header('signature-256')

  if (!certUrl || !signature) {
    return { ok: false, reason: 'Anfrage ohne Unterschrift.' }
  }
  if (!certUrlAllowed(certUrl)) {
    return { ok: false, reason: `Zertifikatsadresse nicht zulässig: ${certUrl}` }
  }

  let chain: X509Certificate[]
  try {
    chain = await loadChain(certUrl)
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }

  const valid = chainValid(chain, now)
  if (!valid.ok) return valid

  const verifier = createVerify('RSA-SHA256')
  verifier.update(rawBody)
  if (!verifier.verify(chain[0].publicKey, signature, 'base64')) {
    return { ok: false, reason: 'Die Unterschrift passt nicht zum Rumpf.' }
  }

  let envelope: AlexaEnvelope
  try {
    envelope = JSON.parse(rawBody.toString('utf8')) as AlexaEnvelope
  } catch {
    return { ok: false, reason: 'Der Rumpf war kein JSON.' }
  }

  /*
   * Der Zeitstempel gegen das Wiedereinspielen.
   *
   * Ohne ihn könnte jemand, der eine gültige Anfrage einmal mitgeschnitten
   * hat, sie beliebig oft erneut schicken — Unterschrift und Zertifikat wären
   * jedes Mal einwandfrei.
   */
  const stamp = Date.parse(envelope.request?.timestamp ?? '')
  if (!Number.isFinite(stamp)) return { ok: false, reason: 'Anfrage ohne Zeitstempel.' }
  if (Math.abs(now.getTime() - stamp) > MAX_AGE_MS) {
    return { ok: false, reason: 'Anfrage ist zu alt oder liegt in der Zukunft.' }
  }

  /*
   * Und zuletzt: Ist das überhaupt unsere Skill?
   *
   * Die Tunneladresse ist nicht geheim, und eine fremde Skill könnte auf sie
   * zeigen. Deren Anfragen trügen echte Amazon-Unterschriften — sie kämen ja
   * wirklich von Amazon. Nur die Kennung unterscheidet sie.
   */
  const appId =
    envelope.context?.System?.application?.applicationId ??
    envelope.session?.application?.applicationId ??
    ''
  if (!expectedSkillId) return { ok: false, reason: 'Es ist keine Skill-Kennung hinterlegt.' }
  if (appId !== expectedSkillId) {
    return { ok: false, reason: 'Die Anfrage gehört zu einer anderen Skill.' }
  }

  return { ok: true }
}

/** Nur zum Testen. */
export const __internals = { splitPem, chainValid, MAX_AGE_MS }
