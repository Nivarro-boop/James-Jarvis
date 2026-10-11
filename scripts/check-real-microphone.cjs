const { _electron } = require('playwright-core')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
;(async () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-mic-audit-'))
  const profile = join(root, 'profile'); mkdirSync(profile)
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({setupDone:true, wake:{enabled:false,clap:false}, automaticBackups:false}))
  const wrapper=resolve('.jarvis-mic-audit.cjs')
  writeFileSync(wrapper, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(profile)});require('./out/main/index.js')`)
  let app
  try {
    app=await _electron.launch({executablePath:require('electron'),args:[wrapper],timeout:30000})
    let page=await app.firstWindow()
    for(let i=0;i<100;i++){const p=app.windows().find(p=>p.url().includes('crystal.html'));if(p){page=p;break}await new Promise(r=>setTimeout(r,100))}
    const result=await page.evaluate(async()=>{
      let stream, context
      try {
        stream=await navigator.mediaDevices.getUserMedia({audio:true})
        context=new AudioContext();await context.resume()
        const source=context.createMediaStreamSource(stream), analyser=context.createAnalyser();source.connect(analyser)
        const samples=new Float32Array(analyser.fftSize);let max=0
        for(let i=0;i<30;i++){analyser.getFloatTimeDomainData(samples);for(const value of samples)max=Math.max(max,Math.abs(value));await new Promise(r=>setTimeout(r,100))}
        const devices=await navigator.mediaDevices.enumerateDevices()
        return {opened:true,live:stream.getAudioTracks()[0]?.readyState==='live',sampleRate:context.sampleRate,maxAmplitude:max,inputDevices:devices.filter(d=>d.kind==='audioinput').length,outputDevices:devices.filter(d=>d.kind==='audiooutput').length}
      }catch(e){return {opened:false,error:e.name+': '+e.message}}
      finally{stream?.getTracks().forEach(t=>t.stop());await context?.close()}
    })
    writeFileSync(resolve('out/audit/real-microphone.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
  }finally{await app?.close();rmSync(wrapper,{force:true});if(root.startsWith(join(tmpdir(),'jarvis-mic-audit-')))rmSync(root,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1})
