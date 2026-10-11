import { execFile } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { networkInterfaces } from 'node:os'
import { promisify } from 'node:util'
import type { WakeReadiness } from '@shared/companion'

const execFileAsync = promisify(execFile)

export type { WakeReadiness }

/**
 * Wake-on-LAN.
 *
 * Der Zweck steht auf dem Kopf gegenüber allem anderen in diesem Ordner: Hier
 * geht es um den Fall, in dem James gerade *nicht* läuft. Schläft der Rechner,
 * ist auch der Server aus diesem Ordner aus, und das Telefon redet gegen eine
 * Wand. Aufwecken kann deshalb grundsätzlich nicht der Rechner selbst — das
 * Zauberpaket muss von außen kommen, also vom Telefon.
 *
 * Daraus folgt eine unangenehme Wahrheit für die Weboberfläche: Ein Browser
 * kann kein UDP verschicken. Kein Safari, kein Chrome, auch nicht als PWA vom
 * Startbildschirm. Der Weckknopf funktioniert deshalb nur in der eingepackten
 * App (Capacitor, siehe `resources/companion/README.md`), wo ein natives Stück
 * Code den Sockel öffnet. In der reinen Weboberfläche bleibt er sichtbar, sagt
 * aber, warum er nicht kann — das ist ehrlicher, als ihn zu verstecken und den
 * Nutzer rätseln zu lassen, warum sein Rechner nicht aufwacht.
 *
 * Was dieser Rechner beitragen kann, ist alles andere: Er kennt seine eigene
 * MAC-Adresse und seine Rundrufadresse, er kann sagen, ob Windows überhaupt auf
 * ein Zauberpaket hört, und er kann das einschalten. Diese Angaben wandern beim
 * Koppeln aufs Telefon und liegen dort, bis sie gebraucht werden.
 */

export interface WakeTarget {
  /** Groß geschrieben, mit Doppelpunkten — so, wie man sie vorliest. */
  mac: string
  /** Die Rundrufadresse des Netzes, in dem dieser Rechner steht. */
  broadcast: string
  /** Die eigene Adresse, damit das Telefon weiß, wohin es danach verbinden soll. */
  address: string
  adapter: string
}

const WOL_PORTS = [9, 7]

// ─────────────────────────────────────────────────────────────
// Das Paket
// ─────────────────────────────────────────────────────────────

/** Sechs Byte 0xFF, danach sechzehnmal die MAC. Mehr ist ein Zauberpaket nicht. */
export function magicPacket(mac: string): Buffer {
  const bytes = parseMac(mac)
  const packet = Buffer.alloc(102, 0xff)
  for (let i = 0; i < 16; i++) bytes.copy(packet, 6 + i * 6)
  return packet
}

function parseMac(mac: string): Buffer {
  const clean = mac.replace(/[^0-9a-fA-F]/g, '')
  if (clean.length !== 12) throw new Error(`"${mac}" ist keine MAC-Adresse.`)
  return Buffer.from(clean, 'hex')
}

/**
 * Schickt das Zauberpaket.
 *
 * An beide üblichen Ports und sowohl an die Rundrufadresse des Netzes als auch
 * an die allgemeine: Welche davon ankommt, hängt am Router, und ein Paket von
 * 102 Byte doppelt zu schicken kostet nichts. Aufgewacht wird von jedem.
 *
 * Der Rechner kann sich damit nicht selbst wecken — er schläft ja. Nützlich ist
 * es trotzdem: zum Prüfen der Einrichtung von einem wachen Rechner aus, und für
 * den Fall, dass jemand einen zweiten Rechner im Netz stehen hat.
 */
export async function sendWake(mac: string, broadcast?: string): Promise<void> {
  const packet = magicPacket(mac)
  const targets = broadcast ? [broadcast, '255.255.255.255'] : ['255.255.255.255']
  const socket = createSocket({ type: 'udp4', reuseAddr: true })

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.bind(() => {
        socket.setBroadcast(true)
        resolve()
      })
    })

    await Promise.all(
      targets.flatMap((host) =>
        WOL_PORTS.map(
          (port) =>
            new Promise<void>((resolve) => {
              // Fehler beim Senden werden geschluckt: Ein Netz ohne Rundruf ist
              // ein Grund weniger, es über den anderen Weg nicht zu versuchen.
              socket.send(packet, port, host, () => resolve())
            })
        )
      )
    )
  } finally {
    socket.close()
  }
}

// ─────────────────────────────────────────────────────────────
// Was dieser Rechner über sich weiß
// ─────────────────────────────────────────────────────────────

/**
 * Die eigene MAC und die Rundrufadresse.
 *
 * Gesucht wird die Schnittstelle, über die dieser Rechner tatsächlich im
 * Heimnetz steht — also eine mit IPv4, nicht intern und mit einer MAC, die
 * nicht aus lauter Nullen besteht. Virtuelle Adapter von Hyper-V, WSL oder
 * einem VPN tragen alle eine, und die falsche zu nehmen heißt, ein Zauberpaket
 * an eine Karte zu schicken, die es nie sehen wird.
 */
export function localWakeTarget(): WakeTarget | null {
  const candidates: WakeTarget[] = []

  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const info of addresses ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      if (!info.mac || info.mac === '00:00:00:00:00:00') continue
      // 169.254.x.x heißt: Es war keine Vergabe zu erreichen. Windows lässt so
      // eine Adresse trotzdem stehen — abgeschaltete VPN-Adapter tragen sie
      // typischerweise —, aber im Heimnetz erreicht sie niemand.
      if (info.address.startsWith('169.254.')) continue

      candidates.push({
        mac: info.mac.toUpperCase(),
        broadcast: broadcastOf(info.address, info.netmask),
        address: info.address,
        adapter: name
      })
    }
  }

  if (candidates.length === 0) return null

  /**
   * Kabel vor Funk vor allem anderen, Virtuelles zuletzt.
   *
   * Wake-on-LAN über WLAN verlangt zusätzlich Wake-on-Wireless-LAN und
   * scheitert auf den meisten Karten; steckt ein Kabel, ist es fast immer das
   * richtige Ziel.
   *
   * Die virtuellen zuerst auszusortieren ist nicht bloß Feinschliff: Der
   * Hyper-V-Standardschalter heißt `vEthernet (Default Switch)` und fiele sonst
   * unter „Ethernet" — gleichauf mit der echten Karte, entschieden allein durch
   * die Reihenfolge, in der Windows sie aufzählt. Seit das Zertifikat auf diese
   * Adresse lautet, wäre das nicht mehr nur ein Zauberpaket ins Leere, sondern
   * eine Fernbedienung, die auf `172.21.208.1` zeigt und die niemand erreicht.
   */
  const rank = (t: WakeTarget): number => {
    const n = t.adapter.toLowerCase()
    if (/(vethernet|hyper-v|virtualbox|vmware|vmnet|wsl|docker|tailscale|zerotier|tap-|loopback|bluetooth)/.test(n))
      return 3
    if (/(wlan|wi-?fi|wireless|drahtlos)/.test(n)) return 2
    if (/(ethernet|lan|realtek|intel\(r\) ethernet)/.test(n)) return 0
    return 1
  }
  candidates.sort((a, b) => rank(a) - rank(b))
  return candidates[0]
}

function broadcastOf(address: string, netmask: string): string {
  const a = address.split('.').map(Number)
  const m = netmask.split('.').map(Number)
  if (a.length !== 4 || m.length !== 4 || [...a, ...m].some(Number.isNaN)) {
    return '255.255.255.255'
  }
  return a.map((part, i) => (part & m[i]) | (~m[i] & 0xff)).join('.')
}

// ─────────────────────────────────────────────────────────────
// Ob Windows überhaupt zuhört
// ─────────────────────────────────────────────────────────────

/**
 * Fragt Windows, ob die Karte auf ein Zauberpaket hört — und ob der
 * Schnellstart dazwischenfunkt.
 *
 * Beides ist nur die halbe Wahrheit, und das steht auch so in der Rückgabe: Die
 * dritte Stelle, an der Wake-on-LAN abgeschaltet sein kann, ist das BIOS, und
 * dort kommt keine Software heran. Wer alles hier auf grün hat und trotzdem
 * nicht aufwacht, muss beim Start in die Firmware.
 */
export async function wakeReadiness(): Promise<WakeReadiness> {
  const target = localWakeTarget()
  if (!target) {
    return {
      armed: null,
      fastStartup: null,
      adapter: null,
      note: 'Ich finde keine Netzwerkkarte, über die dieser Rechner im Heimnetz steht.'
    }
  }

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$adapter = Get-NetAdapter | Where-Object { $_.MacAddress -replace '-','' -eq '${target.mac.replace(/:/g, '')}' } | Select-Object -First 1
$pm = if ($adapter) { Get-NetAdapterPowerManagement -Name $adapter.Name } else { $null }
$hiberboot = (Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power' -Name HiberbootEnabled).HiberbootEnabled
[pscustomobject]@{
  adapter = $(if ($adapter) { $adapter.Name } else { $null })
  magic   = $(if ($pm) { "$($pm.WakeOnMagicPacket)" } else { $null })
  hiberboot = $hiberboot
} | ConvertTo-Json -Compress`

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, maxBuffer: 1024 * 1024 }
    )
    const data = JSON.parse(stdout.trim() || '{}') as {
      adapter?: string | null
      magic?: string | null
      hiberboot?: number | null
    }

    const armed = data.magic ? /enabled/i.test(data.magic) : null
    const fastStartup = data.hiberboot === null || data.hiberboot === undefined ? null : data.hiberboot === 1

    return {
      armed,
      fastStartup,
      adapter: data.adapter ?? target.adapter,
      note: buildNote(armed, fastStartup)
    }
  } catch (err) {
    console.warn('[wol] Bereitschaft nicht feststellbar:', err)
    return {
      armed: null,
      fastStartup: null,
      adapter: target.adapter,
      note: 'Windows hat auf die Nachfrage nicht geantwortet.'
    }
  }
}

function buildNote(armed: boolean | null, fastStartup: boolean | null): string {
  const parts: string[] = []
  if (armed === false) parts.push('Die Netzwerkkarte hört nicht auf das Zauberpaket.')
  if (armed === null) parts.push('Ob die Karte zuhört, war nicht feststellbar.')
  if (fastStartup) {
    parts.push(
      'Der Windows-Schnellstart ist an — aus dem heruntergefahrenen Zustand wacht der ' +
        'Rechner damit meist nicht auf, aus dem Schlaf schon.'
    )
  }
  if (parts.length === 0) {
    parts.push('Soweit von hier sichtbar ist alles bereit.')
  }
  parts.push('Bleibt er trotzdem aus, steht der Schalter im BIOS — dorthin komme ich nicht.')
  return parts.join(' ')
}

/**
 * Schaltet das Horchen auf das Zauberpaket ein.
 *
 * Braucht erhöhte Rechte. Ohne sie schlägt der Aufruf fehl, und genau das wird
 * auch zurückgegeben — eine stille Nichtwirkung wäre hier das Schlimmste, weil
 * der Nutzer dann glaubt, es sei eingerichtet, und es erst merkt, wenn er
 * unterwegs vor einem schlafenden Rechner steht.
 */
export async function armWake(): Promise<{ ok: boolean; note: string }> {
  const target = localWakeTarget()
  if (!target) return { ok: false, note: 'Keine passende Netzwerkkarte gefunden.' }

  const script = `
$adapter = Get-NetAdapter | Where-Object { $_.MacAddress -replace '-','' -eq '${target.mac.replace(/:/g, '')}' } | Select-Object -First 1
if (-not $adapter) { Write-Error 'Adapter nicht gefunden'; exit 1 }
Set-NetAdapterPowerManagement -Name $adapter.Name -WakeOnMagicPacket Enabled -ErrorAction Stop
Write-Output 'ok'`

  try {
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true }
    )
    return { ok: true, note: `${target.adapter} hört jetzt auf das Zauberpaket.` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const denied = /Zugriff|Access is denied|Administrator|erforderlich/i.test(message)
    return {
      ok: false,
      note: denied
        ? 'Dafür fehlen die Rechte. Starte James einmal als Administrator, dann bleibt die ' +
          'Einstellung dauerhaft — oder setze sie im Geräte-Manager unter Energieverwaltung.'
        : `Windows hat abgelehnt: ${message.slice(0, 200)}`
    }
  }
}
