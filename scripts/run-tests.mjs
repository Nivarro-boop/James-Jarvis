import { spawn } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { constants, setPriority } from 'node:os'

const lowResource = process.argv.includes('--low-resource')
const testArgs = process.argv.slice(2).filter(arg => arg !== '--low-resource')
if (lowResource) {
  setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL)
  process.env.GOMAXPROCS = '2'
}

/**
 * Die Tests bauen und laufen lassen.
 *
 * ── Warum ein Skript und kein `node --test` direkt ──
 *
 * Node kann seit Kurzem TypeScript lesen, aber nicht das hier: Die Quellen
 * importieren ohne Dateiendung und über die Kürzel `@main/` und `@shared/`.
 * Beides löst Node nicht auf — das tut sonst electron-vite beim Bauen.
 * Deshalb übersetzt esbuild die Tests vorher, mit denselben Kürzeln, und Node
 * bekommt fertige Dateien zu sehen.
 *
 * ── Warum CommonJS ──
 *
 * Aus demselben Grund, aus dem der Hauptprozess so gebaut wird (siehe die
 * Notiz in `package.json`): node-sqlite3-wasm, googleapis und Verwandte sind
 * reine CommonJS-Module. Aus ESM heraus liefern sie keine benannten Exporte,
 * und der Lauf endet vor dem ersten Test mit "Named export 'Database' not
 * found".
 *
 * ── Warum die Abhängigkeiten draußen bleiben ──
 *
 * `packages: 'external'` lässt jedes `require` auf node_modules stehen, statt
 * es mitzubündeln. Das ist schneller, und vor allem geht es Fallstricken aus
 * dem Weg, die beim Bündeln fremder Pakete auftauchen — node-cron etwa liest
 * `import.meta.url`, was in einem CommonJS-Bündel nicht existiert und den
 * ganzen Lauf beim Import abbrechen ließ. Als externes Paket lädt Node
 * einfach dessen eigene CommonJS-Fassung.
 *
 * Deshalb landet die Ausgabe unter `out/` und nicht im Temp-Verzeichnis: Von
 * dort aus findet Node die node_modules des Projekts.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const testDir = join(root, 'tests')
const outDir = join(root, 'out', 'tests')

/** Alle `*.test.ts` unter `tests/`, auch in Unterordnern. */
function findTests(dir) {
  const found = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) found.push(...findTests(full))
    else if (entry.endsWith('.test.ts')) found.push(full)
  }
  return found
}

let entries = findTests(testDir)
if (entries.length === 0) {
  console.error('Keine Tests gefunden — erwartet werden tests/**/*.test.ts')
  process.exit(1)
}
const fileFilters = testArgs.filter((arg) => !arg.startsWith('-'))
if (fileFilters.length > 0) {
  entries = entries.filter((e) =>
    fileFilters.some((f) => {
      const normF = f.replace(/\\/g, '/')
      const normE = e.replace(/\\/g, '/')
      return normE.endsWith(normF) || normE.includes(normF)
    })
  )
  if (entries.length === 0) {
    console.error(`Keine passenden Tests für Filter: ${fileFilters.join(', ')}`)
    process.exit(1)
  }
}

await build({
  entryPoints: entries,
  outdir: outDir,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  packages: 'external',
  logLevel: 'error',
  alias: {
    // Nur die Kürzel aus den tsconfigs. Electron wird nicht hier ersetzt,
    // sondern zur Laufzeit — ein Alias gälte nur für unseren eigenen Code, und
    // die fremden Pakete fordern Electron an esbuild vorbei an. Siehe
    // `tests/helpers/register-electron.cjs`.
    '@main': join(root, 'src', 'main'),
    '@shared': join(root, 'src', 'shared'),
    '@renderer': join(root, 'src', 'renderer')
  }
})

const built = entries.map((e) =>
  join(outDir, relative(testDir, e).replace(/\.test\.ts$/, '.test.cjs'))
)

// Die Pfade ausdrücklich übergeben statt Node suchen zu lassen: Sonst fände
// sein Standardmuster auch die Bündel früherer Läufe, die inzwischen zu
// gelöschten Quellen gehören.
//
// Der Electron-Ersatz geht über NODE_OPTIONS und nicht als Flag: `node --test`
// startet jede Testdatei in einem eigenen Prozess, und nur die Umgebung erbt
// sich dorthin sicher weiter.
const child = spawn(process.execPath, ['--test', ...(lowResource ? ['--test-concurrency=1'] : []), ...testArgs.filter(a => a.startsWith('-')), ...built], {
  stdio: 'inherit',
  cwd: root,
  env: {
    ...process.env,
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS ?? '',
      // Schrägstriche, auch unter Windows: Node liest NODE_OPTIONS wie eine
      // Kommandozeile und nimmt den Backslash als Fluchtzeichen — aus
      // `C:\Users\...` wurde `C:UsersVoid Jarvis...`. Der Pfad mit
      // Schrägstrichen funktioniert hier genauso und übersteht das Parsen.
      `--require "${join(testDir, 'helpers', 'register-electron.cjs').replace(/\\/g, '/')}"`
    ]
      .join(' ')
      .trim()
  }
})

child.on('exit', (code) => process.exit(code ?? 1))
child.on('error', (error) => { console.error(error); process.exitCode = 1 })
