import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { createInflateRaw, crc32 } from 'node:zlib'
import { StringDecoder } from 'node:string_decoder'
import { HealthExportReader } from '@shared/healthExport'
import { parseHealthSnapshot, type HealthSnapshot } from '@shared/health'

const MAX_BYTES = 16 * 1024 ** 3
const BAD_ZIP = 'Die Health-Zip-Datei ist beschädigt oder wird nicht unterstützt.'
interface ZipEntry { compressed: number; uncompressed: number; offset: number; method: number; checksum: number }

/** Read only the export entry, with explicit bounds for every ZIP/Zip64 field. */
async function exportEntry(path: string, signal: AbortSignal): Promise<ZipEntry> {
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size
    if (size > MAX_BYTES) throw new Error('Health-Export ist größer als 16 GiB.')
    const read = async (at: number, length: number): Promise<Buffer> => {
      signal.throwIfAborted()
      if (!Number.isSafeInteger(at) || !Number.isSafeInteger(length) || at < 0 || length < 0 || at + length > size) throw new Error(BAD_ZIP)
      const out = Buffer.alloc(length)
      let filled = 0
      while (filled < length) {
        const { bytesRead } = await file.read(out, filled, length - filled, at + filled)
        if (!bytesRead) throw new Error(BAD_ZIP)
        filled += bytesRead
      }
      return out
    }
    const tailAt = Math.max(0, size - 65557)
    const tail = await read(tailAt, size - tailAt)
    let end = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break }
    }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw new Error(BAD_ZIP)
    let count = tail.readUInt16LE(end + 10), dirSize = tail.readUInt32LE(end + 12), dirAt = tail.readUInt32LE(end + 16)
    const uint64 = (data: Buffer, at: number): number => {
      if (at < 0 || at + 8 > data.length) throw new Error(BAD_ZIP)
      const n = data.readBigUInt64LE(at)
      if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(BAD_ZIP)
      return Number(n)
    }
    if (count === 65535 || dirAt === 0xffffffff || dirSize === 0xffffffff) {
      if (end < 20 || tail.readUInt32LE(end - 20) !== 0x07064b50 || tail.readUInt32LE(end - 16) || tail.readUInt32LE(end - 4) !== 1) throw new Error(BAD_ZIP)
      const record = await read(uint64(tail, end - 12), 56)
      if (record.readUInt32LE(0) !== 0x06064b50 || record.readUInt32LE(16) || record.readUInt32LE(20) || uint64(record, 24) !== uint64(record, 32)) throw new Error(BAD_ZIP)
      count = uint64(record, 32); dirSize = uint64(record, 40); dirAt = uint64(record, 48)
    } else if (tail.readUInt16LE(end + 8) !== count) throw new Error(BAD_ZIP)
    if (count > 100_000 || dirSize > 64 * 1024 ** 2 || dirAt + dirSize > tailAt + end) throw new Error(BAD_ZIP)
    const dir = await read(dirAt, dirSize)
    let p = 0
    let found: ZipEntry | undefined
    for (let i = 0; i < count; i++) {
      signal.throwIfAborted()
      if (p + 46 > dir.length || dir.readUInt32LE(p) !== 0x02014b50) throw new Error(BAD_ZIP)
      const nameLength = dir.readUInt16LE(p + 28), extraLength = dir.readUInt16LE(p + 30), commentLength = dir.readUInt16LE(p + 32)
      const next = p + 46 + nameLength + extraLength + commentLength
      if (next > dir.length) throw new Error(BAD_ZIP)
      const name = dir.toString('utf8', p + 46, p + 46 + nameLength)
      if (/(^|\/)export\.xml$/i.test(name)) {
        if (found || dir.readUInt16LE(p + 8) & 1 || dir.readUInt16LE(p + 34)) throw new Error(BAD_ZIP)
        let compressed = dir.readUInt32LE(p + 20), uncompressed = dir.readUInt32LE(p + 24), offset = dir.readUInt32LE(p + 42)
        let e = p + 46 + nameLength
        const extraEnd = e + extraLength
        while (e < extraEnd) {
          if (e + 4 > extraEnd) throw new Error(BAD_ZIP)
          const id = dir.readUInt16LE(e), len = dir.readUInt16LE(e + 2), finish = e + 4 + len
          if (finish > extraEnd) throw new Error(BAD_ZIP)
          if (id === 1) {
            let q = e + 4
            const take = (): number => { if (q + 8 > finish) throw new Error(BAD_ZIP); const n = uint64(dir, q); q += 8; return n }
            if (uncompressed === 0xffffffff) uncompressed = take()
            if (compressed === 0xffffffff) compressed = take()
            if (offset === 0xffffffff) offset = take()
          }
          e = finish
        }
        const method = dir.readUInt16LE(p + 10)
        if (![0, 8].includes(method) || !compressed || !uncompressed || uncompressed > MAX_BYTES || uncompressed / compressed > 1000) throw new Error(BAD_ZIP)
        const head = await read(offset, 30)
        if (head.readUInt32LE(0) !== 0x04034b50 || head.readUInt16LE(6) & 1 || head.readUInt16LE(8) !== method) throw new Error(BAD_ZIP)
        const localName = await read(offset + 30, head.readUInt16LE(26))
        if (localName.toString('utf8') !== name) throw new Error(BAD_ZIP)
        offset += 30 + head.readUInt16LE(26) + head.readUInt16LE(28)
        if (offset + compressed > dirAt || (method === 0 && compressed !== uncompressed)) throw new Error(BAD_ZIP)
        found = { compressed, uncompressed, offset, method, checksum: dir.readUInt32LE(p + 16) }
      }
      p = next
    }
    if (!found) throw new Error('Im Zip steht keine export.xml. Bitte den Export aus der Health-App wählen.')
    return found
  } finally { await file.close() }
}

export async function readHealthExport(path: string, onProgress?: (records: number) => void, parentSignal?: AbortSignal): Promise<{ snapshot: HealthSnapshot | null; records: number }> {
  const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(10 * 60_000)]) : AbortSignal.timeout(10 * 60_000)
  signal.throwIfAborted()
  const entry = /\.zip$/i.test(path) ? await exportEntry(path, signal) : undefined
  if (!entry && (await stat(path)).size > MAX_BYTES) throw new Error('Health-Export ist größer als 16 GiB.')
  const reader = new HealthExportReader(), decoder = new StringDecoder('utf8')
  const raw = createReadStream(path, { signal, ...(entry ? { start: entry.offset, end: entry.offset + entry.compressed - 1 } : {}) })
  const inflate = entry?.method === 8 ? createInflateRaw() : undefined
  const stream = inflate ?? raw
  if (inflate) { raw.on('error', error => inflate.destroy(error)); raw.pipe(inflate) }
  let bytes = 0, checksum = 0, reportedAt = 0
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      signal.throwIfAborted()
      bytes += chunk.length
      if (bytes > MAX_BYTES || (entry && bytes > entry.uncompressed)) throw new Error('Entpackter Health-Export überschreitet die Größenangabe.')
      if (entry) checksum = crc32(chunk, checksum)
      reader.push(decoder.write(chunk))
      if (onProgress && Date.now() - reportedAt > 250) { reportedAt = Date.now(); onProgress(reader.records) }
    }
    reader.push(decoder.end())
    signal.throwIfAborted()
    if (entry && (bytes !== entry.uncompressed || checksum !== entry.checksum)) throw new Error(BAD_ZIP)
    const result = reader.result()
    onProgress?.(reader.records)
    return { snapshot: result ? parseHealthSnapshot(result) : null, records: reader.records }
  } finally { raw.destroy(); stream.destroy() }
}
