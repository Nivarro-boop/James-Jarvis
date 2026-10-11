/**
 * Electron, so weit die Tests es brauchen.
 *
 * Die Werkzeugmodule hängen fast alle irgendwo an Electron — `app.getPath` für
 * den Ablageort, `shell.openExternal` zum Öffnen, `clipboard` fürs Einfügen.
 * Das ist kein Grund, sie ungetestet zu lassen: Geprüft wird hier, was die
 * Schemata und der Einheitenrechner tun, und davon fasst nichts Electron an.
 * Es muss sich nur importieren lassen.
 *
 * Ein echtes Electron ließe sich nicht laden — sein Node-Einstieg gibt bloß
 * den Pfad zur ausführbaren Datei zurück, die eigentliche Schnittstelle gibt
 * es nur im Electron-Prozess. Deshalb dieser Ersatz.
 *
 * CommonJS und nicht ESM, weil `register-electron.cjs` ihn aus einem
 * `require`-Haken heraus laden muss — und der läuft synchron.
 *
 * Alles, was hier fehlt, fällt beim Laden sofort auf, nicht erst mitten im
 * Test. Kommt ein Modul mit neuem Electron-Import dazu, gehört der Name hier
 * ergänzt.
 */
const noop = () => {}

/**
 * Ein Platzhalter, der jeden Zugriff überlebt.
 *
 * `Tray`, `Menu` und Verwandte werden auf Modulebene angefasst, teils
 * verkettet (`Menu.buildFromTemplate(...).popup()`). Ein einfaches `{}` bräche
 * dort beim Laden. Der Proxy gibt auf jeden Zugriff wieder sich selbst zurück
 * und lässt sich rufen und mit `new` bauen.
 */
const mk = (name) =>
  new Proxy(function () {}, {
    get(_t, prop) {
      // `then` muss undefined bleiben: Sonst hält `await` den Platzhalter für
      // ein Promise und wartet auf ein Einlösen, das nie kommt.
      if (prop === 'then') return undefined
      if (prop === Symbol.toPrimitive || prop === 'toString') return () => `stub:${name}`
      return mk(`${name}.${String(prop)}`)
    },
    apply: () => mk(`${name}()`),
    construct: () => mk(`new ${name}`)
  })

const app = {
  getPath: () => process.env.TEMP ?? '.',
  getAppPath: () => process.env.TEMP ?? '.',
  getName: () => 'void-jarvis',
  getVersion: () => '0.0.0-test',
  // `@electron-toolkit/utils` liest das beim Laden und leitet daraus `is.dev`
  // ab. Ohne den Wert bricht schon der Import.
  isPackaged: false,
  on: noop,
  whenReady: () => Promise.resolve(),
  setLoginItemSettings: noop,
  getLoginItemSettings: () => ({ openAtLogin: false })
}

const safeStorage = {
  // Falsch, und zwar mit Absicht: Der Keystore fällt dann auf "kein Schlüssel
  // vorhanden" zurück, statt zu versuchen, echte Zugangsdaten zu entschlüsseln.
  // Ein Test soll das Benutzerprofil nicht anfassen.
  isEncryptionAvailable: () => false,
  encryptString: (s) => Buffer.from(s),
  decryptString: (b) => b.toString()
}

module.exports = {
  app,
  safeStorage,
  clipboard: { readText: () => '', writeText: noop },
  ipcMain: { handle: noop, on: noop, removeHandler: noop },
  shell: { openExternal: noop, openPath: noop, showItemInFolder: noop },

  BrowserWindow: mk('BrowserWindow'),
  Menu: mk('Menu'),
  Notification: mk('Notification'),
  Tray: mk('Tray'),
  contextBridge: mk('contextBridge'),
  desktopCapturer: mk('desktopCapturer'),
  dialog: mk('dialog'),
  globalShortcut: mk('globalShortcut'),
  ipcRenderer: mk('ipcRenderer'),
  nativeImage: mk('nativeImage'),
  net: mk('net'),
  powerMonitor: mk('powerMonitor'),
  screen: mk('screen'),
  session: mk('session')
}
