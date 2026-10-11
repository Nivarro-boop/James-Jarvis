import { app, shell } from 'electron'
import { readdir, readFile, realpath, stat, writeFile, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'

/**
 * Dateien — suchen, lesen, schreiben, wegwerfen.
 *
 * Der Zuschnitt folgt dem, was gesprochen überhaupt vorkommt: "wo liegt noch
 * mal das Video von gestern", "lies mir die Notiz vor", "schreib das in eine
 * Datei". Kein Dateimanager, keine Rechteverwaltung, kein Umbenennen im
 * Dutzend — dafür würde niemand die Stimme benutzen.
 *
 * Zwei Grenzen sind eingebaut und nicht abschaltbar:
 *
 * Geschrieben wird ausschließlich in die eigenen Ordner des Nutzers. Ein Pfad
 * kommt hier gar nicht erst herein — das Werkzeug nimmt einen Ordnernamen aus
 * einer festen Liste und einen Dateinamen. Damit ist ein Schreibzugriff nach
 * C:\Windows nicht abgesichert, sondern schlicht nicht ausdrückbar.
 *
 * Gelöscht wird nur in den Papierkorb, nie endgültig — dieselbe Regel wie bei
 * Mails. Was weg ist, soll zurückholbar bleiben.
 */

/** Ordner, die James kennt. Alles andere gibt es für ihn nicht. */
const FOLDERS = {
  desktop: 'desktop',
  dokumente: 'documents',
  downloads: 'downloads',
  bilder: 'pictures',
  videos: 'videos',
  musik: 'music'
} as const

type FolderName = keyof typeof FOLDERS

function folderPath(name: FolderName): string {
  return app.getPath(FOLDERS[name])
}

/**
 * Was auch beim Lesen tabu bleibt.
 *
 * Der Nutzer könnte es selbst öffnen — es geht nicht um ihn, sondern darum,
 * dass so ein Inhalt sonst über die Sprachausgabe und den Modellkontext nach
 * draußen wandert. Der eigene Schlüsselspeicher steht bewusst mit drin.
 */
const SENSITIVE = [
  /\\secure\\/i,
  /secrets\.bin$/i,
  /google-tokens\.bin$/i,
  /\\\.ssh\\/i,
  /\\AppData\\Local\\Google\\Chrome\\User Data\\/i,
  // Die übrigen Chromium-Browser legen Passwörter und Cookies genauso ab.
  /\\AppData\\Local\\Microsoft\\Edge\\User Data\\/i,
  /\\AppData\\Local\\BraveSoftware\\/i,
  /\\AppData\\Roaming\\Opera Software\\/i,
  /\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\/i,
  // Windows' eigener Anmeldespeicher und die Schlüssel dazu.
  /\\AppData\\(Roaming|Local)\\Microsoft\\(Credentials|Protect|Vault)\\/i,
  /login ?data$/i,
  /key\d?\.db$/i,
  /logins\.json$/i,
  /\\Windows\\System32\\config\\/i,
  /\.pem$|\.pfx$|\.p12$|id_rsa/i,
  // Die Marke, mit der sich das Telefon als Fernbedienung anmeldet.
  /companion-token\.txt$/i,
  // Übliche Ablagen für Schlüssel in Entwicklerordnern.
  /\\\.env(\.[^\\]*)?$/i,
  /\\\.(aws|azure|kube)\\|\\\.docker\\config\.json$/i,
  /\.git-credentials$|\\\.npmrc$|\\\.pypirc$|\\gh\\hosts\.yml$/i,
  /\.kdbx?$/i
]

/**
 * Endungen, bei denen Windows' „Öffnen" ein Programm startet.
 *
 * Dazu gehören auch Verknüpfungen und Internetverknüpfungen: Sie zeigen auf
 * ein beliebiges Ziel samt Argumenten und sind damit nur ein Umweg zum Start.
 */
const EXECUTABLE =
  /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|msi|msp|msix|appx|appinstaller|scr|pif|cpl|jar|reg|lnk|url|appref-ms|library-ms|scf|inf|application|gadget|msc|diagcab|settingcontent-ms|xll|chm)$/i

function sensitive(path: string): boolean {
  return SENSITIVE.some((pattern) => pattern.test(path))
}

/**
 * Einen Pfad auflösen, aber nur auf dieser Platte.
 *
 * Netzwerkpfade (`\\rechner\freigabe`) werden abgewiesen, bevor irgendetwas
 * sie berührt: Schon die Frage, ob dort eine Datei liegt, meldet Windows beim
 * fremden Rechner an und schickt ihm dabei den Anmelde-Hash des Nutzers. Ein
 * solcher Pfad in einer Mail oder auf einer Webseite wäre sonst eine Falle,
 * die zuschnappt, sobald James ihn nachschlägt. Gerätepfade (`\\?\`, `\\.\`)
 * fallen gleich mit heraus.
 */
function localPath(path: string): string {
  const full = resolve(path)
  if (full.startsWith('\\\\') || full.startsWith('//')) {
    throw new Error('Netzwerkpfade fasse ich nicht an — nur Dateien auf diesem Rechner.')
  }
  return full
}

/**
 * Wohin der Pfad wirklich zeigt, und ob das Ziel erlaubt ist.
 *
 * `sensitive` prüft den Namen, den das Modell nennt. Eine Verknüpfung oder
 * Junction auf der eigenen Platte kann aber harmlos heißen und in den
 * Chrome-Profilordner zeigen — gelesen wird dann das Ziel, geprüft nur der
 * Name davor. Deshalb nach dem Auflösen noch einmal dieselben Prüfungen.
 */
async function realTarget(full: string, refusal: string): Promise<string> {
  const target = localPath(await realpath(full))
  if (sensitive(target)) throw new Error(refusal)
  return target
}

/** Ordner, die bei der Suche nichts beitragen und nur Zeit kosten. */
const SKIP_DIRS =
  /^(node_modules|\.git|\$recycle\.bin|system volume information|appdata|\.cache|__pycache__)$/i

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.log', '.json', '.yaml', '.yml', '.xml', '.csv',
  '.ini', '.cfg', '.conf', '.toml', '.ts', '.tsx', '.js', '.jsx', '.py', '.java',
  '.c', '.h', '.cpp', '.cs', '.go', '.rs', '.rb', '.php', '.sh', '.ps1', '.bat',
  '.html', '.css', '.scss', '.sql', '.properties', '.env', '.gitignore', '.srt', '.vtt'
])

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Byte`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Kilobyte`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} Megabyte`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} Gigabyte`
}

function humanAge(modified: Date): string {
  const days = Math.floor((Date.now() - modified.getTime()) / 86_400_000)
  if (days <= 0) return 'heute'
  if (days === 1) return 'gestern'
  if (days < 7) return `vor ${days} Tagen`
  if (days < 60) return `vor ${Math.round(days / 7)} Wochen`
  return `vor ${Math.round(days / 30)} Monaten`
}

// ─────────────────────────────────────────────────────────────

const findFile = defineTool({
  name: 'file_find',
  group: 'system',
  description:
    'Sucht eine Datei in den eigenen Ordnern nach einem Teil des Namens. Für "wo liegt das Video ' +
    'von gestern" oder "such mir die Rechnung". Liefert Pfade, mit denen file_read und open_path ' +
    'weiterarbeiten.',
  schema: z.object({
    query: z.string().describe('Teil des Dateinamens. Groß- und Kleinschreibung egal.'),
    folder: z
      .enum(['desktop', 'dokumente', 'downloads', 'bilder', 'videos', 'musik', 'alle'])
      .optional()
      .describe('Wo gesucht wird. Ohne Angabe überall.')
  }),
  async execute({ query, folder }) {
    const needle = query.toLowerCase().trim()
    if (needle.length < 2) throw new Error('Der Suchbegriff ist zu kurz.')

    const roots =
      !folder || folder === 'alle'
        ? (Object.keys(FOLDERS) as FolderName[]).map(folderPath)
        : [folderPath(folder)]

    // Zeitbudget statt Tiefenbegrenzung allein: ein voller Downloads-Ordner
    // kann sonst eine halbe Minute kosten, und so lange wartet niemand auf
    // eine gesprochene Antwort.
    const deadline = Date.now() + 4000
    const hits: { path: string; name: string; size: number; modified: Date }[] = []

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 4 || hits.length >= 25 || Date.now() > deadline) return

      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return // Kein Zugriff — kein Grund, die ganze Suche abzubrechen.
      }

      const subdirs: string[] = []
      for (const entry of entries) {
        if (entry.name.startsWith('.') || SKIP_DIRS.test(entry.name)) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          subdirs.push(full)
        } else if (entry.name.toLowerCase().includes(needle) && !sensitive(full)) {
          try {
            const info = await stat(full)
            hits.push({ path: full, name: entry.name, size: info.size, modified: info.mtime })
          } catch {
            // Datei war zwischenzeitlich weg.
          }
        }
      }

      for (const sub of subdirs) await walk(sub, depth + 1)
    }

    for (const root of roots) {
      if (existsSync(root)) await walk(root, 0)
    }

    // Das Neueste zuerst: gesucht wird fast immer etwas von kürzlich.
    hits.sort((a, b) => b.modified.getTime() - a.modified.getTime())

    if (hits.length === 0) {
      return { gefunden: 0, hinweis: `Nichts gefunden, das "${query}" im Namen hat.` }
    }

    return {
      gefunden: hits.length,
      dateien: hits.slice(0, 10).map((h) => ({
        name: h.name,
        pfad: h.path,
        größe: humanSize(h.size),
        geändert: humanAge(h.modified)
      })),
      hinweis:
        'Nenne dem Nutzer Namen und Alter, nicht den ganzen Pfad. Den Pfad brauchst nur du.'
    }
  }
}) as ToolDefinition

const readTextFile = defineTool({
  name: 'file_read',
  group: 'system',
  description:
    'Liest den Inhalt einer Textdatei, damit du daraus vorlesen oder etwas beantworten kannst. ' +
    'Den Pfad liefert file_find. Bilder, Videos und Programme kann es nicht lesen.',
  schema: z.object({
    path: z.string().describe('Vollständiger Pfad, wie ihn file_find geliefert hat.'),
    maxChars: z
      .number()
      .optional()
      .describe('Wie viele Zeichen höchstens, Standard achttausend.')
  }),
  async execute({ path, maxChars }) {
    const full = localPath(path)
    if (sensitive(full)) {
      throw new Error('Diese Datei rühre ich nicht an — dort stehen Zugangsdaten.')
    }
    if (!existsSync(full)) throw new Error('Die Datei gibt es nicht.')
    const target = await realTarget(full, 'Diese Datei rühre ich nicht an — dort stehen Zugangsdaten.')

    const info = await stat(target)
    if (info.isDirectory()) throw new Error('Das ist ein Ordner, keine Datei.')
    if (info.size > 5 * 1024 * 1024) {
      throw new Error(`Die Datei ist ${humanSize(info.size)} groß — zu viel zum Vorlesen.`)
    }

    const buffer = await readFile(target)
    // Nullbytes im ersten Kilobyte heißt: das ist nichts zum Lesen. Die
    // Endung allein reicht als Prüfung nicht, .dat kann alles sein.
    if (buffer.subarray(0, 1024).includes(0)) {
      throw new Error('Das ist keine Textdatei.')
    }

    const limit = Math.min(20_000, Math.max(200, maxChars ?? 8000))
    const text = buffer.toString('utf-8')
    const cut = text.length > limit

    return {
      datei: basename(full),
      inhalt: cut ? `${text.slice(0, limit)}…` : text,
      gekürzt: cut,
      zeichen: text.length,
      hinweis: cut
        ? 'Der Text ist gekürzt. Fass zusammen, statt vorzulesen, und sag dass er länger ist.'
        : 'Fass zusammen oder lies vor, je nachdem was gefragt war.'
    }
  }
}) as ToolDefinition

const writeTextFile = defineTool({
  name: 'file_write',
  group: 'system',
  description:
    'Schreibt Text in eine Datei in einem der eigenen Ordner. Für "schreib das in eine Datei" ' +
    'oder "leg mir eine Notiz an". Nur Text, keine Bilder.',
  schema: z.object({
    name: z.string().describe('Dateiname mit Endung, etwa "einkaufsliste.txt".'),
    content: z.string().describe('Was hineinsoll.'),
    folder: z
      .enum(['desktop', 'dokumente', 'downloads', 'bilder', 'videos', 'musik'])
      .optional()
      .describe('Welcher Ordner. Standard Dokumente.'),
    mode: z
      .enum(['neu', 'überschreiben', 'anhängen'])
      .optional()
      .describe('neu bricht ab, wenn es die Datei schon gibt. Standard neu.')
  }),
  async execute({ name, content, folder, mode }) {
    // Nur der reine Dateiname zählt. So kann aus "..\..\Windows\system32\x"
    // gar kein Ausbruch werden — es bleibt schlicht "x".
    const clean = basename(name).replace(/[<>:"|?*]/g, '').trim()
    if (!clean) throw new Error('Der Dateiname taugt nicht.')

    const extension = extname(clean).toLowerCase()
    if (extension && !TEXT_EXTENSIONS.has(extension)) {
      throw new Error(`${extension} ist keine Textendung. Ich schreibe nur Textdateien.`)
    }

    const dir = folderPath((folder ?? 'dokumente') as FolderName)
    const target = join(dir, extension ? clean : `${clean}.txt`)
    const how = mode ?? 'neu'

    if (how === 'neu' && existsSync(target)) {
      throw new Error(
        `${basename(target)} gibt es schon. Frag den Nutzer, ob überschrieben oder angehängt werden soll.`
      )
    }

    if (how === 'anhängen') {
      await appendFile(target, `\n${content}`, 'utf-8')
    } else {
      await writeFile(target, content, 'utf-8')
    }

    return {
      geschrieben: basename(target),
      ordner: folder ?? 'dokumente',
      zeichen: content.length,
      hinweis: 'Bestätige kurz mit dem Dateinamen und dem Ordner, ohne den ganzen Pfad.'
    }
  }
}) as ToolDefinition

const trashFile = defineTool({
  name: 'file_trash',
  group: 'system',
  description:
    'Legt eine Datei in den Papierkorb. Endgültig gelöscht wird nichts — aus dem Papierkorb ' +
    'lässt sich alles zurückholen.',
  schema: z.object({
    path: z.string().describe('Vollständiger Pfad, wie ihn file_find geliefert hat.')
  }),
  async execute({ path }) {
    const full = localPath(path)
    if (!existsSync(full)) throw new Error('Die Datei gibt es nicht.')
    if (sensitive(full)) throw new Error('An diese Datei gehe ich nicht.')

    // Der Papierkorb ist die einzige Löschstufe, die es gibt. shell.trashItem
    // wirft, wenn das Ziel nicht dorthin kann — etwa auf einem Netzlaufwerk.
    await shell.trashItem(full)
    return {
      papierkorb: basename(full),
      hinweis: 'Sag, dass es im Papierkorb liegt und zurückholbar ist.'
    }
  }
}) as ToolDefinition

const openPath = defineTool({
  name: 'open_path',
  group: 'system',
  description:
    'Öffnet eine Datei im passenden Programm oder zeigt sie im Explorer. Für "mach das auf" ' +
    'oder "zeig mir wo das liegt".',
  schema: z.object({
    path: z.string().describe('Vollständiger Pfad zur Datei oder zum Ordner.'),
    reveal: z
      .boolean()
      .optional()
      .describe('Statt zu öffnen im Explorer zeigen, mit der Datei markiert.')
  }),
  async execute({ path, reveal }) {
    const full = localPath(path)
    if (!existsSync(full)) throw new Error('Das gibt es nicht.')

    // Öffnen heißt bei diesen Endungen: ausführen. Das Werkzeug fragt nicht
    // nach, und der Pfad kann aus einer Mail oder Webseite stammen — ein
    // heruntergeladenes Programm liefe damit ohne ein einziges Ja. Zeigen im
    // Explorer bleibt erlaubt, starten muss der Nutzer selbst.
    if (!reveal && EXECUTABLE.test(full)) {
      throw new Error(
        'Programme und Skripte starte ich nicht über einen Pfad. Für bekannte Programme nimm ' +
          'open_app, sonst zeig die Datei mit reveal im Explorer, und der Nutzer startet sie selbst.'
      )
    }

    if (reveal) {
      shell.showItemInFolder(full)
      return { gezeigt: basename(full) }
    }

    const error = await shell.openPath(full)
    if (error) throw new Error(`Ließ sich nicht öffnen: ${error}`)
    return { geöffnet: basename(full) }
  }
}) as ToolDefinition

export const fileTools: ToolDefinition[] = [
  findFile,
  readTextFile,
  writeTextFile,
  trashFile,
  openPath
]
