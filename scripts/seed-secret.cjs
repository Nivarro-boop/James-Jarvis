const { app, safeStorage } = require('electron')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

/**
 * Einen Schlüssel in den verschlüsselten Speicher legen, ohne die App zu öffnen.
 *
 *   npx electron scripts/seed-secret.cjs elevenlabs sk_…
 *
 * Warum es dieses Werkzeug gibt: `safeStorage` verschlüsselt unter Windows über
 * DPAPI, und daran kommt nur ein laufender Electron-Prozess. Ein gewöhnliches
 * Node-Skript könnte die Datei nicht einmal lesen. Der übliche Weg bleibt das
 * Einstellungsfenster — das hier ist für den Fall, dass ein Schlüssel schon
 * vorliegt und nicht abgetippt werden soll.
 *
 * Der Wert steht ausdrücklich nicht in dieser Datei, sondern kommt als
 * Argument. Eine Datei im Projektordner landet früher oder später in einem
 * Commit; ein Argument nicht.
 *
 * CommonJS, nicht ESM: Die package.json dieses Projekts führt bewusst kein
 * `"type"`, und Electron als Startprogramm für eine einzelne Datei ist bei der
 * Frage, was es da lädt, empfindlicher als Node. Beim ESM-Anlauf blieb der
 * Prozess ohne eine Zeile Ausgabe stehen.
 */

const ALLOWED = [
  'gemini',
  'elevenlabs',
  'openrouter',
  'higgsfield',
  'twitchClientId',
  'twitchClientSecret',
  'googleOAuthClientId',
  'googleOAuthClientSecret'
]

const [key, value] = process.argv.slice(2)

/**
 * Ausgabe über eine Datei, nicht über die Konsole.
 *
 * Electron ist unter Windows ein Fensterprogramm und hängt sich nicht an die
 * Konsole, von der es gestartet wurde — `console.info` verschwindet dort
 * spurlos. Der Bericht landet deshalb neben dem Skript und wird vom Aufrufer
 * gelesen.
 */
const REPORT = join(__dirname, '..', 'seed-secret.log')

function report(message) {
  try {
    writeFileSync(REPORT, `${message}\n`, 'utf-8')
  } catch {
    // Dann eben nicht — der Rückgabewert trägt die Wahrheit ohnehin auch.
  }
}

function done(code, message) {
  report(message)
  app.exit(code)
}

/**
 * Vor allem anderen: derselbe `userData`-Ordner wie die App.
 *
 * Das ist die Stelle, an der der erste Anlauf gescheitert ist, und der Grund
 * ist unerwartet. `safeStorage` verschlüsselt unter Windows nicht direkt mit
 * DPAPI — es legt einen zufälligen Schlüssel an, sichert *den* mit DPAPI und
 * bewahrt ihn in der Datei `Local State` innerhalb von `userData` auf. Wer mit
 * einem anderen `userData` startet, findet dort keinen Schlüssel, legt sich
 * einen neuen an und kann anschließend nichts entschlüsseln, was die App je
 * geschrieben hat. Die Fehlermeldung spricht dabei von einem kaputten
 * Geheimtext und nicht von einem falschen Ordner.
 *
 * Muss vor `whenReady` stehen: Danach ist der Pfad gesetzt und wird ignoriert.
 */
app.setPath('userData', join(app.getPath('appData'), 'void-jarvis'))

app.whenReady().then(() => {
  if (!key || !value) {
    return done(1, 'Aufruf: npx electron scripts/seed-secret.cjs <name> <wert>')
  }
  if (!ALLOWED.includes(key)) {
    return done(1, `"${key}" ist kein bekannter Zugang. Erlaubt: ${ALLOWED.join(', ')}`)
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return done(1, 'Auf diesem System ist kein verschlüsselter Speicher verfügbar.')
  }

  // Derselbe Ort wie in `main/secrets/keystore.ts` — und dank des gesetzten
  // Pfades oben zeigt `userData` jetzt auch dorthin.
  const dir = join(app.getPath('userData'), 'secure')
  const file = join(dir, 'secrets.bin')

  let store = {}
  if (existsSync(file)) {
    try {
      store = JSON.parse(safeStorage.decryptString(readFileSync(file)))
    } catch (err) {
      // Nicht überschreiben: Dahinter liegen womöglich alle anderen Zugänge.
      return done(1, `Vorhandene Datei nicht lesbar (${err}). Nichts geändert.`)
    }
  }

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  store[key] = String(value).trim()
  writeFileSync(file, safeStorage.encryptString(JSON.stringify(store)), { mode: 0o600 })

  return done(0, `"${key}" hinterlegt. Enthalten: ${Object.keys(store).sort().join(', ')}`)
})
