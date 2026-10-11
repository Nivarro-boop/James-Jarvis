import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { PIPER, WHISPER } from '@shared/config/defaults'
import { resourceFile } from '../resources'
import type { Settings } from '@shared/types'

/**
 * Wo die lokalen Stücke liegen.
 *
 * Nicht in `resources/` neben dem Programm, sondern unter `userData`, und das
 * ist eine bewusste Trennung: In `resources/` gehört, was die App mitliefert
 * und was ein Update ersetzt. Ein Sprachmodell von einer halben Gigabyte gehört
 * dort nicht hin — es würde bei jedem Update erneut installiert und jeden
 * Installer aufblähen. Was der Nutzer selbst geholt hat, überlebt hier
 * stattdessen jedes Update.
 *
 * Alle Pfade in den Einstellungen dürfen leer sein und meinen dann genau diese
 * Orte. Ein eingetragener Pfad hat Vorrang — wer whisper schon woanders liegen
 * hat, soll es nicht ein zweites Mal laden müssen.
 */

/** `%APPDATA%/Void James/lokal/...`, bei Bedarf angelegt. */
export function localDir(...parts: string[]): string {
  const dir = join(app.getPath('userData'), 'lokal', ...parts)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Ein eingetragener Pfad schlägt den vorgesehenen.
 *
 * Der Rückgabewert sagt nicht, ob dort etwas liegt — nur, wo nachzusehen ist.
 * Das Prüfen gehört zur Gesundheitsauskunft, die daraus einen ganzen Satz
 * machen kann; ein `existsSync` an dieser Stelle könnte nur schweigen.
 */
function chosen(setting: string, fallback: string): string {
  return setting.trim() ? setting.trim() : fallback
}

export function whisperDir(settings: Settings): string {
  return chosen(settings.whisper.dir, localDir('whisper'))
}

export function whisperServerExe(settings: Settings): string {
  return join(whisperDir(settings), 'whisper-server.exe')
}

export function whisperModelPath(settings: Settings): string {
  return chosen(settings.whisper.modelPath, join(localDir('modelle'), WHISPER.defaultModel))
}

export function whisperVadPath(settings: Settings): string {
  return chosen(settings.whisper.vadModelPath, join(localDir('modelle'), WHISPER.vadFile))
}

export function piperDir(settings: Settings): string {
  return chosen(settings.piper.exeDir, localDir('piper'))
}

export function piperExe(settings: Settings): string {
  return join(piperDir(settings), 'piper.exe')
}

/**
 * espeak-ng-data liegt neben der ausführbaren Datei — sucht piper auch selbst
 * dort, aber nur relativ zu sich. In einer verpackten App steht die .exe
 * woanders als das Arbeitsverzeichnis, deshalb wird der Pfad immer ausdrücklich
 * übergeben statt auf das Suchen zu vertrauen.
 */
export function piperEspeakData(settings: Settings): string {
  return join(piperDir(settings), 'espeak-ng-data')
}

export function piperVoicePath(settings: Settings): string {
  return chosen(
    settings.piper.voicePath,
    join(localDir('stimmen'), `${PIPER.defaultVoice}.onnx`)
  )
}

/**
 * Der Wirt für die gepflegte piper-Fassung.
 *
 * Liegt bei den mitgelieferten Dateien und nicht unter `userData`: Er ist Teil
 * der App und soll mit ihr aktualisiert werden, anders als alles andere in
 * diesem Modul.
 */
export function piperHostScript(): string {
  return resourceFile('piper-host.py')
}

/** Nur der Dateiname, für Anzeigen. */
export function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return cut < 0 ? path : path.slice(cut + 1)
}
