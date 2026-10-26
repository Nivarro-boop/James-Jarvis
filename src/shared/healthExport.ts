import type { HealthDay, HealthSnapshot } from './health'

/**
 * Apple-Health-Export lesen (Health-App → Profil → „Alle Gesundheitsdaten
 * exportieren“).
 *
 * Das ist der Weg zu Health ohne eigene iPhone-App: Die Datei `export.xml`
 * enthält jede Einzelmessung, bei langjährigen Nutzern mehrere Gigabyte. Sie
 * wird deshalb stückweise gelesen, und behalten werden nur die Tageswerte der
 * letzten sieben Tage vor dem Exportdatum — dieselbe Zusammenfassung, die
 * sonst die iPhone-App schickt.
 *
 * iPhone und Apple Watch zählen Schritte doppelt in den Export. Die Health-App
 * entscheidet über eine Quellenrangfolge; hier gewinnt je Tag die Quelle mit
 * dem höchsten Wert. Das liegt nah an Apples Anzeige, ist aber eine Näherung.
 */

const SUM_TYPES: Record<string, keyof HealthDay> = {
  HKQuantityTypeIdentifierStepCount: 'steps',
  HKQuantityTypeIdentifierDistanceWalkingRunning: 'distanceKm',
  HKQuantityTypeIdentifierActiveEnergyBurned: 'activeKcal',
  HKQuantityTypeIdentifierAppleExerciseTime: 'exerciseMin',
  HKQuantityTypeIdentifierFlightsClimbed: 'flights'
}

const SLEEP = 'HKCategoryTypeIdentifierSleepAnalysis'
const ASLEEP = /^HKCategoryValueSleepAnalysisAsleep/

/** `2026-10-20 07:31:00 +0200` → Millisekunden. */
export function parseHealthDate(value: string | undefined): number | null {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})$/.exec(value?.trim() ?? '')
  if (!match) return null
  const ms = Date.parse(`${match[1]}T${match[2]}${match[3]}${match[4]}:${match[5]}`)
  return Number.isFinite(ms) ? ms : null
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const match of tag.matchAll(/(\w+)="([^"]*)"/g)) out[match[1]] = match[2]
  return out
}

function convert(field: keyof HealthDay, value: number, unit: string | undefined): number {
  if (field === 'distanceKm') return unit === 'mi' ? value * 1.609344 : unit === 'm' ? value / 1000 : value
  if (field === 'activeKcal') return unit === 'kJ' ? value / 4.184 : value
  return value
}

export class HealthExportReader {
  private rest = ''
  private exportAt: number | null = null
  private exportDay: string
  private windowDays: string[] | null = null
  private seenRoot = false
  private endedRoot = false
  private seen = new Set<string>()
  /** Tag → Feld → Quelle → Summe */
  private sums = new Map<string, Map<keyof HealthDay, Map<string, number>>>()
  private resting = new Map<string, { at: number; bpm: number }>()
  private heart: { at: number; bpm: number } | null = null
  private weight: { at: number; kg: number } | null = null
  private sleep = new Map<string, Map<string, Array<[number, number]>>>()
  records = 0

  constructor(private readonly now = Date.now()) { this.exportDay = new Date(now).toISOString().slice(0, 10) }

  /** Nimmt ein Stück Text; Elemente über Stückgrenzen hinweg werden zusammengesetzt. */
  push(chunk: string): void {
    const text = this.rest + chunk
    let index = 0
    const pattern = /<(Record|ExportDate|HealthData|\/HealthData)(?=[\s/>])[^>]*>/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text))) {
      index = pattern.lastIndex
      if (match[0].length > 65_536) throw new Error('Ein Health-XML-Element ist zu lang.')
      if (match[1] === 'HealthData') this.seenRoot = true
      else if (match[1] === '/HealthData') this.endedRoot = true
      else if (match[1] === 'ExportDate') {
        if (this.records) throw new Error('Das Exportdatum muss vor den Health-Messungen stehen.')
        const value = attributes(match[0]).value
        this.exportAt = parseHealthDate(value)
        if (this.exportAt === null || this.exportAt > this.now + 300_000) throw new Error('Ungültiges Health-Exportdatum.')
        this.exportDay = value.slice(0, 10)
        this.windowDays = null
      } else this.record(attributes(match[0]))
    }
    // Ein angefangenes Element bleibt für das nächste Stück liegen.
    const open = text.lastIndexOf('<')
    this.rest = open >= index && !text.slice(open).includes('>') ? text.slice(open) : ''
    if (this.rest.length > 65_536) throw new Error('Ein Health-XML-Element ist zu lang.')
  }

  private dayKeys(): string[] {
    if (this.windowDays) return this.windowDays
    const end = Date.parse(this.exportDay + 'T12:00:00Z')
    this.windowDays = Array.from({ length: 7 }, (_, i) => new Date(end - i * 86_400_000).toISOString().slice(0, 10))
    return this.windowDays
  }

  private add(day: string, field: keyof HealthDay, source: string, value: number): void {
    let fields = this.sums.get(day)
    if (!fields) this.sums.set(day, (fields = new Map()))
    let sources = fields.get(field)
    if (!sources) fields.set(field, (sources = new Map()))
    if (!sources.has(source) && sources.size >= 128) throw new Error('Zu viele Health-Datenquellen.')
    sources.set(source, (sources.get(source) ?? 0) + value)
  }

  private record(a: Record<string, string>): void {
    this.records++
    const type = a.type
    const day = a.startDate?.slice(0, 10)
    if (!type || !day) return
    const endDay = a.endDate?.slice(0, 10) ?? day
    const targetDay = type === SLEEP ? endDay : day
    if (!this.dayKeys().includes(targetDay)) return
    const source = (a.sourceName ?? '').slice(0, 300)
    const identity = JSON.stringify([type, source, a.startDate, a.endDate, a.value, a.unit])
    if (this.seen.has(identity)) return
    if (this.seen.size >= 250_000) throw new Error('Zu viele Messungen in sieben Tagen. Bitte den Export verkleinern.')
    this.seen.add(identity)
    const sum = SUM_TYPES[type]
    if (sum) {
      const value = Number(a.value)
      if (Number.isFinite(value) && value >= 0) this.add(day, sum, source, convert(sum, value, a.unit))
      return
    }
    if (type === SLEEP && ASLEEP.test(a.value ?? '')) {
      const start = parseHealthDate(a.startDate)
      const end = parseHealthDate(a.endDate)
      if (start === null || end === null || !endDay || end <= start || end - start > 24 * 3_600_000) return
      let sources = this.sleep.get(endDay)
      if (!sources) this.sleep.set(endDay, (sources = new Map()))
      if (!sources.has(source) && sources.size >= 128) throw new Error('Zu viele Health-Datenquellen.')
      const intervals = sources.get(source) ?? []
      if (intervals.length >= 20_000) throw new Error('Zu viele Schlafintervalle.')
      intervals.push([start, end]); sources.set(source, intervals)
      return
    }
    const at = parseHealthDate(a.endDate ?? a.startDate)
    const value = Number(a.value)
    if (at === null || !Number.isFinite(value)) return
    if (type === 'HKQuantityTypeIdentifierRestingHeartRate') {
      const current = this.resting.get(day)
      if (!current || current.at < at) this.resting.set(day, { at, bpm: value })
    } else if (type === 'HKQuantityTypeIdentifierHeartRate') {
      if (!this.heart || this.heart.at < at) this.heart = { at, bpm: value }
    } else if (type === 'HKQuantityTypeIdentifierBodyMass') {
      const kg = a.unit === 'lb' ? value * 0.45359237 : value
      if (!this.weight || this.weight.at < at) this.weight = { at, kg }
    }
  }

  /** Die letzten sieben Tage bis zum Exportdatum. `null`, wenn darin nichts steht. */
  result(): HealthSnapshot | null {
    if (!this.seenRoot || !this.endedRoot || this.rest) throw new Error('Der Health-XML-Export ist unvollständig oder ungültig.')
    const takenAt = Math.min(this.exportAt ?? this.now, this.now)
    const days: HealthDay[] = []
    for (const key of this.dayKeys()) {
      const day: HealthDay = { date: key }
      for (const [field, sources] of this.sums.get(key) ?? []) {
        const best = Math.max(...sources.values())
        ;(day as unknown as Record<string, number>)[field] = field === 'steps' || field === 'flights' ? Math.round(best) : Math.round(best * 10) / 10
      }
      const sleep = this.sleep.get(key)
      if (sleep) {
        const hours = [...sleep.values()].map(intervals => {
          let total = 0, until = -Infinity
          for (const [start, end] of intervals.sort((a, b) => a[0] - b[0])) {
            total += Math.max(0, end - Math.max(start, until)); until = Math.max(until, end)
          }
          return total / 3_600_000
        })
        day.sleepHours = Math.round(Math.min(24, Math.max(...hours)) * 10) / 10
      }
      const resting = this.resting.get(key)
      if (resting) day.restingHeartRate = Math.round(resting.bpm)
      if (Object.keys(day).length > 1) days.push(day)
    }
    const heartRate = this.heart ? { bpm: Math.round(this.heart.bpm), at: this.heart.at } : undefined
    const weight = this.weight ? { kg: Math.round(this.weight.kg * 10) / 10, at: this.weight.at } : undefined
    if (days.length === 0 && !heartRate && !weight) return null
    return { takenAt, days, ...(heartRate ? { heartRate } : {}), ...(weight ? { weight } : {}) }
  }
}
