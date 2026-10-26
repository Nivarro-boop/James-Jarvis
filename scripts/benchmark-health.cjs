// Synthetic million-record export, generated in chunks without private data.
const { build } = require('esbuild')
const { mkdirSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')
;(async () => {
  mkdirSync(resolve('out/audit'), { recursive: true })
  await build({ entryPoints: ['src/shared/healthExport.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'out/audit/health-parser.cjs', logLevel: 'silent' })
  const { HealthExportReader } = require('../out/audit/health-parser.cjs')
  const reader = new HealthExportReader(Date.parse('2026-10-26T12:00:00Z'))
  reader.push('<HealthData><ExportDate value="2026-10-26 12:00:00 +0000"/>')
  const row = '<Record type="HKQuantityTypeIdentifierStepCount" sourceName="Synthetic" startDate="2000-01-01 08:00:00 +0000" endDate="2000-01-01 09:00:00 +0000" unit="count" value="123"/>'
  const chunk = row.repeat(1000)
  const baseline = process.memoryUsage().heapUsed, started = performance.now()
  let peak = baseline
  for (let i = 0; i < 1000; i++) {
    reader.push(chunk)
    peak = Math.max(peak, process.memoryUsage().heapUsed)
    if (i % 20 === 0) await new Promise(resolve => setImmediate(resolve))
  }
  reader.push('</HealthData>')
  if (reader.records !== 1_000_000 || reader.result() !== null || reader.sums.size !== 0) throw new Error('Historical data was retained')
  const result = { records: reader.records, generatedXMLMB: Math.round(Buffer.byteLength(chunk) * 1000 / 1024 ** 2), elapsedMs: Math.round(performance.now() - started), sampledPeakHeapGrowthMB: Math.round((peak - baseline) / 1024 ** 2), retainedHistoricalDays: reader.sums.size, note: 'Synthetic parser benchmark; sampled JS heap, not total process memory or ZIP I/O.' }
  writeFileSync('out/audit/health-performance-2026-10-26.json', JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
})().catch(error => { console.error(error); process.exitCode = 1 })
