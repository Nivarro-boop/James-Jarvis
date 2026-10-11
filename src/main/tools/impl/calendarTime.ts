/**
 * Die Zeitrechnung des Kalenders — ohne jede Abhängigkeit.
 *
 * Bewusst von `calendar.ts` getrennt, und nicht aus Ordnungsliebe: Sobald
 * `googleapis` und der Schlüsselspeicher mit im Modul hängen, lässt sich hier
 * nichts mehr ausprobieren, ohne eine halbe Anwendung zu starten. Und
 * ausprobieren will man genau das hier — Wochengrenzen, Monatsenden,
 * Sommerzeit. Das sind die Stellen, an denen ein Kalender falsch liegt, und
 * zwar leise: Ein fehlender Termin sieht aus wie ein freier Tag.
 */

export const RANGES = [
  'heute',
  'morgen',
  'uebermorgen',
  'diese_woche',
  'naechste_woche',
  'dieser_monat',
  'naechste_7_tage',
  'naechste_30_tage'
] as const

export type Range = (typeof RANGES)[number]

export function startOfDay(d: Date): Date {
  const out = new Date(d)
  out.setHours(0, 0, 0, 0)
  return out
}

/**
 * Tage addieren, über `setDate`.
 *
 * Nicht über eine Addition auf den Millisekunden: Ein Tag hat an den beiden
 * Umstellungswochenenden 23 beziehungsweise 25 Stunden, und wer mit 86 400 000
 * rechnet, landet dort eine Stunde daneben — beim Tagesanfang also im
 * Vortag. `setDate` rechnet im Kalender und nicht auf der Uhr.
 */
export function addDays(d: Date, days: number): Date {
  const out = new Date(d)
  out.setDate(out.getDate() + days)
  return out
}

/** Die Zeitzone des Rechners — Google will sie bei jedem Eintrag benannt haben. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Vienna'
}

/**
 * Ein Wort in ein Zeitfenster übersetzen.
 *
 * „Diese Woche" beginnt am Montag, nicht am Sonntag — der Kalender wird auf
 * Deutsch bedient. Und der Anfang aller gegenwartsbezogenen Fenster ist der
 * jetzige Zeitpunkt statt des Tagesanfangs: Ein Termin, der vor zwei Stunden
 * vorbei war, steht nicht mehr an.
 *
 * `now` ist ein Parameter und keine Abfrage der Uhr, damit sich die Fälle an
 * Monatsenden und Zeitumstellungen überhaupt nachstellen lassen.
 */
export function resolveRange(range: Range, now: Date = new Date()): { from: Date; to: Date; label: string } {
  const today = startOfDay(now)

  switch (range) {
    case 'heute':
      return { from: now, to: addDays(today, 1), label: 'heute' }
    case 'morgen':
      return { from: addDays(today, 1), to: addDays(today, 2), label: 'morgen' }
    case 'uebermorgen':
      return { from: addDays(today, 2), to: addDays(today, 3), label: 'übermorgen' }
    case 'diese_woche': {
      // getDay(): 0 ist Sonntag. Für eine Woche ab Montag heißt das, den
      // Sonntag als siebten Tag zu behandeln statt als nullten.
      const weekday = (now.getDay() + 6) % 7
      return { from: now, to: addDays(today, 7 - weekday), label: 'diese Woche' }
    }
    case 'naechste_woche': {
      const weekday = (now.getDay() + 6) % 7
      const monday = addDays(today, 7 - weekday)
      return { from: monday, to: addDays(monday, 7), label: 'nächste Woche' }
    }
    case 'dieser_monat': {
      const firstOfNext = new Date(today.getFullYear(), today.getMonth() + 1, 1)
      return { from: now, to: firstOfNext, label: 'diesen Monat' }
    }
    case 'naechste_7_tage':
      return { from: now, to: addDays(today, 8), label: 'in den nächsten sieben Tagen' }
    case 'naechste_30_tage':
      return { from: now, to: addDays(today, 31), label: 'in den nächsten dreißig Tagen' }
  }
}

export interface When {
  dateTime?: string
  date?: string
}

/**
 * Eine vom Modell genannte Zeit prüfen.
 *
 * Angenommen wird `2026-08-15T14:30` (Ortszeit) und `2026-08-15` (ganztägig).
 * Alles andere wird abgelehnt statt zurechtgebogen: Ein Termin am falschen Tag
 * ist schlimmer als einer, der nicht zustande kommt — der zweite fällt auf.
 */
export function parseWhen(value: string): When {
  const trimmed = value.trim()

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const [year, month, day] = trimmed.split('-').map(Number)
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      throw new Error(`"${value}" nennt kein gültiges Datum.`)
    }
    // Gegenprobe über das Datum selbst: Der 31. Februar besteht die
    // Bereichsprüfung oben und wird von JavaScript still zum 3. März.
    const probe = new Date(year, month - 1, day)
    if (probe.getMonth() !== month - 1 || probe.getDate() !== day) {
      throw new Error(`Den ${day}.${month}.${year} gibt es nicht.`)
    }
    return { date: trimmed }
  }

  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/.exec(trimmed)
  if (!match) {
    throw new Error(
      `"${value}" ist keine brauchbare Zeitangabe. Erwartet wird 2026-08-15T14:30 für einen ` +
        'Termin mit Uhrzeit oder 2026-08-15 für einen ganztägigen.'
    )
  }

  const [, day, hour, minute] = match
  if (Number(hour) > 23 || Number(minute) > 59) {
    throw new Error(`"${value}" nennt keine gültige Uhrzeit.`)
  }
  // Die Datumsgegenprobe gilt hier genauso.
  parseWhen(day)

  // Ohne Zeitzonen-Anhängsel: Google bekommt die Zone daneben als eigenes
  // Feld. Ein hier angehängtes "Z" würde die Zeit nach UTC verschieben und
  // jeden Termin im Sommer um zwei Stunden verrücken.
  return { dateTime: `${day}T${hour}:${minute}:00` }
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Ortszeit als `2026-08-15T14:30:00`, ohne Umweg über UTC. */
export function localIso(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:00`
  )
}

/**
 * Das Ende zu einem Anfang.
 *
 * Bei ganztägigen Terminen will Google den Folgetag als Ende — mit demselben
 * Tag erscheint der Termin überhaupt nicht im Kalender, und das ist ein
 * Fehler, den man erst bemerkt, wenn man nachsieht und nichts findet.
 */
export function computeEnd(start: When, minutes: number): When {
  if (start.date) {
    const next = addDays(new Date(`${start.date}T00:00:00`), 1)
    return { date: `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}` }
  }
  const from = new Date(start.dateTime!)
  const clamped = Math.min(24 * 60, Math.max(5, minutes))
  return { dateTime: localIso(new Date(from.getTime() + clamped * 60_000)) }
}

/** Für die gesprochene Antwort: „Freitag, 15. August, 14:30" statt eines Zeitstempels. */
export function speakable(event: { start?: When }): string {
  const start = event.start
  if (!start) return 'ohne Zeitangabe'
  if (start.date) {
    return (
      new Date(`${start.date}T00:00:00`).toLocaleDateString('de-DE', {
        weekday: 'long',
        day: 'numeric',
        month: 'long'
      }) + ', ganztägig'
    )
  }
  if (!start.dateTime) return 'ohne Zeitangabe'
  return new Date(start.dateTime).toLocaleString('de-DE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit'
  })
}
