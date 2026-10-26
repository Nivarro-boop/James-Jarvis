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

  // Erst die Treibereinstellung („Bei Magic Packet aufwecken“) und die Liste der
  // Geräte, die wecken dürfen. Get-NetAdapterPowerManagement allein reicht nicht:
  // Manche Treiber (z. B. Realtek PCIe GbE) beantworten die Abfrage mit
  // „Windows System Error 31“, obwohl Wake-on-LAN eingeschaltet ist.
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
${adapterLookup(target.mac)}
$magic = $null; $device = $null
if ($adapter) {
  $prop = Get-NetAdapterAdvancedProperty -Name $adapter.Name -RegistryKeyword '*WakeOnMagicPacket'
  if ($prop) { $magic = "$($prop.RegistryValue)" -eq '1' }
  if ($magic -eq $null) { $pm = Get-NetAdapterPowerManagement -Name $adapter.Name; if ($pm) { $magic = "$($pm.WakeOnMagicPacket)" -match 'Enabled' } }
  $device = [bool](powercfg /devicequery wake_armed | Where-Object { $_.Trim() -eq $adapter.InterfaceDescription })
}
$hiberboot = (Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power' -Name HiberbootEnabled).HiberbootEnabled
[pscustomobject]@{
  adapter = $(if ($adapter) { $adapter.Name } else { $null })
  magic   = $magic
  device  = $device
  hiberboot = $hiberboot
} | ConvertTo-Json -Compress`

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 20_000 }
    )
    const data = JSON.parse(stdout.trim() || '{}') as {
      adapter?: string | null
      magic?: boolean | null
      device?: boolean | null
      hiberboot?: number | null
    }

    const armed = typeof data.magic === 'boolean' ? data.magic && data.device !== false : null
    const fastStartup = data.hiberboot === null || data.hiberboot === undefined ? null : data.hiberboot === 1

    return {
      armed,
      fastStartup,
      adapter: data.adapter ?? target.adapter,
      note: buildNote(armed, fastStartup, data.magic === true && data.device === false)
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

/** Findet die Karte über ihre MAC-Adresse. Die Adresse kommt aus Windows selbst, nicht von außen. */
function adapterLookup(mac: string): string {
  const clean = mac.replace(/[^0-9a-f]/gi, '').toUpperCase()
  return `$adapter = Get-NetAdapter | Where-Object { ($_.MacAddress -replace '-','') -eq '${clean}' } | Select-Object -First 1`
}

/** Nur der Grund aus PowerShells Fehlerausgabe, ohne den mitgeschickten Befehl. */
export function powershellReason(err: unknown): string {
  const stderr = (err as { stderr?: unknown })?.stderr
  const text = typeof stderr === 'string' && stderr.trim() ? stderr : err instanceof Error ? err.message.replace(/^Command failed:[\s\S]*?\r?\n/, '') : String(err)
  return text.replace(/#< CLIXML[\s\S]*$/, '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^(In Zeile|At line|\+ |CategoryInfo|FullyQualifiedErrorId|\+)/.test(line)).slice(0, 2).join(' ').slice(0, 240)
}

/** Übersetzt die häufigen Gründe in einen Schritt, den der Nutzer gehen kann. */
export function armFailureNote(reason: string, adapter: string): string {
  if (/Zugriff|Access is denied|Administrator|erforderlich|0x80070005|PermissionDenied|Berechtigung|elevat/i.test(reason)) {
    return 'Dafür fehlen die Rechte. Starte James einmal als Administrator, dann bleibt die ' +
      'Einstellung dauerhaft — oder setze sie im Geräte-Manager unter Energieverwaltung.'
  }
  if (/System Error 31|funktioniert nicht|not functioning/i.test(reason)) {
    return `Der Treiber von „${adapter}“ lässt sich von Windows aus nicht umstellen. Geräte-Manager → ` +
      'Netzwerkadapter → Eigenschaften: unter „Erweitert“ „Bei Magic Packet aufwecken“ aktivieren und unter ' +
      '„Energieverwaltung“ „Gerät kann den Computer aus dem Ruhezustand aktivieren“ anhaken.'
  }
  return `Windows hat abgelehnt: ${reason || 'ohne Begründung'}`
}

function buildNote(armed: boolean | null, fastStartup: boolean | null, deviceBlocked = false): string {
  const parts: string[] = []
  if (deviceBlocked) parts.push('Die Karte hört auf das Zauberpaket, darf den Rechner aber nicht wecken (Geräte-Manager → Energieverwaltung).')
  else if (armed === false) parts.push('Die Netzwerkkarte hört nicht auf das Zauberpaket.')
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

  // Bereits eingerichtet? Dann nichts anfassen. Sonst zuerst die
  // Treibereinstellung, die auch dort geht, wo die Energieverwaltung über
  // CIM mit „Windows System Error 31“ antwortet.
  const script = `
$ErrorActionPreference = 'Stop'
${adapterLookup(target.mac)}
if (-not $adapter) { throw 'Adapter nicht gefunden' }
$prop = Get-NetAdapterAdvancedProperty -Name $adapter.Name -RegistryKeyword '*WakeOnMagicPacket' -ErrorAction SilentlyContinue
$device = [bool](powercfg /devicequery wake_armed | Where-Object { $_.Trim() -eq $adapter.InterfaceDescription })
$magic = $prop -and "$($prop.RegistryValue)" -eq '1'
if ($magic -and $device) { Write-Output 'already'; exit 0 }
if (-not $magic) {
  if ($prop) { Set-NetAdapterAdvancedProperty -Name $adapter.Name -RegistryKeyword '*WakeOnMagicPacket' -RegistryValue 1 }
  else { Set-NetAdapterPowerManagement -Name $adapter.Name -WakeOnMagicPacket Enabled }
}
if (-not $device) {
  powercfg /deviceenablewake "$($adapter.InterfaceDescription)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Zugriff verweigert (powercfg $LASTEXITCODE)" }
}
Write-Output 'ok'`

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 }
    )
    const checked = await wakeReadiness()
    if (checked.armed !== true) return { ok: false, note: `Die Änderung wurde angefordert, konnte aber nicht bestätigt werden. ${checked.note}` }
    if (/already/.test(stdout)) return { ok: true, note: `${target.adapter} ist schon eingerichtet und hört auf das Zauberpaket.` }
    return { ok: true, note: `${target.adapter} hört jetzt auf das Zauberpaket.` }
  } catch (err) {
    return { ok: false, note: armFailureNote(powershellReason(err), target.adapter) }
  }
}
