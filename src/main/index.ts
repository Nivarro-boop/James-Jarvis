import './userDataPath'
import { stopLocalServer } from './local/jarvisModels'
import { app, dialog, globalShortcut, Menu, nativeImage, Tray } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { initLogging } from './logging'
import { startDiagnosticMonitor, stopDiagnosticMonitor } from './providers/diagnosticMonitor'
import { closeDb, initDb } from './db'
import { resourceFile } from './resources'
import { registerIpcHandlers } from './ipc/bridge'
import { broadcast, sendToCrystal } from './ipc/emit'
import { createCrystalWindow, getCrystalWindow, toggleCrystalVisibility } from './windows/crystal'
import { createSettingsWindow } from './windows/settings'
import { getSettings, onSettingsChanged } from './store/settings'
import { prefetchAppIcons } from './automation/desktop'
import {
  companionStatus,
  isRunning as isCompanionRunning,
  startCompanion,
  stopCompanion,
  type TlsMaterial
} from './companion/server'
import { ensureCert } from './companion/tailscale'
import { shutdownPublicEndpoint } from './telephony'
import { startSip, stopSip, watchSipSettings } from './telephony/sip'
import { startAlexa } from './alexa'
import { ensureLocalCert } from './companion/cert'
import { localWakeTarget } from './companion/wol'
import { isPaused, onPauseChanged, pauseState, setPaused, stopPauseTimer } from './store/pause'
import { encryptionAvailable, hasSecret } from './secrets/keystore'
import { registerAllTools } from './tools/index'
import { registerAllRemedies } from './selfheal/remedies'
import { startSelfHealMonitor, stopSelfHealMonitor } from './selfheal/monitor'
import { abortAllTools, hasRunningTools } from './tools/runner'
import { clearChallenges, hasOpenChallenge } from './tools/permissions'
import { reloadMcpServers, shutdownMcp } from './mcp/client'
import { scheduleMemoryCare } from './agent/memoryCare'
import { startScheduler, stopScheduler } from './scheduler/cron'
import { watchPcProfile } from './agent/pcProfile'
import { watchDailyBriefing } from './agent/dailyBriefing'
import { startTimers, stopTimers } from './scheduler/timers'
import { startReminders, stopReminders } from './scheduler/reminders'
import { ensureLocalAssets } from './local/assets'
import { startBackups, stopBackups, flushBackups } from './store/backups'
import { shutdownInput } from './automation/inputServer'
import { stopLocalServices } from './local/service'
import { stopUia } from './automation/uia'
import { installPendingUpdate, startAutoUpdate } from './updater'
import { needsGeminiForVoice } from '../shared/startupRequirements'
import { constants as priorities, setPriority } from 'node:os'
import { isTransientNetworkError } from '../shared/transientError'

// Als Allererstes, noch vor jeder anderen Zeile Arbeit: Was hier passiert,
// soll auch dann nachlesbar sein, wenn es beim Start schiefgeht.
initLogging()

const VERSION = app.getVersion()
let tray: Tray | null = null

/**
 * Argument des Autostart-Eintrags.
 *
 * `openAsHidden` allein reicht unter Windows nicht — das Feld wertet nur macOS
 * aus. Das Fenster hält sich deshalb an diesem Argument zurück, siehe
 * `windows/crystal.ts`.
 */
const LOGIN_ARGS = ['--hidden']

/** "21:45" — für die Frist einer befristeten Stilllegung im Tray. */
function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
}

// Nur eine Instanz — sonst kämpfen zwei Kristalle um das Mikrofon.
//
// `app.quit()` allein hält den Rest dieser Datei nicht an: `whenReady` feuerte
// in der zweiten Instanz trotzdem, und die öffnete dieselbe Datenbank, griff
// nach denselben Ports und zeigte kurz einen zweiten Kristall. Deshalb prüft
// der Start unten zusätzlich, ob er überhaupt an der Reihe ist.
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = getCrystalWindow()
    if (win) {
      // Ein minimiertes Fenster bleibt bei `show()` in der Taskleiste liegen.
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
}

function buildTray(): void {
  // Nicht über __dirname: im Paket zeigt das ins asar-Archiv, wo das Symbol
  // nicht liegt — das Tray hätte dann still ein leeres Bild.
  const icon = nativeImage
    .createFromPath(resourceFile('tray.png'))
    .resize({ width: 16, height: 16 })
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('James-Jarvis')

  let onTop = false

  const rebuild = (): void => {
    const menu = Menu.buildFromTemplate([
      { label: 'Fenster anzeigen / verstecken', click: () => toggleCrystalVisibility() },
      {
        label: 'James stilllegen',
        type: 'checkbox',
        checked: isPaused(),
        // Nur den Zustand setzen: Der Kristall erfährt es über den Melder
        // weiter unten, genau wie beim Hotkey und beim Ablauf einer Frist.
        click: (item) => setPaused(item.checked)
      },
      { type: 'separator' },
      { label: 'Einstellungen…', click: () => createSettingsWindow() },
      { label: 'Aktionslog…', click: () => createSettingsWindow('audit') },
      { type: 'separator' },
      {
        label: 'Immer im Vordergrund',
        type: 'checkbox',
        checked: onTop,
        click: (item) => {
          onTop = item.checked
          getCrystalWindow()?.setAlwaysOnTop(onTop, 'floating')
        }
      },
      { type: 'separator' },
      { label: `Version ${VERSION}`, enabled: false },
      { label: 'Beenden', click: () => app.quit() }
    ])
    tray?.setContextMenu(menu)

    // Die Uhrzeit statt der Restdauer: Der Tooltip wird nur bei einer
    // Änderung neu gesetzt, und "noch 30 Minuten" wäre eine halbe Stunde
    // später gelogen. "bis 21:45" bleibt richtig, solange es gilt.
    const { paused, until } = pauseState()
    tray?.setToolTip(
      !paused
        ? 'James-Jarvis'
        : until === null
          ? 'James-Jarvis — stillgelegt'
          : `James-Jarvis — stillgelegt bis ${clockTime(until)}`
    )
  }

  /**
   * Die eine Stelle, an der eine Änderung der Pause bekanntgegeben wird.
   *
   * Vier Auslöser führen hierher: das Häkchen oben, der Hotkey, der Kristall
   * (über `app:pauseState`) und der abgelaufene Wecker einer befristeten
   * Pause. Der letzte ist der Grund für die Zusammenlegung — er entsteht im
   * Hauptprozess, während der Renderer stillgelegt ist, und muss trotzdem
   * dort ankommen. Jeder Auslöser einzeln benachrichtigen zu lassen hieße,
   * dass genau der eine, der es am nötigsten hat, es vergessen könnte.
   *
   * Der Rückweg zum Kristall, der die Meldung selbst geschickt hat, ist kein
   * Kreis: Dort steht die Pause dann schon so, und `setPaused` steigt bei
   * unverändertem Zustand sofort wieder aus.
   */
  onPauseChanged((state) => {
    rebuild()
    sendToCrystal('app:togglePause', { paused: state.paused, until: state.until })
  })
  rebuild()
  tray.on('click', () => toggleCrystalVisibility())
}

/**
 * Not-Aus. Dreimal Escape innerhalb einer Sekunde bricht alles ab:
 * laufende Tools und offene Rückfragen.
 *
 * Bewusst nicht auf eine exotische Tastenkombination gelegt — im Zweifel
 * hämmert man Escape.
 *
 * Entscheidend ist aber, wann der Griff nach der Taste gilt: Ein global
 * registriertes Escape wird vom Betriebssystem *abgefangen* und erreicht das
 * Programm im Vordergrund nicht mehr. Dauerhaft registriert hätte James damit
 * jedem anderen Fenster auf dem Rechner die Escape-Taste weggenommen — kein
 * Dialog ließe sich mehr schließen, kein Vollbild verlassen, und in Minecraft,
 * also genau dem Fall, für den der Hotkey gedacht ist, ginge das Pausenmenü
 * nicht mehr auf.
 *
 * Deshalb wird die Taste nur gehalten, solange es überhaupt etwas abzubrechen
 * gibt. In der übrigen Zeit — also fast immer — verhält sich Escape völlig
 * normal.
 */
let killSwitchHeld = false
let killSwitchWatcher: NodeJS.Timeout | null = null
let escapeHits: number[] = []

function fireKillSwitch(): void {
  const now = Date.now()
  escapeHits = escapeHits.filter((t) => now - t < 1000)
  escapeHits.push(now)
  if (escapeHits.length < 3) return

  escapeHits = []
  abortAllTools()
  clearChallenges()
  sendToCrystal('state:set', { state: 'idle', reason: 'kill switch' })
  broadcast('toast:error', { message: 'Alles abgebrochen.' })
  // Sofort loslassen statt auf den nächsten Durchlauf zu warten: nach dem
  // Abbruch läuft nichts mehr, und die Taste gehört wieder dem Vordergrund.
  syncKillSwitch()
}

/** Holt bzw. gibt Escape zurück, je nachdem ob gerade etwas läuft. */
function syncKillSwitch(): void {
  const needed = hasRunningTools() || hasOpenChallenge()
  if (needed === killSwitchHeld) return

  if (needed) {
    killSwitchHeld = globalShortcut.register('Escape', fireKillSwitch)
    if (!killSwitchHeld) console.warn('[main] Escape konnte nicht global registriert werden')
  } else {
    globalShortcut.unregister('Escape')
    killSwitchHeld = false
    escapeHits = []
  }
}

/**
 * Abgefragt statt gemeldet.
 *
 * Der Zustand entsteht an mehreren Stellen — jedem Start und Ende eines
 * Werkzeugs, jeder ausgestellten und jeder eingelösten Rückfrage. Diese
 * Stellen einzeln melden zu lassen hieße, dass ein einziger vergessener Aufruf
 * die Escape-Taste dauerhaft belegt lässt. Zwei Größenabfragen alle 400 ms
 * kosten nichts und können nicht auseinanderlaufen.
 */
function startKillSwitchWatcher(): void {
  if (killSwitchWatcher) return
  killSwitchWatcher = setInterval(syncKillSwitch, 400)
  killSwitchWatcher.unref?.()
}

/**
 * Autostart mit Windows.
 *
 * Wird bei jedem Start und nach jeder Änderung neu gesetzt, statt sich auf
 * einen einmal geschriebenen Registrierungseintrag zu verlassen: Der Pfad zur
 * ausführbaren Datei ändert sich bei jedem Update, und ein Eintrag, der ins
 * Leere zeigt, ist schlimmer als keiner — Windows meldet dann bei jeder
 * Anmeldung einen Fehler.
 *
 * `openAsHidden` gehört dazu: Wer den Autostart einschaltet, will einen
 * mitlaufenden Assistenten, kein Fenster, das ihm beim Anmelden ins Gesicht
 * springt. Erreichbar bleibt er über das Symbol im Infobereich.
 */
function applyLaunchOnStartup(): void {
  // Im Entwicklungslauf zeigt der Pfad auf die Electron-Binärdatei in
  // node_modules. Einen Autostart darauf einzutragen wäre für den Nutzer
  // unsichtbarer Unfug.
  if (!app.isPackaged) return

  const enabled = getSettings().launchOnStartup

  // Mit denselben Argumenten abfragen wie beim Setzen: Windows vergleicht den
  // Eintrag samt Argumenten, und ohne sie meldet Electron jedes Mal "steht
  // nicht drin" — wir würden bei jedem Start neu schreiben.
  const current = app.getLoginItemSettings({ args: LOGIN_ARGS })
  if (current.openAtLogin === enabled) return

  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true,
    args: LOGIN_ARGS
  })
}

/**
 * Welche Tasten zuletzt registriert wurden.
 *
 * Jede Änderung irgendeiner Einstellung — auch jeder Tastendruck in einem
 * Textfeld — meldet sich über `onSettingsChanged`. Die Tasten jedes Mal
 * abzumelden und neu anzumelden ließ sie für einen Augenblick tot und nahm
 * nebenbei das gehaltene Escape mit. Neu registriert wird nur, wenn sich an
 * den Tasten selbst etwas geändert hat.
 */
let hotkeySignature: string | null = null

function hotkeysOf(wake: ReturnType<typeof getSettings>['wake']): string {
  return `${wake.pushToTalkHotkey ?? ''}|${wake.pauseHotkey ?? ''}`
}

function registerHotkeys(): void {
  // Nimmt auch ein gerade gehaltenes Escape mit — die Buchhaltung muss das
  // wissen, sonst gilt es als registriert und wird nie wieder angefordert.
  globalShortcut.unregisterAll()
  killSwitchHeld = false
  syncKillSwitch()

  const wake = getSettings().wake
  hotkeySignature = hotkeysOf(wake)

  if (wake.pushToTalkHotkey) {
    const ok = globalShortcut.register(wake.pushToTalkHotkey, () => {
      const win = getCrystalWindow()
      if (!win) return
      win.show()
      win.webContents.send('hotkey:pushToTalk')
    })
    if (!ok) console.warn(`[main] Hotkey ${wake.pushToTalkHotkey} ist belegt`)
  }

  // Stilllegen muss auch dann gehen, wenn Minecraft im Vollbild läuft und man
  // gerade nicht an den Kristall kommt.
  if (wake.pauseHotkey && wake.pauseHotkey !== wake.pushToTalkHotkey) {
    const ok = globalShortcut.register(wake.pauseHotkey, () => setPaused(!isPaused()))
    if (!ok) console.warn(`[main] Hotkey ${wake.pauseHotkey} ist belegt`)
  }
}

/**
 * Server für das Telefon an- oder abschalten, je nach Einstellung.
 *
 * Ein Portwechsel bei laufendem Server verlangt einen Neustart des Servers —
 * `listen` lässt sich nicht umhängen. Deshalb erst stoppen, dann starten, und
 * zwar auch dann, wenn nur der Port geändert wurde.
 */
let companionPort: number | null = null

/**
 * Besorgt das Zertifikat aus der gewählten Quelle.
 *
 * Beide Wege enden in derselben Form, weil den Server nicht interessiert, wer
 * unterschrieben hat — nur, dass etwas Gültiges vorliegt. Kommt nichts zurück,
 * läuft er im Klartext weiter: Anzeige und Tippfeld gehen, die Sprechtaste
 * nicht. Das ist wenig, aber mehr als ein Server, der gar nicht erst startet.
 */
async function companionTls(source: 'local' | 'tailscale'): Promise<TlsMaterial | null> {
  if (source === 'tailscale') {
    const cert = await ensureCert()
    return cert
      ? { hostname: cert.hostname, pem: { certFile: cert.certFile, keyFile: cert.keyFile } }
      : null
  }

  const target = localWakeTarget()
  if (!target) return null
  const cert = await ensureLocalCert(target.address)
  return cert
    ? {
        hostname: cert.address,
        pfx: { file: cert.pfxFile, passphrase: cert.passphrase },
        caFile: cert.caFile
      }
    : null
}

async function applyCompanionSettingNow(): Promise<void> {
  const { companion } = getSettings()

  if (!companion.enabled) {
    companionPort = null
    await stopCompanion()
    return
  }
  if (isCompanionRunning() && companionPort === companion.port) return

  await stopCompanion()
  try {
    // Ohne Zertifikat startet er trotzdem — nur eben ohne Mikrofon auf dem
    // Telefon. Das Warten darauf blockiert den Start nicht länger als das
    // Ausstellen dauert, und bei einem gültigen ist beides sofort zurück.
    const cert = await companionTls(companion.certSource)
    await startCompanion(companion.port, cert)
    companionPort = companion.port
    if (!cert) {
      console.info('[companion] kein Zertifikat — die Sprechtaste am Telefon bleibt gesperrt')
    }
  } catch (err) {
    companionPort = null
    const message = err instanceof Error ? err.message : String(err)
    console.error('[companion] Server ließ sich nicht starten:', message)
    broadcast('toast:error', {
      message: message.includes('EADDRINUSE')
        ? `Port ${companion.port} ist belegt. Wähle unter Einstellungen, Telefon einen anderen.`
        : `Der Server für das Telefon ließ sich nicht starten: ${message}`
    })
  }
}

/**
 * Einstellungen und Selbstheilung können denselben Neustart fast gleichzeitig
 * anstoßen. Seriell ausgeführt sieht der zweite Lauf den fertigen Zustand des
 * ersten, statt ihm während stop/start den Server unter den Füßen wegzuziehen.
 */
let companionApplyQueue = Promise.resolve()

function applyCompanionSetting(): Promise<void> {
  const run = companionApplyQueue.then(() => applyCompanionSettingNow())
  companionApplyQueue = run.catch(() => undefined)
  return run
}

async function reloadCrystalAfterCrash(): Promise<boolean> {
  const window = getCrystalWindow()
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false

  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      window.webContents.removeListener('did-finish-load', loaded)
      resolve(ok)
    }
    const loaded = (): void => finish(true)
    const timer = setTimeout(() => finish(false), 8_000)
    window.webContents.once('did-finish-load', loaded)
    window.webContents.reload()
  })
}

app.whenReady().then(async () => {
  if (!primaryInstance) return
  electronApp.setAppUserModelId('dev.void.jarvis')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  try {
    initDb()
  } catch (err) {
    // Ohne Datenbank läuft nichts davon. Ein Fehler hier blieb früher als
    // unbehandelte Zurückweisung stehen: kein Fenster, kein Tray, aber der
    // Prozess lebte weiter und hielt die Einzelinstanz-Sperre — jeder neue Start
    // beendete sich sofort, und der Nutzer sah nichts.
    console.error('[main] Datenbank ließ sich nicht öffnen:', err)
    dialog.showErrorBox(
      'James-Jarvis',
      'Die Datenbank ließ sich nicht öffnen. Beende alle Void-James-Prozesse im Task-Manager und starte neu.\n\n' +
        (err instanceof Error ? err.message : String(err))
    )
    app.exit(1)
    return
  }
  registerAllTools()
  startAutoUpdate()
  registerAllRemedies({
    restartCompanion: async () => {
      await applyCompanionSetting()
      return companionStatus().running
    },
    reloadRenderer: reloadCrystalAfterCrash
  })
  registerIpcHandlers(VERSION)
  startDiagnosticMonitor()
  startSelfHealMonitor()

  createCrystalWindow()
  watchPcProfile(getCrystalWindow)
  watchDailyBriefing(getCrystalWindow)
  buildTray()
  registerHotkeys()
  startKillSwitchWatcher()
  applyLaunchOnStartup()

  void applyCompanionSetting()

  onSettingsChanged((settings) => {
    if (hotkeysOf(settings.wake) !== hotkeySignature) registerHotkeys()
    applyLaunchOnStartup()
    void applyCompanionSetting()
  })

  // MCP, Zeitplaner und Timer blockieren den Start nicht — der Kristall ist
  // sofort da.
  void reloadMcpServers().then(() => {
    sendToCrystal('session:forceReconnect', undefined)
  }).catch(error => console.error('[mcp] Initiales Laden fehlgeschlagen:', error))
  scheduleMemoryCare()
  startScheduler()
  startTimers()
  startReminders()
  startBackups()
  // Whisper, Piper und Stimme fehlen nach einer frischen Installation; ohne
  // sie hört und spricht James nicht. Im Hintergrund holen, nach dem Aufbau.
  setTimeout(() => { if (!getSettings().gamingMode) void ensureLocalAssets() }, 3_000).unref()
  // Programmsymbole für die Denkblase, ein paar Sekunden nach dem Start: Der
  // PowerShell-Aufruf soll nicht mit dem Aufbau des Kristalls konkurrieren.
  setTimeout(() => { if (!getSettings().gamingMode) void prefetchAppIcons() }, 8_000).unref()
  const applyGamingPriority = (): void => {
    try { setPriority(0, getSettings().gamingMode ? priorities.priority.PRIORITY_BELOW_NORMAL : priorities.priority.PRIORITY_NORMAL) } catch { /* OS may restrict priority changes. */ }
  }
  applyGamingPriority()
  onSettingsChanged(applyGamingPriority)

  // Erreichbar werden, falls eingeschaltet. Auch das blockiert den Start
  // nicht: Ein Tunnel braucht ein paar Sekunden, und niemand soll währenddessen
  // auf einen schwarzen Bildschirm sehen. Schlägt es fehl, steht der Grund im
  // Protokoll und in den Einstellungen — nicht in einem Fenster, das jemanden
  // beim Hochfahren anspringt.
  // Linphone: braucht keinen Tunnel, die Verbindung geht von hier aus.
  startSip()
  watchSipSettings()

  /*
   * Dasselbe für die Alexa-Skill.
   *
   * Muss beim Start passieren und nicht erst, wenn jemand die Einstellungen
   * aufmacht: Ein Echo Dot wird angesprochen, ohne dass vorher jemand am
   * Rechner sitzt — das ist der ganze Sinn der Sache. Der Fehlerfall ist
   * ebenso still wie oben, aus demselben Grund: Ein Fenster, das beim
   * Anmelden aufspringt, weil ein Tunnel nicht wollte, ist eine Zumutung für
   * etwas, das man ohnehin nur in den Einstellungen beheben kann.
   */
  if (getSettings().alexa.enabled) {
    void startAlexa()
      .then((status) => console.info(`[alexa] Erreichbar unter ${status.endpoint}`))
      .catch((err) => console.info('[alexa] nicht erreichbar:', String(err).slice(0, 200)))
  }

  if (!encryptionAvailable()) {
    broadcast('toast:error', {
      message:
        'Verschlüsselter Speicher steht nicht zur Verfügung. API-Keys können nicht gesichert abgelegt werden.'
    })
  }

  // Ohne Gemini-Schlüssel kann die App gar nichts. Das Fenster geht deshalb
  // von selbst auf — und zeigt dann den Einrichtungsassistenten, nicht die
  // Abschnittsleiste: Genau das ist der Fall, in dem noch niemand wissen
  // kann, wonach er suchen müsste. Der Abschnitt hier ist nur die Landung
  // für den, der den Assistenten überspringt.
  if (needsGeminiForVoice(getSettings()) && !hasSecret('gemini')) {
    createSettingsWindow('keys')
  }
})

app.on('window-all-closed', () => {
  // Der Tray hält die App am Leben; Schließen des Kristalls beendet sie nicht.
  if (process.platform !== 'darwin' && !tray) app.quit()
})

/**
 * Ob das Aufräumen beim Beenden schon gelaufen ist.
 *
 * Die Hälfte davon ist asynchron — der Funnel wird per Befehl abgeschaltet,
 * Server schließen über Rückrufe. Ohne Warten endete der Prozess, bevor auch
 * nur der erste davon an der Reihe war, und genau der Funnel, um den es in
 * den Kommentaren unten geht, blieb offen. Deshalb hält `will-quit` das
 * Beenden einmal an, wartet höchstens ein paar Sekunden und beendet dann
 * selbst mit `app.exit`, das dieses Ereignis nicht noch einmal auslöst.
 */
let quitCleanupStarted = false
const QUIT_CLEANUP_MS = 15_000

app.on('will-quit', (event) => {
  if (quitCleanupStarted) return
  quitCleanupStarted = true
  event.preventDefault()

  if (killSwitchWatcher) clearInterval(killSwitchWatcher)
  killSwitchWatcher = null
  globalShortcut.unregisterAll()
  stopPauseTimer()
  stopScheduler()
  stopTimers()
  stopReminders()
  stopBackups()
  stopSelfHealMonitor()
  stopDiagnosticMonitor()
  shutdownInput()
  stopUia()
  // whisper und piper laufen als eigene Prozesse weiter, wenn niemand sie
  // beendet. Ein zurückgelassener whisper-server hält ein halbes Gigabyte
  // Modell im Speicher und den Port besetzt — und beim nächsten Start redet die
  // App mit dem Gespenst statt mit dem neuen Dienst.
  stopLocalServices()

  const pending = Promise.allSettled([
    stopLocalServer(),
    flushBackups(),
    stopCompanion(),
    // Der Tunnel gehört unbedingt zu: Ein Funnel, der die App überlebt, zeigt
    // weiter auf einen Port, hinter dem nichts mehr sitzt — und stünde beim
    // nächsten Start offen, ohne dass jemand ihn eingeschaltet hätte.
    // Beides hängt am selben Server und am selben Tunnel — Telefonie und die
    // Alexa-Skill. Deshalb hier der harte Halt und nicht die beiden einzelnen
    // Abschaltungen: Die schonen einander, und wenn beide eingeschaltet sind,
    // verlässt sich jede auf die andere und keine macht zu.
    shutdownPublicEndpoint(),
    Promise.resolve(stopSip()),
    // Der Sprachdienst belegt die Grafikkarte, bis sein Prozess endet. Bliebe
    // er stehen, wäre die Karte nach dem Beenden der App weiter zu drei
    // Vierteln belegt — für ein Modell, das niemand mehr fragt.
    shutdownMcp()
  ])
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, QUIT_CLEANUP_MS))

  void Promise.race([pending, deadline]).finally(() => {
    // Die WASM-Variante von SQLite gibt ihren Speicher nur beim expliziten
    // Schließen frei — und schreibt dabei das WAL zurück.
    closeDb()
    // Ein geladenes Update jetzt einspielen. Der eigene Weg von
    // electron-updater wartet auf `quit`, und das feuert bei `app.exit` nicht.
    installPendingUpdate()
    app.exit(0)
  })
})

process.on('uncaughtException', (err) => {
  if (isTransientNetworkError(err)) {
    console.warn('[main] Verbindung abgerissen:', (err as NodeJS.ErrnoException).code)
    return
  }
  console.error('[main] Unbehandelter Fehler:', err)
  broadcast('toast:error', { message: err.message })
})
