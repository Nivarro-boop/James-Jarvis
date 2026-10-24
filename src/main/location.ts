/**
 * Standort für Wetter, Orte und Routen.
 *
 * Ohne Erlaubnis gilt der eingetragene Standardort. Hat der Nutzer den echten
 * Standort erlaubt, fragt James die Windows-Ortung (System.Device,
 * GeoCoordinateWatcher) und macht aus den Koordinaten über OpenStreetMap einen
 * Ortsnamen. Das Ergebnis wird zehn Minuten gemerkt, damit nicht jede Frage
 * eine neue Ortung startet. Scheitert die Ortung (Ortungsdienst aus, keine
 * Freigabe für Desktop-Apps), bleibt der Standardort.
 */
import { execFile } from 'node:child_process'
import { getSettings } from './store/settings'

export interface DeviceLocation { lat: number; lon: number; name: string }

const CACHE_MS = 10 * 60_000
let cached: { at: number; value: DeviceLocation } | null = null

const SCRIPT = [
  'Add-Type -AssemblyName System.Device',
  '$w = New-Object System.Device.Location.GeoCoordinateWatcher',
  '$w.Start()',
  '$t = 0',
  "while (($w.Status -ne 'Ready' -or $w.Position.Location.IsUnknown) -and $t -lt 80) { Start-Sleep -Milliseconds 100; $t++ }",
  '$l = $w.Position.Location',
  "if ($l.IsUnknown) { 'unknown' } else { '{0};{1}' -f $l.Latitude.ToString([cultureinfo]::InvariantCulture), $l.Longitude.ToString([cultureinfo]::InvariantCulture) }",
  '$w.Stop()'
].join('; ')

function windowsPosition(): Promise<{ lat: number; lon: number }> {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('Echte Ortung gibt es nur unter Windows.'))
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { timeout: 15_000, windowsHide: true }, (error, stdout) => {
      if (error) return reject(new Error('Windows-Ortung nicht erreichbar.'))
      const [lat, lon] = stdout.trim().split(';').map(Number)
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return reject(new Error('Kein Standort. In Windows unter Datenschutz → Standort die Ortung für Desktop-Apps erlauben.'))
      }
      resolve({ lat, lon })
    })
  })
}

async function placeName(lat: number, lon: number): Promise<string> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=de&lat=${lat}&lon=${lon}`
    const res = await fetch(url, { headers: { 'User-Agent': 'James-Jarvis (Desktop-Assistent)' }, signal: AbortSignal.timeout(6000) })
    if (!res.ok) throw new Error(String(res.status))
    const data = (await res.json()) as { address?: Record<string, string> }
    const a = data.address ?? {}
    return a.city || a.town || a.village || a.municipality || a.county || `${lat.toFixed(4)}, ${lon.toFixed(4)}`
  } catch {
    return `${lat.toFixed(4)}, ${lon.toFixed(4)}`
  }
}

/** Fragt die Windows-Ortung, unabhängig von der Einstellung (für „Jetzt orten“). */
export async function locateDevice(): Promise<DeviceLocation> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value
  const { lat, lon } = await windowsPosition()
  const value = { lat, lon, name: await placeName(lat, lon) }
  cached = { at: Date.now(), value }
  return value
}

/** Der Ort, den Werkzeuge ohne eigene Angabe verwenden. */
export async function homeLocation(): Promise<string> {
  const settings = getSettings()
  if (settings.useDeviceLocation) {
    try {
      return (await locateDevice()).name
    } catch {
      // Fällt still auf den Standardort zurück; der Fehler steht in der Einstellung beim Orten.
    }
  }
  return settings.homeLocation.trim()
}
