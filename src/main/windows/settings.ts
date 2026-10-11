import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { guardExternalLinks } from './external'

/**
 * Bewusst vom Kristall getrennt und nur über Tray oder Rechtsklick erreichbar.
 * Hier gibt es alles, was man nicht diktieren kann: API-Keys, Modellwahl,
 * Mikrofontest, Rechte-Matrix, Aktionslog, Kosten.
 */

let win: BrowserWindow | null = null

export function createSettingsWindow(section?: string): BrowserWindow {
  if (win && !win.isDestroyed()) {
    // Ein minimiertes Fenster bliebe bei `show()` in der Taskleiste liegen.
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    if (section) win.webContents.send('settings:navigate', section)
    return win
  }

  win = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 820,
    minHeight: 600,
    title: 'James-Jarvis — Einstellungen',
    backgroundColor: '#0B0420',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Auto-hide alone lets Alt reveal Electron's default application menu.
  win.setMenu(null)
  win.setMenuBarVisibility(false)

  win.on('ready-to-show', () => {
    win?.show()
  })
  win.on('closed', () => {
    win = null
  })

  guardExternalLinks(win.webContents)

  // Der gewünschte Abschnitt reist als Anker in der Adresse mit. Als Nachricht
  // nach `ready-to-show` kam er manchmal an, bevor React zuhörte — dann ging
  // „Aktionslog…" aus dem Tray-Menü wortlos auf der Zugangsseite auf.
  const hash = section ? encodeURIComponent(section) : undefined
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/settings.html${hash ? `#${hash}` : ''}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/settings.html'), hash ? { hash } : undefined)
  }

  return win
}

export function getSettingsWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null
}
