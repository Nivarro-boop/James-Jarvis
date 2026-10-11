import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Findet eine Datei aus `resources/`.
 *
 * Sie liegt an zwei verschiedenen Orten, je nachdem wie die App läuft:
 * im Paket neben der ausführbaren Datei (`process.resourcesPath`, dort landet
 * alles aus `extraResources`), in der Entwicklung schlicht im Projektordner.
 * Ins asar-Archiv gehört nichts davon — PowerShell kann daraus nicht lesen,
 * und ein Tray-Symbol aus einem Archiv zu ziehen lohnt die Umstände nicht.
 *
 * Wichtig: Was hier gesucht wird, muss auch in `electron-builder.yml` unter
 * `extraResources` stehen. Sonst fällt es erst im fertigen Installer auf.
 */
export function resourceFile(name: string): string {
  const packaged = join(process.resourcesPath ?? '', name)
  if (existsSync(packaged)) return packaged
  return join(app.getAppPath(), 'resources', name)
}
