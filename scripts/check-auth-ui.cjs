const {build}=require('esbuild')
const {chromium}=require('playwright-core')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
;(async()=>{
const output=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {ChatGptConnection} from './src/renderer/settings/ChatGptConnection';createRoot(document.getElementById('root')).render(<ChatGptConnection />)`,resolveDir:process.cwd(),loader:'tsx'},jsx:'automatic',bundle:true,write:false,format:'iife',platform:'browser',alias:{'@shared':path.resolve('src/shared')}})
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true})
try{
const page=await browser.newPage({viewport:{width:780,height:700}})
const errors=[];page.on('pageerror',err=>errors.push(err.message))
await page.setContent('<html><body><div id="root"></div></body></html>')
await page.evaluate(()=>{
 let connected=false
 window.jarvis={invoke:async(channel,payload)=>{
  if(channel==='chatgpt:status')return{enabled:true,connected}
  if(channel==='chatgpt:connect')return new Promise(resolve=>window.finishLogin=()=>{connected=true;resolve({ok:true})})
  if(channel==='chatgpt:pendingSignIn')return{url:'https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client&state=local-test',expiresAt:Date.now()+300000}
  if(channel==='chatgpt:submitCallback'){window.submitted=payload.url;window.finishLogin();return}
  if(channel==='chatgpt:models')return[{id:'test-model',name:'Testmodell'}]
  throw Error(channel)
 }}
})
await page.addScriptTag({content:output.outputFiles[0].text})
await page.waitForTimeout(100)
assert.deepEqual(errors,[])
await page.getByRole('button',{name:'Continue with ChatGPT',exact:true}).click()
await page.getByRole('textbox',{name:'Rückleitungsadresse',exact:true}).fill('http://127.0.0.1:12345/auth/callback?code=test&state=local-test')
await page.getByRole('button',{name:'Anmeldung abschließen',exact:true}).click()
await page.getByText('Anmeldung gespeichert',{exact:false}).waitFor()
assert.match(await page.evaluate(()=>window.submitted),/^http:\/\/127\.0\.0\.1:/)
assert.equal(await page.getByRole('textbox',{name:'Rückleitungsadresse',exact:true}).count(),0)
assert.deepEqual(errors,[])
console.log('PASS: remote login controls, manual callback submission, successful completion, cleared callback input; no real account request')
}finally{await browser.close()}
})().catch(err=>{console.error(err);process.exitCode=1})
