/** Minimal protobuf/MVT decoder: unknown fields are skipped by wire type. */
class Reader {
  pos = 0
  constructor(readonly bytes: Uint8Array) {}
  varint(): number { let n = 0, shift = 0; while (this.pos < this.bytes.length && shift < 56) { const b = this.bytes[this.pos++]; n += (b & 127) * 2 ** shift; if (!(b & 128)) return n; shift += 7 }; throw new Error('Invalid protobuf') }
  block(): Uint8Array { const size = this.varint(), end = this.pos + size; if (end > this.bytes.length) throw new Error('Truncated protobuf'); const result = this.bytes.subarray(this.pos, end); this.pos = end; return result }
  skip(wire: number): void { if (wire === 0) this.varint(); else if (wire === 2) this.block(); else if (wire === 1 || wire === 5) this.pos += wire === 1 ? 8 : 4; else throw new Error('Invalid wire type'); if (this.pos > this.bytes.length) throw new Error('Truncated protobuf') }
}
export interface TileShape { layer: string; extent: number; type: number; paths: [number, number][][]; name?: string }
export function decodeTile(bytes: Uint8Array): TileShape[] {
  const result: TileShape[] = [], tile = new Reader(bytes)
  while (tile.pos < bytes.length) {
    const tag = tile.varint(); if (tag !== 26) { tile.skip(tag & 7); continue }
    const layer = new Reader(tile.block()); let name = '', extent = 4096; const features: Uint8Array[] = [], keys: string[] = [], values: string[] = []
    while (layer.pos < layer.bytes.length) {
      const t = layer.varint()
      if (t === 10) name = new TextDecoder().decode(layer.block())
      else if (t === 18) features.push(layer.block())
      else if (t === 26) keys.push(new TextDecoder().decode(layer.block()))
      else if (t === 34) { const value = new Reader(layer.block()); let text = ''; while (value.pos < value.bytes.length) { const tag = value.varint(); if (tag === 10) text = new TextDecoder().decode(value.block()); else value.skip(tag & 7) }; values.push(text) }
      else if (t === 40) extent = layer.varint()
      else layer.skip(t & 7)
    }
    for (const bytes of features) {
      const feature = new Reader(bytes); let type = 0; const commands: number[] = [], tags: number[] = []
      while (feature.pos < bytes.length) { const t = feature.varint(); if (t === 24) type = feature.varint(); else if (t === 34 || t === 18) { const packed = new Reader(feature.block()); while (packed.pos < packed.bytes.length) (t === 34 ? commands : tags).push(packed.varint()) } else feature.skip(t & 7) }
      const properties: Record<string, string> = {}; for (let j = 0; j + 1 < tags.length; j += 2) properties[keys[tags[j]]] = values[tags[j + 1]]
      const label = properties['name:de'] || properties.name_de || properties.name
      const paths: [number, number][][] = []; let x = 0, y = 0, i = 0, path: [number, number][] = []
      while (i < commands.length) { const command = commands[i++], op = command & 7, count = command >>> 3; if (!count || ![1, 2, 7].includes(op)) throw new Error('Invalid geometry'); for (let n = 0; n < count; n++) { if (op === 7) { if (path.length) path.push([...path[0]]) } else { if (i + 1 >= commands.length) throw new Error('Truncated geometry'); const dx = commands[i++], dy = commands[i++]; x += dx % 2 ? -(dx + 1) / 2 : dx / 2; y += dy % 2 ? -(dy + 1) / 2 : dy / 2; if (op === 1) { path = []; paths.push(path) }; path.push([x, y]) } } }
      if (extent > 0) result.push({ layer: name, extent, type, paths, ...(label ? { name: label } : {}) })
    }
  }
  return result
}
export function project(lon: number, lat: number): [number, number] { const phi = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180; return [(lon + 180) / 360, (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2] }
