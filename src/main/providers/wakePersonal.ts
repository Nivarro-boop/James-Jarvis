/**
 * Persönliches Weckwort, eingelernt wie bei Siri.
 *
 * Der Nutzer spricht sein Wort in der Einrichtung dreimal. Der Renderer macht
 * daraus mit den vorhandenen openWakeWord-Vorstufen (Mel, Embedding) je eine
 * kurze Folge von Merkmalsvektoren; hier werden nur diese Zahlen abgelegt,
 * keine Aufnahme. Erkannt wird später über die Ähnlichkeit zu diesen Mustern.
 * Ein eigens trainierter Klassifikator ist genauer, braucht aber Stunden auf
 * einer GPU — das hier ist in zehn Sekunden fertig.
 */
import { app } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const PERSONAL_MODEL = 'personal.onnx'

export interface PersonalWake {
  phrase: string
  /** Je Aufnahme eine Folge von Embeddings (Frames × 96). */
  templates: number[][][]
  /** Ab dieser mittleren Kosinus-Ähnlichkeit gilt das Wort als erkannt. */
  threshold: number
}

const file = (): string => join(app.getPath('userData'), 'wake-personal.json')

function valid(value: unknown): value is PersonalWake {
  if (!value || typeof value !== 'object') return false
  const v = value as PersonalWake
  return typeof v.phrase === 'string' && v.phrase.trim().length > 0 && v.phrase.length <= 40 &&
    typeof v.threshold === 'number' && v.threshold > 0 && v.threshold < 1 &&
    Array.isArray(v.templates) && v.templates.length >= 1 && v.templates.length <= 8 &&
    v.templates.every(t => Array.isArray(t) && t.length >= 4 && t.length <= 16 &&
      t.every(row => Array.isArray(row) && row.length === 96 && row.every(n => typeof n === 'number' && Number.isFinite(n))))
}

export function readPersonalWake(): PersonalWake | null {
  try {
    if (!existsSync(file())) return null
    const data: unknown = JSON.parse(readFileSync(file(), 'utf8'))
    return valid(data) ? data : null
  } catch {
    return null
  }
}

export function savePersonalWake(data: unknown): { ok: boolean; error?: string } {
  if (!valid(data)) return { ok: false, error: 'Aufnahmen unvollständig. Bitte noch einmal einsprechen.' }
  writeFileSync(file(), JSON.stringify({ phrase: data.phrase.trim(), templates: data.templates, threshold: data.threshold }))
  return { ok: true }
}

export function clearPersonalWake(): void {
  rmSync(file(), { force: true })
}
