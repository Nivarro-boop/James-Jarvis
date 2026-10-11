import type { MemoryEntry } from '@shared/types'
import {
  allMemoriesWithEmbeddings,
  insertMemory,
  listMemories,
  recentMemoryTexts,
  touchMemories,
  updateMemory
} from '../db'
import { cosine, embed } from '../db/embeddings'

/**
 * Langzeitgedächtnis.
 *
 * Ähnlichkeitssuche läuft in JS über Float32-Blobs aus SQLite. Bei den
 * Mengen, die hier realistisch anfallen (einige Tausend Einträge), ist das
 * schnell genug und spart eine eigene Vektordatenbank.
 */

export async function remember(text: string, kind = 'fact'): Promise<number> {
  const vector = await embed(text)
  return insertMemory(text.trim(), kind, vector)
}

export interface RecalledMemory {
  id: number
  text: string
  score: number
}

export async function recall(query: string, limit = 6, minScore = 0.3): Promise<RecalledMemory[]> {
  const rows = allMemoriesWithEmbeddings()
  if (rows.length === 0) return []

  const queryVector = await embed(query)

  let scored: RecalledMemory[] = []
  if (queryVector) {
    scored = rows
      .filter((r) => r.embedding !== null)
      .map((r) => ({ id: r.id, text: r.text, score: cosine(queryVector, r.embedding!) }))
      .filter((r) => r.score >= minScore)
  }

  /**
   * Rückfall auf Wortüberlappung. Deutlich schlechter als die
   * Ähnlichkeitssuche, aber besser als gar kein Gedächtnis.
   *
   * Greift nicht nur, wenn sich für die Frage kein Vektor bilden lässt,
   * sondern auch, wenn die Ähnlichkeitssuche leer ausgeht — und das ist der
   * Fall, der wirklich weh tat: Erinnerungen, die angelegt wurden, während der
   * Einbettungsdienst nicht erreichbar war, stehen ohne Vektor in der
   * Datenbank. Die Zeile darüber filtert sie ersatzlos weg, und sobald der
   * Dienst wieder ging, waren sie über `recall` dauerhaft unerreichbar —
   * gemerkt, gespeichert, unauffindbar.
   */
  if (scored.length === 0) {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 3)
    scored = rows
      .map((r) => {
        const lower = r.text.toLowerCase()
        const hits = terms.filter((t) => lower.includes(t)).length
        return { id: r.id, text: r.text, score: terms.length ? hits / terms.length : 0 }
      })
      .filter((r) => r.score > 0)
  }

  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, limit)
  touchMemories(top.map((t) => t.id))
  return top
}

/**
 * Die Erinnerungen, die beim Sitzungsstart in den System-Prompt wandern:
 * die zuletzt angelegten, ohne Suchbegriff.
 *
 * Bewusst über eine eigene Abfrage statt über `allMemoriesWithEmbeddings`.
 * Der System-Prompt entsteht bei jedem Verbindungsaufbau neu — alle fünfzehn
 * Minuten und nach jeder Trennung wegen Stille. Sämtliche Vektoren dafür aus
 * der Datenbank zu holen, um zwölf Sätze anzuzeigen, ist reine Arbeit ohne
 * Ertrag.
 */
export function baselineMemories(limit = 12): string[] {
  return recentMemoryTexts(limit)
}

// ─────────────────────────────────────────────────────────────
// Von Hand eintragen und berichtigen
// ─────────────────────────────────────────────────────────────

/**
 * Ein Wortlaut, der keiner ist.
 *
 * Über die Stimme kommt so etwas nicht an — das Modell ruft `remember` mit
 * einem Satz auf oder gar nicht. Ein Eingabefeld liefert dagegen ständig
 * Leeres: versehentlich abgeschickt, alles markiert und weggelöscht, ein
 * einzelnes Leerzeichen stehen geblieben. Eine leere Zeile in der Liste könnte
 * danach niemand mehr zuordnen; sie ließe sich nur noch löschen.
 */
function requireText(text: string): string {
  const clean = text.trim()
  if (!clean) {
    throw new Error(
      'Eine Erinnerung ohne Wortlaut gibt es nicht. Schreib hinein, was James sich merken soll.'
    )
  }
  return clean
}

/**
 * Einbetten, ohne daran zu scheitern.
 *
 * `embed` gibt null zurück, wenn weder Gemini noch das lokale Modell erreichbar
 * sind, kann aber zusätzlich werfen: Die lokale Pipeline fängt nur ihr Laden ab,
 * nicht den Lauf danach. Von Hand eingetragen wird beides derselbe Fall und
 * keiner, der den Vorgang beenden darf — jemand sitzt vor einem Formular und
 * will einen Satz speichern, und ob im Hintergrund ein Vektor entstanden ist,
 * geht ihn nichts an. Ohne Vektor bleibt die Erinnerung über die Wortsuche in
 * `recall` erreichbar; der Verlust ist eine schlechtere Suche, nicht ein
 * verlorener Satz.
 */
async function embedQuietly(text: string): Promise<Float32Array | null> {
  try {
    return await embed(text)
  } catch (err) {
    console.error('[memory] Einbettung fehlgeschlagen, Erinnerung bleibt ohne Vektor:', err)
    return null
  }
}

/**
 * Eine Erinnerung von Hand anlegen.
 *
 * Steht bewusst neben `remember` und nicht darin. `remember` ist der Weg des
 * Modells und gibt die Kennung zurück, weil das Werkzeug sie meldet. Von Hand
 * eingetragen wird aus der Liste heraus, und die will danach die neue Liste
 * sehen — nicht eine Nummer, für die sie ein zweites Mal fragen muss.
 */
export async function addMemory(
  text: string,
  kind: MemoryEntry['kind'] = 'fact'
): Promise<MemoryEntry[]> {
  const clean = requireText(text)
  insertMemory(clean, kind, await embedQuietly(clean))
  return listMemories()
}

/**
 * Den Wortlaut einer bestehenden Erinnerung berichtigen.
 *
 * Der Vektor wird dabei neu berechnet, und das ist der eigentliche Inhalt
 * dieser Funktion und nicht ihre Beigabe. `recall` sucht über die Vektoren, nur
 * im Notfall über die Wörter: Bliebe der alte Vektor stehen, wäre die
 * berichtigte Erinnerung weiter unter dem falschen Wortlaut zu finden und unter
 * dem richtigen nicht. Sie wäre damit schlimmer als die falsche davor — der
 * Nutzer hätte sie berichtigt, in der Liste stünde der richtige Satz, und
 * James wüsste weiter das Alte, ohne dass irgendwo ein Fehler zu sehen ist.
 *
 * Ist der Einbettungsdienst gerade nicht erreichbar, wird der alte Vektor
 * trotzdem verworfen. Das klingt nach Verlust und ist die Reparatur: Eine
 * Erinnerung ohne Vektor fällt in die Wortsuche weiter oben und wird dort unter
 * ihrem neuen Wortlaut gefunden — genau der Fall, den der Kommentar dort
 * beschreibt. Nur weiß man diesmal, warum sie ohne Vektor dasteht, und der
 * nächste Aufruf hier holt ihn nach.
 */
export async function reviseMemory(id: number, text: string): Promise<MemoryEntry[]> {
  const clean = requireText(text)
  const vector = await embedQuietly(clean)

  // Berichtigt wird nur, was es gibt. Ohne diese Prüfung bekäme die Oberfläche
  // eine unveränderte Liste zurück und keinen Anlass zu sagen, warum die
  // Änderung nicht darin steht.
  if (!updateMemory(id, clean, vector)) {
    throw new Error(
      `Es gibt keine Erinnerung mit der Nummer ${id} — vermutlich wurde sie inzwischen ` +
        'gelöscht. Lade die Liste neu.'
    )
  }

  return listMemories()
}
