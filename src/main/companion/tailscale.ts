import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { X509Certificate } from 'node:crypto'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Tailscale als Zertifikatsquelle.
 *
 * Der Grund ist nicht der Zugang von unterwegs — den gibt es geschenkt dazu.
 * Der Grund ist das Mikrofon. `getUserMedia` verlangt auf iOS einen sicheren
 * Kontext, und `localhost` ist die einzige Ausnahme; eine Adresse wie
 * `http://192.168.1.20:8788` fällt durch, Safari stellt `navigator.mediaDevices`
 * dort gar nicht erst bereit. Die Sprechtaste wäre also tot, und zwar ohne
 * Einstellung, an der sich drehen ließe.
 *
 * Ein selbst unterschriebenes Zertifikat hilft nur halb: Safari lässt einen
 * zwar durchklicken, aber die Ausnahme gilt nicht für den WebSocket daneben,
 * und auf dem Startbildschirm ohne Safari-Leisten gibt es nichts zum
 * Durchklicken. Tailscale liefert dagegen ein echtes, öffentlich vertrautes
 * Zertifikat auf einen Namen, der nur im eigenen Netz auflöst — genau das, was
 * hier gebraucht wird, und ohne dass ein Port im Router aufgeht.
 */

const TAILSCALE_PATHS = [
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Tailscale\\tailscale.exe')
]

export interface TailscaleCert {
  certFile: string
  keyFile: string
  /** Der Name, auf den das Zertifikat lautet — ohne den abschließenden Punkt. */
  hostname: string
  /** Wann es abläuft. Tailscale stellt auf neunzig Tage aus. */
  expires: Date
}

export function tailscaleExecutable(): string | null {
  return TAILSCALE_PATHS.find((p) => p && existsSync(p)) ?? null
}

const executable = tailscaleExecutable

export function tailscaleInstalled(): boolean {
  return executable() !== null
}

async function run(args: string[]): Promise<string> {
  const exe = executable()
  if (!exe) throw new Error('Tailscale ist auf diesem Rechner nicht installiert.')
  const { stdout } = await execFileAsync(exe, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  return stdout
}

/**
 * Der eigene Name im Tailnet, etwa `rechner.taile1234.ts.net`.
 *
 * `null` heißt: Tailscale läuft nicht, ist nicht angemeldet, oder MagicDNS ist
 * aus. Alle drei sind Zustände, die der Nutzer selbst herstellen muss — deshalb
 * wird hier nichts repariert, sondern nur berichtet.
 */
export async function tailnetName(): Promise<string | null> {
  try {
    const raw = await run(['status', '--json'])
    const status = JSON.parse(raw) as { Self?: { DNSName?: string }; BackendState?: string }
    if (status.BackendState !== 'Running') return null
    const dns = status.Self?.DNSName
    if (!dns) return null
    // Tailscale liefert den Namen mit abschließendem Punkt als absolute
    // DNS-Angabe. In einer Adresszeile hat der nichts verloren.
    return dns.replace(/\.$/, '') || null
  } catch {
    return null
  }
}

function certDir(): string {
  return join(app.getPath('userData'), 'companion-tls')
}

/**
 * Holt oder erneuert das Zertifikat.
 *
 * `tailscale cert` ist selbst schlau genug, ein noch gültiges nicht neu
 * auszustellen — der Aufruf ist also billig genug, um ihn bei jedem Start zu
 * machen. Erneuert wird trotzdem erst ab zwei Wochen Restlaufzeit: Wer den
 * Rechner täglich startet, soll nicht täglich an Tailscales Ratenbegrenzung
 * klopfen.
 */
export async function ensureCert(): Promise<TailscaleCert | null> {
  const hostname = await tailnetName()
  if (!hostname) return null

  const dir = certDir()
  await mkdir(dir, { recursive: true })
  const certFile = join(dir, `${hostname}.crt`)
  const keyFile = join(dir, `${hostname}.key`)

  const existing = readCert(certFile, keyFile, hostname)
  const twoWeeks = 14 * 24 * 60 * 60 * 1000
  if (existing && existing.expires.getTime() - Date.now() > twoWeeks) return existing

  try {
    await run(['cert', '--cert-file', certFile, '--key-file', keyFile, hostname])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[companion] Zertifikat nicht zu bekommen:', message.slice(0, 300))
    // Ein abgelaufenes ist immer noch besser als keines: Safari meckert dann,
    // lässt aber durch. Gar keines heißt gar kein Mikrofon.
    return existing
  }

  return readCert(certFile, keyFile, hostname)
}

function readCert(certFile: string, keyFile: string, hostname: string): TailscaleCert | null {
  if (!existsSync(certFile) || !existsSync(keyFile)) return null
  try {
    const cert = new X509Certificate(readFileSync(certFile))
    return { certFile, keyFile, hostname, expires: new Date(cert.validTo) }
  } catch {
    return null
  }
}

/** Was der Nutzer tun muss, wenn es nicht klappt — in ganzen Sätzen. */
export async function tailscaleHint(): Promise<string> {
  if (!tailscaleInstalled()) {
    return (
      'Tailscale ist nicht installiert. Ohne ein gültiges Zertifikat lässt iOS das Mikrofon nicht ' +
      'zu — die Anzeige und das Tippfeld gehen, die Sprechtaste nicht.'
    )
  }
  const name = await tailnetName()
  if (!name) {
    return (
      'Tailscale läuft nicht oder ist nicht angemeldet. Melde dich einmal an; MagicDNS muss im ' +
      'Tailnet eingeschaltet sein, sonst gibt es keinen Namen für das Zertifikat.'
    )
  }
  return (
    `Der Rechner heißt im Tailnet ${name}. Bekommst du kein Zertifikat, fehlt in den ` +
    'Tailscale-Einstellungen unter DNS noch der Schalter für HTTPS.'
  )
}
