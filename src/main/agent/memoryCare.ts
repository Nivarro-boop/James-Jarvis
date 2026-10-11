import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { allMemoriesWithEmbeddings, deleteMemory, updateMemory } from '../db'
import { cosine, embed } from '../db/embeddings'
import { thinkText } from '../providers/text'
import { activityEnd, activityStart } from './activity'
import { getSettings } from '../store/settings'

/**
 * Gedächtnis-Pflege.
 *
 * Wie bei Hermes kuratiert der Agent sein Gedächtnis selbst. Über Monate
 * sammelt sich dasselbe in fünf Fassungen an — „Void streamt dienstags",
 * „Stream ist am Dienstag", „dienstags ist Streamtag" —, und jede davon
 * belegt einen der zwölf Plätze, die beim Sitzungsstart in den Prompt gehen.
 * Die Pflege fasst solche Gruppen zu einem Satz zusammen. Widersprüche löst
 * sie zugunsten des neueren Eintrags.
 *
 * Gelöscht wird nur, was in einen zusammengefassten Satz eingegangen ist.
 * Einzelne Erinnerungen ohne Doppelgänger bleiben unberührt.
 */

/** Ab dieser Ähnlichkeit gelten zwei Erinnerungen als Fassungen desselben. */
const SIMILAR = 0.88
const MAX_GROUPS = 15
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

interface Row {
  id: number
  text: string
  embedding: Float32Array | null
}

/** Gruppen ähnlicher Erinnerungen, jede mindestens zwei Einträge. */
export function similarGroups(rows: Row[], threshold = SIMILAR): Row[][] {
  const withVector = rows.filter((r) => r.embedding)
  const used = new Set<number>()
  const groups: Row[][] = []
  for (const row of withVector) {
    if (used.has(row.id)) continue
    const group = [row]
    for (const other of withVector) {
      if (other.id === row.id || used.has(other.id)) continue
      if (cosine(row.embedding!, other.embedding!) >= threshold) group.push(other)
    }
    if (group.length > 1) {
      group.forEach((g) => used.add(g.id))
      groups.push(group)
    }
  }
  return groups
}

export async function tidyMemories(): Promise<{ merged: number; removed: number }> {
  const id = randomUUID()
  activityStart({ id, label: 'Gedächtnis-Pflege — fasst doppelte Erinnerungen zusammen', source: 'learning' })
  try {
    const rows = allMemoriesWithEmbeddings() as Row[]
    // Neuere zuerst: Bei Widersprüchen gilt, was zuletzt gesagt wurde.
    rows.sort((a, b) => b.id - a.id)
    const groups = similarGroups(rows).slice(0, MAX_GROUPS)
    let merged = 0
    let removed = 0

    for (const group of groups) {
      const answer = await thinkText({
        system:
          'Fasse diese Erinnerungen eines persönlichen Assistenten zu genau einem Satz zusammen. ' +
          'Behalte jede Einzelheit. Widersprechen sie sich, gilt die zuerst genannte (sie ist die neueste). ' +
          'Antworte nur mit dem Satz.',
        user: group.map((g) => `- ${g.text}`).join('\n'),
        maxTokens: 200
      })
      const text = answer.text.trim().replace(/^[-•]\s*/, '')
      if (!text || text.length > 500) continue
      const [keep, ...rest] = group
      updateMemory(keep.id, text, await embed(text))
      for (const r of rest) deleteMemory(r.id)
      merged++
      removed += rest.length
    }

    activityEnd(id, true, merged > 0 ? `${merged} Gruppen zusammengefasst, ${removed} Doppelte entfernt.` : 'Nichts Doppeltes gefunden.')
    markTidied()
    return { merged, removed }
  } catch (err) {
    activityEnd(id, false, err instanceof Error ? err.message : String(err))
    throw err
  }
}

function stampFile(): string {
  return join(app.getPath('userData'), 'memory-tidy.json')
}

function markTidied(): void {
  try {
    writeFileSync(stampFile(), JSON.stringify({ at: Date.now() }), 'utf-8')
  } catch {
    // Dann eben beim nächsten Start noch einmal.
  }
}

/** Einmal pro Woche von selbst, zehn Minuten nach dem Start — nie mitten in den Start hinein. */
export function scheduleMemoryCare(): void {
  setTimeout(() => {
    // Explicit memory_tidy remains available; no unsolicited paid model calls in saver mode.
    if (getSettings().tokenSaver.enabled || getSettings().gamingMode) return
    let last = 0
    try {
      if (existsSync(stampFile())) last = JSON.parse(readFileSync(stampFile(), 'utf-8')).at ?? 0
    } catch {
      last = 0
    }
    if (Date.now() - last > WEEK_MS) void tidyMemories().catch(() => undefined)
  }, 10 * 60 * 1000).unref()
}
