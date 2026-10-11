import { countIncidents, insertIncident, listIncidents, openIncidents, updateIncidentOutcome } from '../db'
import type { SelfHealReport } from '@shared/types'
import { redactLogText } from '../logging'
import { createStateGate } from '@shared/stateGate'

/**
 * Selbstheilung: was schiefging, was dagegen getan wurde, was übrig bleibt.
 *
 * Vorher war jede Ausfallsicherung eine Insel — der Sprachdienst startete sich
 * neu, das Übersetzen wich auf Ollama aus, Twilio übersetzte seine
 * Fehlernummern. Jede für sich richtig, aber zusammen ergaben sie kein Bild:
 * Auf die Frage "warum ging die Stimme gestern abend nicht" hätte niemand
 * antworten können, auch James nicht.
 *
 * Hier laufen sie zusammen. Drei Dinge passieren an dieser Stelle:
 *
 * 1. Jede Störung wird notiert, mit einem Fingerabdruck, der Gleichartiges
 *    zusammenfasst.
 * 2. Passt ein Gegenmittel, wird es angewandt — begrenzt, damit aus einer
 *    Störung keine Schleife wird.
 * 3. Was offen bleibt, kann James vorlesen. Nicht als Stacktrace, sondern
 *    als Satz mit dem, was der Nutzer tun kann.
 *
 * Was hier ausdrücklich NICHT passiert: den eigenen Quelltext ändern. Ein
 * Assistent, der sich unbeaufsichtigt umschreibt und neu startet, kann sich
 * die eigene Reparierbarkeit nehmen — und aus dem Ergebnis wäre eine echte
 * Korrektur nicht von einer erfundenen zu unterscheiden. Für Codefehler
 * sammelt `codeReport()` alles, was zur Behebung nötig ist, und legt es dem
 * Nutzer hin.
 */

export type Area =
  | 'system'
  | 'stimme'
  | 'telefonie'
  | 'gemini'
  | 'werkzeug'
  | 'live'
  | 'fernbedienung'

export interface Incident {
  area: Area
  /** Kurze, stabile Kennung — `dienst-abgestuerzt`, nicht die Fehlermeldung. */
  code: string
  message: string
  context?: Record<string, unknown>
}

/**
 * Ein Gegenmittel.
 *
 * `applies` entscheidet, `apply` handelt, `describe` erklärt es hinterher dem
 * Nutzer. Die Trennung ist wichtig: Was James dem Nutzer sagt, soll nicht der
 * technische Vorgang sein, sondern was daraus für ihn folgt.
 */
export interface Remedy {
  name: string
  applies(incident: Incident): boolean
  /** Gibt zurück, ob es geholfen hat. */
  apply(incident: Incident): Promise<boolean>
  describe(healed: boolean): string
  /**
   * Unterbricht, was der Nutzer gerade tut (Fenster neu laden). Läuft nur
   * automatisch, nicht beim Reparieren von Hand — dort säße der Nutzer
   * vielleicht mitten im Gespräch.
   */
  disruptive?: boolean
  /**
   * Wie oft dasselbe Gegenmittel je Stunde höchstens angewandt wird.
   *
   * Ohne diese Grenze wird aus "Dienst neu starten" bei einem Fehler, der
   * gleich wieder auftritt, eine Endlosschleife, die die Grafikkarte belegt
   * und das Protokoll füllt.
   */
  maxPerHour: number
}

const HOUR_MS = 60 * 60 * 1000
const remedies: Remedy[] = []
const incidentListeners = new Set<(incident: Pick<Incident, 'area' | 'code'>) => void>()
/**
 * Dauerzustände stehen einmal im Protokoll, nicht bei jedem Prüflauf.
 *
 * Die Störung selbst wird weiter jedes Mal gespeichert (Zählung und Bericht
 * brauchen sie); nur die Protokollzeile „greift nicht mehr“ bzw. „kein
 * Gegenmittel“ kam vorher bis zu 27 Mal in der Stunde, ohne etwas Neues zu sagen.
 */
const quiet = createStateGate(HOUR_MS)

export function onIncidentRecorded(listener: (incident: Pick<Incident, 'area' | 'code'>) => void): () => void {
  incidentListeners.add(listener)
  return () => incidentListeners.delete(listener)
}

/**
 * Marke für "wurde ausgesetzt, weil es zu oft war".
 *
 * Sie hängt am gespeicherten Namen des Gegenmittels und wird beim Vorlesen
 * wieder abgetrennt — sonst stünde eine interne Kennung wie
 * `sprachdienst-neustart (ausgesetzt)` in einem Satz, den James vorliest.
 */
const SUSPENDED = ' §ausgesetzt'

/** Entwicklerwarnungen, die keinen Ausfall der Anwendung darstellen. */
export function isIgnorableRuntimeWarning(text: string): boolean {
  return /^\(node:\d+\)\s+\[DEP\d+\]\s+DeprecationWarning:/i.test(text.trim())
}

export function registerRemedy(remedy: Remedy): void {
  remedies.push(remedy)
}

/**
 * Der Fingerabdruck.
 *
 * Bereich und Kennung, sonst nichts. Die Meldung selbst gehört bewusst nicht
 * dazu: "Port 8791 belegt" und "Port 8792 belegt" sind dieselbe Störung, und
 * würden sie getrennt gezählt, liefe jede Zählung ins Leere.
 */
function fingerprintOf(incident: Incident): string {
  return `${incident.area}:${incident.code}`
}

/**
 * Eine Störung melden — und, wenn möglich, gleich beheben.
 *
 * Gibt zurück, ob sie behoben wurde. Der Aufrufer kann daran entscheiden, ob
 * er es noch einmal versucht.
 */
export async function report(incident: Incident): Promise<boolean> {
  const fingerprint = fingerprintOf(incident)
  const message = redactLogText(incident.message)
  let context: string | null = null
  if (incident.context) {
    try {
      context = redactLogText(JSON.stringify(incident.context)).slice(0, 2000)
    } catch {
      context = '{"hinweis":"Kontext war nicht serialisierbar."}'
    }
  }
  const id = insertIncident({
    area: incident.area,
    code: incident.code,
    fingerprint,
    message,
    context,
    remedy: null,
    healed: null
  })
  for (const listener of incidentListeners) {
    try { listener({ area: incident.area, code: incident.code }) } catch { /* Diagnostics never block repair. */ }
  }

  const remedy = remedies.find((r) => r.applies(incident))
  if (!remedy) {
    // Mit dem Wortlaut als Zustand: Eine andere Meldung unter demselben
    // Fingerabdruck (zwei verschiedene Renderer-Fehler) ist eine Neuigkeit.
    if (quiet.changed(`ohne-mittel:${fingerprint}`, message.slice(0, 200))) {
      console.warn(`[selbstheilung] ${fingerprint}: kein Gegenmittel — ${message.slice(0, 200)}`)
    }
    return false
  }

  const recent = countIncidents(fingerprint, Date.now() - HOUR_MS)
  if (recent > remedy.maxPerHour) {
    if (quiet.changed(`ausgesetzt:${fingerprint}`, remedy.name)) {
      console.warn(`[selbstheilung] ${fingerprint}: ${recent} Mal in einer Stunde, ${remedy.name} greift nicht mehr`)
    }
    updateIncidentOutcome(id, `${remedy.name}${SUSPENDED}`, false)
    return false
  }

  let healed = false
  try {
    healed = await remedy.apply(incident)
  } catch (err) {
    console.error(`[selbstheilung] ${remedy.name} ist selbst gescheitert:`, err)
    healed = false
  }
  updateIncidentOutcome(id, remedy.name, healed)
  // Behoben heißt: Kommt es wieder, ist das eine Neuigkeit und gehört ins Protokoll.
  if (healed) {
    quiet.forget(`ohne-mittel:${fingerprint}`)
    quiet.forget(`ausgesetzt:${fingerprint}`)
  }
  console.info(`[selbstheilung] ${fingerprint}: ${remedy.name} → ${healed ? 'behoben' : 'nicht behoben'}`)
  return healed
}

/**
 * Alles Offene noch einmal behandeln — auf ausdrücklichen Wunsch.
 *
 * Der Knopf „Jetzt prüfen und reparieren" und `self_repair` liefen vorher nur
 * die Dienstprüfung. Offene Störungen, deren Gegenmittel nach zu vielen
 * Versuchen ausgesetzt war, blieben dadurch offen, egal wie oft man drückte.
 * Wer selbst auf Reparieren drückt, will es jetzt versucht haben: Die
 * Stundengrenze gilt hier deshalb nicht — sie schützt vor Schleifen der
 * Automatik, nicht vor dem Nutzer.
 */
export async function retryOpenIncidents(hours = 24): Promise<void> {
  for (const open of openIncidents(Date.now() - hours * HOUR_MS)) {
    const incident: Incident = { area: open.area as Area, code: open.code, message: open.message }
    const remedy = remedies.find((r) => r.applies(incident))
    if (!remedy || remedy.disruptive) continue
    let healed = false
    try {
      healed = await remedy.apply(incident)
    } catch (err) {
      console.warn(`[selbstheilung] ${remedy.name} ist selbst gescheitert:`, String(err).slice(0, 200))
    }
    updateIncidentOutcome(open.id, remedy.name, healed)
    console.info(`[selbstheilung] ${open.fingerprint}: ${remedy.name} (von Hand) → ${healed ? 'behoben' : 'nicht behoben'}`)
  }
}

/**
 * Was gerade nicht in Ordnung ist, in ganzen Sätzen.
 *
 * Das ist die Fassung, die James vorliest. Deshalb keine Kennungen, keine
 * Zeitstempel in Millisekunden und keine Fingerabdrücke — die stehen im
 * Aktionslog, wer sie braucht, sieht dort nach.
 */
export function healthReport(hours = 24): SelfHealReport {
  const since = Date.now() - hours * HOUR_MS
  // Auch schon gespeicherte Fehlalarme verschwinden damit sofort aus dem
  // Bericht; nur die Erkennung neuer Zeilen zu korrigieren ließe sie sonst bis
  // zum Ende des 24-Stunden-Fensters als „offen“ stehen.
  const relevant = (message: string): boolean => !isIgnorableRuntimeWarning(message)
  const open = openIncidents(since).filter((i) => relevant(i.message))
  const all = listIncidents(500).filter((i) => i.ts >= since && relevant(i.message))

  const healed = all.filter((i) => i.healed === true).length
  const problems = open.map((i) => {
    const suspended = i.remedy?.endsWith(SUSPENDED) ?? false
    const name = suspended ? i.remedy!.slice(0, -SUSPENDED.length) : i.remedy
    const remedy = remedies.find((r) => r.name === name)
    // Was versucht wurde und was es gebracht hat — oder dass nichts passte.
    // Bei ausgesetzten Gegenmitteln zählt die Häufigkeit zur Auskunft dazu:
    // "hat nicht geholfen" und "hat so oft nicht geholfen, dass ich es sein
    // lasse" sind für den Nutzer zwei verschiedene Nachrichten.
    let attempted: string | null = null
    if (name) {
      const base = remedy?.describe(false) ?? name
      attempted = suspended
        ? `${base} Das ist ${i.count} Mal passiert — ich versuche es vorerst nicht mehr.`
        : base
    }
    return {
      area: i.area,
      code: i.code,
      message: i.message,
      count: i.count,
      lastAt: i.ts,
      attempted
    }
  })

  return {
    hours,
    total: all.length,
    healed,
    problems,
    // Die kurze Antwort auf "läuft alles?", damit James nicht die Liste
    // vorlesen muss, wenn sie leer ist.
    summary:
      all.length === 0
        ? 'Keine Störungen.'
        : problems.length === 0
          ? `${all.length} ${all.length === 1 ? 'Störung' : 'Störungen'}, alle von selbst behoben.`
          : `${all.length} ${all.length === 1 ? 'Störung' : 'Störungen'}, ${healed} davon behoben, ${problems.length} offen.`
  }
}

/**
 * Alles, was zur Behebung eines Codefehlers nötig ist — zum Weiterreichen.
 *
 * Der bewusste Endpunkt der Selbstheilung: Was sich zur Laufzeit nicht kurieren
 * lässt, wird nicht heimlich gepatcht, sondern zusammengetragen. Der Text ist
 * so gebaut, dass er sich unverändert in eine Sitzung mit einem
 * Programmierwerkzeug einfügen lässt.
 */
export function codeReport(hours = 24): string {
  const report = healthReport(hours)
  if (report.problems.length === 0) return 'Nichts offen.'

  const lines = [
    `James-Jarvis — offene Störungen der letzten ${hours} Stunden`,
    '',
    report.summary,
    ''
  ]
  for (const p of report.problems) {
    lines.push(`## ${p.area}: ${p.code} (${p.count}×, zuletzt ${new Date(p.lastAt).toLocaleString('de-DE')})`)
    lines.push(p.message)
    if (p.attempted) lines.push(`Versucht wurde: ${p.attempted} — ohne Erfolg.`)
    lines.push('')
  }
  return lines.join('\n')
}
