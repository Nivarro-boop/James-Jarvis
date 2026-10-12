import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Fertigkeiten — Anleitungen, die James sich selbst schreibt.
 *
 * Die Idee stammt aus Hermes (Nous Research, MIT-Lizenz): Nach einer
 * Aufgabe, die mehrere Schritte gebraucht hat und wiederkommen kann, hält der
 * Agent fest, wie es ging. Beim nächsten Mal liest er die Anleitung, statt
 * den Weg neu zu suchen — und verbessert sie, wenn etwas anders lief.
 *
 * Eine Fertigkeit ist eine Markdown-Datei mit Kopfzeilen. Bewusst kein
 * Datenbankeintrag: Wer will, kann sie im Explorer öffnen, lesen, von Hand
 * berichtigen oder löschen, und sie überlebt jede Schemaänderung.
 *
 * Im System-Prompt stehen nur Name und Beschreibung. Den Inhalt holt James
 * sich mit `skill_view`, wenn er ihn braucht — zwanzig Anleitungen im Volltext
 * kosteten bei jeder Verbindung Tokens für Wissen, das meist nicht gebraucht wird.
 */

export interface Skill {
  slug: string
  name: string
  description: string
  steps: string
  /** auto = von der Lernschleife angelegt, manual = von James auf Zuruf. */
  source: 'auto' | 'manual'
  uses: number
  updated: string
}

const MAX_SKILLS = 200
const MAX_BODY = 6000

function dir(): string {
  const path = join(app.getPath('userData'), 'skills')
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
  return path
}

export function skillsDir(): string {
  return dir()
}

/** Dateiname aus dem Namen — Umlaute ausgeschrieben, sonst nur a–z, 0–9 und Bindestrich. */
export function skillSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || 'fertigkeit'
}

/** Eine Zeile Kopf: nur einzeilig, ohne Doppelpunkt-Fallen. */
function headerValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

export function serializeSkill(skill: Omit<Skill, 'slug'>): string {
  return [
    '---',
    `name: ${headerValue(skill.name)}`,
    `description: ${headerValue(skill.description)}`,
    `source: ${skill.source}`,
    `uses: ${skill.uses}`,
    `updated: ${skill.updated}`,
    '---',
    '',
    skill.steps.trim(),
    ''
  ].join('\n')
}

export function parseSkill(slug: string, text: string): Skill | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) return null
  const header: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at > 0) header[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  if (!header.name) return null
  return {
    slug,
    name: header.name,
    description: header.description ?? '',
    steps: match[2].trim(),
    source: header.source === 'auto' ? 'auto' : 'manual',
    uses: Number(header.uses) || 0,
    updated: header.updated ?? ''
  }
}

export function listSkills(): Skill[] {
  const folder = dir()
  const skills: Skill[] = []
  for (const file of readdirSync(folder)) {
    if (!file.endsWith('.md')) continue
    try {
      const skill = parseSkill(file.slice(0, -3), readFileSync(join(folder, file), 'utf-8'))
      if (skill) skills.push(skill)
    } catch {
      // Eine kaputte Datei darf die anderen nicht verdecken.
    }
  }
  return skills.sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name))
}

export function findSkill(nameOrSlug: string): Skill | null {
  const slug = skillSlug(nameOrSlug)
  const all = listSkills()
  return (
    all.find((s) => s.slug === slug) ??
    all.find((s) => s.name.toLowerCase() === nameOrSlug.toLowerCase()) ??
    null
  )
}

/** Lesen zählt als Benutzung — so wandern die nützlichen nach oben. */
export function useSkill(nameOrSlug: string): Skill | null {
  const skill = findSkill(nameOrSlug)
  if (!skill) return null
  const next = { ...skill, uses: skill.uses + 1 }
  writeFileSync(join(dir(), `${skill.slug}.md`), serializeSkill(next), 'utf-8')
  return next
}

export function saveSkill(input: {
  name: string
  description: string
  steps: string
  source: Skill['source']
}): { skill: Skill; created: boolean } {
  const name = input.name.trim()
  const description = input.description.trim()
  const steps = input.steps.trim()
  if (!name) throw new Error('Eine Fertigkeit braucht einen Namen.')
  if (!steps) throw new Error('Eine Fertigkeit ohne Schritte hilft beim nächsten Mal nicht.')
  if (steps.length > MAX_BODY) throw new Error(`Zu lang — höchstens ${MAX_BODY} Zeichen.`)

  const existing = findSkill(name)
  if (!existing && listSkills().length >= MAX_SKILLS) {
    throw new Error('Es sind schon zweihundert Fertigkeiten gespeichert. Erst eine alte löschen.')
  }
  const skill: Skill = {
    slug: existing?.slug ?? skillSlug(name),
    name,
    description,
    steps,
    // Eine von Hand bestätigte Fertigkeit bleibt „manual", auch wenn die
    // Lernschleife sie später verbessert.
    source: existing?.source === 'manual' ? 'manual' : input.source,
    uses: existing?.uses ?? 0,
    updated: new Date().toISOString().slice(0, 10)
  }
  writeFileSync(join(dir(), `${skill.slug}.md`), serializeSkill(skill), 'utf-8')
  return { skill, created: !existing }
}

/**
 * Gezielte Änderung wie Hermes' `skill_manage patch`: ersetzt genau eine
 * Stelle, statt die ganze Anleitung neu zu schreiben.
 */
export function patchSkill(nameOrSlug: string, oldText: string, newText: string): Skill {
  const skill = findSkill(nameOrSlug)
  if (!skill) throw new Error(`Keine Fertigkeit „${nameOrSlug}".`)
  if (!oldText) throw new Error('Die zu ersetzende Stelle fehlt.')
  const count = skill.steps.split(oldText).length - 1
  if (count === 0) throw new Error('Die Stelle steht so nicht in der Anleitung. Erst mit skill_view nachlesen.')
  if (count > 1) throw new Error('Die Stelle kommt mehrfach vor. Mehr Umgebung angeben.')
  return saveSkill({
    name: skill.name,
    description: skill.description,
    steps: skill.steps.replace(oldText, () => newText),
    source: skill.source
  }).skill
}

export function deleteSkill(nameOrSlug: string): boolean {
  const skill = findSkill(nameOrSlug)
  if (!skill) return false
  unlinkSync(join(dir(), `${skill.slug}.md`))
  return true
}

/** Der Abschnitt im System-Prompt: was es gibt, nicht wie es geht. */
export function skillIndexForPrompt(limit = 30): string {
  const skills = listSkills().slice(0, limit)
  if (skills.length === 0) return ''
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`)
  return [
    '',
    '## Deine Fertigkeiten',
    '',
    'Diese Anleitungen hast du dir bei früheren Aufgaben selbst geschrieben. Passt eine zur',
    'aktuellen Aufgabe, lies sie zuerst mit skill_view und folge ihr.',
    '',
    ...lines,
    ''
  ].join('\n')
}
