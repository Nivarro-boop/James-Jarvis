// One isolated launch and an idle sample; no accounts or microphone requests.
const { _electron } = require('playwright-core')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
;(async () => {
  const profile = mkdtempSync(join(tmpdir(), 'james-performance-'))
  const data = join(profile, 'void-jarvis'); mkdirSync(data)
  const wrapper = resolve('out/performance-wrapper.cjs')
  writeFileSync(join(data, 'settings.json'), JSON.stringify({ setupDone: true, gamingMode: true, pcProfile: false, dailyBriefing: false, automaticBackups: false, useDeviceLocation: false, wake: { enabled: false, clap: false }, diagnosticReporting: { enabled: false, automatic: false, capabilityGaps: false, url: '' } }))
  writeFileSync(wrapper, `const {app}=require('electron');app.setPath('appData',${JSON.stringify(profile)});app.setPath('userData',${JSON.stringify(data)});require('./main/index.js')`)
  let app
  try {
    const started = performance.now()
    app = await _electron.launch({ executablePath: require('electron'), args: [wrapper], timeout: 30000 })
    let home
    for (let i = 0; i < 100 && !home; i++) { home = app.windows().find(p => p.url().includes('crystal.html')); if (!home) await new Promise(r => setTimeout(r, 100)) }
    if (!home) throw new Error('Home did not appear')
    await home.getByRole('button', { name: 'Menü', exact: true }).waitFor()
    const launchToMenuMs = Math.round(performance.now() - started)
    await app.evaluate(({ app }) => app.getAppMetrics())
    await home.waitForTimeout(5000)
    const processes = await app.evaluate(({ app }) => app.getAppMetrics().map(p => ({ type: p.type, cpuPercent: p.cpu.percentCPUUsage, workingSetKB: p.memory.workingSetSize, privateKB: p.memory.privateBytes ?? null })))
    const result = { launchToMenuMs, sampleIntervalMs: 5000, processes, sumWorkingSetsMB: Math.round(processes.reduce((n, p) => n + p.workingSetKB, 0) / 1024), sumPrivateMB: Math.round(processes.reduce((n,p)=>n+(p.privateKB??0),0)/1024), note: 'One local development Electron launch without accounts; setup may open. Working-set sum includes shared pages; use private bytes for unshared memory. No model/audio/provider latency measured.' }
    mkdirSync(resolve('out/audit'), { recursive: true })
    writeFileSync(resolve('out/audit/performance-2026-10-26.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result))
  } finally {
    if (app) await app.close()
    rmSync(wrapper, { force: true })
    if (!profile.startsWith(join(tmpdir(), 'james-performance-'))) throw new Error('Unexpected profile path')
    rmSync(profile, { recursive: true, force: true })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
