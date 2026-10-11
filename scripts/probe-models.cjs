const { app, safeStorage } = require('electron')
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

/**
 * Welche Modelle hat dieses Konto — und was können sie?
 *
 *   npx electron scripts/probe-models.cjs [suchwort]
 *
 * Der Schlüssel wird gelesen, aber nirgends hingeschrieben; im Bericht stehen
 * nur Modellnamen.
 */

const REPORT = join(__dirname, '..', 'probe-models.log')
const needle = (process.argv[2] ?? '').toLowerCase()

app.setPath('userData', join(app.getPath('appData'), 'void-jarvis'))

app.whenReady().then(async () => {
  const file = join(app.getPath('userData'), 'secure', 'secrets.bin')
  const out = []
  const say = (line) => {
    out.push(line)
    writeFileSync(REPORT, out.join('\n') + '\n', 'utf-8')
  }

  if (!existsSync(file)) {
    say('Keine secrets.bin gefunden.')
    return app.exit(1)
  }

  let key
  try {
    key = JSON.parse(safeStorage.decryptString(readFileSync(file))).gemini
  } catch (err) {
    say(`secrets.bin nicht lesbar: ${err}`)
    return app.exit(1)
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=300`
  )
  if (!res.ok) {
    say(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return app.exit(1)
  }

  const models = ((await res.json()).models ?? [])
    .map((m) => ({
      name: m.name.replace(/^models\//, ''),
      methods: m.supportedGenerationMethods ?? [],
      input: m.inputTokenLimit
    }))
    .filter((m) => (needle ? m.name.toLowerCase().includes(needle) : true))

  say(`${models.length} Modelle${needle ? ` mit "${needle}"` : ''}:`)
  for (const m of models) {
    const kann = []
    if (m.methods.includes('generateContent')) kann.push('Text')
    if (m.methods.includes('bidiGenerateContent')) kann.push('Live')
    if (m.methods.includes('embedContent')) kann.push('Vektoren')
    say(`  ${m.name.padEnd(46)} ${kann.join(', ') || m.methods.join(', ')}`)
  }

  app.exit(0)
})
