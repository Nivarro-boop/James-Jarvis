// Richtet den eingebauten Google-Zugang einmal für den Herausgeber ein.
//
//   npm run google:setup
//   npm run google:setup -- "C:\Users\…\Downloads\client_secret_….json"
//
// Danach muss kein Nutzer mehr eine Client-ID eintragen: Der nächste Build
// (`npm run dist`, die Release-Action) bettet den Client verschleiert ein.
//
// Am bequemsten ist die JSON-Datei, die die Google Cloud Console beim Anlegen
// des Desktop-Clients zum Herunterladen anbietet. Ohne Datei fragt das Skript
// nach beiden Werten; die Eingabe erscheint dabei nicht auf dem Bildschirm.
//
// Geschrieben wird `.env.google` im Projektordner (über `.env.*` in
// .gitignore ausgeschlossen, landet nicht im Installer). Auf Wunsch gehen die
// Werte zusätzlich als GitHub-Secrets an das Release-Repo — über die
// Standardeingabe von `gh`, also weder in der Befehlszeile noch im Verlauf.
// Ausgegeben wird nie ein Wert, nur eine gekürzte Form zum Wiedererkennen.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

const RELEASE_REPO = 'Nivarro-boop/James-Jarvis'
const ENV_FILE = resolve('.env.google')
const ID_PATTERN = /^[\w-]+\.apps\.googleusercontent\.com$/

function short(value) {
  return value.length <= 12 ? '…' : `${value.slice(0, 6)}…${value.slice(-6)}`
}

/** Fragt nach einer Zeile; mit `hidden` wird nichts mitgeschrieben. */
function ask(question, { hidden = false } = {}) {
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    if (hidden) {
      // readline schreibt jede Taste zurück; für verdeckte Eingabe nur die Frage zeigen.
      rl._writeToOutput = (text) => {
        if (text.includes(question)) process.stdout.write(question)
      }
    }
    rl.question(question, (answer) => {
      rl.close()
      if (hidden) process.stdout.write('\n')
      done(answer.trim())
    })
  })
}

/** Liest die von Google heruntergeladene client_secret_….json. */
function fromGoogleJson(path) {
  const data = JSON.parse(readFileSync(path, 'utf8'))
  const client = data.installed ?? data.web ?? data
  if (data.web) {
    console.warn('Hinweis: Das ist ein Web-Client. Für James braucht es den Anwendungstyp „Desktop-App“.')
  }
  return { id: String(client.client_id ?? '').trim(), secret: String(client.client_secret ?? '').trim() }
}

function hasGh() {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

async function main() {
  const file = process.argv[2]?.replace(/^"|"$/g, '')
  let pair
  if (file) {
    if (!existsSync(file)) throw new Error(`Datei nicht gefunden: ${file}`)
    pair = fromGoogleJson(file)
  } else {
    console.log('Google-Client für James einrichten. Werte aus der Google Cloud Console →')
    console.log('Anmeldedaten → OAuth-Client (Desktop-App). Die Eingabe bleibt unsichtbar.\n')
    const id = await ask('Client-ID: ', { hidden: true })
    const secret = await ask('Clientschlüssel: ', { hidden: true })
    pair = { id, secret }
  }

  if (!ID_PATTERN.test(pair.id)) throw new Error('Das ist keine Google-Client-ID (endet auf .apps.googleusercontent.com).')
  if (!pair.secret) throw new Error('Der Clientschlüssel fehlt.')

  writeFileSync(ENV_FILE, `JARVIS_GOOGLE_CLIENT_ID=${pair.id}\nJARVIS_GOOGLE_CLIENT_SECRET=${pair.secret}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
  console.log(`Gespeichert in .env.google (Client ${short(pair.id)}). Wird nicht eingecheckt.`)

  if (!hasGh()) {
    console.log(`GitHub-CLI nicht angemeldet. Für Releases die Secrets JARVIS_GOOGLE_CLIENT_ID und`)
    console.log(`JARVIS_GOOGLE_CLIENT_SECRET in ${RELEASE_REPO} von Hand anlegen.`)
  } else if ((await ask(`Auch als GitHub-Secrets in ${RELEASE_REPO} hinterlegen? (j/n) `)).toLowerCase().startsWith('j')) {
    for (const [name, value] of [['JARVIS_GOOGLE_CLIENT_ID', pair.id], ['JARVIS_GOOGLE_CLIENT_SECRET', pair.secret]]) {
      execFileSync('gh', ['secret', 'set', name, '--repo', RELEASE_REPO], { input: value, stdio: ['pipe', 'ignore', 'inherit'] })
      console.log(`GitHub-Secret ${name} gesetzt.`)
    }
  }

  console.log('\nFertig. Der nächste Build (`npm run dist` oder die Release-Action) bringt den Zugang mit.')
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
