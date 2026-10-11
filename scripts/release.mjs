/**
 * Baut und veröffentlicht ein Update.
 *
 * electron-builder lädt Exe und Blockmap gleichzeitig hoch, und beide wollen
 * das GitHub-Release anlegen, wenn es fehlt — eines bekommt dann
 * „422 Unprocessable Entity“, und das Release steht halb gefüllt da. Deshalb
 * wird es hier vorher angelegt; danach lädt electron-builder nur noch hoch.
 *
 * Braucht GH_TOKEN (z. B. $env:GH_TOKEN = (gh auth token)) und die GitHub-CLI.
 * Läuft auch in der GitHub-Action (.github/workflows/release.yml); dort kommen
 * die Release-Notizen aus der Commit-Nachricht über RELEASE_NOTES.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const repo = 'Nivarro-boop/James-Jarvis'
const tag = `v${version}`
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' })

try {
  execFileSync('gh', ['release', 'view', tag, '--repo', repo], { stdio: 'ignore', shell: process.platform === 'win32' })
} catch {
  // Als Datei, nicht als Argument: Eine mehrzeilige Commit-Nachricht mit
  // Anführungszeichen übersteht die Windows-Shell sonst nicht heil.
  const notes = join(mkdtempSync(join(tmpdir(), 'release-')), 'notes.md')
  writeFileSync(notes, process.env.RELEASE_NOTES?.trim() || `James-Jarvis ${version}`)
  run('gh', ['release', 'create', tag, '--repo', repo, '--title', version, '--notes-file', notes])
}
run('npx', ['electron-builder', '--win', '--publish', 'always'])
