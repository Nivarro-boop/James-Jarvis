import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { parseHealthSnapshot, type HealthSnapshot } from '@shared/health'

/**
 * Die zuletzt vom iPhone geschickten Gesundheitswerte.
 *
 * Gesundheitsdaten sind die empfindlichsten Daten, die James überhaupt sieht.
 * Deshalb verschlüsselt (DPAPI wie die Schlüssel), nur der letzte Stand, keine
 * Historie, und mit einem Knopf in den Einstellungen löschbar. Geht nirgendwo
 * hin außer in die Antwort, nach der der Nutzer gefragt hat.
 */

let cache: HealthSnapshot | null | undefined

function file(): string {
  const dir = join(app.getPath('userData'), 'secure')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'health.bin')
}

export function latestHealth(): HealthSnapshot | null {
  if (cache !== undefined) return cache
  cache = null
  const path = file()
  if (!existsSync(path)) return cache
  try {
    // Beim Lesen erneut prüfen: Die Datei könnte aus einer älteren Fassung stammen.
    cache = parseHealthSnapshot(JSON.parse(safeStorage.decryptString(readFileSync(path))), Date.now())
  } catch (err) {
    console.error('[health] Gespeicherte Werte nicht lesbar:', err)
  }
  return cache
}

/** Übernimmt einen geprüften Stand. Ältere Stände überschreiben keinen neueren. */
export function saveHealth(snapshot: HealthSnapshot): boolean {
  const current = latestHealth()
  if (current && current.takenAt > snapshot.takenAt) return false
  // Ohne Verschlüsselung lieber nur im Speicher halten als im Klartext ablegen.
  if (safeStorage.isEncryptionAvailable()) {
    const path = file()
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, safeStorage.encryptString(JSON.stringify(snapshot)), { mode: 0o600 })
      renameSync(temp, path)
    } finally {
      rmSync(temp, { force: true })
    }
  }
  cache = snapshot
  return true
}

export function clearHealth(): void {
  cache = null
  rmSync(file(), { force: true })
}
