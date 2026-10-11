import { app, safeStorage } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { randomBytes, X509Certificate } from 'node:crypto'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { resourceFile } from '../resources'

const execFileAsync = promisify(execFile)

/**
 * Ein eigenes Zertifikat für die Adresse im Heimnetz.
 *
 * Der Grund ist derselbe wie bei Tailscale: `getUserMedia` verlangt auf iOS
 * einen sicheren Kontext, und `http://192.168.1.20:8788` ist keiner. Ohne TLS
 * ist die Sprechtaste tot, und daran lässt sich nichts einstellen.
 *
 * Der Unterschied ist, was dafür nötig ist. Tailscale bringt ein öffentlich
 * vertrautes Zertifikat mit und dazu den Zugang von unterwegs — kostet aber ein
 * Konto, eine Installation auf beiden Geräten und zwei Schalter in einer
 * fremden Oberfläche. Hier entsteht das Zertifikat auf diesem Rechner, und das
 * Telefon lernt einmal, ihm zu trauen. Danach ist nichts mehr zu tun, aber es
 * gilt eben auch nur im eigenen Netz.
 *
 * **Was das Telefon dabei eingeht, gehört gesagt:** Ein Root, dem es vertraut,
 * ist eine Vollmacht. Wer den privaten Schlüssel hat, kann diesem Telefon jede
 * beliebige Seite vorspielen. Er liegt deshalb DPAPI-verschlüsselt in den
 * App-Daten und ist auf einem anderen Rechner wertlos — dieselbe Zusage wie bei
 * den API-Schlüsseln. Wer die Vollmacht zurücknehmen will, löscht das Profil am
 * Telefon; ein Widerruf von hier aus ginge nicht.
 *
 * Warum überhaupt eine eigene Stelle und nicht ein einzelnes selbst
 * unterschriebenes Zertifikat: iOS nimmt keine Serverzertifikate mit mehr als
 * 398 Tagen Laufzeit. Ohne Stelle wäre jedes Jahr wieder ein Profil auf dem
 * Telefon fällig. So läuft die Stelle zehn Jahre, das Serverzertifikat darunter
 * wird still erneuert, und das Telefon merkt nichts davon.
 */

export interface LocalCert {
  /** Die Adresse, auf die es lautet — eine IPv4 im Heimnetz. */
  address: string
  pfxFile: string
  passphrase: string
  /** Die Stelle im DER-Format. Das ist die Datei, die aufs Telefon geht. */
  caFile: string
  expires: Date
}

function certDir(): string {
  return join(app.getPath('userData'), 'companion-local-tls')
}

/**
 * Das Kennwort der PFX-Datei.
 *
 * Es schützt den privaten Schlüssel auf der Platte und muss beim Start wieder
 * lesbar sein — also verschlüsselt abgelegt statt abgeleitet. DPAPI bindet es
 * an dieses Windows-Konto, genau wie die API-Schlüssel in `secrets/keystore.ts`.
 */
function passphrase(): string {
  const file = join(certDir(), 'pfx.bin')
  mkdirSync(certDir(), { recursive: true })

  if (existsSync(file)) {
    const raw = readFileSync(file)
    if (safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(raw)
      } catch {
        // Unlesbar heißt: an einem anderen Konto verschlüsselt oder beschädigt.
        // Ein neues Kennwort macht die alte PFX wertlos — das ist richtig so,
        // denn ohne Kennwort ist sie ohnehin nicht zu gebrauchen.
      }
    } else {
      return raw.toString('utf-8')
    }
  }

  const fresh = randomBytes(24).toString('base64url')
  writeFileSync(
    file,
    safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(fresh)
      : Buffer.from(fresh, 'utf-8')
  )
  return fresh
}

/**
 * Liest, was schon da ist — ohne PowerShell und ohne etwas zu erzeugen.
 *
 * Damit beantwortet die Einstellungsseite ihre Frage in Millisekunden. Ein
 * Prozessstart pro Aufruf wäre für eine Anzeige, die beim Öffnen erscheint, zu
 * viel.
 */
export function readLocalCert(): LocalCert | null {
  const dir = certDir()
  const pfxFile = join(dir, 'server.pfx')
  const caFile = join(dir, 'ca.cer')
  const leafFile = join(dir, 'server.cer')
  if (!existsSync(pfxFile) || !existsSync(caFile) || !existsSync(leafFile)) return null

  try {
    const leaf = new X509Certificate(readFileSync(leafFile))
    // Der Betreff ist `CN=192.168.1.20`; die Adresse steht aber verbindlich im
    // Alternativnamen, denn danach richtet sich iOS.
    const address = /IP Address:([\d.]+)/.exec(leaf.subjectAltName ?? '')?.[1]
    if (!address) return null
    return { address, pfxFile, caFile, passphrase: passphrase(), expires: new Date(leaf.validTo) }
  } catch {
    return null
  }
}

/**
 * Stellt sicher, dass ein gültiges Zertifikat für genau diese Adresse vorliegt.
 *
 * Erneuert wird aus drei Gründen: Es gibt keines, es läuft in weniger als zwei
 * Wochen ab, oder der Rechner hat inzwischen eine andere Adresse. Der dritte
 * ist der wahrscheinlichste — ohne feste Vergabe im Router verschiebt sich die
 * Adresse irgendwann, und dann passt das Zertifikat nicht mehr. Neu ausstellen
 * kostet hier zwei Sekunden und am Telefon nichts, weil die Stelle dieselbe
 * bleibt.
 */
export async function ensureLocalCert(address: string): Promise<LocalCert | null> {
  const existing = readLocalCert()
  const twoWeeks = 14 * 24 * 60 * 60 * 1000
  if (
    existing &&
    existing.address === address &&
    existing.expires.getTime() - Date.now() > twoWeeks
  ) {
    return existing
  }

  const secret = passphrase()
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        resourceFile('companion-cert.ps1'),
        '-Address',
        address,
        '-Dir',
        certDir(),
        '-Password',
        secret
      ],
      { windowsHide: true, maxBuffer: 1024 * 1024 }
    )
    const result = JSON.parse(stdout.trim()) as { ok: boolean; error?: string }
    if (!result.ok) {
      console.warn('[companion] Zertifikat nicht erzeugt:', result.error?.slice(0, 300))
      // Ein abgelaufenes oder auf die alte Adresse lautendes ist immer noch
      // besser als keines: Safari meckert dann, aber nur beim ersten Aufruf.
      return existing
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[companion] Zertifikat nicht erzeugt:', message.slice(0, 300))
    return existing
  }

  return readLocalCert()
}
