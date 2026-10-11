import type { GeoBounds, LatLon, LonLat, RouteMode } from './types'
import { ROUTE_PATH_MAX } from './types'

/**
 * Kleine Geometrie, die Hauptprozess und Kartenzeichner beide brauchen.
 *
 * Bewusst ohne Bibliothek: Luftlinie, Ausschnitt und Linienvereinfachung sind
 * zusammen keine hundert Zeilen, und jede dieser Zeilen ist geprüft
 * (`tests/maps-contract.test.ts`). Die Kachelmathematik des Zeichners gehört
 * nicht hierher, sondern zu ihm.
 */

/**
 * Was sichtbar auf jeder gezeichneten Karte stehen muss: Die Kacheln kommen
 * von OpenFreeMap im Schema von OpenMapTiles, die Daten von OpenStreetMap
 * (ODbL). Ortssuche und Route allein brauchen nur den letzten Teil.
 */
export const MAP_ATTRIBUTION = 'OpenFreeMap © OpenMapTiles © OpenStreetMap-Mitwirkende'
export const OSM_ATTRIBUTION = '© OpenStreetMap-Mitwirkende'

const RAD = Math.PI / 180
const EARTH_M = 6_371_000

const lonOf = (p: LatLon | LonLat): number => (Array.isArray(p) ? p[0] : p.lon)
const latOf = (p: LatLon | LonLat): number => (Array.isArray(p) ? p[1] : p.lat)

/** Luftlinie in Metern (Haversine). Für Entfernungen, die kein Dienst mitliefert. */
export function distanceM(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * RAD
  const dLon = (b.lon - a.lon) * RAD
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Der kleinste Ausschnitt um alle Punkte — oder null ohne Punkte.
 *
 * Nimmt beide Schreibweisen, damit Treffer (`LatLon`) und Routenlinie
 * (`LonLat`) ohne Umbau in denselben Ausschnitt gehen. Über die Datumsgrenze
 * wird nicht gerechnet: Eine Ortssuche um Wien braucht das nicht.
 */
export function boundsOf(points: ReadonlyArray<LatLon | LonLat>): GeoBounds | null {
  let south = Infinity
  let west = Infinity
  let north = -Infinity
  let east = -Infinity
  for (const p of points) {
    const lat = latOf(p)
    const lon = lonOf(p)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    if (lat < south) south = lat
    if (lat > north) north = lat
    if (lon < west) west = lon
    if (lon > east) east = lon
  }
  return Number.isFinite(south) ? { south, west, north, east } : null
}

/**
 * Eine Linie auf höchstens `max` Punkte bringen, ohne ihre Form zu verlieren.
 *
 * Douglas-Peucker, aber nicht mit fester Toleranz, sondern nach Rang: Jeder
 * Punkt bekommt die Abweichung, bei der er im Verfahren gewählt würde, und es
 * bleiben die `max` wichtigsten. So passt das Ergebnis immer in die Grenze —
 * eine Toleranz in Metern hätte bei einer Fahrt quer durch Europa trotzdem
 * tausende Punkte übrig gelassen. Erster und letzter Punkt bleiben immer.
 *
 * Gerechnet wird flach mit gestauchter Länge; für das Abwägen von Punkten
 * gegeneinander genügt das. Ohne Rekursion, weil eine lange Route aus
 * zehntausenden Punkten besteht.
 */
export function simplifyPath(path: readonly LonLat[], max = ROUTE_PATH_MAX): LonLat[] {
  const n = path.length
  if (n <= max) return path.slice()
  if (max <= 2) return max <= 0 ? [] : max === 1 ? [path[0]] : [path[0], path[n - 1]]

  let latSum = 0
  for (const p of path) latSum += p[1]
  const k = Math.cos((latSum / n) * RAD)

  /** Quadrat des Abstands von `p` zur Strecke `a`–`b`. */
  const away = (p: LonLat, a: LonLat, b: LonLat): number => {
    const ax = a[0] * k
    const ay = a[1]
    const dx = b[0] * k - ax
    const dy = b[1] - ay
    const px = p[0] * k - ax
    const py = p[1] - ay
    const len = dx * dx + dy * dy
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / len))
    const ex = px - t * dx
    const ey = py - t * dy
    return ex * ex + ey * ey
  }

  const rank = new Float64Array(n)
  rank[0] = Infinity
  rank[n - 1] = Infinity
  const stack: [number, number, number][] = [[0, n - 1, Infinity]]
  while (stack.length > 0) {
    const [a, b, cap] = stack.pop()!
    if (b - a < 2) continue
    let best = -1
    let at = a + 1
    for (let i = a + 1; i < b; i++) {
      const d = away(path[i], path[a], path[b])
      if (d > best) {
        best = d
        at = i
      }
    }
    // Nie wichtiger als der Punkt, der die Strecke erst geteilt hat — sonst
    // bliebe ein Zacken stehen, dessen Anker längst weggefallen ist.
    const r = Math.min(best, cap)
    rank[at] = r
    stack.push([a, at, r], [at, b, r])
  }

  const keep = Array.from({ length: n }, (_, i) => i)
    .sort((i, j) => rank[j] - rank[i])
    .slice(0, max)
    .sort((i, j) => i - j)
  return keep.map((i) => path[i])
}

const coord = (n: number): string => n.toFixed(5)

/** Ein Ort auf openstreetmap.org, mit Nadel. Für den „Karte"-Knopf einer Karte. */
export function osmPlaceUrl(p: LatLon, zoom = 17): string {
  const lat = coord(p.lat)
  const lon = coord(p.lon)
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=${zoom}/${lat}/${lon}`
}

/** Die Routenplaner-Engines auf openstreetmap.org, je Verkehrsmittel. */
const OSM_ENGINES: Record<RouteMode, string> = {
  auto: 'fossgis_osrm_car',
  zu_fuss: 'fossgis_osrm_foot',
  fahrrad: 'fossgis_osrm_bike'
}

/** Dieselbe Strecke im Routenplaner von openstreetmap.org. */
export function osmRouteUrl(from: LatLon, to: LatLon, mode: RouteMode): string {
  const route = `${coord(from.lat)},${coord(from.lon)};${coord(to.lat)},${coord(to.lon)}`
  return `https://www.openstreetmap.org/directions?engine=${OSM_ENGINES[mode]}&route=${encodeURIComponent(route)}`
}
