export function clampZoom(level: number): number {
  return Math.max(0, Math.min(18, level))
}

/** Keep the relative offset inside the renderer's supported absolute zoom range. */
export function changeZoomOffset(current: number, delta: number, baseZoom: number): number {
  const base = clampZoom(baseZoom)
  return Math.max(-base, Math.min(18 - base, current + delta))
}

export interface MapOffset { x: number; y: number; zoom: number }
export function resetMapOffset(): MapOffset { return { x: 0, y: 0, zoom: 0 } }
