const asar = require('@electron/asar')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path='dist/win-unpacked/resources/app.asar'
const files=asar.listPackage(path)
for(const name of ['out/main/index.js','out/renderer/crystal.html','out/renderer/settings.html','out/renderer/wakeword/jarvis.onnx','out/renderer/wakeword/melspectrogram.onnx','out/renderer/wakeword/embedding_model.onnx']) assert.ok(files.some(f=>f.replaceAll('\\','/').replace(/^\//,'')===name),'Missing packaged file: '+name)
const version=JSON.parse(asar.extractFile(path,'package.json').toString()).version
assert.equal(version,require('../package.json').version)
const builtFiles = ['out/main/index.js', 'out/preload/index.js', 'out/renderer/crystal.html',
  ...fs.readdirSync('out/renderer/assets').filter(name => /^crystal-.*\.js$/.test(name)).map(name => 'out/renderer/assets/' + name)]
for (const name of builtFiles) assert.ok(asar.extractFile(path, require('node:path').normalize(name)).equals(fs.readFileSync(name)), 'Packaged build is outdated: ' + name)
for(const name of ['windows-helper.ps1','input-server.ps1','uia-server.ps1','audio-devices.ps1'])assert.ok(fs.existsSync('dist/win-unpacked/resources/'+name),name)
assert.ok(!files.some(f=>/out[\\/]audit[\\/]|\.log$/.test(f)),'Audit logs packaged')
console.log('PASS packaged version '+version+': UI, main, wake models, Windows helpers; no audit logs')
