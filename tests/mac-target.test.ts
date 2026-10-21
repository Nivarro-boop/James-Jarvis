import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'

it('targets only Apple Silicon for macOS and never publishes through dist:mac', () => {
  const config = readFileSync('electron-builder.yml', 'utf8')
  const mac = config.split(/^mac:\s*$/m)[1]?.split(/^\S[^\n]*:/m)[0]
  assert.ok(mac, 'An explicit macOS target is required')
  assert.match(mac, /target: dmg/)
  assert.match(mac, /arch: \[arm64\]/)
  assert.doesNotMatch(mac, /\b(?:x64|universal)\b/)
  assert.match(mac, /NSMicrophoneUsageDescription:/)
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  assert.match(pkg.scripts['dist:mac'], /--mac --arm64 --publish never/)
  assert.match(pkg.scripts.dist, /electron-builder --win/)
})

it('requires a genuine arm64 runner for the macOS integration check', () => {
  const workflow = readFileSync('.github/workflows/checks.yml', 'utf8')
  assert.match(workflow, /os: \[ubuntu-latest, windows-latest, macos-15\]/)
  assert.doesNotMatch(workflow, /macos-15-intel/)
  assert.match(workflow, /uname -m/)
  assert.match(workflow, /process\.arch/)
  assert.match(workflow, /arm64/)
})
