import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  buildGraph,
  parseProject,
  renderProject,
  slugify,
  type BrainGraph,
  type NoteDoc,
  type Project,
  type Widget
} from '@shared/brain'

/**
 * Wo das Gehirn auf der Platte liegt: Markdown-Dateien unter
 * `userData/gehirn`, lesbar mit jedem Editor und mit Obsidian.
 *
 * `projekte/` gehört James, er schreibt dort. `notizen/` gehört dem Nutzer;
 * James legt dort nur neue Dateien an und überschreibt keine fremden.
 */
export function brainDir(): string {
  const root = join(app.getPath('userData'), 'gehirn')
  for (const sub of ['projekte', 'notizen']) {
    const path = join(root, sub)
    if (!existsSync(path)) mkdirSync(path, { recursive: true })
  }
  return root
}

/** Schreibt erst daneben und benennt dann um — ein Absturz hinterlässt keine halbe Datei. */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

function projectPath(slug: string): string {
  return join(brainDir(), 'projekte', `${slug}.md`)
}

export function listProjects(): Project[] {
  const dir = join(brainDir(), 'projekte')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => parseProject(f.slice(0, -3), readFileSync(join(dir, f), 'utf8')))
    .sort((a, b) => b.updated.localeCompare(a.updated))
}

/** Findet ein Projekt über Slug oder einen Teil des Titels. */
export function findProject(name: string, exact = false): Project | undefined {
  const lower = name.toLowerCase().trim()
  if (!lower) throw new Error('Bitte einen eindeutigen Projektnamen angeben.')
  const all = listProjects()
  const slug = slugify(name)
  const identity = all.find((p) => p.slug === lower) ?? all.find((p) => p.title.toLowerCase() === lower)
  if (identity || exact) return identity
  const matches = all.filter((p) => p.title.toLowerCase().includes(lower) || p.slug.includes(slug))
  if (matches.length > 1) throw new Error(`Mehrere Projekte passen: ${matches.map(p => p.title).join(', ')}. Bitte den vollständigen Namen angeben.`)
  return matches[0]
}

export function saveProject(project: Project): Project {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(project.slug)) throw new Error('Ungültige Projektkennung.')
  const next = { ...project, updated: new Date().toISOString() }
  writeAtomic(projectPath(next.slug), renderProject(next))
  return next
}

export function createProject(title: string, stand = ''): Project {
  if (!title.trim() || title.length > 300) throw new Error('Projektname muss 1 bis 300 Zeichen haben.')
  let slug = slugify(title)
  for (let n = 2; existsSync(projectPath(slug)); n++) slug = `${slugify(title)}-${n}`
  return saveProject({ slug, title: title.trim(), status: 'aktiv', updated: '', stand, decisions: [], steps: [] })
}

/** Alle Markdown-Dateien des Gehirns, höchstens 2000, je höchstens 200 KB. */
export function readNotes(): (NoteDoc & { kind: 'projekt' | 'notiz'; title: string })[] {
  const root = brainDir()
  const out: (NoteDoc & { kind: 'projekt' | 'notiz'; title: string })[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || out.length >= 2000) return
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue
      const path = join(dir, name)
      const stat = statSync(path)
      if (stat.isDirectory()) walk(path, depth + 1)
      else if (name.toLowerCase().endsWith('.md') && stat.size <= 200_000) {
        const text = readFileSync(path, 'utf8')
        const file = relative(root, path).split(sep).join('/')
        const title = text.match(/^#\s+(.+)$/m)?.[1].trim() ?? name.replace(/\.md$/i, '')
        out.push({ file, text, title, kind: file.startsWith('projekte/') ? 'projekt' : 'notiz' })
      }
    }
  }
  walk(root, 0)
  return out
}

/** Legt eine neue Notiz an. Eine vorhandene Datei bleibt unangetastet. */
export function saveNote(title: string, text: string): string {
  let slug = slugify(title)
  const dir = join(brainDir(), 'notizen')
  for (let n = 2; existsSync(join(dir, `${slug}.md`)); n++) slug = `${slugify(title)}-${n}`
  writeAtomic(join(dir, `${slug}.md`), `# ${title.trim()}\n\n${text.trim()}\n`)
  return `notizen/${slug}.md`
}

export function brainGraph(): BrainGraph {
  return buildGraph(readNotes())
}

// ─── Widgets ────────────────────────────────────────────────────────────

const WIDGET_LIMIT = 12

function widgetsPath(): string {
  return join(brainDir(), 'widgets.json')
}

export function listWidgets(): Widget[] {
  try {
    const data = JSON.parse(readFileSync(widgetsPath(), 'utf8'))
    return Array.isArray(data) ? data.filter((w) => w && typeof w.id === 'string' && typeof w.title === 'string') : []
  } catch {
    return []
  }
}

export function setWidget(widget: Omit<Widget, 'updated'>): Widget[] {
  const rest = listWidgets().filter((w) => w.id !== widget.id)
  if (rest.length >= WIDGET_LIMIT) throw new Error(`Höchstens ${WIDGET_LIMIT} Kacheln. Entferne erst eine.`)
  const next = [...rest, { ...widget, updated: Date.now() }]
  writeAtomic(widgetsPath(), JSON.stringify(next, null, 2))
  return next
}

export function removeWidget(id: string): Widget[] {
  const next = listWidgets().filter((w) => w.id !== id)
  writeAtomic(widgetsPath(), JSON.stringify(next, null, 2))
  return next
}
