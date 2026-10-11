import type { LatLon, PlaceItem } from '@shared/types'
import { distanceM } from '@shared/geo'
import { photon } from './geocode'
import { overpass, type MapsCallOptions } from './net'
export async function searchPlaces(query: string, around: LatLon | null, limit: number, options: MapsCallOptions = {}): Promise<PlaceItem[]> {
  const categories: Record<string, string> = { apotheke: 'amenity=pharmacy', tankstelle: 'amenity=fuel', supermarkt: 'shop=supermarket', restaurant: 'amenity=restaurant', café: 'amenity=cafe', cafe: 'amenity=cafe', krankenhaus: 'amenity=hospital', bank: 'amenity=bank', bäckerei: 'shop=bakery' }
  const category = categories[query.trim().toLowerCase()]
  let found: PlaceItem[]
  if (category && around) {
    const [key, value] = category.split('=')
    const elements = await overpass(`[out:json][timeout:20];nwr[${key}=${value}](around:10000,${around.lat},${around.lon});out center tags;`, options)
    found = elements.flatMap(e => { const p = e.center ?? e; if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return []; const t = e.tags ?? {}; return [{ lat: p.lat!, lon: p.lon!, name: t.name || query, category: query, address: [t['addr:street'], t['addr:housenumber'], t['addr:city']].filter(Boolean).join(' ') }] })
  } else found = (await photon(query, around ?? undefined, options, Math.min(10, limit))).map(f => ({ lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], name: f.properties.name || f.properties.street || query, address: [f.properties.street, f.properties.housenumber, f.properties.city].filter(Boolean).join(' ') }))
  if (around) found = found.map(p => ({ ...p, distanceM: distanceM(around, p) })).sort((a, b) => a.distanceM! - b.distanceM!)
  return found.slice(0, Math.min(10, Math.max(1, limit)))
}
