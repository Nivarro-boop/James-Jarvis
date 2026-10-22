import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { finished } from 'node:stream/promises'
import { runInNewContext } from 'node:vm'
const { verifyReleaseMetadata, localReference, verifyPayload } = require(resolve('scripts/check-release-package.cjs'))
function fixture(run: (directory: string, manifest: any, installer: Buffer) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'james-release-metadata-'))
  const installer = Buffer.from('small deterministic installer fixture')
  const name = 'James-Jarvis-Setup-1.3.9.exe'
  const sha512 = createHash('sha512').update(installer).digest('base64')
  const files: Record<string, Buffer> = {
    [name]: installer,
    [`${name}.blockmap`]: gzipSync(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0, sizes: [installer.length], checksums: ['fixture-checksum'] }] })),
    'latest.yml': Buffer.from(`version: 1.3.9\npath: ${name}\nsha512: ${sha512}\nfiles:\n  - url: ${name}\n    size: ${installer.length}\n    sha512: ${sha512}\n`)
  }
  const manifest = { tagName: 'v1.3.9', assets: Object.entries(files).map(([name, bytes]) => ({ name, size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` })) }
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(directory, name), bytes)
  try { run(directory, manifest, installer) }
  finally { rmSync(directory, { recursive: true, force: true }) }
}

it('checks published SHA-256, update SHA-512, exact file size and blockmap coverage together', () => {
  fixture((directory, manifest, installer) => {
    const actual = verifyReleaseMetadata(directory, manifest)
    assert.equal(actual.version, '1.3.9')
    assert.equal(actual.sha256, createHash('sha256').update(installer).digest('hex'))
    assert.equal(actual.blocks, 1)
  })
})

it('rejects a modified installer even when its byte length remains unchanged', () => {
  fixture((directory, manifest, installer) => {
    const changed = Buffer.from(installer); changed[0] ^= 1
    writeFileSync(join(directory, 'James-Jarvis-Setup-1.3.9.exe'), changed)
    assert.throws(() => verifyReleaseMetadata(directory, manifest), /SHA-256 mismatch/)
  })
})

it('rejects inconsistent update SHA-512 independently of a matching asset digest', () => {
  fixture((directory, manifest, installer) => {
    const yaml = Buffer.from(`version: 1.3.9\npath: James-Jarvis-Setup-1.3.9.exe\nsha512: wrong\nfiles:\n  - url: James-Jarvis-Setup-1.3.9.exe\n    size: ${installer.length}\n    sha512: wrong\n`)
    writeFileSync(join(directory, 'latest.yml'), yaml)
    Object.assign(manifest.assets.find((asset: any) => asset.name === 'latest.yml'), { size: yaml.length, digest: `sha256:${createHash('sha256').update(yaml).digest('hex')}` })
    assert.throws(() => verifyReleaseMetadata(directory, manifest), /SHA-512 mismatch/)
  })
})

it('normalizes actual renderer links but rejects references outside the renderer output', () => {
  assert.equal(localReference('./assets/a.js?v=1', 'out/renderer/crystal.html'), 'out/renderer/assets/a.js')
  assert.equal(localReference('./font.woff2', 'out/renderer/assets/a.css'), 'out/renderer/assets/font.woff2')
  assert.equal(localReference('data:image/png;base64,AA==', 'out/renderer/crystal.html'), null)
  assert.equal(localReference('https://example.com/icon.png', 'out/renderer/crystal.html'), null)
  assert.throws(() => localReference('../../private/file', 'out/renderer/crystal.html'), /escapes/)
})


it('rejects a blockmap that does not cover the installer even if its published digest matches', () => {
  fixture((directory, manifest, installer) => {
    const filename = 'James-Jarvis-Setup-1.3.9.exe.blockmap'
    const bytes = gzipSync(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0, sizes: [installer.length + 1], checksums: ['fixture-checksum'] }] }))
    writeFileSync(join(directory, filename), bytes)
    Object.assign(manifest.assets.find((asset: any) => asset.name === filename), { size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` })
    assert.throws(() => verifyReleaseMetadata(directory, manifest), /does not cover installer/)
  })
})

it('rejects encoded slash and backslash escapes in renderer asset references', () => {
  assert.throws(() => localReference('..%2f..%2fprivate', 'out/renderer/crystal.html'), /escapes/)
  assert.throws(() => localReference('..%5c..%5cprivate', 'out/renderer/crystal.html'), /escapes/)
})

it('reads actual nested ASAR files using host-native paths, including CSS and font references', async () => {
  const root = mkdtempSync(join(tmpdir(), 'james-release-asar-'))
  const source = join(root, 'source'), app = join(root, 'app')
  const put = (filename: string, value: string | Buffer): void => { mkdirSync(dirname(filename), { recursive: true }); writeFileSync(filename, value) }
  try {
    put(join(source, 'package.json'), JSON.stringify({ name: 'release-fixture', version: '1.3.9', main: './out/main/index.js', dependencies: { example: '1.0.0' } }))
    put(join(source, 'out/main/index.js'), '/* never executed */')
    put(join(source, 'out/preload/index.js'), '/* never executed */')
    put(join(source, 'node_modules/example/package.json'), '{"name":"example","version":"1.0.0"}')
    put(join(source, 'out/renderer/crystal.html'), '<script src="./assets/app.js"></script><link href="./assets/style.css" rel="stylesheet">')
    put(join(source, 'out/renderer/settings.html'), '<script src="./assets/app.js"></script>')
    put(join(source, 'out/renderer/assets/app.js'), '/* never executed */')
    put(join(source, 'out/renderer/assets/style.css'), '@font-face{src:url("./font.woff2")}')
    put(join(source, 'out/renderer/assets/font.woff2'), 'fixture font')
    for (const filename of ['windows-helper.ps1', 'input-server.ps1', 'uia-server.ps1', 'audio-devices.ps1', 'app-icons.ps1', 'piper-host.py', 'vibevoice-server.py', 'companion-cert.ps1', 'tray.png', 'kurzanleitung.html', 'THIRD_PARTY_NOTICES.md', 'app-update.yml', 'companion/index.html', 'companion/app.js', 'companion/mic-worklet.js', 'companion/sw.js']) put(join(app, 'resources', filename), 'fixture')
    const pe = Buffer.alloc(0x80)
    pe.write('MZ'); pe.writeUInt32LE(0x40, 0x3c); pe.writeUInt32LE(0x00004550, 0x40); pe.writeUInt16LE(0x8664, 0x44)
    put(join(app, 'James-Jarvis.exe'), pe) // Header-only fixture; this is not an executable and is never launched.
    // ASAR 3 resolves with the output stream before its final writes are flushed.
    // Reading immediately can yield NUL-filled payloads, especially on Windows.
    const archive = await require('@electron/asar').createPackage(source, join(app, 'resources/app.asar'))
    await finished(archive)
    const actual = verifyPayload(app, '1.3.9')
    assert.equal(actual.version, '1.3.9')
    assert.ok(actual.checkedRendererReferences > 0)
    assert.equal(actual.nativeExecution, 'not-run')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('keeps a native launch failure strict, preserves only disposable logs and never inherits provider credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'james-release-launch-fixture-'))
  const output = join(root, 'audit'), app = join(root, 'app')
  mkdirSync(output)
  const sandboxModule = { exports: {} as any }
  try {
    const mockedRequire = (id: string): any => {
      if (id === 'node:os') return { ...require(id), tmpdir: () => root }
      if (id === 'playwright-core') return { _electron: { launch: async (options: any) => {
        assert.equal(options.executablePath, join(app, 'James-Jarvis.exe'))
        assert.equal(options.cwd, app)
        assert.ok(options.args.includes('--enable-logging=stderr'))
        assert.equal(options.env.ELECTRON_ENABLE_LOGGING, '1')
        assert.equal(options.env.OPENAI_API_KEY, undefined)
        assert.equal(options.env.GH_TOKEN, undefined)
        const logs = join(options.env.APPDATA, 'Void Jarvis', 'logs')
        mkdirSync(logs, { recursive: true })
        writeFileSync(join(logs, 'main.log'), 'fixture startup failure')
        throw new Error('simulated native launch timeout')
      } } }
      return require(id)
    }
    const source = readFileSync(resolve('scripts/check-release-package.cjs'), 'utf8')
    runInNewContext(source + '\nmodule.exports.nativeSmoke = nativeSmoke', { module: sandboxModule, require: mockedRequire, process: { platform: 'win32', env: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', OPENAI_API_KEY: 'must-not-inherit', GH_TOKEN: 'must-not-inherit' } }, console, Buffer, URL })
    await assert.rejects(sandboxModule.exports.nativeSmoke(app, output, '1.3.9'), /simulated native launch timeout/)
    const report = JSON.parse(readFileSync(join(output, 'release-original-startup.json'), 'utf8'))
    assert.equal(report.logs.length, 1)
    assert.equal(report.logs[0].tail, 'fixture startup failure')
    assert.ok(!JSON.stringify(report).includes('must-not-inherit'))
    assert.deepEqual(readdirSync(root), ['audit'], 'Disposable profile must be removed even after launch failure')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
