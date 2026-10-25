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
assert.ok(!files.some(f => /out[\\/][^\\/]+\.(?:cjs|mjs)$/.test(f)), 'UI test wrapper packaged')
for (const name of ['index.html', 'app.js', 'style.css', 'sw.js', 'mic-worklet.js']) {
  assert.ok(fs.readFileSync('dist/win-unpacked/resources/companion/' + name).equals(fs.readFileSync('resources/companion/' + name)), 'Phone resource is outdated: ' + name)
}
// Der eingebaute Google-Client darf nur verschleiert im Installer stehen.
if (fs.existsSync('.env.google')) {
  const googleId = /^JARVIS_GOOGLE_CLIENT_ID=(.+)$/m.exec(fs.readFileSync('.env.google', 'utf8'))?.[1]?.trim()
  if (googleId) assert.ok(!asar.extractFile(path, require('node:path').normalize('out/main/index.js')).toString('latin1').includes(googleId), 'Google client ID readable in package')
}
console.log('PASS packaged version '+version+': UI, main, wake models, Windows helpers; no audit logs')
