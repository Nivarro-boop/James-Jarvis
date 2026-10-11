import type { LatLon, LonLat, RouteMode } from '@shared/types'
import { distanceM } from '@shared/geo'
import { MapsError, overpass, type MapsCallOptions, type OsmElement } from './net'
export interface RouteResult { durationS: number; distanceM: number; path: LonLat[]; summary?: string }
type Edge = { to: number; distance: number; seconds: number; name: string }
export function solveRoute(elements: OsmElement[], from: LatLon, to: LatLon, mode: RouteMode, signal?: AbortSignal): RouteResult {
  const nodes = new Map(elements.filter(e => e.type === 'node' && Number.isFinite(e.lat) && Number.isFinite(e.lon)).map(e => [e.id, { lat: e.lat!, lon: e.lon! }]))
  const graph = new Map<number, Edge[]>()
  const speeds: Record<string, number> = { motorway: 110, motorway_link: 50, trunk: 90, trunk_link: 50, primary: 65, secondary: 55, tertiary: 45, residential: 30, living_street: 10, service: 20, unclassified: 40 }
  const add = (a: number, b: number, edge: Edge): void => { graph.set(a, [...(graph.get(a) ?? []), { ...edge, to: b }]) }
  for (const way of elements) {
    const t = way.tags ?? {}, h = t.highway
    if (way.type !== 'way' || !h || !way.nodes) continue
    const access = t[mode === 'auto' ? 'motorcar' : mode === 'fahrrad' ? 'bicycle' : 'foot'] ?? (mode === 'auto' ? t.motor_vehicle ?? t.vehicle : mode === 'fahrrad' ? t.vehicle : undefined) ?? t.access
    if (['no', 'private'].includes(access ?? '') || ['construction', 'proposed'].includes(h)) continue
    if (mode === 'auto' && !speeds[h]) continue
    if (mode !== 'auto' && /^(motorway|trunk)/.test(h) && access !== 'yes' && access !== 'designated') continue
    if (mode === 'fahrrad' && ['steps', 'footway', 'pedestrian'].includes(h) && !['yes', 'designated'].includes(access ?? '')) continue
    const raw = t.maxspeed ?? '', max = parseFloat(raw) * (raw.includes('mph') ? 1.609344 : 1)
    const speed = mode === 'zu_fuss' ? 5 : mode === 'fahrrad' ? 18 : Math.min(130, Number.isFinite(max) && max > 0 ? max : speeds[h])
    const one = mode === 'zu_fuss' ? 'no' : t[mode === 'fahrrad' ? 'oneway:bicycle' : 'oneway:motor_vehicle'] ?? t.oneway ?? (t.junction === 'roundabout' || h === 'motorway' ? 'yes' : 'no')
    for (let i = 1; i < way.nodes.length; i++) {
      const a = way.nodes[i - 1], b = way.nodes[i], p = nodes.get(a), q = nodes.get(b)
      if (!p || !q) continue
      const d = distanceM(p, q), edge = { to: b, distance: d, seconds: d / (speed / 3.6), name: t.ref || t.name || '' }
      if (one !== '-1') add(a, b, edge)
      if (!['yes', '1', 'true'].includes(one)) add(b, a, edge)
    }
  }
  const destinations = new Set([...graph.values()].flatMap(edges => edges.map(e => e.to)))
  const nearest = (point: LatLon, ids: Iterable<number>): number => {
    let best = -1, dist = Infinity
    for (const id of ids) { const d = distanceM(point, nodes.get(id)!); if (d < dist) { dist = d; best = id } }
    if (dist > 2000) throw new MapsError('In der Nähe des Start- oder Zielorts wurde kein nutzbarer Weg gefunden.')
    return best
  }
  const connected = new Set([...graph.keys(), ...destinations])
  const start = nearest(from, connected), goal = nearest(to, connected)
  const costs = new Map([[start, 0]]), previous = new Map<number, { id: number; edge: Edge }>()
  const heap: { id: number; cost: number; score: number }[] = []
  const push = (v: typeof heap[number]): void => { heap.push(v); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p].score <= v.score) break; heap[i] = heap[p]; i = p }; heap[i] = v }
  const pop = (): typeof heap[number] => { const first = heap[0], last = heap.pop()!; if (heap.length) { let i = 0; while (i * 2 + 1 < heap.length) { let c = i * 2 + 1; if (c + 1 < heap.length && heap[c + 1].score < heap[c].score) c++; if (heap[c].score >= last.score) break; heap[i] = heap[c]; i = c }; heap[i] = last }; return first }
  const heuristic = (id: number): number => distanceM(nodes.get(id)!, nodes.get(goal)!) / ((mode === 'auto' ? 130 : mode === 'fahrrad' ? 18 : 5) / 3.6)
  push({ id: start, cost: 0, score: heuristic(start) })
  while (heap.length) {
    signal?.throwIfAborted()
    const current = pop()
    if (current.cost !== costs.get(current.id)) continue
    if (current.id === goal) break
    for (const edge of graph.get(current.id) ?? []) { const cost = current.cost + edge.seconds; if (cost < (costs.get(edge.to) ?? Infinity)) { costs.set(edge.to, cost); previous.set(edge.to, { id: current.id, edge }); push({ id: edge.to, cost, score: cost + heuristic(edge.to) }) } }
  }
  if (!costs.has(goal)) throw new MapsError('Zwischen diesen Orten wurde kein durchgehender Weg gefunden.')
  const ids = [goal], names: string[] = []; let distance = 0
  while (ids[ids.length - 1] !== start) { const step = previous.get(ids[ids.length - 1])!; distance += step.edge.distance; if (step.edge.name) names.push(step.edge.name); ids.push(step.id) }
  return { durationS: costs.get(goal)!, distanceM: distance, path: ids.reverse().map(id => { const p = nodes.get(id)!; return [p.lon, p.lat] }), summary: [...new Set(names.reverse())].slice(0, 5).join(', ') }
}
export async function route(from: LatLon, to: LatLon, mode: RouteMode, options: MapsCallOptions = {}): Promise<RouteResult> {
  if (![from.lat, from.lon, to.lat, to.lon].every(Number.isFinite)) throw new MapsError('Ungültige Koordinaten.')
  if ([from, to].some(p => Math.abs(p.lat) > 85 || Math.abs(p.lon) > 180) || Math.abs(from.lon - to.lon) > 180) throw new MapsError('Dieser Kartenausschnitt wird von der eigenen Wegsuche nicht unterstützt.')
  if (distanceM(from, to) > 300000) throw new MapsError('Die eigene Wegsuche unterstützt derzeit Strecken bis 300 Kilometer Luftlinie.')
  const pad = Math.max(0.025, Math.abs(from.lat - to.lat) * 0.25, Math.abs(from.lon - to.lon) * 0.25)
  const bbox = [Math.max(-85, Math.min(from.lat, to.lat) - pad), Math.max(-180, Math.min(from.lon, to.lon) - pad), Math.min(85, Math.max(from.lat, to.lat) + pad), Math.min(180, Math.max(from.lon, to.lon) + pad)].join(',')
  const elements = await overpass(`[out:json][timeout:25];way[highway](${bbox});(._;>;);out body;`, options)
  return solveRoute(elements, from, to, mode, options.signal)
}
