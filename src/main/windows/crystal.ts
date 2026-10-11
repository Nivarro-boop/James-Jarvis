import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { guardExternalLinks } from './external'

/**
 * Das Hauptfenster mit der Startseite. Der End Crystal sitzt darin —
 * weiterhin kein Chat, kein Textfeld, keine Nachrichtenliste.
 *
 * Bewusst ein gewöhnliches Fenster mit Rahmen: verschoben und geschlossen
 * wird über die Titelleiste von Windows, nicht über eine Drag-Region im
 * Renderer. "Immer im Vordergrund" bleibt über den Tray erreichbar.
 */

let win: BrowserWindow | null = null

const WIDTH = 900
const HEIGHT = 640
const MIN_WIDTH = 520
const MIN_HEIGHT = 480

export function createCrystalWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) {
    forceVisible(win)
    return win
  }

  const display = screen.getPrimaryDisplay()
  const { width, height } = display.workAreaSize

  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    x: Math.round((width - WIDTH) / 2),
    y: Math.round((height - HEIGHT) / 2),
    backgroundColor: '#0B0420',
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    skipTaskbar: false,
    autoHideMenuBar: true,
    title: 'James-Jarvis',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Nötig, damit getUserMedia ohne erneute Nachfrage an das Gerät kommt.
      backgroundThrottling: false
    }
  })

  // Remove the menu itself so pressing Alt cannot reveal a blank menu strip.
  win.setMenu(null)
  win.setMenuBarVisibility(false)

  // Der Kristall soll auch dann weiterlaufen, wenn das Fenster nicht fokussiert
  // ist — sonst friert die Animation ein, sobald du in Minecraft klickst.
  win.webContents.setBackgroundThrottling(false)

  // Beim Autostart mit Windows bleibt das Fenster zu. Wer sich anmeldet, will
  // einen mitlaufenden Assistenten, kein Fenster, das ihm entgegenspringt —
  // erreichbar bleibt er über Weckwort, Hotkey und das Symbol im Infobereich.
  //
  // Erkannt am Argument, nicht an `wasOpenedAsHidden`: das Feld füllt Electron
  // nur unter macOS. Der Eintrag im Autostart setzt `--hidden` deshalb selbst.
  const startHidden = process.argv.includes('--hidden')

  /**
   * Zeigen, und zwar über drei Wege statt über einen.
   *
   * `ready-to-show` gilt als der saubere Weg — es feuert nach dem ersten
   * Anstrich, und genau deshalb bleibt das Fenster damit manchmal für immer
   * unsichtbar: Ein Fenster mit `show: false` wird nicht zusammengesetzt, und
   * was nicht zusammengesetzt wird, streicht auch nichts an. Beobachtet auf
   * genau diesem Rechner — fünf Electron-Prozesse, das Fenster im
   * Fensterbaum vorhanden, der Renderer verbunden, React gemountet, und
   * trotzdem kein Bild. Für den Benutzer sieht das aus, als sei die App
   * abgestürzt.
   *
   * Deshalb drei Auslöser, von denen jeder allein genügt: der reguläre, das
   * fertig geladene Dokument, und eine Frist als letzte Sicherung. `show()`
   * ist ungefährlich mehrfach aufzurufen, ein Wächter verhindert nur, dass
   * ein zwischenzeitliches Verstecken wieder aufgehoben wird.
   *
   * Nachtrag, nach demselben Fehler ein zweites Mal: Drei Auslöser helfen
   * nichts, wenn nicht der Auslöser fehlt, sondern `show()` selbst wirkungslos
   * bleibt. Genau so war es — alle drei liefen, `isVisible()` blieb falsch, und
   * `IsWindowVisible` von Windows sagte dasselbe. Deshalb wird jetzt
   * nachgesehen statt vertraut: Nach dem Zeigen wird geprüft, ob das Fenster
   * auch wirklich sichtbar ist, und wenn nicht, über den Umweg gegangen. Ein
   * `restore()` auf ein nicht minimiertes Fenster ist folgenlos, `showInactive()`
   * nimmt einen anderen Pfad in Electron als `show()`, und beides zusammen hat
   * hier gegriffen.
   */
  let shown = false
  const showOnce = (): void => {
    if (shown || startHidden) return
    shown = true
    if (fallbackTimer) clearTimeout(fallbackTimer)
    fallbackTimer = null
    forceVisible(win)
  }

  let fallbackTimer: NodeJS.Timeout | null = setTimeout(showOnce, 4000)
  fallbackTimer.unref?.()

  win.on('ready-to-show', showOnce)
  win.webContents.on('did-finish-load', showOnce)
  win.on('closed', () => {
    if (fallbackTimer) clearTimeout(fallbackTimer)
    fallbackTimer = null
    win = null
  })

  // Ohne diese Weiterleitung ist der Renderer eine Blackbox: Fehler in
  // Shadern, Audio-Worklets oder der Live-Verbindung landen sonst nur in
  // den Entwicklerwerkzeugen, die im Betrieb niemand offen hat.
  // Die Stufe kommt als Wort und nicht mehr als Zahl.
  //
  // Bis Electron 43 trug dieser Rückruf seine Angaben einzeln nach: (_event,
  // level, message, line, sourceId), mit level als 0 bis 3. Das ist seit 43
  // veraltet und meldet sich bei jedem Start als Warnung. Beides zusammen
  // stehen zu lassen wäre besonders ungünstig, weil der alte Weg nicht
  // krachend ausfällt, sondern leise: Sobald die Positionsargumente
  // verschwinden, ist `level` undefined, `['debug',…][undefined]` ergibt
  // nichts, und der Vergleich `level === 3` trifft nie mehr. Jede
  // Renderer-Meldung liefe dann als "[renderer:log]" über console.log —
  // Fehler eingeschlossen, und das ist genau der Zustand, gegen den der
  // Kommentar unten geschrieben wurde.
  win.webContents.on('console-message', ({ level, message, lineNumber, sourceId }) => {
    // Electron nennt die mittlere Stufe "warning", im Protokoll steht "warn".
    const tag = level === 'warning' ? 'warn' : level
    const where = sourceId ? ` (${sourceId.split('/').pop()}:${lineNumber})` : ''
    // Die Stufe mitnehmen, statt alles über console.log zu schicken: Seit die
    // Konsole in eine Datei mitschreibt, steht sie dort in eckigen Klammern
    // vorn — und ein Renderer-Fehler, der als "[info]" protokolliert wird,
    // ist genau die Zeile, die man beim Suchen nach Fehlern übersieht.
    const write =
      level === 'error' ? console.error : level === 'warning' ? console.warn : console.log
    write(`[renderer:${tag}]${where} ${message}`)
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer] Prozess beendet:', details.reason, details.exitCode)
  })

  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[preload] Fehler in', preloadPath, error)
  })

  // Externe Links nie im App-Fenster öffnen und nur Web-Protokolle an das
  // Betriebssystem weiterreichen.
  guardExternalLinks(win.webContents)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/crystal.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/crystal.html'))
  }

  return win
}

/**
 * Zeigen und nachsehen, ob es geklappt hat.
 *
 * `show()` meldet keinen Fehler, wenn es nichts bewirkt — das ist der Grund,
 * warum der Fehler zweimal durchgerutscht ist. Also wird der Erfolg geprüft und
 * bei Bedarf ein zweiter und dritter Weg genommen. Der Abstand dazwischen ist
 * nicht Zierde: Die Fensterverwaltung von Windows verarbeitet den Aufruf
 * asynchron, und ein sofortiges `isVisible()` läse den Zustand von vorher.
 *
 * Bleibt es auch danach unsichtbar, steht das im Protokoll. Ein Fenster, das
 * niemand sieht und über das niemand etwas erfährt, sieht aus wie ein Absturz.
 */
function forceVisible(target: BrowserWindow | null, attempt = 0): void {
  if (!target || target.isDestroyed()) return

  if (attempt === 0) {
    target.show()
    target.focus()
  } else if (attempt === 1) {
    target.restore()
    target.showInactive()
    target.focus()
  } else {
    // Der letzte Griff: einmal ganz nach oben und gleich wieder zurück. Das
    // zwingt Windows, die Sichtbarkeit neu zu bewerten.
    target.setAlwaysOnTop(true, 'floating')
    target.show()
    target.setAlwaysOnTop(false)
  }

  if (attempt >= 2) {
    if (!target.isVisible()) {
      console.error('[crystal] Fenster bleibt unsichtbar — weder show() noch die Umwege greifen.')
    }
    return
  }

  setTimeout(() => {
    if (!target.isDestroyed() && !target.isVisible()) {
      console.warn(`[crystal] show() hat nichts bewirkt, Versuch ${attempt + 2}`)
      forceVisible(target, attempt + 1)
    }
  }, 300)
}

export function getCrystalWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null
}

export function setAlwaysOnTop(value: boolean): void {
  win?.setAlwaysOnTop(value, 'floating')
}

export function toggleCrystalVisibility(): void {
  if (!win || win.isDestroyed()) {
    createCrystalWindow()
    return
  }
  if (win.isVisible() && win.isFocused()) {
    win.hide()
  } else {
    // Derselbe Weg wie beim Start — auch der Hotkey soll nicht wirkungslos
    // bleiben, wenn `show()` gerade nicht durchgeht.
    forceVisible(win)
  }
}
