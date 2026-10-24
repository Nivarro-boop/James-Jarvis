import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Settings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/config/defaults'
import { validateSettingsPatch } from '@shared/config/validation'

/**
 * Einstellungen als schlichte JSON-Datei — hier ist nichts geheim,
 * Keys liegen getrennt im Keystore.
 */

let current: Settings | null = null
const listeners = new Set<(s: Settings) => void>()

function filePath(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'settings.json')
}

/**
 * Tiefes Mergen, damit neue Default-Felder nach einem Update ergänzt werden.
 *
 * `undefined` heißt "nicht mitgeschickt" und lässt den Bestand stehen — darauf
 * beruht das Nachrüsten neuer Felder. `null` ist dagegen ein Wert und muss
 * durchkommen: Ein- und Ausgabegerät sind `string | null`, und null bedeutet
 * dort "Systemstandard". Solange beides gleich behandelt wurde, ließ sich ein
 * einmal gewähltes Mikrofon nie wieder auf den Systemstandard zurückstellen —
 * die Auswahl schickte brav null, und genau das wurde hier verworfen.
 */
function merge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base
  if (patch === null) return patch as T
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    return patch as T
  }
  if (typeof patch !== 'object' || Array.isArray(patch)) return base
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue
    if (Object.hasOwn(out, key)) {
      out[key] = merge(out[key], value)
    } else {
      out[key] = value
    }
  }
  return out as T
}

/**
 * Frische Standardwerte.
 *
 * Tief kopiert, nicht flach gespreizt. `{ ...DEFAULT_SETTINGS }` teilt die
 * verschachtelten Objekte — `audio`, `vad`, `wake` — mit der Konstante selbst.
 * Solange nur über `merge` geschrieben wird, geht das gut; ein einziger
 * direkter Zugriff der Art `getSettings().audio.outputGain = 2` würde dagegen
 * die Standardwerte des laufenden Prozesses dauerhaft verbiegen, und
 * "Zurücksetzen" stellte danach den verbogenen Stand wieder her.
 */
/** Voreinstellung bis 1.3.4; dort war die Function nie bereitgestellt. */
const LEGACY_REPORT_URLS = ['https://aimarketer-electronics.netlify.app/api/error-report', 'https://fastidious-pastelito-1f1564.netlify.app/api/error-report']

function freshDefaults(): Settings {
  return structuredClone(DEFAULT_SETTINGS)
}

export function getSettings(): Settings {
  if (current) return current
  const file = filePath()
  if (existsSync(file)) {
    try {
      const saved: unknown = JSON.parse(readFileSync(file, 'utf-8'))
      // Hermes gibt es nicht mehr: alte Wahl und alte Felder vor der Prüfung entfernen.
      if (saved && typeof saved === 'object') {
        const old = saved as { hermes?: unknown; speech?: { thinkProvider?: string } }
        delete old.hermes
        if (old.speech?.thinkProvider === 'hermes') old.speech.thinkProvider = 'chatgpt'
      }
      validateSettingsPatch(saved)
      current = merge(freshDefaults(), saved)
      // VibeVoice gibt es nicht mehr; die lokale Stimme ist piper.
      if ((current.speech.provider as string) === 'vibevoice') current.speech.provider = 'piper'
      // Der frühere Empfänger lief nie: Die Fehlerwebseite liegt auf dem
      // Host des Dashboards. Nur die alte Voreinstellung umstellen, eigene
      // Adressen bleiben.
      if (LEGACY_REPORT_URLS.includes(current.diagnosticReporting.url)) current.diagnosticReporting.url = DEFAULT_SETTINGS.diagnosticReporting.url
      // Einmalig beim Update, an dem der Standort-Schalter dazukam: Fehlerberichte
      // gehen ab jetzt standardmäßig automatisch an den eingetragenen Empfänger.
      // Abschalten unter Diagnose & Werkzeuge bleibt jederzeit möglich.
      if (saved && typeof saved === 'object' && !('useDeviceLocation' in saved)) {
        current.diagnosticReporting = { ...current.diagnosticReporting, enabled: true, automatic: true }
      }
    } catch (err) {
      console.error('[settings] Datei unlesbar, nutze Standardwerte:', err)
      // Die kaputte Datei beiseitelegen, bevor die nächste Änderung sie mit
      // den Standardwerten überschreibt — sonst ist mit ihr jede Chance weg,
      // die alten Einstellungen von Hand zu retten.
      try {
        copyFileSync(file, `${file}.defekt-${Date.now()}`)
      } catch {
        // Dann eben ohne Sicherung — starten muss die App trotzdem.
      }
      current = freshDefaults()
    }
  } else {
    current = freshDefaults()
  }
  return current
}

/**
 * Erst in eine Nebendatei schreiben, dann umbenennen.
 *
 * Direkt geschrieben stand nach einem Absturz oder Stromausfall mitten im
 * Schreiben eine halbe Datei da. Die war beim nächsten Start unlesbar, und
 * alle Einstellungen fielen auf die Standardwerte zurück. Das Umbenennen
 * ersetzt die Datei in einem Zug.
 */
function writeSettingsFile(settings: Settings): void {
  const file = filePath()
  const data = JSON.stringify(settings, null, 2)
  const temp = `${file}.tmp`
  try {
    writeFileSync(temp, data, 'utf-8')
    renameSync(temp, file)
  } catch (err) {
    // Preserve the last valid file and report failure rather than overwrite it.
    throw err
  }
}

/** Jeden Zuhörer einzeln absichern: Einer, der wirft, darf die anderen nicht aufhalten. */
function notify(settings: Settings): void {
  for (const fn of listeners) {
    try {
      fn(settings)
    } catch (err) {
      console.error('[settings] Ein Zuhörer auf Änderungen ist gescheitert:', err)
    }
  }
}

/**
 * "Standard" in der Rechte-Matrix ist die Abwesenheit eines Eintrags, kein
 * eigener Wert — das Auswahlfeld liefert dafür einen leeren String. Weil
 * `merge` Schlüssel nur setzen und nie entfernen kann, sammelten sich sonst
 * unbrauchbare Einträge in der Datei an. Ausgewertet wurden sie nie, aber sie
 * stehen im Widerspruch zum Typ und wachsen mit jedem Zurückstellen.
 */
function prunePermissions(settings: Settings): Settings {
  const cleaned: Settings['permissions'] = {}
  for (const [tool, value] of Object.entries(settings.permissions ?? {})) {
    if (value === 'allow' || value === 'ask' || value === 'deny') cleaned[tool] = value
  }
  settings.permissions = cleaned
  return settings
}

export function setSettings(patch: Partial<Settings>): Settings {
  validateSettingsPatch(patch)
  const next = prunePermissions(merge(getSettings(), patch))
  writeSettingsFile(next)
  current = next
  notify(next)
  return next
}

export function resetSettings(): Settings {
  const fresh = freshDefaults()
  writeSettingsFile(fresh)
  current = fresh
  notify(fresh)
  return fresh
}

export function onSettingsChanged(fn: (s: Settings) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
