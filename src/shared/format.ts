/**
 * Entfernungen, Dauern und Uhrzeiten — einmal geschrieben, zweimal gesagt.
 *
 * Hauptprozess und Kristallfenster brauchen dieselben Zahlen in zwei Formen:
 * gesprochen für das Modell („2,4 Kilometer", „1 Stunde 5 Minuten") und
 * knapp für die Karte („2,4 km", „1 h 5 min"). Stünden beide Formen je an
 * ihrer eigenen Stelle, sagte die Stimme irgendwann „zehn Kilometer", während
 * auf der Karte „9,9 km" steht. Deshalb hier, in `shared`, mit denselben
 * Rundungsgrenzen für beide.
 */

/** Die Grenzen liegen dort, wo das Runden umschlägt — sonst hieße es „1000 m" bei 996 Metern. */
const METERS_TO_KM = 995
const KM_WHOLE = 9.95

function oneDecimal(km: number): string {
  return km.toLocaleString('de-AT', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

/** Entfernung so, wie man sie sagt: „350 Meter", „2,4 Kilometer", „37 Kilometer". */
export function spokenDistance(meters: number): string {
  if (meters < METERS_TO_KM) return `${Math.max(10, Math.round(meters / 10) * 10)} Meter`
  const km = meters / 1000
  if (km >= KM_WHOLE) return `${Math.round(km)} Kilometer`
  return `${oneDecimal(km)} Kilometer`
}

/** Entfernung für die Karte: „350 m", „2,4 km", „37 km". */
export function formatDistance(meters: number): string {
  if (meters < METERS_TO_KM) return `${Math.max(10, Math.round(meters / 10) * 10)} m`
  const km = meters / 1000
  if (km >= KM_WHOLE) return `${Math.round(km)} km`
  return `${oneDecimal(km)} km`
}

/** Ganze Minuten, mindestens eine: Unter einer Minute sagt niemand „0 Minuten". */
function minutesOf(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60))
}

/** Dauer so, wie man sie sagt: „eine Minute", „25 Minuten", „1 Stunde 5 Minuten". */
export function spokenDuration(seconds: number): string {
  const minutes = minutesOf(seconds)
  if (minutes < 60) return minutes === 1 ? 'eine Minute' : `${minutes} Minuten`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const h = hours === 1 ? '1 Stunde' : `${hours} Stunden`
  if (rest === 0) return h
  return `${h} ${rest === 1 ? '1 Minute' : `${rest} Minuten`}`
}

/** Dauer für die Karte: „1 min", „25 min", „1 h 5 min", „3 h". */
export function formatDuration(seconds: number): string {
  const minutes = minutesOf(seconds)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

/**
 * Uhrzeit „14:05", wahlweise in einer bestimmten Zone (Börse, Reiseziel).
 *
 * Eine unbekannte Zone wirft in `toLocaleTimeString` — dann eben die eigene.
 */
export function clock(ms: number, timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }
  try {
    return new Date(ms).toLocaleTimeString('de-DE', timeZone ? { ...options, timeZone } : options)
  } catch {
    return new Date(ms).toLocaleTimeString('de-DE', options)
  }
}
