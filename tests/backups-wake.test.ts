import assert from 'node:assert/strict'
import { it } from 'node:test'
import { app } from 'electron'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { Database } from 'node-sqlite3-wasm'
import { createBackup, ensureDailyBackup, listBackups } from '@main/store/backups'
import { closeDb, initDb } from '@main/db'
import { createReminder } from '@main/scheduler/reminders'
import { setSettings } from '@main/store/settings'
import { wakeStatus } from '@main/providers/wakeStatus'
import { addCards, quizAnswer, quizNext } from '@main/study/store'

it('sichert die offene Datenbank konsistent, hält sieben tägliche Kopien und lässt Kontodateien aus', async t => {
  const root = mkdtempSync(join(tmpdir(), 'james-backup-'))
  t.mock.method(app, 'getPath', () => root)
  t.after(() => { closeDb(); assert.ok(root.startsWith(join(tmpdir(), 'james-backup-'))); rmSync(root, {recursive:true,force:true}) })
  setSettings({automaticBackups:false, mcpServers:[{id:'test',name:'Test',enabled:false,command:'node',args:[],env:{API_KEY:'test-private-value'}}]})
  createReminder({text:'Wichtiger Termin',inMinutes:60})
  const deck = addCards('Testwissen', [{ question: 'Hauptstadt Frankreichs', answer: 'Paris' }])
  const question = quizNext(deck.id)
  assert.ok(!('done' in question))
  quizAnswer(deck.id, deck.cards[0].id, 'Paris', question.questionToken)
  const manual = await createBackup()
  const payload = JSON.parse(gunzipSync(readFileSync(manual.file)).toString())
  assert.equal(payload.format, 'void-james-backup')
  assert.equal(payload.study.version, 1)
  assert.equal(payload.study.decks[0].cards[0].right, 1)
  assert.deepEqual(payload.settings.mcpServers[0].env, {})
  assert.ok(!JSON.stringify(payload).includes('test-private-value'))
  const snapshot = join(root,'read-only-snapshot.db')
  writeFileSync(snapshot,Buffer.from(payload.database.sqlite,'base64'))
  const restored = new Database(snapshot,{readOnly:true})
  try { assert.equal(restored.get('SELECT text FROM reminders')?.text,'Wichtiger Termin') }
  finally { restored.close() }
  await ensureDailyBackup()
  assert.equal(listBackups().length,1)
  setSettings({automaticBackups:true})
  const day = Date.now()
  for (let i=0;i<9;i++) await createBackup(true,day+i*86_400_000)
  assert.equal(listBackups().filter(item=>item.automatic).length,7)
  assert.equal(listBackups().filter(item=>!item.automatic).length,1)
  const same = await createBackup(true,day+8*86_400_000)
  assert.equal(listBackups().filter(item=>item.file===same.file).length,1)
  initDb().exec('BEGIN')
  try { await assert.rejects(createBackup(),/transaction/i) }
  finally { initDb().exec('ROLLBACK') }
  assert.ok(readdirSync(join(root,'backups')).every(file=>file.endsWith('.james-backup.json.gz')))
})

it('meldet den fehlenden Weckwort-Klassifikator und erkennt lokal bereitgestellte Dateien', t => {
  const root = mkdtempSync(join(tmpdir(), 'james-wake-'))
  t.mock.method(app,'getAppPath',()=>root)
  t.after(()=>{assert.ok(root.startsWith(join(tmpdir(),'james-wake-')));rmSync(root,{recursive:true,force:true})})
  const dir=join(root,'src','renderer','public','wakeword')
  mkdirSync(dir,{recursive:true})
  writeFileSync(join(dir,'melspectrogram.onnx'),'fixture')
  writeFileSync(join(dir,'embedding_model.onnx'),'fixture')
  assert.deepEqual(wakeStatus(),{installed:false,missing:['hey_james.onnx'],model:'hey_james.onnx',available:[]})
  writeFileSync(join(dir,'jarvis.onnx'),'fixture')
  assert.deepEqual(wakeStatus(),{installed:true,missing:[],model:'jarvis.onnx',available:['jarvis.onnx']})
  writeFileSync(join(dir,'hey_james.onnx'),'fixture')
  assert.deepEqual(wakeStatus(),{installed:true,missing:[],model:'hey_james.onnx',available:['jarvis.onnx','hey_james.onnx']})
})
