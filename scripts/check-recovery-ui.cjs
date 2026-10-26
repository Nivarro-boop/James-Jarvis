// Synthetic backup/restore and PC-profile UI; no files are restored or scanned.
const { build } = require('esbuild')
const { chromium } = require('playwright-core')
const { readFileSync, mkdirSync } = require('node:fs')
const { resolve } = require('node:path')
const assert = require('node:assert/strict')
;(async () => {
  const built = await build({ stdin: { resolveDir: resolve('.'), loader: 'tsx', contents: `
    import React, {useState} from 'react'
    import {createRoot} from 'react-dom/client'
    import {BackupPanel} from './src/renderer/settings/BackupPanel'
    import {PcProfilePanel} from './src/renderer/settings/PcProfilePanel'
    import {DEFAULT_SETTINGS} from './src/shared/config/defaults'
    let pending=false
    window.jarvis={invoke:async(channel)=>{
      if(channel==='backup:list')return []
      if(channel==='backup:restoreStatus')return {pending}
      if(channel==='backup:restore'){pending=true;return {ok:true,detail:'Geprüft und vorgemerkt.'}}
      if(channel==='backup:cancelRestore'){pending=false;return}
      if(channel==='pc:status')return {scannedAt:null,programs:0,files:0,documents:0}
      if(channel==='pc:chooseFolders')return ['C:\\\\Audit\\\\Dokumente']
      if(channel==='pc:preview')return {folders:[{name:'Dokumente',entries:['notiz.txt']}],documents:[{path:'C:/Audit/notiz.txt',name:'notiz.txt',excerpt:'Synthetische Vorschau'}]}
      throw Error(channel)
    }}
    function App(){const [s,set]=useState(structuredClone(DEFAULT_SETTINGS));return <div className='settings-shell james-ui'><nav className='settings-nav'><h2>James-Jarvis</h2><p>Sicherung und PC-Profil</p></nav><main className='settings-main'><BackupPanel settings={s} patch={async p=>{window.saved={...s,...p};set(window.saved);return window.saved}}/><PcProfilePanel settings={s} patch={async p=>{window.saved={...s,...p};set(window.saved);return window.saved}}/></main></div>}
    createRoot(document.getElementById('root')).render(<App/>);
  ` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', alias: { '@shared': resolve('src/shared') } })
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1050, height: 1000 } })
    const errors = []; page.on('pageerror', e => errors.push(e.message))
    await page.setContent('<body class="settings-body"><div id="root"></div></body>')
    await page.addStyleTag({ content: readFileSync('src/renderer/styles.css', 'utf8') + readFileSync('src/renderer/settings/settings.css', 'utf8') + readFileSync('src/renderer/refinement.css', 'utf8') })
    await page.addScriptTag({ content: built.outputFiles[0].text })
    await page.getByRole('button', { name: 'Sicherung wiederherstellen …', exact: true }).click()
    await page.getByText('Geprüft und vorgemerkt.', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Sicherung wiederherstellen …', exact: true }).isDisabled(), true)
    await page.getByRole('button', { name: 'Vorgemerkte Wiederherstellung abbrechen', exact: true }).click()
    await page.getByText('Wiederherstellung abgebrochen.', { exact: true }).waitFor()
    mkdirSync(resolve('out/audit/recovery'), { recursive: true })
    await page.getByRole('region', { name: 'Datensicherung', exact: true }).screenshot({ path: resolve('out/audit/recovery/backup.png') })
    await page.getByText('Ordner auswählen und ausschließen', { exact: true }).click()
    await page.getByRole('button', { name: 'Ordner wählen …', exact: true }).first().click()
    await page.waitForFunction(() => window.saved?.pcProfileFolders.length === 1)
    await page.getByRole('button', { name: 'Profilvorschau laden', exact: true }).click()
    await page.getByText('Synthetische Vorschau', { exact: true }).waitFor()
    mkdirSync(resolve('out/audit/recovery'), { recursive: true })
    await page.screenshot({ path: resolve('out/audit/recovery/settings.png'), fullPage: true })
    assert.deepEqual(errors, [])
    console.log('PASS: restore staging/cancellation, PC folder selection and profile preview; mocked IPC only')
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
