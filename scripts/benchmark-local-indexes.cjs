const { build } = require('esbuild')
const fs = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { performance } = require('node:perf_hooks')

// Isolated, repeatable local CPU/I/O benchmark; never opens the user's profile.
;(async () => {
  const workspace = resolve(__dirname, '..')
  require(join(workspace, 'tests/helpers/register-electron.cjs'))
  const { app } = require('electron')
  const { z } = require('zod')
  const profile = fs.mkdtempSync(join(tmpdir(), 'james-local-index-benchmark-'))
  fs.mkdirSync(join(workspace, 'out'), { recursive: true })
  const bundleDir = fs.mkdtempSync(join(workspace, 'out', 'local-index-benchmark-'))
  const skillsDir = join(profile, 'skills')
  fs.mkdirSync(skillsDir)
  const getPath = app.getPath
  const readFile = fs.readFileSync
  let skillReads = 0
  try {
    app.getPath = () => profile
    for (let n = 0; n < 200; n++) fs.writeFileSync(join(skillsDir, `skill-${n}.md`), [
      '---', `name: Aufgabe ${n}`, `description: Stream Kalender Recherche Projekt ${n}`,
      'source: manual', `uses: ${n}`, 'updated: 2026-10-16', '---',
      'Eine ausführliche gespeicherte Anleitung. '.repeat(120)
    ].join('\n'))
    const file = join(bundleDir, 'indexes.cjs')
    await build({
      stdin: { contents: [
        "export { listSkills, skillIndexForPrompt } from './agent/skills'",
        "export { register } from './tools/registry'",
        "export { searchTools } from './tools/impl/toolSearch'"
      ].join('\n'), loader: 'ts', resolveDir: join(workspace, 'src/main') },
      bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: file,
      alias: { '@shared': join(workspace, 'src/shared'), '@main': join(workspace, 'src/main') }, logLevel: 'silent'
    })
    const indexes = require(file)
    const schema = z.object({})
    for (let n = 0; n < 500; n++) indexes.register({ name: `connector_${n}_search`, group: 'web',
      description: `Plugin ${n}: ` + 'Kalender E-Mail Dateien suchen lesen öffnen. '.repeat(15),
      schema, execute: async () => undefined })
    fs.readFileSync = function (file, ...args) {
      if (String(file).startsWith(skillsDir)) skillReads++
      return readFile.call(this, file, ...args)
    }
    indexes.skillIndexForPrompt(30, 'Kalender')
    indexes.searchTools('Kalender lesen', new Set())
    skillReads = 0
    const samples = (iterations, operation) => {
      const durations = []
      for (let round = 0; round < 3; round++) {
        const started = performance.now()
        for (let n = 0; n < iterations; n++) operation(n)
        durations.push((performance.now() - started) / iterations)
      }
      return Number(durations.sort((a, b) => a - b)[1].toFixed(3))
    }
    const result = {
      skillFiles: 200,
      registeredTools: 500,
      skillPromptMedianMs: samples(40, n => indexes.skillIndexForPrompt(30, `Kalender Projekt ${n}`)),
      skillFileReadsIn120Prompts: skillReads,
      toolSearchMedianMs: samples(400, n => indexes.searchTools(`Kalender lesen ${n}`, new Set()))
    }
    console.log(JSON.stringify(result, null, 2))
    if (process.argv[2]) fs.writeFileSync(resolve(process.argv[2]), JSON.stringify(result, null, 2) + '\n')
  } finally {
    fs.readFileSync = readFile
    app.getPath = getPath
    if (!profile.startsWith(join(tmpdir(), 'james-local-index-benchmark-')) || !bundleDir.startsWith(join(workspace, 'out', 'local-index-benchmark-'))) throw new Error('Unexpected benchmark cleanup path')
    fs.rmSync(profile, { recursive: true, force: true })
    fs.rmSync(bundleDir, { recursive: true, force: true })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
