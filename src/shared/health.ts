/**
 * Apple Health, wie es beim Rechner ankommt.
 *
 * Der Rechner kann HealthKit nicht selbst lesen — das darf nur eine App auf
 * dem iPhone, nach ausdrücklicher Zustimmung. Die James-App liest deshalb eine
 * kleine Tageszusammenfassung (keine Einzelmessungen) und schickt sie über die
 * bestehende, gekoppelte Telefonverbindung. Der Rechner prüft hier jede Zahl,
 * weil die Verbindung von außen erreichbar ist: Was nicht in den erlaubten
 * Bereich passt, fällt weg, statt James falsche Werte vorzulesen.
 */

export interface HealthDay {
  /** Kalendertag auf dem iPhone, `JJJJ-MM-TT`. */
  date: string
  steps?: number
  /** Gehen und Laufen, Kilometer. */
  distanceKm?: number
  /** Aktive Energie, Kilokalorien. */
  activeKcal?: number
  /** Trainingsminuten (Apple-Ring „Training“). */
  exerciseMin?: number
  flights?: number
  /** Schlaf der Nacht, die an diesem Morgen endete, in Stunden. */
  sleepHours?: number
  /** Ruhepuls, Schläge pro Minute. */
  restingHeartRate?: number
}

export interface HealthSnapshot {
  /** Zeitpunkt der Messung auf dem iPhone, Millisekunden. */
  takenAt: number
  /** Neueste zuerst, höchstens sieben. */
  days: HealthDay[]
  /** Letzter gemessener Puls und wann. */
  heartRate?: { bpm: number; at: number }
  /** Letztes Gewicht in Kilogramm und wann. */
  weight?: { kg: number; at: number }
}

const LIMITS: Record<Exclude<keyof HealthDay, 'date'>, [number, number]> = {
  steps: [0, 200_000],
  distanceKm: [0, 500],
  activeKcal: [0, 20_000],
  exerciseMin: [0, 1_440],
  flights: [0, 2_000],
  sleepHours: [0, 24],
  restingHeartRate: [20, 250]
}

function inRange(value: unknown, [min, max]: [number, number]): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return undefined
  return Math.round(value * 10) / 10
}

function timestamp(value: unknown, now: number): number | undefined {
  // Nicht aus der Zukunft (fünf Minuten Uhrabweichung erlaubt), nicht älter als ein Jahr.
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (value > now + 5 * 60_000 || value < now - 366 * 86_400_000) return undefined
  return Math.round(value)
}

/** Prüft, was das Telefon geschickt hat. `null`, wenn nichts Brauchbares darin steht. */
export function parseHealthSnapshot(value: unknown, now = Date.now()): HealthSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const takenAt = timestamp(raw.takenAt, now)
  if (takenAt === undefined || !Array.isArray(raw.days)) return null

  const days: HealthDay[] = []
  for (const entry of raw.days.slice(0, 7)) {
    if (!entry || typeof entry !== 'object') continue
    const day = entry as Record<string, unknown>
    if (typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) continue
    const clean: HealthDay = { date: day.date }
    for (const key of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
      const number = inRange(day[key], LIMITS[key])
      if (number !== undefined) clean[key] = key === 'steps' || key === 'flights' ? Math.round(number) : number
    }
    days.push(clean)
  }
  days.sort((a, b) => b.date.localeCompare(a.date))

  const snapshot: HealthSnapshot = { takenAt, days }
  const pair = (input: unknown, field: 'bpm' | 'kg', limits: [number, number]): { value: number; at: number } | undefined => {
    if (!input || typeof input !== 'object') return undefined
    const record = input as Record<string, unknown>
    const number = inRange(record[field], limits)
    const at = timestamp(record.at, now)
    return number !== undefined && at !== undefined ? { value: number, at } : undefined
  }
  const heart = pair(raw.heartRate, 'bpm', [20, 250])
  if (heart) snapshot.heartRate = { bpm: Math.round(heart.value), at: heart.at }
  const weight = pair(raw.weight, 'kg', [2, 400])
  if (weight) snapshot.weight = { kg: weight.value, at: weight.at }

  if (!days.length && !snapshot.heartRate && !snapshot.weight) return null
  return snapshot
}

function number(value: number, digits = 0): string {
  return value.toLocaleString('de-DE', { maximumFractionDigits: digits, minimumFractionDigits: 0 })
}

function hours(value: number): string {
  const whole = Math.floor(value)
  const minutes = Math.round((value - whole) * 60)
  return minutes ? `${whole} Std. ${minutes} Min.` : `${whole} Std.`
}

function age(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 2) return 'gerade eben'
  if (minutes < 90) return `vor ${minutes} Minuten`
  const h = Math.round(minutes / 60)
  if (h < 36) return `vor ${h} Stunden`
  return `vor ${Math.round(h / 24)} Tagen`
}

function dayLine(day: HealthDay): string {
  const parts: string[] = []
  if (day.steps !== undefined) parts.push(`${number(day.steps)} Schritte`)
  if (day.distanceKm !== undefined) parts.push(`${number(day.distanceKm, 1)} km`)
  if (day.activeKcal !== undefined) parts.push(`${number(day.activeKcal)} kcal aktiv`)
  if (day.exerciseMin !== undefined) parts.push(`${number(day.exerciseMin)} Min. Training`)
  if (day.flights !== undefined) parts.push(`${number(day.flights)} Stockwerke`)
  if (day.sleepHours !== undefined) parts.push(`${hours(day.sleepHours)} Schlaf`)
  if (day.restingHeartRate !== undefined) parts.push(`Ruhepuls ${number(day.restingHeartRate)}`)
  return parts.join(', ')
}

/**
 * Kurzfassung für das Sprachmodell, auf Deutsch und ohne Einheitenkürzel, die
 * sich schlecht vorlesen. Mit Alter der Daten, damit James nicht von „heute"
 * spricht, wenn das Telefon seit gestern nichts geschickt hat.
 */
export function describeHealth(snapshot: HealthSnapshot, now = Date.now()): string {
  const lines = [`Apple Health vom iPhone, Stand ${age(snapshot.takenAt, now)}.`]
  const [today, ...earlier] = snapshot.days
  if (today) lines.push(`${today.date}: ${dayLine(today) || 'keine Werte'}.`)
  if (snapshot.heartRate) lines.push(`Letzter Puls ${snapshot.heartRate.bpm} Schläge pro Minute, ${age(snapshot.heartRate.at, now)}.`)
  if (snapshot.weight) lines.push(`Letztes Gewicht ${number(snapshot.weight.kg, 1)} kg, ${age(snapshot.weight.at, now)}.`)
  const withSteps = earlier.filter((d) => d.steps !== undefined)
  if (withSteps.length) {
    const avg = withSteps.reduce((n, d) => n + (d.steps ?? 0), 0) / withSteps.length
    lines.push(`Durchschnitt der ${withSteps.length} Tage davor: ${number(avg)} Schritte.`)
  }
  for (const day of earlier) {
    const line = dayLine(day)
    if (line) lines.push(`${day.date}: ${line}.`)
  }
  return lines.join('\n')
}
