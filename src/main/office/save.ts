import { app, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { safeFileName } from './ooxml'

/**
 * Wohin eine erzeugte Office-Datei kommt.
 *
 * Dieselbe Grenze wie bei `file_write`: Es wird kein Pfad entgegengenommen,
 * sondern ein Ordnername aus einer festen Liste. Ein Schreibzugriff irgendwohin
 * ist damit nicht abgesichert, sondern nicht ausdrückbar.
 *
 * Die Liste ist kürzer als dort — Bilder, Videos und Musik stehen nicht drin.
 * Ein Angebot im Musikordner ist kein Anwendungsfall, sondern ein Vertipper,
 * und ein Auswahlfeld mit drei plausiblen Einträgen trifft das Modell
 * zuverlässiger als eines mit sechs.
 */
const FOLDERS = {
  dokumente: 'documents',
  desktop: 'desktop',
  downloads: 'downloads'
} as const

export type OfficeFolder = keyof typeof FOLDERS

export const OFFICE_FOLDERS = Object.keys(FOLDERS) as [OfficeFolder, ...OfficeFolder[]]

export interface SavedFile {
  /** Vollständiger Pfad — den braucht nur der Hauptprozess. */
  path: string
  /** Der Name, den der Nutzer zu hören bekommt. */
  name: string
  folder: OfficeFolder
  bytes: number
}

/**
 * Einen Namen finden, der noch frei ist.
 *
 * Nicht überschreiben, sondern hochzählen. Ein Sprachassistent wird zweimal
 * dasselbe gefragt — „mach mir eine Präsentation über X" —, und die zweite
 * Antwort darf die erste nicht stillschweigend auffressen. Bei „Bericht.docx"
 * entsteht dann „Bericht (2).docx".
 */
function freePath(dir: string, stem: string, extension: string): string {
  const first = join(dir, `${stem}${extension}`)
  if (!existsSync(first)) return first

  for (let n = 2; n < 100; n++) {
    const next = join(dir, `${stem} (${n})${extension}`)
    if (!existsSync(next)) return next
  }

  // Nach hundert gleichnamigen Dateien ist das kein Namenskonflikt mehr,
  // sondern eine Schleife. Der Zeitstempel bricht sie auf.
  return join(dir, `${stem} ${Date.now()}${extension}`)
}

/**
 * Datei ablegen und auf Wunsch öffnen.
 *
 * Das Öffnen ist Vorgabe und nicht Beiwerk: Wer eine Präsentation diktiert,
 * will sie ansehen, und der Weg über „wo hast du sie hingelegt" wäre ein
 * zweiter Gesprächszug für etwas, das der Klick sofort zeigt.
 */
export async function saveOfficeFile(
  data: Buffer,
  title: string,
  extension: string,
  folder: OfficeFolder | undefined,
  open: boolean
): Promise<SavedFile> {
  const where = folder ?? 'dokumente'
  const dir = app.getPath(FOLDERS[where])
  const stem = safeFileName(title, 'Dokument')
  const target = freePath(dir, stem, extension)

  await writeFile(target, data)

  if (open) {
    // Ein Fehlschlag hier ist kein Fehlschlag des Auftrags — die Datei liegt
    // ja. Das passiert etwa, wenn für die Endung kein Programm eingetragen
    // ist, und dann soll James sagen, wo sie liegt, statt abzubrechen.
    await shell.openPath(target).catch(() => '')
  }

  return { path: target, name: basename(target), folder: where, bytes: data.length }
}
