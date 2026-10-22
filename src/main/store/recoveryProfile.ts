import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ARGUMENT = '--james-recovery-profile='

function directory(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Recovery-Pfad ist kein sicherer lokaler Ordner.')
}
function regularFile(path: string, maximumBytes: number): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximumBytes) throw new Error('Recovery-Datei fehlt, ist unsicher oder überschreitet das Größenlimit.')
}

/** Called by the FIRST startup import, before settings/database modules load.
 * Invalid recovery arguments fail closed; never silently open the normal profile.
 * No arbitrary user-data path is accepted from the command line.
 */
export function resolveRecoveryProfile(appData: string, args: readonly string[]): { id: string; directory: string } | null {
  const selected = args.filter(argument => argument.startsWith(ARGUMENT))
  if (args.includes('--james-recovery-profile') || selected.length > 1) throw new Error('Recovery-Profil muss genau einmal mit gültiger Kennung angegeben werden.')
  if (selected.length === 0) return null
  const id = selected[0].slice(ARGUMENT.length)
  if (!PROFILE_ID.test(id)) throw new Error('Ungültige Recovery-Profilkennung.')
  const root = join(appData, 'james-recovery-profiles')
  const profile = join(root, id)
  directory(root); directory(profile); directory(join(profile, 'data'))
  const markerFile = join(profile, '.james-recovery.json')
  regularFile(markerFile, 4096)
  const marker = JSON.parse(readFileSync(markerFile, 'utf8')) as Record<string, unknown>
  if (!marker || marker.format !== 'james-recovery-profile' || marker.version !== 1 || marker.id !== id || marker.safeMode !== true || typeof marker.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(marker.sourceDigest)) throw new Error('Recovery-Profilmarker ist ungültig; Start abgebrochen.')
  regularFile(join(profile, 'settings.json'), 1024 * 1024)
  regularFile(join(profile, 'data', 'jarvis.db'), 64 * 1024 * 1024)
  return { id, directory: profile }
}
