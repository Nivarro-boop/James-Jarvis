/**
 * Lädt die openWakeWord-Modelle für „Hey James" (nur die Vorstufen, Apache-2.0).
 *
 * Bewusst ein eigener Schritt und nicht Teil von npm install: die Dateien
 * kommen von GitHub, und wer das Weckwort nicht braucht, soll dafür nicht ins
 * Netz müssen. Ohne die Modelle läuft die App vollständig weiter — dann eben
 * über Hotkey und Klick.
 *
 * Aufruf:  node scripts/fetch-wakeword.mjs
 */

import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TARGET = join(HERE, '..', 'src', 'renderer', 'public', 'wakeword')

const BASE = 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1'

const FILES = [
  // Gemeinsame Vorstufen — für jedes Weckwort identisch.
  { name: 'melspectrogram.onnx', minBytes: 100_000 },
  { name: 'embedding_model.onnx', minBytes: 1_000_000 }
  // Die Weckwort-Klassifikatoren von openWakeWord sind CC BY-NC-SA und
  // werden nicht mehr geladen. hey_james.onnx muss separat trainiert und
  // bereitgestellt werden; dieses Skript erzeugt keinen Klassifikator.
]

async function download(name, minBytes, localName = name) {
  const dest = join(TARGET, localName)

  if (existsSync(dest)) {
    const existing = await readFile(dest)
    if (existing.byteLength >= minBytes) {
      console.log(`  ${name} — schon vorhanden (${fmt(existing.byteLength)})`)
      return
    }
    console.log(`  ${name} — vorhandene Datei ist zu klein, lade neu`)
  }

  const url = `${BASE}/${name}`
  process.stdout.write(`  ${name} — lade… `)

  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} für ${url}`)
  }

  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))

  // Grobe Plausibilitätsprüfung: GitHub liefert bei Fehlern gern eine
  // HTML-Seite mit Status 200. Die wäre wenige Kilobyte groß.
  const written = await readFile(dest)
  if (written.byteLength < minBytes) {
    await unlink(dest)
    throw new Error(
      `${name} ist nur ${fmt(written.byteLength)} groß — vermutlich keine Modelldatei. Verworfen.`
    )
  }

  console.log(fmt(written.byteLength))
}

function fmt(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function main() {
  if (!existsSync(TARGET)) mkdirSync(TARGET, { recursive: true })

  console.log('Wake-Word-Modelle für „Hey James" (nur die Vorstufen, Apache-2.0)')
  console.log(`Ziel: ${TARGET}\n`)

  for (const file of FILES) {
    await download(file.name, file.minBytes)
  }

  // Explicit personal build only: this classifier has a noncommercial license.
  // Normal and commercial builds continue to require a separately trained model.
  if (process.argv.includes('--personal-jarvis')) {
    await download('hey_jarvis_v0.1.onnx', 100_000, 'jarvis.onnx')
    console.log('Hey Jarvis: openWakeWord, © David Scripka, CC BY-NC-SA 4.0. Nur nichtkommerzielle Nutzung.')
  }

  if (existsSync(join(TARGET, 'jarvis.onnx'))) {
    console.log('\nHey-Jarvis-Klassifikator vorhanden. Erkennbarkeit am eigenen Mikrofon prüfen.')
  } else if (existsSync(join(TARGET, 'hey_james.onnx'))) {
    console.log('\nVorstufen und Hey-James-Klassifikator vorhanden. Die Erkennung muss praktisch getestet werden.')
  } else {
    console.warn('\nHey-James-Klassifikator fehlt: Hotkey und Klick funktionieren, das Weckwort bleibt aus. Siehe scripts/wakeword-training/README.md.')
  }
}

main().catch((err) => {
  console.error('\nFehlgeschlagen:', err.message)
  console.error(
    'Die App läuft auch ohne die Modelle — dann weckst du James per Hotkey oder Klick auf den Kristall.'
  )
  // Bewusst kein Fehlercode. Das Skript hängt als `prebuild` vor jedem Bau,
  // und ein Rechner ohne Netz soll deswegen keinen Installer verweigern —
  // fehlendes Weckwort ist eine Einbuße, kein Baufehler. Was fehlt, steht
  // oben; wer es braucht, sieht es und ruft das Skript später noch einmal.
  process.exit(0)
})
