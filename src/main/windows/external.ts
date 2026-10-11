import { shell, type WebContents } from 'electron'

/**
 * Renderer dürfen Links an den Standardbrowser weiterreichen, aber niemals
 * beliebige Betriebssystem-Protokolle starten. Ein eingeschleustes `file:`,
 * `ms-settings:` oder anwendungsspezifisches Protokoll wäre sonst nur einen
 * Klick von einem Aufruf außerhalb der Electron-Sandbox entfernt.
 */
export function isSafeExternalUrl(raw: string): boolean {
  try {
    const protocol = new URL(raw).protocol
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * Ob ein Navigationsziel noch dieselbe Anwendung ist.
 *
 * Ohne diese Unterscheidung fängt der Riegel unten auch die eigenen Seiten ab.
 * Im Entwicklungsbetrieb lädt das Fenster von einem Vite-Server, und ein voller
 * Neuladevorgang zählt als Navigation — das Ergebnis wäre ein Fenster, das leer
 * bleibt, während sich `http://localhost:5173` im Systembrowser öffnet.
 *
 * Verglichen wird gegen die Seite, die gerade im Fenster steht, nicht gegen
 * eine feste Liste: Woher die Oberfläche kommt, entscheidet sich erst beim
 * Start (Vite-Server oder `out/renderer`), und beide Fälle sollen ohne eine
 * zweite Stelle auskommen, die davon weiß.
 *
 * `file:` braucht dabei einen eigenen Zweig. Solche Adressen haben in Chromium
 * allesamt den Ursprung `null` — ein Ursprungsvergleich würde in der gebauten
 * Fassung also jede Datei auf der Platte durchlassen, `System32` eingeschlossen.
 * Deshalb muss das Ziel im Ordner der aktuellen Seite liegen; `..` hat die
 * URL-Auflösung davor schon aufgelöst, es führt also nicht heraus.
 */
export function isInternalNavigation(target: string, current: string): boolean {
  let to: URL
  let from: URL
  try {
    to = new URL(target)
    from = new URL(current)
  } catch {
    return false
  }

  if (to.protocol !== from.protocol) return false

  if (to.protocol === 'file:') {
    // Windows-Pfade unterscheiden sich mitunter in der Groß-/Kleinschreibung
    // des Laufwerksbuchstabens; das Dateisystem darunter tut es nicht.
    const folder = from.pathname.slice(0, from.pathname.lastIndexOf('/') + 1).toLowerCase()
    return folder.length > 1 && to.pathname.toLowerCase().startsWith(folder)
  }

  return to.origin === from.origin && to.origin !== 'null'
}

async function openExternalUrl(url: string): Promise<void> {
  if (!isSafeExternalUrl(url)) {
    console.warn('[window] Unsicheres externes Link-Protokoll blockiert.')
    return
  }

  try {
    await shell.openExternal(url)
  } catch (error) {
    console.error('[window] Externer Link konnte nicht geöffnet werden:', error)
  }
}

/** Hält sowohl neue Fenster als auch Navigationen aus der App heraus. */
export function guardExternalLinks(webContents: WebContents): void {
  webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url)
    return { action: 'deny' }
  })

  webContents.on('will-navigate', (event, url) => {
    if (isInternalNavigation(url, webContents.getURL())) return
    event.preventDefault()
    void openExternalUrl(url)
  })
}
