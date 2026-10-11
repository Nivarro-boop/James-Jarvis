import { app } from 'electron'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

/**
 * Was alle Kartendienste gemeinsam haben: wer fragt, wo abgelegt wird, und
 * welche Fehler zurückkommen.
 *
 * Karten, Ortssuche und Routen laufen ohne Schlüssel und ohne kommerziellen
 * Anbieter — über OpenFreeMap (Kacheln), Photon und Nominatim (Ortssuche),
 * Overpass (Geschäfte, Straßennetz) und Open-Meteo (letzter Rückfall). Das
 * sind freie Dienste, betrieben von Freiwilligen oder kleinen Teams, und ihre
 * Nutzungsregeln sind die Bedingung dafür, dass es sie gibt:
 *
 * - Ein ehrlicher User-Agent mit Kontaktadresse. Nominatim sperrt Anfragen
 *   ohne ihn; ein Browser-Kennzeichen wäre dort ausdrücklich verboten.
 * - Wenige Anfragen: Nominatim höchstens eine pro Sekunde, Overpass mit
 *   Zeitlimit in der Abfrage und mit Ausweichen auf Spiegel statt Hämmern.
 * - Alles, was sich nicht stündlich ändert, auf die Platte.
 *
 * Gefragt wird ausschließlich aus dem Hauptprozess. Die CSP des
 * Kristallfensters lässt für Bilder und Verbindungen nur `'self'`, `data:`
 * und `blob:` zu; Kacheln kommen dort über `maps:tile` an.
 */

const PROJECT_URL = 'https://github.com/Nivarro-boop/James-Jarvis'

/** „James-Jarvis/1.3.0 (+https://github.com/…)" — so verlangen es die OSM-Dienste. */
export function mapsUserAgent(): string {
  return `James-Jarvis/${app.getVersion()} (+${PROJECT_URL})`
}

/** Kopfzeilen für jede Anfrage an einen Kartendienst. */
export function mapsHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'User-Agent': mapsUserAgent(), 'Accept-Language': 'de', ...extra }
}

/** Die Ablage je Art: `<Datenordner>/karten/<art>`. Angelegt wird sie vom Benutzer der Ablage. */
export function mapsCacheDir(kind: 'tiles' | 'overpass' | 'geocode' | 'routing'): string {
  return join(app.getPath('userData'), 'karten', kind)
}

/** Was jede Abfrage an einen Kartendienst annehmen kann. */
export interface MapsCallOptions {
  signal?: AbortSignal
}

/**
 * Ein Fehler, dessen Text das Modell vorlesen kann.
 *
 * `message` ist ein Satz für den Nutzer („Der Kartendienst antwortet gerade
 * nicht."), `detail` das Technische fürs Log — Adresse, Status, Spiegel.
 */
export class MapsError extends Error {
  constructor(
    message: string,
    readonly detail?: string
  ) {
    super(message)
    this.name = 'MapsError'
  }
}

/** Was ein Platzhalter wirft, bis sein Modul gebaut ist. */
export const NOT_BUILT = 'noch nicht gebaut'

export async function cachedJson<T>(url: string, kind: 'geocode' | 'overpass', options: MapsCallOptions = {}, body?: string): Promise<T> {
  options.signal?.throwIfAborted()
  const dir = mapsCacheDir(kind)
  const file = join(dir, createHash('sha256').update(url + (body ?? '')).digest('hex') + '.json')
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'))
    if (Date.now() - saved.at < 86400000) return saved.data
  } catch { /* no usable cache */ }
  const timeout = AbortSignal.timeout(30000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const response = await fetch(url, { signal, headers: mapsHeaders(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(body ? { method: 'POST', body } : {}) })
  if (!response.ok) throw new MapsError('Der Kartendienst antwortet gerade nicht.', String(response.status))
  const data = await response.json() as T
  try { await mkdir(dir, { recursive: true }); await writeFile(file, JSON.stringify({ at: Date.now(), data })) } catch { /* cache is optional */ }
  return data
}

export interface OsmElement { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; nodes?: number[]; tags?: Record<string, string> }
export async function overpass(query: string, options: MapsCallOptions = {}): Promise<OsmElement[]> {
  for (const host of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) {
    try {
      const data = await cachedJson<{ elements: OsmElement[]; remark?: string }>(host, 'overpass', options, 'data=' + encodeURIComponent(query))
      if (data.remark || !Array.isArray(data.elements)) throw new Error('Incomplete Overpass response')
      return data.elements
    } catch (error) { options.signal?.throwIfAborted(); if (host.includes('kumi')) throw new MapsError('Das Straßennetz konnte gerade nicht geladen werden.', String(error)) }
  }
  return []
}
