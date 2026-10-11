import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mapsCacheDir, mapsHeaders, type MapsCallOptions } from './net'
export const TILEJSON_URL = 'https://tiles.openfreemap.org/planet'
export const TILE_MAX_ZOOM = 14
export function isValidTile(z: number, x: number, y: number): boolean { return [z, x, y].every(Number.isInteger) && z >= 0 && z <= 14 && x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z }
let template: Promise<string> | undefined
export async function readTile(z: number, x: number, y: number, options: MapsCallOptions = {}): Promise<Uint8Array | null> {
  if (!isValidTile(z, x, y)) return null
  options.signal?.throwIfAborted()
  const dir = mapsCacheDir('tiles'), file = join(dir, `${z}-${x}-${y}.pbf`)
  try { return new Uint8Array(await readFile(file)) } catch { /* fetch */ }
  try {
    template ??= fetch(TILEJSON_URL, { headers: mapsHeaders(), signal: AbortSignal.timeout(8000) }).then(async r => {
      if (!r.ok) throw new Error('TileJSON unavailable')
      const data = await r.json() as { tiles: string[] }; const url = data.tiles[0]
      if (!url || new URL(url).hostname !== 'tiles.openfreemap.org' || !url.startsWith('https://')) throw new Error('Invalid tile host')
      return url
    }).catch(e => { template = undefined; throw e })
    const url = (await template).replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
    const timeout = AbortSignal.timeout(10000)
    const r = await fetch(url, { headers: mapsHeaders(), signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout })
    if (!r.ok) return null
    const bytes = new Uint8Array(await r.arrayBuffer())
    if (!bytes.length || bytes.length > 10000000) return null
    try { await mkdir(dir, { recursive: true }); await writeFile(file, bytes) } catch { /* optional */ }
    return bytes
  } catch { options.signal?.throwIfAborted(); return null }
}
