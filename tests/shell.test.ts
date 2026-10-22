import assert from 'node:assert/strict'
import { it } from 'node:test'
import fs from 'node:fs'
import childProcess from 'node:child_process'
import { commandConfirmation, shellTools } from '@main/tools/impl/shell'
import type { ToolContext } from '@main/tools/registry'

const runCommand = shellTools.find(tool => tool.name === 'run_command')!

for (const workDir of ['\\\\server\\share', '//server/share', '\\\\?\\C:\\Windows', '\\\\.\\C:', '\\/server/share', '/\\server/share']) {
  it(`blocks remote/device workDir before filesystem or process access: ${workDir}`, async t => {
    const exists = t.mock.method(fs, 'existsSync', () => { throw new Error('unexpected filesystem access') })
    const exec = t.mock.method(childProcess, 'execFile', () => { throw new Error('unexpected process execution') })
    await assert.rejects(runCommand.execute({ command: 'Get-Location', purpose: 'Test', workDir }, {} as ToolContext), /Netzwerk- und Gerätepfade/)
    assert.equal(exists.mock.callCount(), 0)
    assert.equal(exec.mock.callCount(), 0)
  })
}

it('still checks whether a local working directory exists', async t => {
  const exists = t.mock.method(fs, 'existsSync', () => false)
  const exec = t.mock.method(childProcess, 'execFile', () => { throw new Error('unexpected process execution') })
  await assert.rejects(runCommand.execute({ command: 'Get-Location', purpose: 'Test', workDir: 'C:\\missing' }, {} as ToolContext), /Arbeitsverzeichnis gibt es nicht/)
  assert.equal(exists.mock.callCount(), 1)
  assert.equal(exec.mock.callCount(), 0)
})

it('includes the working directory in the command confirmation', () => {
  assert.equal(commandConfirmation('Get-Location', 'C:\\Projekte'), 'Ich führe den Befehl Get-Location im Arbeitsverzeichnis C:\\Projekte aus. Soll ich?')
  assert.equal(commandConfirmation('Get-Location', ''), 'Ich führe den Befehl Get-Location aus. Soll ich?')
})
