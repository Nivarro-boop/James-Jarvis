import type { GeoPoint, LatLon } from '@shared/types'
import { cachedJson, type MapsCallOptions } from './net'
export interface PhotonFeature { geometry: { coordinates: number[] }; properties: Record<string, string> }
export async function photon(query: string, near?: LatLon, options: MapsCallOptions = {}, limit = 1): Promise<PhotonFeature[]> {
  const params = new URLSearchParams({ q: query, lang: 'de', limit: String(limit), ...(near ? { lat: String(near.lat), lon: String(near.lon) } : {}) })
  const data = await cachedJson<{ features: PhotonFeature[] }>('https://photon.komoot.io/api/?' + params, 'geocode', options)
  return (data.features ?? []).filter(f => Number.isFinite(f.geometry?.coordinates[0]) && Number.isFinite(f.geometry?.coordinates[1]))
}
export async function geocode(query: string, near?: LatLon, options: MapsCallOptions = {}): Promise<GeoPoint | null> {
  try { const hit = (await photon(query, near, options))[0]; if (hit) return { lon: hit.geometry.coordinates[0], lat: hit.geometry.coordinates[1], label: [hit.properties.name || hit.properties.street, hit.properties.city || hit.properties.state].filter(Boolean).join(', ') } } catch { options.signal?.throwIfAborted() }
  return geocodeOpenMeteo(query, options)
}
export async function reverseGeocode(at: LatLon, options: MapsCallOptions = {}): Promise<GeoPoint | null> {
  const data = await cachedJson<{ features: PhotonFeature[] }>(`https://photon.komoot.io/reverse?lat=${at.lat}&lon=${at.lon}&lang=de`, 'geocode', options)
  const hit = data.features?.[0]; return hit ? { ...at, label: [hit.properties.name || hit.properties.street, hit.properties.city].filter(Boolean).join(', ') } : null
}
export async function geocodeOpenMeteo(query: string, options: MapsCallOptions = {}): Promise<GeoPoint | null> {
  const data = await cachedJson<{ results?: { name: string; latitude: number; longitude: number; admin1?: string }[] }>('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(query) + '&count=1&language=de&format=json', 'geocode', options)
  const hit = data.results?.[0]; return hit ? { label: [hit.name, hit.admin1].filter(Boolean).join(', '), lat: hit.latitude, lon: hit.longitude } : null
}
