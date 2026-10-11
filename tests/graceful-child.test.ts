import assert from 'node:assert/strict'
import { it } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { stopOwnedChild } from '@main/providers/gracefulChild'

it('wartet auf das kontrollierte Ende eines echten Kindprozesses ohne Zwangsstopp', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  await once(child, 'spawn')
  let forced = false
  try {
    await stopOwnedChild(child, async () => { child.kill() }, async () => { forced = true; child.kill('SIGKILL') }, 2_000)
    assert.equal(forced, false)
    assert.ok(child.exitCode !== null || child.signalCode !== null)
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill() }
})

it('erzwingt nach Frist nur das Ende des eigenen hängenden Prozesses und ignoriert bereits beendete', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  await once(child, 'spawn')
  let forced = 0
  try {
    const exit = once(child, 'exit')
    await stopOwnedChild(child, async () => {}, async () => { forced++; child.kill('SIGKILL') }, 40)
    await exit
    await stopOwnedChild(child, async () => { throw new Error('must not run') }, async () => { forced++ })
    assert.equal(forced, 1)
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill() }
})
