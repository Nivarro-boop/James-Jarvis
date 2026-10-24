import { lazy, Suspense, useEffect, useRef, useState, type JSX } from 'react'
import type { GeoBounds, LatLon, LonLat } from '@shared/types'
import { MAP_ATTRIBUTION } from '@shared/geo'
import { decodeTile, project, type TileShape } from '@shared/mapVector'
export interface MapMarker extends LatLon { label?: string; index?: number }
export interface MapViewProps { center?: LatLon; zoom?: number; bounds?: GeoBounds; markers?: MapMarker[]; path?: LonLat[]; height?: number; interactive?: boolean; className?: string; label?: string }
const cache = new Map<string, Promise<TileShape[]>>()
const EMPTY_MARKERS: MapMarker[] = []
const EMPTY_PATH: LonLat[] = []
function tile(z: number, x: number, y: number): Promise<TileShape[]> {
  const key = `${z}/${x}/${y}`
  if (!cache.has(key)) { const request = window.jarvis.invoke('maps:tile', { z, x, y }).then(bytes => { if (!bytes) { cache.delete(key); return [] }; return decodeTile(new Uint8Array(bytes)) }).catch(() => { cache.delete(key); return [] }); cache.set(key, request); if (cache.size > 160) cache.delete(cache.keys().next().value!) }
  return cache.get(key)!
}
function OwnMapView({ center, zoom = 13, bounds, markers = EMPTY_MARKERS, path = EMPTY_PATH, height = 200, interactive = false, className, label }: MapViewProps): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null), holder = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(400), [offset, setOffset] = useState({ x: 0, y: 0, zoom: 0 }), [status, setStatus] = useState('Karte lädt …')
  const drag = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => { const element = holder.current!; const observer = new ResizeObserver(entries => setWidth(Math.max(1, entries[0].contentRect.width))); observer.observe(element); return () => observer.disconnect() }, [])
  const contentKey = JSON.stringify([center, bounds, path, markers])
  useEffect(() => { setOffset({ x: 0, y: 0, zoom: 0 }) }, [contentKey])
  useEffect(() => {
    let disposed = false
    const ctx = canvas.current!.getContext('2d')!; const dpr = window.devicePixelRatio || 1
    canvas.current!.width = width * dpr; canvas.current!.height = height * dpr; ctx.scale(dpr, dpr)
    let c = project(center?.lon ?? 16.37, center?.lat ?? 48.21), level = zoom
    const points = bounds ? [project(bounds.west, bounds.north), project(bounds.east < bounds.west ? bounds.east + 360 : bounds.east, bounds.south)] : [...markers.map(p => project(p.lon, p.lat)), ...path.map(p => project(p[0], p[1]))]
    if (bounds || (!center && points.length)) {
      const xs = points.map(p => p[0]), ys = points.map(p => p[1]); const west = Math.min(...xs), east = Math.max(...xs), north = Math.min(...ys), south = Math.max(...ys)
      c = [(west + east) / 2, (north + south) / 2]
      level = Math.min(16, Math.log2(Math.min((width - 60) / Math.max(0.00001, east - west), (height - 60) / Math.max(0.00001, south - north)) / 256))
    }
    level = Math.max(0, Math.min(18, level + offset.zoom)); const scale = 256 * 2 ** level
    const tz = Math.min(14, Math.floor(level)), n = 2 ** tz, size = scale / n
    const left = c[0] * scale - width / 2 - offset.x, top = c[1] * scale - height / 2 - offset.y
    const xy = (lon: number, lat: number): [number, number] => { const p = project(lon, lat); p[0] += Math.round(c[0] - p[0]); return [p[0] * scale - left, p[1] * scale - top] }
    const overlays = (): void => {
      if (path.length) { ctx.beginPath(); path.forEach((p, i) => { const q = xy(...p); if (i) ctx.lineTo(...q); else ctx.moveTo(...q) }); ctx.strokeStyle = '#15d8eb'; ctx.lineWidth = 4; ctx.stroke() }
      for (const p of markers) { const q = xy(p.lon, p.lat); ctx.beginPath(); ctx.arc(...q, 11, 0, Math.PI * 2); ctx.fillStyle = '#de42b3'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); ctx.fillStyle = '#fff'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(String(p.index ?? ''), q[0], q[1] + 4) }
    }
    ctx.fillStyle = '#222838'; ctx.fillRect(0, 0, width, height); overlays()
    const requests: Promise<void>[] = []; let loaded = 0
    const labels: { name: string; x: number; y: number }[] = []
    for (let x = Math.floor(left / size); x <= Math.floor((left + width) / size); x++) for (let y = Math.max(0, Math.floor(top / size)); y <= Math.min(n - 1, Math.floor((top + height) / size)); y++) {
      requests.push(tile(tz, ((x % n) + n) % n, y).then(shapes => {
        if (disposed) return
        if (shapes.length) loaded++
        ctx.save(); ctx.beginPath(); ctx.rect(x * size - left, y * size - top, size, size); ctx.clip()
        for (const shape of shapes) {
          if (['place', 'transportation_name', 'poi'].includes(shape.layer) && shape.name) {
            const p = shape.paths[0]?.[0]
            if (p) labels.push({ name: shape.name, x: x * size - left + p[0] / shape.extent * size, y: y * size - top + p[1] / shape.extent * size })
          }
          if (!['water', 'waterway', 'landuse', 'landcover', 'park', 'building', 'transportation', 'boundary'].includes(shape.layer)) continue
          ctx.beginPath(); for (const line of shape.paths) line.forEach((p, i) => { const px = x * size - left + p[0] / shape.extent * size, py = y * size - top + p[1] / shape.extent * size; if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py) })
          ctx.fillStyle = shape.layer === 'water' ? '#234963' : ['park', 'landcover'].includes(shape.layer) ? '#304636' : shape.layer === 'building' ? '#535068' : '#353944'
          ctx.strokeStyle = shape.layer === 'transportation' ? '#99929c' : '#426477'; ctx.lineWidth = shape.layer === 'transportation' ? 1.5 : 0.6
          if (shape.type === 3) ctx.fill('evenodd'); else if (shape.type === 2) ctx.stroke()
        }
        ctx.restore()
      }))
    }
    void Promise.all(requests).then(() => { if (!disposed) {
      const occupied: { x: number; y: number; width: number }[] = []
      ctx.font = '11px sans-serif'; ctx.textAlign = 'center'
      for (const label of labels) {
        const w = ctx.measureText(label.name).width
        if (label.x < 0 || label.x > width || label.y < 0 || label.y > height || occupied.some(p => Math.abs(p.y - label.y) < 15 && Math.abs(p.x - label.x) < (p.width + w) / 2 + 8)) continue
        occupied.push({ ...label, width: w }); ctx.strokeStyle = '#222838'; ctx.lineWidth = 3; ctx.strokeText(label.name, label.x, label.y); ctx.fillStyle = '#eee'; ctx.fillText(label.name, label.x, label.y)
      }
      overlays(); setStatus(loaded ? '' : 'Kartengrundlage nicht verfügbar')
    } })
    return () => { disposed = true }
  }, [center, zoom, bounds, markers, path, height, width, offset])
  return <div ref={holder} className={['map-view', className].filter(Boolean).join(' ')} style={{ height, width: '100%', position: 'relative', overflow: 'hidden', touchAction: interactive ? 'none' : 'auto' }} role="img" aria-label={label ?? 'Karte'}>
    <canvas ref={canvas} style={{ width: '100%', height, cursor: interactive ? 'grab' : 'default' }} onPointerDown={e => { if (interactive) { drag.current = { x: e.clientX, y: e.clientY }; e.currentTarget.setPointerCapture(e.pointerId) } }} onPointerMove={e => { if (drag.current) { const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y; drag.current = { x: e.clientX, y: e.clientY }; setOffset(p => ({ ...p, x: p.x + dx, y: p.y + dy })) } }} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }} onWheel={e => { if (interactive) setOffset(p => ({ x: 0, y: 0, zoom: Math.max(-12, Math.min(5, p.zoom + (e.deltaY < 0 ? 0.5 : -0.5))) })) }} />
    {status && <small className="map-status">{status}</small>}<small className="map-attribution">{MAP_ATTRIBUTION}</small>
  </div>
}


/**
 * Mit Mapbox-Schlüssel: 3D-Karte (gekippt, Gebäude, Gelände). Ohne Schlüssel
 * oder bei Fehlern: der eigene 2D-Zeichner oben.
 */
let tokenRequest: Promise<string | null> | null = null
function mapboxToken(): Promise<string | null> {
  tokenRequest ??= window.jarvis.invoke('secrets:getMapboxForMap').catch(() => null)
  return tokenRequest
}
const Mapbox3D = lazy(() => import('./Mapbox3D'))

export function MapView(props: MapViewProps): JSX.Element {
  const [token, setToken] = useState<string | null | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  useEffect(() => { void mapboxToken().then(setToken) }, [])
  if (token && !failed) {
    const fallback = <OwnMapView {...props} />
    return <Suspense fallback={fallback}><Mapbox3D {...props} token={token} onFail={() => { tokenRequest = null; setFailed(true) }} /></Suspense>
  }
  return <OwnMapView {...props} />
}
