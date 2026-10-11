import { app } from 'electron'
import electronUpdater, { type NsisUpdater } from 'electron-updater'
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

/**
 * Beim Beenden aufrufen, unmittelbar vor `app.exit`.
 *
 * Startet den Installer still und ohne die App danach wieder zu öffnen — wer
 * beendet, will sie zu haben. Der Installer wartet, bis der Prozess weg ist.
 */
export function installPendingUpdate(): void {
  if (status.state !== 'ready') return
  try {
    console.info(`[update] Spiele ${status.version} beim Beenden ein.`)
    // Unter Windows ist der Updater ein NsisUpdater; nur dort gibt es `install`.
    ;(electronUpdater.autoUpdater as NsisUpdater).install(true, false)
  } catch (err) {
    console.warn('[update] Einspielen beim Beenden fehlgeschlagen:', err instanceof Error ? err.message : err)
  }
}
