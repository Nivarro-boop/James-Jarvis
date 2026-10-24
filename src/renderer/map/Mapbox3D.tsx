import { useEffect, useRef, type JSX } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import type { MapViewProps } from './MapView'

/**
 * Mapbox GL in 3D: Standard-Stil mit Nachtlicht, Gebäuden und Gelände,
 * gekippt. Route als Linie, Punkte als nummerierte Marker. Schlägt der
 * Schlüssel fehl, meldet `onFail` und der eigene Zeichner übernimmt.
 */
export default function Mapbox3D({
  center, zoom = 14, bounds, markers = [], path = [], height = 200, interactive = false, className, label, token, onFail
}: MapViewProps & { token: string; onFail: () => void }): JSX.Element {
  const holder = useRef<HTMLDivElement>(null)
  const replay = useRef<(() => void) | null>(null)

  useEffect(() => {
    mapboxgl.accessToken = token
    const map = new mapboxgl.Map({
      container: holder.current!,
      style: 'mapbox://styles/mapbox/standard',
      config: { basemap: { lightPreset: 'night', show3dObjects: true } },
      center: [center?.lon ?? 16.37, center?.lat ?? 48.21],
      zoom,
      pitch: 55,
      bearing: -17,
      antialias: true,
      interactive,
      attributionControl: true,
      language: 'de'
    })
    let failed = false
    map.on('error', (e) => {
      const status = (e.error as { status?: number } | undefined)?.status
      if (!failed && (status === 401 || status === 403)) { failed = true; onFail() }
    })
    if (interactive) map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'top-right')

    map.on('style.load', () => {
      map.addSource('dem', { type: 'raster-dem', url: 'mapbox://mapbox.mapbox-terrain-dem-v1', tileSize: 512, maxzoom: 14 })
      map.setTerrain({ source: 'dem', exaggeration: 1.2 })
      if (path.length > 1) {
        map.addSource('route', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: path } } })
        map.addLayer({ id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#15d8eb', 'line-width': 5, 'line-emissive-strength': 1 } })
      }
      const pts: [number, number][] = [...markers.map((m) => [m.lon, m.lat] as [number, number]), ...path]
      if (bounds) {
        map.fitBounds([[bounds.west, bounds.south], [bounds.east, bounds.north]], { padding: 40, pitch: 55, duration: 0 })
      } else if (!center && pts.length > 1) {
        const b = new mapboxgl.LngLatBounds(pts[0], pts[0])
        for (const p of pts) b.extend(p)
        map.fitBounds(b, { padding: 50, pitch: 55, duration: 0, maxZoom: 16 })
      } else if (!center && pts.length === 1) {
        map.jumpTo({ center: pts[0], zoom: 15 })
      }
      // Immersive Ansicht: Bei einer Route fliegt die Kamera einmal die Strecke ab.
      if (path.length > 1 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        map.once('idle', () => { if (!stopped) fly() })
      }
    })

    // Kamera folgt der Route, leicht vorausschauend; danach zurück zur Übersicht.
    let stopped = false
    let frame = 0
    const fly = (): void => {
      const line = path
      const seg = line.slice(1).map((p, i) => Math.hypot(p[0] - line[i][0], (p[1] - line[i][1]) * 1.5))
      const total = seg.reduce((a, b) => a + b, 0)
      if (!total) return
      const at = (f: number): [number, number] => {
        let d = f * total
        for (let i = 0; i < seg.length; i++) {
          if (d <= seg[i] || i === seg.length - 1) {
            const t = seg[i] ? Math.min(1, d / seg[i]) : 0
            return [line[i][0] + (line[i + 1][0] - line[i][0]) * t, line[i][1] + (line[i + 1][1] - line[i][1]) * t]
          }
          d -= seg[i]
        }
        return line[line.length - 1]
      }
      const duration = Math.min(14000, Math.max(6000, path.length * 120))
      const start = performance.now()
      const step = (now: number): void => {
        if (stopped) return
        const f = Math.min(1, (now - start) / duration)
        const here = at(f), ahead = at(Math.min(1, f + 0.04))
        const bearing = (Math.atan2(ahead[0] - here[0], ahead[1] - here[1]) * 180) / Math.PI
        map.jumpTo({ center: here, zoom: 16.5, pitch: 65, bearing })
        if (f < 1) frame = requestAnimationFrame(step)
        else {
          const b = new mapboxgl.LngLatBounds(line[0], line[0])
          for (const p of line) b.extend(p)
          map.fitBounds(b, { padding: 50, pitch: 55, bearing: -17, duration: 1500, maxZoom: 16 })
        }
      }
      frame = requestAnimationFrame(step)
    }
    // Jede Berührung beendet den Flug sofort.
    for (const ev of ['mousedown', 'wheel', 'touchstart'] as const) map.on(ev, () => { stopped = true; cancelAnimationFrame(frame) })
    replay.current = (): void => { stopped = false; cancelAnimationFrame(frame); fly() }

    const placed = markers.map((m) => {
      const el = document.createElement('div')
      el.className = 'mapbox-marker'
      el.textContent = String(m.index ?? '')
      if (m.label) el.title = m.label
      return new mapboxgl.Marker({ element: el }).setLngLat([m.lon, m.lat]).addTo(map)
    })
    return () => { stopped = true; cancelAnimationFrame(frame); replay.current = null; placed.forEach((m) => m.remove()); map.remove() }
    // Inhalt als Schlüssel: neu zeichnen nur, wenn sich wirklich etwas ändert.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, JSON.stringify([center, zoom, bounds, markers, path, interactive])])

  return <div style={{ position: 'relative' }}>
    <div ref={holder} className={['map-view', 'map-3d', className].filter(Boolean).join(' ')}
      style={{ height, width: '100%', position: 'relative' }} role="img" aria-label={label ?? 'Karte'} />
    {path.length > 1 && <button type="button" className="map-fly" onClick={() => replay.current?.()}>Strecke in 3D abfliegen</button>}
  </div>
}
