/**
 * Der Kopplungs-Link aus Einstellungen → Telefon am Rechner:
 *
 *   https://192.168.1.20:8788/#host=192.168.1.20:8788&token=…
 *
 * Die Seite dahinter liest Host und Marke selbst aus dem Fragment. Die App
 * prüft nur, dass es wirklich so ein Link ist, und merkt sich den Ursprung —
 * nur dorthin darf die WebView, nur von dort nimmt sie Nachrichten an.
 *
 * Bewusst ohne `URL` und `URLSearchParams`: Die Fassungen in React Native
 * sind Nachbauten mit regulären Ausdrücken und lesen Fragmente nicht
 * verlässlich.
 */
export interface Pairing {
  /** Vollständiger Link mit Fragment, so wie er geladen wird. */
  url: string
  /** `https://host:port` — die einzige erlaubte Adresse. */
  origin: string
  secure: boolean
}

export type PairingResult = { ok: true; pairing: Pairing } | { ok: false; error: string }

const LINK = /^(https?):\/\/([^/?#\s]+)[^#\s]*#(\S*)$/i

function fragment(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const part of text.split('&')) {
    const at = part.indexOf('=')
    if (at <= 0) continue
    try {
      map.set(decodeURIComponent(part.slice(0, at)), decodeURIComponent(part.slice(at + 1)))
    } catch {
      // Kaputte Kodierung: Eintrag auslassen, der Rest wird unten geprüft.
    }
  }
  return map
}

export function parsePairing(text: string): PairingResult {
  const match = LINK.exec(text.trim())
  if (!match) {
    return /^https?:\/\//i.test(text.trim())
      ? { ok: false, error: 'Im Link fehlt die Marke. Bitte den Kopplungs-QR-Code verwenden, nicht den fürs Zertifikat.' }
      : { ok: false, error: 'Das ist kein Link vom Rechner. Bitte den QR-Code aus Einstellungen → Telefon nehmen.' }
  }
  const scheme = match[1].toLowerCase()
  const authority = match[2].toLowerCase()
  const params = fragment(match[3])
  const host = params.get('host')?.toLowerCase()
  const token = params.get('token')
  if (!host || !token) {
    return { ok: false, error: 'Im Link fehlt die Marke. Bitte den Kopplungs-QR-Code verwenden, nicht den fürs Zertifikat.' }
  }
  if (authority.includes('@') || host !== authority) {
    return { ok: false, error: 'Link und Rechneradresse passen nicht zusammen.' }
  }
  const origin = `${scheme}://${authority}`
  const hash = `host=${encodeURIComponent(host)}&token=${encodeURIComponent(token)}`
  return { ok: true, pairing: { url: `${origin}/#${hash}`, origin, secure: scheme === 'https' } }
}

/** Gehört diese Adresse zum gekoppelten Rechner? */
export function sameOrigin(pairing: Pairing, address: string): boolean {
  const lower = address.toLowerCase()
  if (!lower.startsWith(pairing.origin)) return false
  // `https://10.0.0.2:8788` darf nicht auch `https://10.0.0.2:87889` erlauben.
  const rest = lower.slice(pairing.origin.length)
  return rest === '' || /^[/?#]/.test(rest)
}
