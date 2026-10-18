/**
 * Rechner-Check: Reicht der PC für James, und was fehlt?
 *
 * Die Messwerte sammelt der Hauptprozess (Arbeitsspeicher, Platte, Netz) und
 * das Kristallfenster (Mikrofon, Lautsprecher). Hier steht nur die Bewertung,
 * damit sie ohne Electron prüfbar ist. Jeder Punkt bekommt einen Satz, den
 * James so vorlesen kann, und — wenn etwas fehlt — was der Nutzer tun soll.
 */

export interface SystemFacts {
  totalMemBytes: number
  freeMemBytes: number
  cpuModel: string
  cpuCores: number
  arch: string
  /** Freier Platz auf dem Laufwerk mit den App-Daten, `null` wenn unbekannt. */
  freeDiskBytes: number | null
  /** Antwortzeit in ms, `null` ohne Internet. */
  internetMs: number | null
  /** `null`, wenn das Kristallfenster nicht gefragt werden konnte. */
  microphones: number | null
  speakers: number | null
}

export type CheckLevel = 'ok' | 'hinweis' | 'problem'

export interface CheckItem {
  id: 'ram' | 'disk' | 'internet' | 'mikrofon' | 'lautsprecher' | 'cpu'
  level: CheckLevel
  wert: string
  satz: string
  tun?: string
}

export interface CheckReport {
  gesamt: CheckLevel
  satz: string
  punkte: CheckItem[]
}

const GB = 1024 ** 3

const gb = (bytes: number): string => `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0).replace('.', ',')} GB`

export function evaluateSystem(f: SystemFacts): CheckReport {
  const punkte: CheckItem[] = []

  const ram = f.totalMemBytes
  punkte.push(
    ram < 6 * GB
      ? {
          id: 'ram',
          level: 'problem',
          wert: gb(ram),
          satz: `Dein PC hat nur ${gb(ram)} Arbeitsspeicher. Lokale Stimme und lokale Modelle laufen damit langsam.`,
          tun: 'Nimm Cloud-Stimme und Cloud-Modell oder schließ andere Programme.'
        }
      : ram < 12 * GB
        ? {
            id: 'ram',
            level: 'hinweis',
            wert: gb(ram),
            satz: `${gb(ram)} Arbeitsspeicher reichen. Für große lokale Modelle wird es knapp.`
          }
        : { id: 'ram', level: 'ok', wert: gb(ram), satz: `${gb(ram)} Arbeitsspeicher, das passt.` }
  )

  punkte.push(
    f.cpuCores < 4
      ? {
          id: 'cpu',
          level: 'hinweis',
          wert: `${f.cpuCores} Kerne`,
          satz: `Der Prozessor hat ${f.cpuCores} Kerne. Ich rechne lokal etwas langsamer.`
        }
      : f.arch === 'arm64'
        ? {
            id: 'cpu',
            level: 'hinweis',
            wert: `${f.cpuCores} Kerne, ARM`,
            satz: 'ARM-Prozessor: Manche lokalen Bausteine laufen über die Windows-Emulation und sind langsamer.'
          }
        : { id: 'cpu', level: 'ok', wert: `${f.cpuCores} Kerne`, satz: `Prozessor mit ${f.cpuCores} Kernen, das passt.` }
  )

  if (f.freeDiskBytes === null) {
    punkte.push({ id: 'disk', level: 'hinweis', wert: 'unbekannt', satz: 'Freien Speicherplatz konnte ich nicht lesen.' })
  } else {
    const d = f.freeDiskBytes
    punkte.push(
      d < 2 * GB
        ? {
            id: 'disk',
            level: 'problem',
            wert: gb(d),
            satz: `Auf der Platte sind nur noch ${gb(d)} frei. Stimmen und Updates passen so nicht mehr drauf.`,
            tun: 'Räum Downloads oder den Papierkorb auf.'
          }
        : d < 10 * GB
          ? { id: 'disk', level: 'hinweis', wert: gb(d), satz: `${gb(d)} frei. Für lokale Modelle wird es eng.` }
          : { id: 'disk', level: 'ok', wert: gb(d), satz: `${gb(d)} frei auf der Platte.` }
    )
  }

  punkte.push(
    f.internetMs === null
      ? {
          id: 'internet',
          level: 'problem',
          wert: 'keins',
          satz: 'Ich finde gerade kein Internet. Cloud-Stimme, Suche und Kalender gehen so nicht.',
          tun: 'Prüf WLAN oder Kabel.'
        }
      : f.internetMs > 1500
        ? { id: 'internet', level: 'hinweis', wert: `${f.internetMs} ms`, satz: 'Das Internet ist langsam. Antworten können verzögert kommen.' }
        : { id: 'internet', level: 'ok', wert: `${f.internetMs} ms`, satz: 'Internet ist da und schnell genug.' }
  )

  punkte.push(
    f.microphones === null
      ? { id: 'mikrofon', level: 'hinweis', wert: 'unbekannt', satz: 'Das Mikrofon konnte ich gerade nicht prüfen.' }
      : f.microphones === 0
        ? {
            id: 'mikrofon',
            level: 'problem',
            wert: 'keins',
            satz: 'Ich finde kein Mikrofon. Schreib mir einfach, mit Mikrofon können wir auch reden.',
            tun: 'Schließ ein Headset an oder erlaube den Mikrofonzugriff in den Windows-Einstellungen.'
          }
        : { id: 'mikrofon', level: 'ok', wert: String(f.microphones), satz: 'Ein Mikrofon ist da.' }
  )

  punkte.push(
    f.speakers === null
      ? { id: 'lautsprecher', level: 'hinweis', wert: 'unbekannt', satz: 'Den Lautsprecher konnte ich gerade nicht prüfen.' }
      : f.speakers === 0
        ? {
            id: 'lautsprecher',
            level: 'problem',
            wert: 'keiner',
            satz: 'Ich finde keinen Lautsprecher. Bis einer dran ist, lies meine Antworten mit.',
            tun: 'Schließ Kopfhörer oder Boxen an.'
          }
        : { id: 'lautsprecher', level: 'ok', wert: String(f.speakers), satz: 'Ein Lautsprecher ist da.' }
  )

  const problems = punkte.filter((p) => p.level === 'problem')
  const hints = punkte.filter((p) => p.level === 'hinweis')
  const gesamt: CheckLevel = problems.length ? 'problem' : hints.length ? 'hinweis' : 'ok'
  const satz =
    gesamt === 'ok'
      ? 'Dein PC ist stark genug, alles da.'
      : gesamt === 'hinweis'
        ? 'Dein PC passt. Ein paar Kleinigkeiten solltest du wissen.'
        : problems.length === 1
          ? 'Eine Sache an deinem PC musst du selbst machen, ich sag dir welche.'
          : `${problems.length} Sachen an deinem PC musst du selbst machen, ich sag dir welche.`
  return { gesamt, satz, punkte }
}
