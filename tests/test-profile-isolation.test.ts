import assert from 'node:assert/strict'
import { it } from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const stub = resolve('tests/helpers/electron-stub.cjs')
function profilePath(temp?: string, explicit = false): string {
  const env = { ...process.env }
  delete env.TEMP
  delete env.JAMES_TEST_PROFILE
  if (temp !== undefined) env.TEMP = temp
  if (explicit) env.JAMES_TEST_PROFILE = temp
  return execFileSync(process.execPath, ['-e', `const {app}=require(${JSON.stringify(stub)}); const a=app.getPath('userData'); const b=app.getPath('userData'); if(a!==b) throw Error('unstable profile'); process.stdout.write(a)`], { env, encoding: 'utf8' })
}

it('isoliert Testprofile je Prozess statt Daten im Repository abzulegen und räumt sie auf', () => {
  const first = profilePath()
  const second = profilePath()
  assert.notEqual(first, process.cwd())
  assert.notEqual(first, '.')
  assert.notEqual(first, second)
  assert.equal(existsSync(first), false, 'temporary profile must be removed after child exit')
  assert.equal(existsSync(second), false)
})

it('isoliert auch Prozesse mit voreingestelltem TEMP wie unter Windows', () => {
  const first = profilePath(tmpdir())
  const second = profilePath(tmpdir())
  assert.notEqual(first, tmpdir())
  assert.notEqual(first, second)
})

it('respektiert einen expliziten Testprofilpfad und löscht ihn nicht', () => {
  const dir = mkdtempSync(join(tmpdir(), 'james-explicit-profile-'))
  try {
    assert.equal(profilePath(dir, true), dir)
    assert.equal(existsSync(dir), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
