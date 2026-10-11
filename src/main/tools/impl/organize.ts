import { app } from 'electron'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'

/**
 * Ordner aufräumen.
 *
 * Der Anlass ist der Downloads-Ordner, in dem nach einem halben Jahr
 * zwölfhundert Dateien liegen. Was hier passiert, ist bewusst das Einfachste,
 * was dagegen hilft: Dateien in Unterordner schieben, nach Art oder nach
 * Monat. Kein Umbenennen, kein Aussortieren von Doppelten, kein Löschen.
 *
 * Drei Grenzen tragen das Ganze und sind nicht abschaltbar:
 *
 * Es wird nur die oberste Ebene angefasst. Wer selbst einen Ordner „Steuer
 * 2025" angelegt hat, hat damit eine Ordnung ausgedrückt — sie zu durchsuchen
 * und ihren Inhalt umzuverteilen wäre kein Aufräumen, sondern Zerstören.
 *
 * Es wird nur verschoben, nie überschrieben und nie gelöscht. Liegt am Ziel
 * schon etwas mit dem Namen, bekommt die Datei eine Nummer.
 *
 * Und jeder Lauf schreibt mit, was er getan hat. `file_organize_undo` macht
 * ihn rückgängig. Ohne das wäre ein Aufräumen auf Zuruf eine Zumutung: Der
 * Nutzer sieht das Ergebnis erst, wenn es schon passiert ist.
 */

const FOLDERS = {
  downloads: 'downloads',
  desktop: 'desktop',
  dokumente: 'documents',
  bilder: 'pictures',
  videos: 'videos',
  musik: 'music'
} as const

type FolderName = keyof typeof FOLDERS

const FOLDER_NAMES = Object.keys(FOLDERS) as [FolderName, ...FolderName[]]

// ─────────────────────────────────────────────────────────────
// Einteilung
// ─────────────────────────────────────────────────────────────

/**
 * Endung zu Ordnername.
 *
 * Die Ordnernamen sind die, die ein Mensch vergeben würde — sie stehen
 * nachher im Explorer. Was nicht in der Liste steht, landet unter
 * „Sonstiges" und nicht in einem Ordner je Endung: Ein Aufräumen, das
 * dreißig Ordner mit je einer Datei hinterlässt, hat nichts aufgeräumt.
 */
const BY_EXTENSION: Record<string, string> = {}

function assign(folder: string, extensions: string[]): void {
  for (const extension of extensions) BY_EXTENSION[extension] = folder
}

assign('Bilder', ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.heic', '.svg', '.tif', '.tiff', '.ico', '.raw', '.cr2', '.nef'])
assign('Videos', ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.webm', '.flv', '.m4v', '.mpg', '.mpeg'])
assign('Musik', ['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.wma', '.opus'])
assign('Dokumente', ['.pdf', '.doc', '.docx', '.odt', '.rtf', '.txt', '.md', '.epub', '.mobi', '.tex'])
assign('Tabellen', ['.xls', '.xlsx', '.xlsm', '.csv', '.ods', '.tsv'])
assign('Präsentationen', ['.ppt', '.pptx', '.odp', '.key'])
assign('Archive', ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso'])
assign('Programme', ['.exe', '.msi', '.bat', '.cmd', '.ps1', '.appx', '.msix'])
assign('Code', ['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.c', '.h', '.cpp', '.cs', '.go', '.rs', '.rb', '.php', '.sh', '.html', '.css', '.scss', '.json', '.xml', '.yml', '.yaml', '.sql'])
assign('Schriften', ['.ttf', '.otf', '.woff', '.woff2'])

const OTHER = 'Sonstiges'

/** Die Ordner, die dieses Werkzeug selbst anlegt — die fasst es nie wieder an. */
const OWN_FOLDERS = new Set([...new Set(Object.values(BY_EXTENSION)), OTHER])

const MONTHS = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'
]

function categoryByType(name: string): string {
  return BY_EXTENSION[extname(name).toLowerCase()] ?? OTHER
}

function categoryByMonth(modified: Date): string {
  return `${modified.getFullYear()}-${String(modified.getMonth() + 1).padStart(2, '0')} ${MONTHS[modified.getMonth()]}`
}

/**
 * Dateien, die liegen bleiben, egal was.
 *
 * Verknüpfungen auf dem Desktop sind der wichtigste Fall: Sie in einen
 * Unterordner zu schieben heißt für den Nutzer, dass seine Programme
 * verschwunden sind.
 */
const NEVER_MOVE = /^(desktop\.ini|thumbs\.db|\.ds_store)$/i
const NEVER_MOVE_EXTENSIONS = new Set(['.lnk', '.url', '.sys', '.tmp', '.crdownload', '.part'])

interface Candidate {
  name: string
  path: string
  category: string
  size: number
  modified: Date
}

/** Eine Ebene lesen und einteilen. Unterordner bleiben unberührt. */
async function scan(dir: string, by: 'art' | 'monat'): Promise<Candidate[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    throw new Error('Diesen Ordner kann ich nicht lesen.')
  }

  const found: Candidate[] = []

  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (entry.name.startsWith('.') || NEVER_MOVE.test(entry.name)) continue
    if (NEVER_MOVE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue

    const full = join(dir, entry.name)
    let info
    try {
      info = await stat(full)
    } catch {
      continue // War zwischenzeitlich weg.
    }

    found.push({
      name: entry.name,
      path: full,
      category: by === 'monat' ? categoryByMonth(info.mtime) : categoryByType(entry.name),
      size: info.size,
      modified: info.mtime
    })
  }

  return found
}

function groupByCategory(files: Candidate[]): Map<string, Candidate[]> {
  const groups = new Map<string, Candidate[]>()
  for (const file of files) {
    const list = groups.get(file.category)
    if (list) list.push(file)
    else groups.set(file.category, [file])
  }
  return groups
}

/**
 * Kategorien mit einer einzigen Datei bleiben, wo sie sind.
 *
 * Ein Ordner „Schriften" für eine einzelne .ttf macht den Ordner nicht
 * übersichtlicher, sondern fügt ihm einen Eintrag hinzu. Nach Monat sortiert
 * gilt das nicht — dort ist ein dünner Monat eine richtige Auskunft.
 */
function worthMoving(groups: Map<string, Candidate[]>, by: 'art' | 'monat'): Map<string, Candidate[]> {
  if (by === 'monat') return groups
  const kept = new Map<string, Candidate[]>()
  for (const [category, files] of groups) {
    if (files.length >= 2) kept.set(category, files)
  }
  return kept
}

function humanSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} Kilobyte`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} Megabyte`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} Gigabyte`
}

// ─────────────────────────────────────────────────────────────
// Rückgängig
// ─────────────────────────────────────────────────────────────

interface Journal {
  at: number
  folder: FolderName
  by: string
  moves: { from: string; to: string }[]
}

function journalPath(): string {
  return join(app.getPath('userData'), 'aufraeumen.json')
}

/**
 * Nur der letzte Lauf wird aufbewahrt.
 *
 * „Mach das rückgängig" meint das, was gerade passiert ist. Eine Kette über
 * mehrere Läufe hinweg wäre eine Versionsverwaltung für einen Ordner — und
 * gesprochen nicht mehr ansprechbar, weil niemand sagen kann, welchen der
 * fünf Läufe er meint.
 */
async function writeJournal(entry: Journal): Promise<void> {
  await writeFile(journalPath(), JSON.stringify(entry, null, 2), 'utf-8').catch(() => undefined)
}

async function readJournal(): Promise<Journal | null> {
  try {
    const raw = await readFile(journalPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Journal
    return Array.isArray(parsed?.moves) ? parsed : null
  } catch {
    return null
  }
}

/** Einen freien Zielpfad finden, statt etwas zu überschreiben. */
function freeTarget(target: string): string {
  if (!existsSync(target)) return target

  const dir = dirname(target)
  const extension = extname(target)
  const stem = basename(target, extension)

  for (let n = 2; n < 500; n++) {
    const next = join(dir, `${stem} (${n})${extension}`)
    if (!existsSync(next)) return next
  }
  return join(dir, `${stem} ${Date.now()}${extension}`)
}

// ─────────────────────────────────────────────────────────────
// Werkzeuge
// ─────────────────────────────────────────────────────────────

const folderField = z
  .enum(FOLDER_NAMES)
  .describe('Welcher Ordner. Meist downloads oder desktop.')

const byField = z
  .enum(['art', 'monat'])
  .optional()
  .describe('art sortiert nach Dateityp, monat nach Änderungsdatum. Standard art.')

const preview = defineTool({
  name: 'file_organize_preview',
  group: 'system',
  description:
    'Sieht nach, was ein Aufräumen bewirken würde, ohne etwas zu verschieben. Ruf das zuerst auf, ' +
    'wenn der Nutzer "räum mal auf" sagt — dann kannst du ihm nennen, was passieren würde, ' +
    'bevor es passiert.',
  schema: z.object({ folder: folderField, by: byField }),
  spokenHint: 'Ich seh mir das an.',
  async execute({ folder, by }) {
    const dir = app.getPath(FOLDERS[folder])
    const files = await scan(dir, by ?? 'art')
    const groups = worthMoving(groupByCategory(files), by ?? 'art')

    const moving = [...groups.values()].reduce((sum, list) => sum + list.length, 0)
    if (moving === 0) {
      return {
        dateien: files.length,
        verschiebbar: 0,
        hinweis:
          files.length === 0
            ? `Im Ordner ${folder} liegt nichts.`
            : `Im Ordner ${folder} gibt es nichts zu sortieren — dafür sind es zu wenige oder zu ähnliche Dateien.`
      }
    }

    const plan = [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([category, list]) => ({
        ordner: category,
        anzahl: list.length,
        größe: humanSize(list.reduce((sum, f) => sum + f.size, 0)),
        beispiel: list[0].name
      }))

    return {
      ordner: folder,
      dateien: files.length,
      verschiebbar: moving,
      bleiben: files.length - moving,
      plan,
      hinweis:
        'Sag in ein bis zwei Sätzen, wie viele Dateien in wie viele Ordner wandern würden, und ' +
        'nenne die zwei größten Gruppen. Frag dann, ob du es tun sollst — mit file_organize.'
    }
  }
}) as ToolDefinition

const organize = defineTool({
  name: 'file_organize',
  group: 'system',
  description:
    'Räumt einen Ordner auf, indem es die Dateien der obersten Ebene in Unterordner verschiebt. ' +
    'Nichts wird gelöscht oder überschrieben, bestehende Unterordner bleiben unberührt, und ' +
    'file_organize_undo macht den Lauf rückgängig.',
  schema: z.object({ folder: folderField, by: byField }),
  spokenHint: 'Ich räum auf.',
  async execute({ folder, by }, ctx) {
    const how = by ?? 'art'
    const dir = app.getPath(FOLDERS[folder])
    const files = await scan(dir, how)
    const groups = worthMoving(groupByCategory(files), how)

    const moves: { from: string; to: string }[] = []
    const failed: string[] = []

    for (const [category, list] of groups) {
      /*
       * Der Not-Aus muss auch die äußere Schleife anhalten.
       *
       * Vorher stand die Prüfung nur innen. Dreimal Escape brach damit das
       * Verschieben ab, lief aber weiter durch alle übrigen Kategorien — und
       * legte für jede noch einen Ordner an, in den nie etwas wanderte. Wer
       * abbricht, stand danach vor einem Ordner voller leerer Ordner, und die
       * räumt das Rückgängigmachen nicht weg: Im Journal steht nur, was
       * verschoben wurde.
       */
      if (ctx.signal.aborted) break

      // Der Ordner, den wir selbst angelegt haben, taucht beim nächsten Lauf
      // als Unterordner auf und wird von `scan` ohnehin übersprungen — es
      // liest nur Dateien.
      const targetDir = join(dir, category)

      try {
        await mkdir(targetDir, { recursive: true })
      } catch {
        failed.push(category)
        continue
      }

      for (const file of list) {
        if (ctx.signal.aborted) break
        // Sicherheitshalber, auch wenn `scan` sie gar nicht erst aufnimmt:
        // ein Ordner, der so heißt wie eine Kategorie, darf nicht in sich
        // selbst wandern.
        if (OWN_FOLDERS.has(file.name)) continue

        const target = freeTarget(join(targetDir, file.name))
        try {
          await rename(file.path, target)
          moves.push({ from: file.path, to: target })
        } catch {
          // Meist eine Datei, die gerade offen ist. Der Rest läuft weiter.
          failed.push(file.name)
        }
      }
    }

    if (moves.length > 0) {
      await writeJournal({ at: Date.now(), folder, by: how, moves })
    }

    return {
      ordner: folder,
      verschoben: moves.length,
      neueOrdner: [...groups.keys()].length,
      übersprungen: failed.length,
      hinweis:
        (moves.length === 0
          ? 'Es wurde nichts verschoben. '
          : `Sag, wie viele Dateien in wie viele Ordner gewandert sind. `) +
        (failed.length > 0
          ? `${failed.length} Dateien waren belegt und blieben liegen — erwähn das kurz. `
          : '') +
        'Erwähne, dass sich das mit einem Wort rückgängig machen lässt.'
    }
  }
}) as ToolDefinition

const undo = defineTool({
  name: 'file_organize_undo',
  group: 'system',
  description:
    'Macht das letzte Aufräumen rückgängig und legt alle Dateien dorthin zurück, wo sie waren. ' +
    'Für "mach das wieder rückgängig" oder "so wollte ich das nicht".',
  schema: z.object({}),
  spokenHint: 'Ich stell das zurück.',
  async execute() {
    const journal = await readJournal()
    if (!journal || journal.moves.length === 0) {
      return { zurück: 0, hinweis: 'Es gibt kein Aufräumen, das ich rückgängig machen könnte.' }
    }

    const age = Date.now() - journal.at
    let restored = 0
    const missing: string[] = []

    for (const move of journal.moves) {
      if (!existsSync(move.to)) {
        // Der Nutzer hat die Datei inzwischen selbst angefasst. Dann gehört
        // sie ihm, nicht dem Journal.
        missing.push(basename(move.to))
        continue
      }
      try {
        await rename(move.to, freeTarget(move.from))
        restored++
      } catch {
        missing.push(basename(move.to))
      }
    }

    // Das Journal ist verbraucht — zweimal dasselbe zurückzulegen ergibt nichts.
    await writeFile(journalPath(), JSON.stringify({ ...journal, moves: [] }), 'utf-8').catch(
      () => undefined
    )

    return {
      zurück: restored,
      nichtGefunden: missing.length,
      ordner: journal.folder,
      alter: age < 3_600_000 ? 'von gerade eben' : 'von früher',
      hinweis:
        'Sag knapp, wie viele Dateien zurückgelegt wurden. Die leeren Unterordner bleiben stehen ' +
        '— erwähn das nur, wenn danach gefragt wird.'
    }
  }
}) as ToolDefinition

export const organizeTools: ToolDefinition[] = [preview, organize, undo]

/** Nur zum Testen. */
export const __internals = { categoryByType, categoryByMonth, worthMoving, groupByCategory }
