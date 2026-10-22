import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '@shared/types'
import { broadcast } from './ipc/emit'

/**
 * Automatische Updates über GitHub Releases.
 *
 * Die Installer liegen in einem eigenen, öffentlichen Repo, in dem nur die
 * Releases stehen — der Quellcode bleibt privat. Ein privates Release-Repo
 * bräuchte ein Token in der App, und das könnte jeder Käufer auslesen.
 *
 * Beim Start (und danach alle sechs Stunden) wird nachgesehen. Gibt es eine
 * höhere Version, lädt sie sofort im Hintergrund, und die Startseite zeigt
 * das an. Ist sie geladen, zählt die Startseite herunter und spielt sie ein,
 * sobald James gerade nichts tut — mit „Später" wird stattdessen beim
 * Beenden eingespielt. In der Entwicklung (`npm run dev`) passiert nichts.
 */

const SIX_HOURS = 6 * 60 * 60 * 1000

let status: UpdateStatus = { state: 'idle', current: app.getVersion() }
let lastProgressAt = 0
let started = false

function publish(next: Partial<UpdateStatus>): void {
  status = { ...status, ...next }
  broadcast('update:status', status)
}

export function updateStatus(): UpdateStatus {
  return status
}

export function startAutoUpdate(): void {
  if (!app.isPackaged || started) return
  started = true
  const { autoUpdater } = electronUpdater
  autoUpdater.autoDownload = true
  // Das Einspielen beim Beenden übernimmt `installPendingUpdate`. Der eigene
  // Weg von electron-updater hängt am `quit`-Ereignis, und das feuert nicht:
  // Die App beendet sich nach dem Aufräumen mit `app.exit`, und genau dabei
  // lässt Electron `quit` aus. Geladene Updates blieben deshalb liegen.
  autoUpdater.autoInstallOnAppQuit = false
  // Ohne eigenen Logger schreibt electron-updater jeden Fehlschlag mit
  // Stapel als [error] ins Protokoll — die Selbstheilung hielt „noch keine
  // Version veröffentlicht" oder „kein Netz" dann bei jedem Start für einen
  // Systemdefekt. Gemeldet wird einmal, als Warnung, über das 'error'-Ereignis.
  autoUpdater.logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined
  }
  autoUpdater.on('checking-for-update', () => {
    if (status.state === 'idle' || status.state === 'error') publish({ state: 'checking', error: undefined })
  })
  autoUpdater.on('update-not-available', () => {
    if (status.state === 'checking') publish({ state: 'idle' })
  })
  autoUpdater.on('update-available', (info) => {
    console.info(`[update] Version ${info.version} gefunden, lade herunter.`)
    lastProgressAt = 0
    publish({ state: 'downloading', version: info.version, percent: 0, error: undefined, postponed: false })
  })
  autoUpdater.on('download-progress', (progress) => {
    // Höchstens zweimal pro Sekunde — die Startseite braucht keine 60 Bilder.
    if (Date.now() - lastProgressAt < 500) return
    lastProgressAt = Date.now()
    publish({ state: 'downloading', percent: Math.round(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    console.info(`[update] Version ${info.version} ist geladen.`)
    publish({ state: 'ready', version: info.version, percent: 100, error: undefined })
  })
  autoUpdater.on('error', (err) => {
    console.warn('[update] fehlgeschlagen:', err.message)
    // Ein bereits geladenes Update bleibt gültig, auch wenn die nächste Prüfung scheitert.
    if (status.state !== 'ready') publish({ state: 'error', error: err.message })
  })
  const check = (): void => {
    // Ohne Netz oder bei GitHub-Aussetzern einfach beim nächsten Mal.
    if (status.state === 'downloading' || status.state === 'ready' || status.state === 'installing') return
    autoUpdater.checkForUpdates().catch(() => undefined)
  }
  check()
  setInterval(check, SIX_HOURS).unref()
}

/** Jetzt einspielen und James danach wieder starten. */
export function installUpdateNow(): boolean {
  if (status.state !== 'ready') return false
  console.info(`[update] Spiele ${status.version} ein und starte neu.`)
  publish({ state: 'installing' })
  try {
    electronUpdater.autoUpdater.quitAndInstall(true, true)
    return true
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.warn('[update] Einspielen fehlgeschlagen:', error)
    publish({ state: 'ready', error, postponed: true })
    return false
  }
}

/** „Später": nicht mehr herunterzählen, sondern beim Beenden einspielen. */
export function postponeUpdate(): void {
  if (status.state === 'ready') publish({ postponed: true })
}

type PendingUpdateInstaller = {
  quitAndInstall: () => void
  install?: (isSilent?: boolean, isForceRunAfter?: boolean) => boolean
}

/** Leitet Windows still an NSIS weiter; macOS braucht den nativen Squirrel-Handoff. */
export function installPendingUpdateForPlatform(
  updater: PendingUpdateInstaller,
  platform: NodeJS.Platform
): void {
  if (platform === 'win32') {
    if (!updater.install) throw new Error('NSIS-Installer nicht verfügbar')
    updater.install(true, false)
    return
  }
  updater.quitAndInstall()
}

/**
 * Beim Beenden aufrufen, unmittelbar vor `app.exit`.
 *
 * Windows installiert still ohne Neustart. macOS übergibt an Squirrel; dessen
 * quitAndInstall kann die App nach der Installation erneut starten.
 */
export function installPendingUpdate(): boolean {
  if (status.state !== 'ready') return false
  const updater = electronUpdater.autoUpdater
  const onMacHandoffError = (): void => app.exit(0)
  if (process.platform === 'darwin') updater.once('error', onMacHandoffError)
  try {
    console.info(`[update] Spiele ${status.version} beim Beenden ein.`)
    // NSIS hat eine stille `install`-Methode; der macOS-Updater muss über
    // quitAndInstall an Squirrel übergeben werden. `install` gibt es dort nicht.
    installPendingUpdateForPlatform(
      updater as PendingUpdateInstaller,
      process.platform
    )
    // MacUpdater kann erst nach dem nativen Download das Beenden anstoßen.
    // Der Aufrufer darf app.exit deshalb nicht sofort ausführen.
    return process.platform === 'darwin'
  } catch (err) {
    if (process.platform === 'darwin') updater.removeListener('error', onMacHandoffError)
    console.warn('[update] Einspielen beim Beenden fehlgeschlagen:', err instanceof Error ? err.message : err)
    return false
  }
}
