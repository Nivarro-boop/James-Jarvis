/* Inspect an existing, pinned Windows NSIS release. Never installs or publishes it. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const { execFileSync } = require('node:child_process')
const yaml = require('js-yaml')
const asar = require('@electron/asar')

function verifyReleaseMetadata(directory, manifest) {
  assert.match(manifest.tagName, /^v\d+\.\d+\.\d+$/)
  const version = manifest.tagName.slice(1)
  const name = `James-Jarvis-Setup-${version}.exe`
  for (const filename of [name, `${name}.blockmap`, 'latest.yml']) {
    const asset = manifest.assets.find(asset => asset.name === filename)
    assert.ok(asset, `Missing published asset: ${filename}`)
    assert.match(asset.digest || '', /^sha256:[a-f0-9]{64}$/)
    const bytes = fs.readFileSync(path.join(directory, filename))
    assert.equal(bytes.length, asset.size, `Published size mismatch: ${filename}`)
    assert.equal(`sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`, asset.digest, `Published SHA-256 mismatch: ${filename}`)
  }
  const installer = fs.readFileSync(path.join(directory, name))
  const metadata = yaml.load(fs.readFileSync(path.join(directory, 'latest.yml'), 'utf8'))
  assert.equal(metadata.version, version)
  assert.equal(metadata.path, name)
  assert.equal(metadata.files.length, 1, 'Expected one Windows installer')
  assert.equal(metadata.files[0].url, name)
  assert.equal(metadata.files[0].size, installer.length)
  const sha512 = crypto.createHash('sha512').update(installer).digest('base64')
  assert.equal(metadata.sha512, sha512, 'Top-level update SHA-512 mismatch')
  assert.equal(metadata.files[0].sha512, sha512, 'Update file SHA-512 mismatch')
  const blockmap = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(directory, `${name}.blockmap`)), { maxOutputLength: 16 * 1024 * 1024 }))
  assert.equal(blockmap.version, '2')
  assert.equal(blockmap.files.length, 1)
  const blocks = blockmap.files[0]
  assert.equal(blocks.offset, 0)
  assert.ok(blocks.sizes.length > 0)
  assert.equal(blocks.sizes.length, blocks.checksums.length)
  assert.ok(blocks.sizes.every(size => Number.isSafeInteger(size) && size > 0))
  assert.ok(blocks.checksums.every(sum => typeof sum === 'string' && sum.length > 0))
  assert.equal(blocks.sizes.reduce((total, size) => total + size, 0), installer.length, 'Blockmap does not cover installer')
  return { version, name, sha256: crypto.createHash('sha256').update(installer).digest('hex'), blocks: blocks.sizes.length }
}

function localReference(ref, baseFile) {
  const url = new URL(ref, `https://package.invalid/${baseFile}`)
  if (url.origin !== 'https://package.invalid') return null
  const name = path.posix.normalize(decodeURIComponent(url.pathname.slice(1)).replaceAll('\\', '/'))
  assert.ok(name.startsWith('out/renderer/'), `Renderer asset escapes its output directory: ${ref}`)
  return name
}

function verifyPayload(appDirectory, version) {
  const archive = path.join(appDirectory, 'resources', 'app.asar')
  const entries = new Set(asar.listPackage(archive).map(name => name.replace(/^[/\\]+/, '').replaceAll('\\', '/')))
  // ASAR's directory lookup uses host-native separators, unlike renderer URLs.
  const read = name => asar.extractFile(archive, path.join(...name.split('/'))).toString('utf8')
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.version, version, 'Packaged version differs from release')
  assert.equal(pkg.main, './out/main/index.js')
  for (const name of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/crystal.html', 'out/renderer/settings.html']) assert.ok(entries.has(name), `Missing app entry: ${name}`)
  let references = 0
  for (const name of entries) {
    if (!name.startsWith('out/renderer/') || !/\.(html|css)$/.test(name)) continue
    const text = read(name)
    const refs = name.endsWith('.html') ? [...text.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(match => match[1]) : [...text.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g)].map(match => match[1])
    for (const ref of refs) {
      const target = localReference(ref, name)
      if (!target) continue
      assert.ok(entries.has(target), `Missing renderer asset: ${target} (from ${name})`)
      references++
    }
  }
  for (const dependency of Object.keys(pkg.dependencies || {})) assert.ok(entries.has(`node_modules/${dependency}/package.json`), `Missing production dependency: ${dependency}`)
  for (const resource of ['windows-helper.ps1', 'input-server.ps1', 'uia-server.ps1', 'audio-devices.ps1', 'app-icons.ps1', 'piper-host.py', 'vibevoice-server.py', 'companion-cert.ps1', 'tray.png', 'kurzanleitung.html', 'THIRD_PARTY_NOTICES.md', 'app-update.yml', 'companion/index.html', 'companion/app.js', 'companion/mic-worklet.js', 'companion/sw.js']) {
    assert.ok(fs.statSync(path.join(appDirectory, 'resources', resource)).isFile(), `Missing external resource: ${resource}`)
  }
  const pe = fs.readFileSync(path.join(appDirectory, 'James-Jarvis.exe'))
  assert.equal(pe.toString('ascii', 0, 2), 'MZ')
  const offset = pe.readUInt32LE(0x3c)
  assert.equal(pe.readUInt32LE(offset), 0x00004550)
  assert.equal(pe.readUInt16LE(offset + 4), 0x8664, 'Expected published Windows x64 binary')
  return { version: pkg.version, archiveEntries: entries.size, checkedRendererReferences: references, binary: 'windows-x64', nativeExecution: 'not-run' }
}

async function nativeSmoke(appDirectory, output, expectedVersion) {
  assert.equal(process.platform, 'win32', 'Native release smoke requires Windows')
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Native release smoke is restricted to an ephemeral GitHub-hosted runner')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Do not execute the original installer app on a personal/self-hosted device')
  const { _electron } = require('playwright-core')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'james-original-release-'))
  const appData = path.join(root, 'appdata')
  const profile = path.join(appData, 'Void Jarvis')
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
    setupDone: false, gamingMode: true, automaticBackups: false, launchOnStartup: false, learnSkills: false,
    brainProvider: 'ollama', wake: { enabled: false, clap: false, pushToTalkHotkey: '', pauseHotkey: '' },
    speech: { provider: 'piper', hearProvider: 'whisper', thinkProvider: 'ollama' },
    companion: { enabled: false }, alexa: { enabled: false }, sip: { enabled: false }, mcpServers: [],
    telephony: { incomingEnabled: false, conversationEnabled: false },
    diagnosticReporting: { enabled: false, automatic: false, capabilityGaps: false }
  }))
  const env = {}
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG']) if (process.env[key]) env[key] = process.env[key]
  Object.assign(env, { HOME: root, USERPROFILE: root, APPDATA: appData, LOCALAPPDATA: path.join(root, 'local'), TEMP: root, TMP: root })
  let application
  try {
    application = await _electron.launch({ executablePath: path.join(appDirectory, 'James-Jarvis.exe'), env, timeout: 45000 })
    const actual = await application.evaluate(({ app }) => ({ profile: app.getPath('userData'), version: app.getVersion(), packaged: app.isPackaged }))
    assert.equal(path.resolve(actual.profile).toLowerCase(), path.resolve(profile).toLowerCase(), 'Original app must use the disposable profile')
    assert.equal(actual.version, expectedVersion)
    assert.equal(actual.packaged, true, 'Must execute the actual packaged app, not a source build')
    let page
    for (let attempt = 0; attempt < 100 && !page; attempt++) {
      page = application.windows().find(page => page.url().includes('crystal.html'))
      if (!page) await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(page, 'Original release crystal window must load')
    await page.waitForFunction(() => !!window.jarvis)
    const ping = await page.evaluate(() => window.jarvis.invoke('diag:ping'))
    assert.equal(ping.ok, true)
    assert.equal(ping.version, expectedVersion)
    const settings = await page.evaluate(() => window.jarvis.invoke('settings:get'))
    assert.equal(settings.gamingMode, true)
    assert.equal(settings.companion.enabled, false)
    assert.equal(settings.alexa.enabled, false)
    await page.evaluate(() => window.jarvis.invoke('app:pauseState', { paused: true }))
    await page.locator('.orb').first().waitFor({ state: 'visible' })
    assert.ok(await page.locator('.orb').count(), 'Original release home must render')
    await page.screenshot({ path: path.join(output, 'release-original-home.png') })
    return { result: 'passed', platform: 'win32', originalBinary: true, version: actual.version, disposableProfile: true, accountAndHardwareTests: 'not-run' }
  } finally {
    if (application) { await application.evaluate(({ app }) => app.exit(0)).catch(() => {}); await application.close().catch(() => {}) }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
}

async function main() {
  const directory = path.resolve(process.argv[2] || '')
  assert.ok(process.argv[2], 'Usage: node scripts/check-release-package.cjs <download-directory> [--native-smoke]')
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
  const metadata = verifyReleaseMetadata(directory, manifest)
  // Pin executable identity before any extraction or native execution in CI.
  assert.equal(metadata.version, '1.3.9')
  assert.equal(metadata.sha256, 'b0208f50654742f4fcbc0689f18ee0b9c0902b462cf35e8f5b67e889dc14813d')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'james-release-package-'))
  const output = path.resolve('out/audit')
  fs.mkdirSync(output, { recursive: true })
  const report = { release: manifest.tagName, metadata, platform: process.platform, nativeSmoke: { result: 'not-run' } }
  try {
    const unpacked = path.join(root, 'installer'), app = path.join(root, 'app')
    execFileSync('7z', ['x', '-y', path.join(directory, metadata.name), `-o${unpacked}`], { stdio: 'pipe' })
    execFileSync('7z', ['x', '-y', path.join(unpacked, '$PLUGINSDIR', 'app-64.7z'), `-o${app}`], { stdio: 'pipe' })
    report.payload = verifyPayload(app, metadata.version)
    if (process.argv.includes('--native-smoke')) {
      report.nativeSmoke = await nativeSmoke(app, output, metadata.version)
      report.payload.nativeExecution = 'passed'
    }
    report.result = 'passed'
  } catch (error) {
    report.result = 'failed'; report.error = error.message
    throw error
  } finally {
    fs.writeFileSync(path.join(output, 'release-package.json'), JSON.stringify(report, null, 2) + '\n')
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    console.log(JSON.stringify(report, null, 2))
  }
}
module.exports = { verifyReleaseMetadata, localReference, verifyPayload }
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
