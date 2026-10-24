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

/**
 * Release-Seite für Nutzer: Commit-Titel als Überschrift, Text ohne
 * Git-Zusätze (Co-Authored-By, Signed-off-by …), darunter Installationshinweis.
 */
function releaseNotes(message) {
  const lines = message.replace(/\r/g, '').split('\n')
    .filter((line) => !/^[A-Za-z-]+-by:\s/i.test(line.trim()))
  const [title = '', ...rest] = lines
  const body = rest.join('\n').trim()
  return [
    `## ${title.trim() || `James-Jarvis ${version}`}`,
    body,
    '### Installieren',
    `\`James-Jarvis-Setup-${version}.exe\` herunterladen und ausführen. ` +
      'Bereits installierte Fassungen finden das Update beim nächsten Start von selbst.',
    'Windows SmartScreen kann beim ersten Start warnen („Weitere Informationen“ → „Trotzdem ausführen“), ' +
      'weil der Installer nicht signiert ist.'
  ].filter(Boolean).join('\n\n') + '\n'
}

try {
  execFileSync('gh', ['release', 'view', tag, '--repo', repo], { stdio: 'ignore', shell: process.platform === 'win32' })
} catch {
  // Als Datei, nicht als Argument: Eine mehrzeilige Commit-Nachricht mit
  // Anführungszeichen übersteht die Windows-Shell sonst nicht heil.
  const notes = join(mkdtempSync(join(tmpdir(), 'release-')), 'notes.md')
  writeFileSync(notes, releaseNotes(process.env.RELEASE_NOTES ?? ''))
  run('gh', ['release', 'create', tag, '--repo', repo, '--title', `James-Jarvis ${version}`, '--notes-file', notes])
}
run('npx', ['electron-builder', '--win', '--publish', 'always'])
