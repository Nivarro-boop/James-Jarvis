import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync, crc32 } from 'node:zlib'
import { HealthExportReader, parseHealthDate } from '@shared/healthExport'
import { readHealthExport } from '../src/main/health/appleExport'

const NOW = Date.parse('2026-10-25T12:00:00+02:00')

const rec = (type: string, start: string, end: string, value: string, unit = '', source = 'iPhone') =>
    `<Record type="${type}" sourceName="${source}" unit="${unit}" creationDate="${end}" startDate="${start}" endDate="${end}" value="${value}"/>`
function xml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>', '<HealthData locale="de_AT">', '<ExportDate value="2026-10-25 10:00:00 +0200"/>',
    rec('HKQuantityTypeIdentifierStepCount', '2026-10-25 08:00:00 +0200', '2026-10-25 08:30:00 +0200', '3000', 'count'),
    rec('HKQuantityTypeIdentifierStepCount', '2026-10-25 09:00:00 +0200', '2026-10-25 09:30:00 +0200', '1500', 'count'),
    // Die Uhr zählt dieselben Schritte noch einmal; gewinnen soll die größere Quelle, nicht die Summe.
    rec('HKQuantityTypeIdentifierStepCount', '2026-10-25 08:00:00 +0200', '2026-10-25 09:30:00 +0200', '4200', 'count', 'Apple Watch'),
    rec('HKQuantityTypeIdentifierDistanceWalkingRunning', '2026-10-24 10:00:00 +0200', '2026-10-24 11:00:00 +0200', '2', 'mi'),
    rec('HKQuantityTypeIdentifierActiveEnergyBurned', '2026-10-24 10:00:00 +0200', '2026-10-24 11:00:00 +0200', '418.4', 'kJ'),
    rec('HKCategoryTypeIdentifierSleepAnalysis', '2026-10-24 23:00:00 +0200', '2026-10-25 03:00:00 +0200', 'HKCategoryValueSleepAnalysisAsleepCore'),
    rec('HKCategoryTypeIdentifierSleepAnalysis', '2026-10-25 03:00:00 +0200', '2026-10-25 06:30:00 +0200', 'HKCategoryValueSleepAnalysisAsleepDeep'),
    rec('HKCategoryTypeIdentifierSleepAnalysis', '2026-10-24 22:30:00 +0200', '2026-10-25 07:00:00 +0200', 'HKCategoryValueSleepAnalysisInBed'),
    rec('HKQuantityTypeIdentifierRestingHeartRate', '2026-10-25 07:00:00 +0200', '2026-10-25 07:00:00 +0200', '58', 'count/min'),
    rec('HKQuantityTypeIdentifierHeartRate', '2026-10-25 09:45:00 +0200', '2026-10-25 09:45:00 +0200', '72', 'count/min'),
    rec('HKQuantityTypeIdentifierBodyMass', '2026-10-20 07:00:00 +0200', '2026-10-20 07:00:00 +0200', '176.4', 'lb'),
    // Zu alt für die sieben Tage.
    rec('HKQuantityTypeIdentifierStepCount', '2026-09-01 08:00:00 +0200', '2026-09-01 09:00:00 +0200', '9999', 'count'),
    '</HealthData>'
  ].join('\n')
}

function check(snapshot: ReturnType<HealthExportReader['result']>): void {
  assert.ok(snapshot)
  assert.equal(snapshot.takenAt, Date.parse('2026-10-25T10:00:00+02:00'))
  const today = snapshot.days.find((d) => d.date === '2026-10-25')!
  assert.equal(today.steps, 4500)
  assert.equal(today.sleepHours, 7.5)
  assert.equal(today.restingHeartRate, 58)
  const yesterday = snapshot.days.find((d) => d.date === '2026-10-24')!
  assert.equal(yesterday.distanceKm, 3.2)
  assert.equal(yesterday.activeKcal, 100)
  assert.ok(!snapshot.days.some((d) => d.date === '2026-09-01'))
  assert.equal(snapshot.heartRate?.bpm, 72)
  assert.equal(snapshot.weight?.kg, 80)
}

it('parses Apple Health dates with offset', () => {
  assert.equal(parseHealthDate('2026-10-20 07:31:00 +0200'), Date.parse('2026-10-20T07:31:00+02:00'))
  assert.equal(parseHealthDate('gestern'), null)
})

it('summarizes the last seven days even when elements span chunk borders', () => {
  const text = xml()
  for (const size of [7, 113, 4096, text.length]) {
    const reader = new HealthExportReader(NOW)
    for (let i = 0; i < text.length; i += size) reader.push(text.slice(i, i + size))
    check(reader.result())
  }
})

it('returns nothing for an export without recent values', () => {
  const reader = new HealthExportReader(NOW)
  reader.push('<HealthData><ExportDate value="2026-10-25 10:00:00 +0200"/></HealthData>')
  assert.equal(reader.result(), null)
})

it('reads export.xml from a deflated Export.zip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-export-'))
  try {
    const name = Buffer.from('apple_health_export/export.xml')
    const data = Buffer.from(xml())
    const packed = deflateRawSync(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42)
    const dirOffset = local.length + name.length + packed.length
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10)
    end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(dirOffset, 16)
    const zip = join(dir, 'Export.zip')
    writeFileSync(zip, Buffer.concat([local, name, packed, central, name, end]))
    const result = await readHealthExport(zip)
    assert.ok(result.records >= 12)
    assert.ok(result.snapshot)
    assert.equal(result.snapshot.days.find((d) => d.date === '2026-10-25')?.steps, 4500)
    const plain = join(dir, 'export.xml')
    writeFileSync(plain, xml())
    assert.equal((await readHealthExport(plain)).snapshot?.days.find((d) => d.date === '2026-10-24')?.distanceKm, 3.2)
    const emptyEnd = Buffer.alloc(22); emptyEnd.writeUInt32LE(0x06054b50)
    writeFileSync(join(dir, 'leer.zip'), emptyEnd)
    await assert.rejects(readHealthExport(join(dir, 'leer.zip')), /keine export\.xml/)
    const corrupted = Buffer.concat([local, name, packed, central, name, end])
    corrupted[dirOffset + 16] ^= 1
    writeFileSync(join(dir, 'crc.zip'), corrupted)
    await assert.rejects(readHealthExport(join(dir, 'crc.zip')), /beschädigt/)
    writeFileSync(join(dir, 'truncated.zip'), corrupted.subarray(0, 18))
    await assert.rejects(readHealthExport(join(dir, 'truncated.zip')), /beschädigt/)
    const abort = new AbortController(); abort.abort(new Error('Gestoppt'))
    await assert.rejects(readHealthExport(plain, undefined, abort.signal), /Gestoppt/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('rejects truncated and oversized XML, deduplicates sleep, and uses the export local day', () => {
  const reader = new HealthExportReader(NOW)
  reader.push('<HealthData><ExportDate value="2026-10-25 00:30:00 +1400"/>' +
    rec('HKCategoryTypeIdentifierSleepAnalysis', '2026-10-24 23:00:00 +1400', '2026-10-25 02:00:00 +1400', 'HKCategoryValueSleepAnalysisAsleepCore') +
    rec('HKCategoryTypeIdentifierSleepAnalysis', '2026-10-24 23:00:00 +1400', '2026-10-25 02:00:00 +1400', 'HKCategoryValueSleepAnalysisAsleepCore') +
    rec('HKCategoryTypeIdentifierSleepAnalysis', '2026-10-25 01:00:00 +1400', '2026-10-25 03:00:00 +1400', 'HKCategoryValueSleepAnalysisAsleepDeep') + '</HealthData>')
  assert.equal(reader.result()?.days.find(d => d.date === '2026-10-25')?.sleepHours, 4)
  const broken = new HealthExportReader(NOW)
  broken.push('<HealthData><Record type="test"')
  assert.throws(() => broken.result(), /unvollständig/)
  assert.throws(() => broken.push('x'.repeat(65_536)), /zu lang/)
})
