const { Database } = require('node-sqlite3-wasm')
const { cpSync, existsSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { randomUUID } = require('node:crypto')

// Local rollback copy; never print profile contents or encrypted credentials.
const version = require('../package.json').version
const source = join(process.env.APPDATA, 'Void Jarvis')
const parent = join(process.env.LOCALAPPDATA, 'James-Jarvis-Update-Backups')
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna' }).format(new Date())
const backup = join(parent, `${date}-${version}-${randomUUID().slice(0, 8)}`)
mkdirSync(parent, { recursive: true })
mkdirSync(backup)
for (const name of ['settings.json', 'secure', 'skills', 'backups']) {
  const file = join(source, name)
  if (existsSync(file)) cpSync(file, join(backup, name), { recursive: true, errorOnExist: true, force: false })
}
const databaseFile = join(source, 'data', 'jarvis.db')
if (existsSync(databaseFile)) {
  mkdirSync(join(backup, 'data'))
  const snapshot = join(backup, 'data', 'jarvis.db')
  const database = new Database(databaseFile, { readOnly: true, fileMustExist: true })
  try {
    database.run('VACUUM INTO ?', [snapshot])
  } finally { database.close() }
  const check = new Database(snapshot, { readOnly: true, fileMustExist: true })
  try {
    if (Object.values(check.get('PRAGMA quick_check') ?? {})[0] !== 'ok') throw new Error('Datenbanksicherung hat die Prüfung nicht bestanden.')
  } finally { check.close() }
}
writeFileSync(join(backup, 'manifest.json'), JSON.stringify({ version, createdAt: new Date().toISOString(),
  database: 'consistent-snapshot', containsPersonalData: true }, null, 2), { flag: 'wx' })
console.log(`PASS: lokale Profilsicherung mit geprüfter Datenbank: ${backup}`)
