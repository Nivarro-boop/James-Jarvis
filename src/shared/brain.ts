/**
 * Das Gehirn: Projekte, Notizen und was sich daraus rechnen lässt.
 *
 * Alles hier ist rein — keine Dateien, keine Uhr, kein Electron. Die
 * Hauptseite liest die Dateien und reicht Text herein; dadurch lässt sich jede
 * Regel prüfen, ohne einen Ordner anzulegen. Gerechnet wird hier, was ein
 * Sprachmodell gern schätzt: ob sich zwei Termine überschneiden, wo im Tag
 * eine Lücke ist, in welcher Zeile ein Wort steht.
 */

export interface TimedItem {
  title: string
  start: number
  end: number
  allDay?: boolean
}

/** Paare, die sich zeitlich überschneiden. Ganztägige zählen nicht. */
export function findConflicts(items: TimedItem[]): { a: string; b: string; from: number; to: number }[] {
  const timed = items.filter((i) => !i.allDay && i.end > i.start).sort((x, y) => x.start - y.start)
  const out: { a: string; b: string; from: number; to: number }[] = []
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length && timed[j].start < timed[i].end; j++) {
      out.push({ a: timed[i].title, b: timed[j].title, from: timed[j].start, to: Math.min(timed[i].end, timed[j].end) })
    }
  }
  return out
}

/** Freie Abschnitte zwischen `from` und `to`, mindestens `minMinutes` lang. */
export function freeSlots(items: TimedItem[], from: number, to: number, minMinutes = 15): { start: number; end: number }[] {
  const busy = items
    .filter((i) => !i.allDay && i.end > from && i.start < to)
    .map((i) => ({ start: Math.max(from, i.start), end: Math.min(to, i.end) }))
    .sort((a, b) => a.start - b.start)
  const slots: { start: number; end: number }[] = []
  let cursor = from
  for (const b of busy) {
    if (b.start - cursor >= minMinutes * 60_000) slots.push({ start: cursor, end: b.start })
    cursor = Math.max(cursor, b.end)
  }
  if (to - cursor >= minMinutes * 60_000) slots.push({ start: cursor, end: to })
  return slots
}

/**
 * Aufgaben der Reihe nach in freie Lücken legen. Was nicht passt, bleibt
 * übrig und wird genannt — gestrichen wird nichts.
 */
export function planTasks(
  slots: { start: number; end: number }[],
  tasks: { title: string; minutes: number }[]
): { placed: { title: string; start: number; end: number }[]; leftover: string[] } {
  const free = slots.map((s) => ({ ...s }))
  const placed: { title: string; start: number; end: number }[] = []
  const leftover: string[] = []
  for (const task of tasks) {
    const need = Math.max(5, task.minutes) * 60_000
    const slot = free.find((s) => s.end - s.start >= need)
    if (!slot) { leftover.push(task.title); continue }
    placed.push({ title: task.title, start: slot.start, end: slot.start + need })
    slot.start += need
  }
  return { placed, leftover }
}

export interface NoteDoc {
  /** Pfad relativ zum Gehirn-Ordner, mit Schrägstrichen. */
  file: string
  text: string
}

export interface NoteHit {
  file: string
  line: number
  text: string
  score: number
}

const STOP = new Set(['der', 'die', 'das', 'und', 'oder', 'ein', 'eine', 'ist', 'was', 'wie', 'wo', 'wer', 'mit', 'von', 'zu', 'im', 'in', 'am', 'an', 'auf', 'für', 'ich', 'du', 'mein', 'meine', 'hab', 'habe', 'den', 'dem', 'des'])

export function terms(query: string): string[] {
  return [...new Set(query.toLowerCase().normalize('NFC').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w)))]
}

/**
 * Zeilen, in denen die Suchbegriffe vorkommen, mit Datei und Zeilennummer.
 * Leere Liste heißt: steht nicht drin. Dann sagt James „finde ich nicht" und
 * rät nicht.
 */
export function searchNotes(docs: NoteDoc[], query: string, limit = 8): NoteHit[] {
  const words = terms(query)
  if (!words.length) return []
  const hits: NoteHit[] = []
  for (const doc of docs) {
    const lines = doc.text.split(/\r?\n/)
    const fileName = doc.file.toLowerCase()
    lines.forEach((raw, index) => {
      const line = raw.toLowerCase()
      const found = words.filter((w) => line.includes(w))
      if (!found.length) return
      const score = found.length / words.length + (found.length === words.length ? 1 : 0) +
        (words.some((w) => fileName.includes(w)) ? 0.25 : 0) + (/^#/.test(raw) ? 0.1 : 0)
      hits.push({ file: doc.file, line: index + 1, text: raw.trim().slice(0, 240), score })
    })
  }
  return hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line).slice(0, limit)
}

export function slugify(title: string): string {
  return title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'projekt'
}

// ─── Projekte ──────────────────────────────────────────────────────────

export interface Project {
  slug: string
  title: string
  status: 'aktiv' | 'abgeschlossen'
  updated: string
  stand: string
  decisions: { date: string; text: string; reason: string }[]
  steps: { done: boolean; text: string }[]
}

export function renderProject(p: Project): string {
  return [
    `# ${p.title}`,
    '',
    `Status: ${p.status}`,
    `Aktualisiert: ${p.updated}`,
    '',
    '## Stand',
    '',
    p.stand.trim() || '(noch nichts festgehalten)',
    '',
    '## Entscheidungen',
    '',
    ...(p.decisions.length ? p.decisions.map((d) => `- ${d.date}: ${d.text} — Grund: ${d.reason}`) : ['(keine)']),
    '',
    '## Nächste Schritte',
    '',
    ...(p.steps.length ? p.steps.map((s) => `- [${s.done ? 'x' : ' '}] ${s.text}`) : ['(keine)']),
    ''
  ].join('\n')
}

export function parseProject(slug: string, text: string): Project {
  const lines = text.split(/\r?\n/)
  const title = lines.find((l) => l.startsWith('# '))?.slice(2).trim() || slug
  const field = (name: string): string => lines.find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1).trim() ?? ''
  const section = (heading: string): string[] => {
    const start = lines.findIndex((l) => l.trim() === `## ${heading}`)
    if (start < 0) return []
    const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
    return lines.slice(start + 1, end < 0 ? undefined : end).filter((l) => l.trim() && l.trim() !== '(keine)')
  }
  const stand = section('Stand').filter((l) => l.trim() !== '(noch nichts festgehalten)').join('\n')
  const decisions = section('Entscheidungen').map((l) => {
    const m = l.match(/^-\s*([^:]+):\s*(.*?)(?:\s+—\s+Grund:\s*(.*))?$/)
    return m ? { date: m[1].trim(), text: m[2].trim(), reason: (m[3] ?? '').trim() } : null
  }).filter((d): d is Project['decisions'][number] => d !== null)
  const steps = section('Nächste Schritte').map((l) => {
    const m = l.match(/^-\s*\[( |x|X)\]\s*(.+)$/)
    return m ? { done: m[1] !== ' ', text: m[2].trim() } : null
  }).filter((s): s is Project['steps'][number] => s !== null)
  return { slug, title, status: field('Status') === 'abgeschlossen' ? 'abgeschlossen' : 'aktiv', updated: field('Aktualisiert'), stand, decisions, steps }
}

/**
 * Was der Aufräumer meldet. Er schlägt vor, er ändert nichts.
 * `now` kommt herein, damit die Regel ohne Uhr prüfbar bleibt.
 */
export function tidyFindings(projects: Project[], now: number, staleDays = 30): string[] {
  const out: string[] = []
  for (const p of projects) {
    if (p.status !== 'aktiv') continue
    const age = (now - Date.parse(p.updated)) / 86_400_000
    if (Number.isFinite(age) && age > staleDays) out.push(`„${p.title}“ wurde seit ${Math.floor(age)} Tagen nicht angefasst. Noch aktiv?`)
    if (!p.steps.some((s) => !s.done)) out.push(`„${p.title}“ hat keinen offenen nächsten Schritt.`)
    if (p.steps.length && p.steps.every((s) => s.done)) out.push(`Bei „${p.title}“ sind alle Schritte erledigt. Abschließen?`)
    const seen = new Set<string>()
    for (const s of p.steps) {
      const key = s.text.toLowerCase()
      if (seen.has(key)) out.push(`„${p.title}“ hat den Schritt „${s.text}“ doppelt.`)
      seen.add(key)
    }
  }
  const active = projects.filter((p) => p.status === 'aktiv')
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = new Set(terms(active[i].title)); const b = terms(active[j].title)
      if (b.length && b.filter((w) => a.has(w)).length / Math.max(a.size, b.length) >= 0.6) {
        out.push(`„${active[i].title}“ und „${active[j].title}“ sehen nach demselben Projekt aus.`)
      }
    }
  }
  return out
}

// ─── Karte ──────────────────────────────────────────────────────────────

export interface GraphNode { id: string; label: string; kind: 'projekt' | 'notiz' }
export interface BrainGraph { nodes: GraphNode[]; links: { source: string; target: string }[] }

/**
 * Verbindungen zwischen Notizen: ausdrückliche [[Verweise]] und gemeinsame
 * #Schlagworte. Mehr nicht — eine Karte, die Ähnlichkeit rät, zeigt Linien,
 * die niemand gezogen hat.
 */
export function buildGraph(docs: (NoteDoc & { kind: GraphNode['kind']; title: string })[]): BrainGraph {
  const nodes = docs.map((d) => ({ id: d.file, label: d.title, kind: d.kind }))
  const byName = new Map<string, string>()
  for (const d of docs) {
    byName.set(d.title.toLowerCase(), d.file)
    byName.set(d.file.replace(/^.*\//, '').replace(/\.md$/i, '').toLowerCase(), d.file)
  }
  const links = new Map<string, { source: string; target: string }>()
  const add = (a: string, b: string): void => {
    if (a === b) return
    const [s, t] = a < b ? [a, b] : [b, a]
    links.set(`${s}\u0000${t}`, { source: s, target: t })
  }
  const tags = new Map<string, string[]>()
  for (const d of docs) {
    for (const m of d.text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
      const target = byName.get(m[1].trim().toLowerCase())
      if (target) add(d.file, target)
    }
    for (const m of new Set([...d.text.matchAll(/(?:^|\s)#([\p{L}][\p{L}\p{N}_-]+)/gu)].map((x) => x[1].toLowerCase()))) {
      tags.set(m, [...(tags.get(m) ?? []), d.file])
    }
  }
  for (const files of tags.values()) {
    if (files.length > 12) continue
    for (let i = 0; i < files.length; i++) for (let j = i + 1; j < files.length; j++) add(files[i], files[j])
  }
  return { nodes, links: [...links.values()] }
}

// ─── Widgets ────────────────────────────────────────────────────────────

/** Eine Kachel auf der Startseite. Nur Text — kein HTML, kein Skript. */
export interface Widget {
  id: string
  title: string
  value: string
  items?: string[]
  updated: number
}
