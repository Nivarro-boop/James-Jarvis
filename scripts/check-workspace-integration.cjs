/* Real Electron + preload + IPC + disk test. No Electron stub, fake media,
 * provider keys, outgoing calls, profile access or external requests. */
const { _electron } = require('playwright-core')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs')
const { tmpdir, platform } = require('node:os')
const { join, resolve } = require('node:path')

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'james-workspace-integration-'))
  const userData = join(root, 'void-jarvis')
  const output = resolve('out/audit')
  mkdirSync(userData, { recursive: true }); mkdirSync(output, { recursive: true })
  const wrapper = join(root, 'workspace-wrapper.cjs')
  const report = { platform: platform(), engine: 'real-electron', checks: [], deviceTests: [] }
  const mark = (name, detail) => report.checks.push({ name, result: 'passed', ...(detail ? { detail } : {}) })
  let application
  let recoveryApplication
  try {
    writeFileSync(join(userData, 'settings.json'), JSON.stringify({
      setupDone: true, gamingMode: true, automaticBackups: false, launchOnStartup: false, learnSkills: false,
      wake: { enabled: false, clap: false, pushToTalkHotkey: '', pauseHotkey: '' },
      speech: { provider: 'piper', hearProvider: 'whisper', thinkProvider: 'ollama' },
      companion: { enabled: false }, alexa: { enabled: false }, sip: { enabled: false },
      telephony: { incomingEnabled: false, conversationEnabled: false }, mcpServers: [],
      diagnosticReporting: { enabled: false, automatic: false, capabilityGaps: false }
    }))
    // The entry module deliberately sets userData from appData; isolate both.
    writeFileSync(wrapper, `const {app,session}=require('electron');
app.setPath('appData',${JSON.stringify(root)});
app.setPath('userData',${JSON.stringify(userData)});
const oldFetch=global.fetch;global.fetch=(input,options)=>{const u=new URL(typeof input==='string'?input:input.url||String(input));if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))return Promise.reject(new Error('External request blocked by integration harness'));return oldFetch(input,options)};
app.whenReady().then(()=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(details,done)=>{const u=new URL(details.url);done({cancel:!['127.0.0.1','localhost','[::1]'].includes(u.hostname)})}));
require(${JSON.stringify(resolve('out/main/index.js'))});\n`)
    const environment = { ...process.env }
    for (const key of Object.keys(environment)) if (/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key) || ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'].includes(key)) delete environment[key]
    application = await _electron.launch({ executablePath: require('electron'), args: [wrapper], env: environment, timeout: 30_000 })
    await application.firstWindow()
    let page
    for (let attempt = 0; attempt < 100 && !page; attempt++) {
      page = application.windows().find(window => window.url().includes('crystal.html'))
      if (!page) await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(page, 'Real crystal window must load')
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    const invoke = (channel, payload) => page.evaluate(({ channel, payload }) => window.jarvis.invoke(channel, payload), { channel, payload })
    const settings = await invoke('settings:get')
    assert.equal(settings.companion.enabled, false); assert.equal(settings.alexa.enabled, false)
    mark('isolated-app-start-and-preload')

    // The clean home keeps only the conversation surface until the user opens Overview.
    const assertCleanHome = async () => {
      assert.equal(await page.locator('.workspace-board').count(), 0, 'Workspace board stays out of the default DOM')
      for (const selector of ['.feature-packs-panel', '.data-transparency', '.context-panel', '.widget-tiles', '.feature-pack-widgets']) {
        assert.equal(await page.locator(selector).count(), 0, `${selector} stays out of the default DOM`)
      }
      assert.ok(await page.locator('.orb').count(), 'Orb remains on the clean home')
      assert.ok(await page.getByLabel('Nachricht an James', { exact: true }).count(), 'Text bar remains on the clean home')
      assert.ok(await page.locator('.conversation').count(), 'Conversation remains on the clean home')
    }
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('crystal.html')).setSize(1100, 900))
    await assertCleanHome()
    await page.screenshot({ path: join(output, 'home-clean.png') })
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('crystal.html')).setSize(520, 800))
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Clean narrow home must not horizontally overflow')
    assert.equal(await page.evaluate(() => {
      const brand = document.querySelector('.home-top-left').getBoundingClientRect()
      const actions = document.querySelector('.home-actions').getBoundingClientRect()
      const horizontal = brand.right <= actions.left + 1
      const vertical = brand.bottom <= actions.top + 1 || actions.bottom <= brand.top + 1
      return horizontal || vertical
    }), true, 'Clean header brand and actions must not overlap')
    await page.screenshot({ path: join(output, 'home-clean-narrow.png') })
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('crystal.html')).setSize(1100, 900))

    const overviewButton = page.getByRole('button', { name: 'Übersicht', exact: true })
    await overviewButton.click()
    let overview = page.getByRole('dialog', { name: 'Übersicht', exact: true })
    await overview.waitFor()
    const tab = name => overview.getByRole('tab', { name, exact: true })
    assert.equal(await tab('Heute').getAttribute('aria-selected'), 'true', 'Heute is the default overview tab')
    assert.equal(await overview.locator('.workspace-board').count(), 1, 'Today tab contains the workspace board')
    await tab('Feature-Packs').click()
    assert.equal(await tab('Feature-Packs').getAttribute('aria-selected'), 'true')
    await overview.locator('.feature-packs-panel').waitFor()
    await overview.getByRole('heading', { name: 'Deklarative Feature-Packs', exact: true }).waitFor()
    await tab('Daten & KI').click()
    assert.equal(await tab('Daten & KI').getAttribute('aria-selected'), 'true')
    await overview.locator('.data-transparency').waitFor()
    await overview.getByRole('heading', { name: 'Was auf diesem Rechner bleibt', exact: true }).waitFor()
    await tab('Arbeitsstand').click()
    assert.equal(await tab('Arbeitsstand').getAttribute('aria-selected'), 'true')
    await overview.locator('.context-manage').waitFor()
    await overview.getByText('Gesprächskontext verwalten', { exact: true }).waitFor()
    await tab('Widgets').click()
    assert.equal(await tab('Widgets').getAttribute('aria-selected'), 'true')
    assert.ok(await overview.getByRole('tabpanel').count(), 'Widgets tab exposes its tab panel even when there are no tiles')

    // Exercise both ends of the modal focus cycle, then Esc and focus restoration.
    await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]')
      const focusable = [...dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(el => !el.disabled && el.getClientRects().length)
      focusable.at(-1)?.focus()
    })
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement)), true, 'Tab stays inside the overview dialog')
    await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]')
      const focusable = [...dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(el => !el.disabled && el.getClientRects().length)
      focusable[0]?.focus()
    })
    await page.keyboard.press('Shift+Tab')
    assert.equal(await page.evaluate(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement)), true, 'Shift+Tab stays inside the overview dialog')
    await page.keyboard.press('Escape')
    assert.equal(await page.getByRole('dialog', { name: 'Übersicht', exact: true }).count(), 0, 'Escape closes the overview dialog')
    assert.equal(await overviewButton.evaluate(el => document.activeElement === el), true, 'Closing restores focus to Übersicht')
    await assertCleanHome()
    await page.reload()
    await assertCleanHome()
    const more = page.getByLabel('Weitere Bereiche', { exact: true })
    await more.click()
    const destinations = page.getByRole('navigation', { name: 'Weitere Bereiche', exact: true })
    await destinations.getByRole('button', { name: 'Gehirn', exact: true }).waitFor()
    await destinations.getByRole('button', { name: 'Fertigkeiten', exact: true }).waitFor()
    await destinations.getByRole('button', { name: 'Aktionslog', exact: true }).waitFor()
    await destinations.getByRole('button', { name: 'Einstellungen', exact: true }).waitFor()
    await destinations.getByRole('button', { name: 'Steuerzentrale', exact: true }).click()
    await page.getByRole('button', { name: 'Steuerzentrale schließen', exact: true }).click()
    assert.equal(await more.evaluate(element => document.activeElement === element), true, 'Closing a secondary dialog returns focus to the menu opener')
    await more.click()
    await page.keyboard.press('Escape')
    assert.equal(await page.locator('.home-menu[open]').count(), 0, 'Escape closes the secondary menu')
    assert.equal(await more.evaluate(element => document.activeElement === element), true)
    mark('real-clean-home-default-no-board-and-overview-tabs-focus-return-and-reload')

    // Workspace interactions below are deliberately performed only after opening Übersicht.
    await overviewButton.click()
    overview = page.getByRole('dialog', { name: 'Übersicht', exact: true })
    await overview.waitFor()
    await tab('Heute').click()
    await overview.locator('.workspace-board').waitFor()
    await application.evaluate(async ({ BrowserWindow }, preload) => {
      const foreign = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } })
      await foreign.loadURL('data:text/html,<title>Foreign IPC fixture</title>')
    }, resolve('out/preload/index.js'))
    const foreignPage = application.windows().find(window => window.url().startsWith('data:text/html'))
    assert.ok(foreignPage)
    await assert.rejects(foreignPage.evaluate(() => window.jarvis.invoke('packs:list')), /nicht erlaubt/)
    await foreignPage.close()
    mark('real-foreign-window-ipc-denial')
    const reminder = await invoke('reminder:create', { text: 'Integrationserinnerung', inMinutes: 30 })
    assert.ok((await invoke('reminder:list')).some(item => item.id === reminder.id))
    await invoke('reminder:done', { id: reminder.id })
    assert.ok(!(await invoke('reminder:list')).some(item => item.id === reminder.id), 'Completed reminders leave the open-reminders list')
    mark('real-reminder-ipc-and-database')

    async function eventually(check) {
      for (let attempt = 0; attempt < 60; attempt++) {
        if (await check()) return
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw new Error('Persisted UI state did not converge')
    }
    await page.getByLabel('Neue lokale Aufgabe', { exact: true }).fill('Integration: lokal prüfen')
    await page.getByRole('button', { name: 'Hinzufügen', exact: true }).click()
    await eventually(async () => (await invoke('workspace:get', {})).tasks.some(item => item.title === 'Integration: lokal prüfen'))
    await page.getByRole('checkbox', { name: 'Integration: lokal prüfen', exact: true }).click()
    await eventually(async () => (await invoke('workspace:get', {})).tasks.some(item => item.title === 'Integration: lokal prüfen' && item.doneAt))
    assert.match(readFileSync(join(userData, 'workspace-tasks.json'), 'utf8'), /Integration: lokal prüfen/)
    const boardBefore = await invoke('workspace:get', {})
    const tasksIndex = boardBefore.layout.order.indexOf('tasks')
    await page.getByRole('button', { name: 'Aufgaben nach oben verschieben', exact: true }).click()
    await eventually(async () => (await invoke('workspace:get', {})).layout.order.indexOf('tasks') === tasksIndex - 1)
    await page.getByRole('button', { name: 'Termine ausblenden', exact: true }).click()
    await eventually(async () => (await invoke('workspace:get', {})).layout.hidden.includes('calendar'))
    await page.getByRole('button', { name: '„Termine“ wiederherstellen', exact: true }).click()
    await eventually(async () => !(await invoke('workspace:get', {})).layout.hidden.includes('calendar'))
    assert.equal((await invoke('workspace:get', {})).calendarEnabled, false)
    await page.getByRole('button', { name: 'Kalenderzugriff aktivieren & heute einmal laden', exact: true }).click()
    await eventually(async () => (await invoke('workspace:get', {})).calendarEnabled)
    const noCalendarAccount = await invoke('workspace:calendar-read', {})
    assert.equal(noCalendarAccount.sources.google.state, 'not-configured')
    assert.equal(noCalendarAccount.sources.ical.state, 'not-configured')
    await page.getByRole('button', { name: 'Zugriff ausschalten', exact: true }).click()
    await eventually(async () => !(await invoke('workspace:get', {})).calendarEnabled)
    mark('real-task-ui-persistence-board-reorder-hide-restore-and-calendar-consent')

    const pack = { format: 'jarvis-feature-pack', schemaVersion: 1, id: 'integration-pack', name: 'Integration Pack', version: '1.0.0', permissions: ['local-widget-state'], widgets: [{ id: 'check', type: 'checklist', title: 'Prüfung', items: [{ id: 'first', text: 'Lokal speichern' }] }] }
    const json = JSON.stringify(pack)
    const preview = await invoke('packs:preview', { json })
    await assert.rejects(invoke('packs:install', { json, sha256: preview.sha256, acceptTrust: false, acceptedPermissions: [] }))
    await invoke('packs:install', { json, sha256: preview.sha256, acceptTrust: true, acceptedPermissions: ['local-widget-state'] })
    await invoke('packs:toggle', { packId: pack.id, widgetId: 'check', itemId: 'first', checked: true })
    assert.equal((await invoke('packs:widgets')).find(item => item.packId === pack.id).checked.first, true)
    await invoke('packs:setEnabled', { id: pack.id, enabled: false })
    assert.ok(!(await invoke('packs:widgets')).some(item => item.packId === pack.id))
    await invoke('packs:remove', { id: pack.id })
    assert.ok(!(await invoke('packs:list')).some(item => item.id === pack.id))
    mark('real-feature-pack-consent-install-state-disable-remove')

    const backup = await invoke('backup:create')
    const fileName = backup.file.split(/[\\/]/).pop()
    const recovery = await invoke('recovery:preview', { fileName })
    assert.equal(recovery.integrity, 'ok')
    const activeBefore = readFileSync(join(userData, 'settings.json'), 'utf8')
    const recovered = await invoke('recovery:createProfile', { fileName, digest: recovery.digest, confirmed: true })
    assert.ok(existsSync(join(recovered.directory, 'settings.json')))
    assert.equal(readFileSync(join(userData, 'settings.json'), 'utf8'), activeBefore)
    assert.ok(!existsSync(join(recovered.directory, 'secure', 'secrets.bin')))
    mark('real-backup-validation-and-isolated-recovery')

    recoveryApplication = await _electron.launch({ executablePath: require('electron'), args: [wrapper, recovered.launchArgument], env: environment, timeout: 30_000 })
    await recoveryApplication.firstWindow()
    let recoveryPage
    for (let attempt = 0; attempt < 100 && !recoveryPage; attempt++) {
      recoveryPage = recoveryApplication.windows().find(window => window.url().includes('crystal.html'))
      if (!recoveryPage) await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(recoveryPage)
    await recoveryPage.locator('.recovery-banner').waitFor()
    const recoveryInvoke = (channel, payload) => recoveryPage.evaluate(({ channel, payload }) => window.jarvis.invoke(channel, payload), { channel, payload })
    assert.equal(await recoveryApplication.evaluate(({ app }) => app.getPath('userData')), recovered.directory)
    assert.equal((await recoveryInvoke('recovery:status')).active, true)
    assert.equal((await recoveryInvoke('app:pauseGet')).paused, true)
    assert.equal(await recoveryPage.getByLabel('Nachricht an James', { exact: true }).isDisabled(), true)
    assert.equal(await recoveryPage.locator('.orb').getAttribute('aria-disabled'), 'true')
    await assert.rejects(recoveryInvoke('settings:set', { companion: { enabled: true } }), /Recovery/)
    await assert.rejects(recoveryInvoke('workspace:calendar-read', {}), /Recovery/)
    await assert.rejects(recoveryInvoke('tools:call', { id: 'forbidden', name: 'shell', args: {} }), /Recovery/)
    assert.equal(await recoveryInvoke('secrets:getGeminiForLive'), null)
    assert.equal((await recoveryInvoke('openai:realtimeSecret')).ok, false)
    await recoveryPage.screenshot({ path: join(output, 'workspace-integration-recovery.png') })
    await recoveryApplication.close(); recoveryApplication = null
    assert.equal(readFileSync(join(userData, 'settings.json'), 'utf8'), activeBefore)
    mark('real-recovery-boot-isolation-pause-and-execution-denial')

    // No --use-fake-device-for-media-stream. Unavailable hardware is NOT a pass.
    const microphone = await page.evaluate(async () => {
      let stream
      try {
        stream = await Promise.race([
          navigator.mediaDevices.getUserMedia({ audio: true }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('DeviceProbeTimeout')), 5000))
        ])
        return { name: 'physical-microphone-access', result: stream.getAudioTracks().some(track => track.readyState === 'live') ? 'passed' : 'unavailable', detail: 'No speech recognition or acoustic quality assertion' }
      } catch (error) { return { name: 'physical-microphone-access', result: 'unavailable', detail: error.name || 'DeviceUnavailable' } }
      finally { stream?.getTracks().forEach(track => track.stop()) }
    })
    report.deviceTests.push(microphone,
      { name: 'real-provider-account', result: 'unavailable', detail: 'No provider credentials supplied to this isolated test; no paid request performed' },
      { name: 'real-phone-carrier', result: 'unavailable', detail: 'No authorized destination or carrier credentials; no call placed' },
      { name: 'physical-alexa-device', result: 'unavailable', detail: 'No physical Echo device connected to runner' })

    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('crystal.html')).setSize(1100, 900))
    await page.screenshot({ path: join(output, 'workspace-integration.png') })
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('crystal.html')).setSize(520, 800))
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Narrow app must not horizontally overflow')
    assert.equal(await page.evaluate(() => {
      const left = document.querySelector('.home-top-left').getBoundingClientRect()
      const actions = document.querySelector('.home-actions').getBoundingClientRect()
      const horizontal = left.right <= actions.left + 1
      const vertical = left.bottom <= actions.top + 1 || actions.bottom <= left.top + 1
      return horizontal || vertical
    }), true, 'Header navigation must not overlap brand/activity controls')
    await page.screenshot({ path: join(output, 'workspace-integration-narrow.png') })
    assert.deepEqual(errors, [], 'No renderer page errors')
    mark('real-renderer-and-narrow-layout')
    report.result = 'passed'
    console.log(JSON.stringify(report, null, 2))
  } catch (error) {
    report.result = 'failed'; report.error = error.message
    throw error
  } finally {
    writeFileSync(join(output, 'workspace-integration.json'), JSON.stringify(report, null, 2) + '\n')
    if (recoveryApplication) await recoveryApplication.close()
    if (application) await application.close()
    assert.ok(root.startsWith(join(tmpdir(), 'james-workspace-integration-')))
    rmSync(root, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
