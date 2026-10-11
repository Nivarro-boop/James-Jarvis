import { realtimeAccess } from '../providers/realtimeAccess'
import { diagnosticReport } from '@shared/diagnosticReport'
import { sendDiagnosticReport } from '../providers/diagnosticSender'
import { app, BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import type { IpcInvokeMap } from '@shared/ipc'
import { revealLog } from '../logging'
import { resourceFile } from '../resources'
import { readWakeAsset, wakeStatus } from '../providers/wakeStatus'
import { isValidTile, readTile } from '../maps/tiles'
import { getSettings, resetSettings, setSettings } from '../store/settings'
import { createBackup, listBackups, revealBackups } from '../store/backups'
import {
  clearMcpSecrets,
  clearSecret,
  getSecret,
  mcpSecretStatus,
  secretStatus,
  setMcpSecret,
  setSecret
} from '../secrets/keystore'
import { ENV_NAME } from '@shared/mcp'
import { geminiToolDeclarations, openAiToolSchemas, toolMetas } from '../tools/registry'
import { registerAllTools } from '../tools/index'
import { runCancellableTool, cancelToolCall } from '../tools/runner'
import { permissionFor } from '../tools/permissions'
import { activityStart, activityAnnotate, activityEnd } from '../agent/activity'
import { companionHostKey, companionStatus, rotateToken } from '../companion/server'
import { armWake, wakeReadiness } from '../companion/wol'
import { companionSetup, runSetupAction } from '../companion/setup'
import {
  clearActions,
  clearIncidents,
  clearSavings,
  costSince,
  countSince,
  deleteContact,
  deleteMemory,
  deleteSchedule,
  deleteTimer,
  deleteWatch,
  getResearch,
  listActions,
  listContacts,
  listMemories,
  listResearch,
  listSchedules,
  listTimers,
  listWatches,
  upsertContact,
  upsertSchedule
} from '../db'
import { runAutomaticRepair, selfHealDashboard } from '../selfheal/monitor'
import { addMemory, reviseMemory } from '../agent/memory'
import { buildSystemPrompt } from '../agent/prompt'
import { checkConnections } from '../agent/connections'
import { openForLogin } from '../automation/chromeCdp'
import { deliverCameraFrame } from '../automation/camera'
import { smartHomeStatus } from '../smarthome/homeAssistant'
import { connectSpotify, disconnectSpotify, forgetMusicCaches, musicStatus } from '../music'
import { alexaStatus, startAlexa, stopAlexa } from '../alexa'
import { clearResultCache, recordExternalSaving, tokenReport } from '../agent/tokenSaver'
import { pauseState, setPaused } from '../store/pause'
import { loginMcpServer, mcpStatus, reloadMcpServers } from '../mcp/client'
import { forgetMcpLogin } from '../mcp/oauth'
import { activitySnapshot } from '../agent/activity'
import { reloadSchedules } from '../scheduler/cron'
import { listReminders } from '../db'
import { completeReminder, createReminder, snoozeReminder } from '../scheduler/reminders'
import { hermesHealth, hermesRun } from '../providers/hermes'
import { startHermesGateway } from '../providers/hermesService'
import { cancelChatGptSignIn, chatGptStatus, connectChatGpt, disconnectChatGpt } from '../providers/chatgptAuth'
import { chatGptModels, chatGptResponse, chatGptTools } from '../providers/chatgptResponses'
import { consumeModelCall, withModelBudget } from '../agent/modelBudget'
import { connectGoogle, disconnectGoogle, hasCalendarAuth, hasGoogleAuth } from '../providers/googleAuth'
import { listModels as listOpenRouterModels } from '../providers/openrouter'
import {
  forgetOllamaReachability,
  listOllamaModels,
  ollamaInstalled,
  ollamaReachable,
  warmOllama
} from '../providers/ollama'
import { shutdownTelephony, startIncoming, telephonyStatus, testTelephonySetup } from '../telephony'
import { callUser, sipStatus, startSip } from '../telephony/sip'
import { installUpdateNow, postponeUpdate, updateStatus } from '../updater'
import { startVoiceService, stopVoiceService, voiceServiceStatus } from '../voice/vibevoice'
import {
  elevenBestModel,
  elevenPreview,
  checkElevenKey,
  elevenQuota,
  elevenVoices,
  forgetElevenCache,
  noteElevenSpent
} from '../providers/elevenlabs'
import { ollamaHealth } from '../providers/ollama'
import { transcribe, whisperHealth, forgetWhisperWarmup } from '../providers/whisper'
import {
  forgetPiperWarmup,
  piperAbort,
  piperHealth,
  piperPrewarm,
  piperSpeak
} from '../providers/piper'
import { installLocalAsset, localAssets } from '../local/assets'
import { createSettingsWindow } from '../windows/settings'
import { getCrystalWindow, setAlwaysOnTop } from '../windows/crystal'
import { broadcast, sendToCrystal } from './emit'
import { capabilityGaps } from '../agent/capabilityGaps'

/** Laufende ChatGPT-Runden, damit Dazwischenreden sie abbrechen kann. */
const chatGptRequests = new Map<string, AbortController>()
const hermesRequests = new Map<string, AbortController>()

type Handler<C extends keyof IpcInvokeMap> = (
  payload: IpcInvokeMap[C]['req']
) => IpcInvokeMap[C]['res'] | Promise<IpcInvokeMap[C]['res']>

/**
 * Kommt der Aufruf aus einem der eigenen Fenster?
 *
 * Die Preload-Brücke ist nur in den eigenen Fenstern geladen, und deren
 * Navigation ist abgeriegelt (`windows/external.ts`). Trotzdem prüft der
 * Empfänger selbst: Hinter diesen Kanälen liegen Schlüssel, Werkzeuge und
 * Einstellungen, und ein eingebetteter Rahmen oder ein künftiges Fenster ohne
 * Riegel soll sie nicht dadurch erreichen, dass anderswo etwas übersehen wurde.
 */
function trustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  // Über Prozess- und Routing-Nummer vergleichen, nicht über die Objektidentität:
  // Ob Electron für denselben Rahmen immer dasselbe Objekt liefert, ist nicht
  // zugesagt — und wenn nicht, stünde hier jeder Kanal still.
  const main = event.sender.mainFrame
  if (!frame || frame.processId !== main.processId || frame.routingId !== main.routingId) return false
  return BrowserWindow.fromWebContents(event.sender) !== null
}

function handle<C extends keyof IpcInvokeMap>(channel: C, fn: Handler<C>): void {
  ipcMain.handle(channel as string, async (event, payload) => {
    if (!trustedSender(event)) {
      console.warn(`[ipc] Aufruf von ${channel} aus fremder Quelle abgewiesen.`)
      throw new Error('IPC-Aufruf nicht erlaubt.')
    }
    return fn(payload)
  })
}

/**
 * Werkzeuge neu aufbauen und die Live-Sitzung dazu bringen, die neue Liste
 * abzuholen. Siehe die Begründung bei den Secret-Handlern.
 */
function refreshTools(): void {
  registerAllTools()
  sendToCrystal('session:forceReconnect', undefined)
}

/**
 * Das lokale Modell in den Speicher holen, sobald es zuständig ist.
 *
 * Gemessen auf diesem Rechner: gemma4 braucht kalt 29,5 Sekunden bis zur
 * Antwort, warm 0,96. Der Unterschied ist fast vollständig das Laden von der
 * Platte, nicht das Rechnen. Ohne diese Zeile bezahlt genau der erste Aufruf
 * nach dem Umstellen die halbe Minute — also der, an dem der Nutzer beurteilt,
 * ob die Einstellung etwas taugt.
 *
 * Ollama hält das Modell danach `keep_alive` lang, siehe `warmOllama`. Fehler
 * sind hier belanglos: Klappt es nicht, dauert der erste echte Aufruf eben so
 * lang wie vorher.
 */
function keepLocalModelWarm(settings: ReturnType<typeof getSettings>): void {
  if (settings.brainProvider !== 'ollama') return
  const local = settings.localFallback
  if (!local?.model) return
  void ollamaReachable(local.baseUrl).then((reachable) => {
    if (reachable) void warmOllama(local.model, local.baseUrl)
  })
}

export function registerIpcHandlers(version: string): void {
  let diagnosticSending = false
  // ── Einstellungen ──────────────────────────────────────────
  handle('settings:get', () => getSettings())
  handle('wake:status', () => wakeStatus())
  handle('wake:asset', (payload) => readWakeAsset(String(payload?.name ?? '')))
  // Die Zahlen kommen aus dem Renderer und landen in Adresse und Dateiname —
  // geprüft wird deshalb hier, an der Grenze, und noch einmal in `readTile`.
  handle('maps:tile', (payload) => {
    const z = Number(payload?.z)
    const x = Number(payload?.x)
    const y = Number(payload?.y)
    return isValidTile(z, x, y) ? readTile(z, x, y) : null
  })
  handle('backup:list', () => listBackups())
  handle('backup:create', () => createBackup())
  handle('backup:openFolder', () => revealBackups())
  handle('settings:set', (patch) => {
    const before = getSettings()
    const next = setSettings(patch)
    broadcast('settings:changed', next)
    keepLocalModelWarm(next)

    /**
     * Eine geänderte Einstellung macht die gemessene Aufwärmzeit wertlos.
     *
     * Beide Dienste setzen sich zwar von selbst neu auf, wenn ihre Startzeile
     * sich ändert — die Messung daneben tun sie nicht. Ohne diese zwei Zeilen
     * stünde nach einem Wechsel auf `medium` weiter die Sekunde von `base` in
     * den Einstellungen, und das ist genau die Zahl, wegen der jemand wechselt.
     *
     * Bei piper kommt ein zweiter Grund dazu: Die Stimme steckt in der geladenen
     * ONNX-Sitzung, nicht in einem Pfad, den man beim nächsten Satz neu liest.
     */
    if (JSON.stringify(before.whisper) !== JSON.stringify(next.whisper)) forgetWhisperWarmup()
    if (JSON.stringify(before.piper) !== JSON.stringify(next.piper)) forgetPiperWarmup()

    return next
  })
  handle('settings:reset', () => {
    const next = resetSettings()
    broadcast('settings:changed', next)
    keepLocalModelWarm(next)
    return next
  })

  // Und einmal beim Start, nicht erst wenn jemand die Einstellungen anfasst:
  // Wer Ollama eingestellt hat, soll die halbe Minute Ladezeit nicht beim
  // ersten Satz des Tages bezahlen.
  keepLocalModelWarm(getSettings())

  // ── Secrets ────────────────────────────────────────────────
  //
  // Nach jeder Änderung die Werkzeuge neu aufbauen und die Sitzung neu
  // aufsetzen. Beides ist nötig, und zwar in dieser Reihenfolge:
  //
  // Ob ein Werkzeug überhaupt existiert, entscheidet sich beim Registrieren an
  // `requiresSecret` — ohne den Neuaufbau wären Twitch, Higgsfield und die
  // Gmail-Schnittstelle bis zum nächsten Start der App weiterhin weg, obwohl
  // der Schlüssel eingetragen ist.
  //
  // Und die Werkzeugliste geht nur beim Verbindungsaufbau über die Leitung.
  // Ohne den Neuaufbau kennt das laufende Modell die neuen Werkzeuge bis zu
  // fünfzehn Minuten lang nicht — der Nutzer trägt den Schlüssel ein und
  // bekommt trotzdem "das kann ich nicht" zu hören.
  handle('secrets:status', () => secretStatus())
  handle('secrets:set', ({ key, value }) => {
    // Am Telefon gibt es nur das Tastenfeld. Eine PIN mit Buchstaben ließe
    // sich dort nie eintippen, und eine zu kurze wäre schnell erraten.
    if (key === 'phonePin' && !/^\d{4,8}$/.test(value.trim())) {
      throw new Error('Die PIN muss aus 4 bis 8 Ziffern bestehen.')
    }
    setSecret(key, value)
    if (key === 'sipPassword') startSip()
    // Ein neuer Schlüssel heißt womöglich ein anderes Konto: Kontingent,
    // Stimmen und Modelle von vorhin gelten dafür nicht.
    if (key === 'elevenlabs') forgetElevenCache()
    refreshTools()
    // Der Apple-Entwicklerschlüssel wird zu einem Token, der zwölf Stunden
    // gilt und im Speicher liegt. Ohne dieses Wegwerfen liefe ein gerade
    // korrigierter Schlüssel bis morgen früh in denselben 401.
    forgetMusicCaches()
    return secretStatus()
  })
  handle('secrets:clear', ({ key }) => {
    clearSecret(key)
    if (key === 'elevenlabs') forgetElevenCache()
    refreshTools()
    forgetMusicCaches()
    return secretStatus()
  })
  handle('secrets:checkGemini', async ({ value }) => {
    const key = value.trim()
    if (!key) return { ok: false, error: 'Da steht noch nichts.' }

    // Die Modellliste, nicht eine Erzeugung: Sie kostet keine Token, antwortet
    // in Sekundenbruchteilen und schlägt bei einem ungültigen Schlüssel genau
    // so fehl wie jeder andere Aufruf auch. Damit ist die Prüfung ehrlich,
    // ohne dass sie etwas verbraucht.
    let res: Response
    try {
      res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
        headers: { 'x-goog-api-key': key },
        signal: AbortSignal.timeout(15_000)
      })
    } catch {
      return {
        ok: false,
        error:
          'Google war nicht erreichbar. Prüf die Internetverbindung — am Schlüssel liegt es vermutlich nicht.'
      }
    }

    if (res.ok) {
      // Erst jetzt ablegen. Ein Schlüssel, der nicht geht, hat im Speicher
      // nichts verloren — sonst steht in den Einstellungen „hinterlegt" und
      // die App funktioniert trotzdem nicht.
      setSecret('gemini', key)
      refreshTools()
      return { ok: true }
    }

    if (res.status === 400 || res.status === 401) {
      return {
        ok: false,
        error: 'Google nimmt diesen Schlüssel nicht an. Meistens fehlt beim Kopieren ein Stück.'
      }
    }
    if (res.status === 403) {
      return {
        ok: false,
        error: 'Der Schlüssel ist echt, darf aber nicht auf die Gemini-API. Leg im AI Studio einen neuen an.'
      }
    }
    if (res.status === 429) {
      return { ok: false, error: 'Das Kontingent dieses Schlüssels ist gerade aufgebraucht.' }
    }
    return { ok: false, error: `Google antwortete mit Fehler ${res.status}.` }
  })

  /**
   * Wie beim Gemini-Schlüssel: erst fragen, dann ablegen.
   *
   * Ein abgelehnter ElevenLabs-Schlüssel fiel bisher erst beim Sprechen auf,
   * als „ElevenLabs steht nicht bereit" ohne Grund.
   */
  handle('secrets:checkEleven', async ({ value }) => {
    const key = value.trim()
    if (!key) return { ok: false, error: 'Da steht noch nichts.' }
    const result = await checkElevenKey(key)
    if (!result.ok) return result
    setSecret('elevenlabs', key)
    forgetElevenCache()
    refreshTools()
    return result
  })

  handle('secrets:checkOpenai', async ({ value }) => {
    const key = value.trim()
    if (!key) return { ok: false, error: 'Da steht noch nichts.' }
    try {
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000)
      })
      await response.body?.cancel()
      if (!response.ok) return { ok: false, error: `OpenAI nimmt den Schlüssel nicht an (${response.status}). Prüfe API-Zugang und Projektberechtigungen.` }
      setSecret('openai', key)
      refreshTools()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error && e.name === 'TimeoutError'
        ? 'Die OpenAI-Prüfung hat zu lange gedauert.' : 'OpenAI ist gerade nicht erreichbar. Der Schlüssel wurde nicht gespeichert.' }
    }
  })

  // Der Live-Socket sitzt im Renderer und braucht den Schlüssel direkt.
  // Nur das Kristallfenster bekommt ihn, nie das Einstellungsfenster.
  //
  // Verglichen wird die WebContents-Identität, nicht der Fenstertitel: Titel
  // kann die geladene Seite selbst setzen, und auf diesem Pfad wäre das ein
  // zu schwaches Kriterium.
  ipcMain.handle('secrets:getGeminiForLive', (event) => {
    const crystal = getCrystalWindow()
    if (!crystal || !trustedSender(event) || event.sender.id !== crystal.webContents.id) return null
    return getSecret('gemini')
  })
  ipcMain.handle('secrets:getElevenForLive', (event) => {
    const crystal = getCrystalWindow()
    if (!crystal || !trustedSender(event) || event.sender.id !== crystal.webContents.id) return null
    return getSecret('elevenlabs')
  })
  // OpenAI Realtime: Der Schlüssel verlässt den Hauptprozess nicht. Der
  // Renderer bekommt ein kurzlebiges Token, das nur den Verbindungsaufbau trägt.
  ipcMain.handle('openai:realtimeSecret', async (event) => {
    const crystal = getCrystalWindow()
    if (!crystal || !trustedSender(event) || event.sender.id !== crystal.webContents.id) {
      return { ok: false, error: 'Nicht erlaubt.' }
    }
    return realtimeAccess(getSecret('openai'), getSettings().speech.realtimeModel)
  })
  // Fähigkeitslücken: Gesprächszüge kommen nur aus dem Kristall, wo die
  // Gespräche laufen. Ob abgelehnt wurde und ob gesendet werden darf,
  // entscheidet der Sammler selbst — der Renderer hat dabei nichts zu sagen.
  ipcMain.handle('gaps:turn', (event, payload) => {
    const crystal = getCrystalWindow()
    if (!crystal || !trustedSender(event) || event.sender.id !== crystal.webContents.id) return
    const text = (value: unknown, max: number): string | null =>
      typeof value === 'string' ? value.slice(0, max) : null
    const request = text(payload?.request, 4000)
    const answer = text(payload?.answer, 4000)
    const channel = text(payload?.channel, 30)
    if (request === null || answer === null || channel === null) return
    capabilityGaps()?.answer({ request, answer, channel })
  })

  handle('openai:checkRealtime', async () => {
    const result = await realtimeAccess(getSecret('openai'), getSettings().speech.realtimeModel)
    return result.ok ? { ok: true } : { ok: false, error: result.error }
  })

  // ── ElevenLabs ─────────────────────────────────────────────
  handle('eleven:quota', ({ fresh }) => elevenQuota(Boolean(fresh)))
  handle('eleven:voices', () => elevenVoices())
  handle('eleven:bestModel', ({ quality }) => elevenBestModel(quality ? 'quality' : 'saving'))
  handle('eleven:spent', ({ chars, creditMultiplier }) => noteElevenSpent(chars, creditMultiplier))
  handle('eleven:preview', ({ voiceId, text }) => elevenPreview(voiceId, text))

  // ── Tools ──────────────────────────────────────────────────
  handle('tools:list', () => toolMetas())
  handle('tools:call', (req) => runCancellableTool(req))
  handle('tools:cancel', ({ id }) => cancelToolCall(id))

  // ── Agent ──────────────────────────────────────────────────
  handle('agent:systemPrompt', () => buildSystemPrompt())
  handle('agent:toolDeclarations', () =>
    geminiToolDeclarations((name) => permissionFor(name) === 'ask')
  )
  handle('agent:toolSchemas', () => openAiToolSchemas((name) => permissionFor(name) === 'ask'))

  // ── Audit ──────────────────────────────────────────────────
  handle('audit:list', ({ limit }) => listActions(limit ?? 200))
  handle('audit:clear', () => clearActions())
  handle('selfheal:status', ({ hours }) => selfHealDashboard(Math.min(Math.max(hours ?? 24, 1), 24 * 14)))
  handle('selfheal:repair', async (request) => {
    const dashboard = await runAutomaticRepair(true)
    if (request?.restartVoice && !dashboard.report.problems.some((problem) => /zugang-fehlt|anmeldung-fehlt/.test(problem.code))) {
      sendToCrystal('session:forceReconnect', { repair: true })
    }
    return dashboard
  })
  handle('selfheal:clear', () => clearIncidents())
  handle('diagnostics:send', async () => {
    const config = getSettings().diagnosticReporting
    if (!config.enabled) return { ok: false, detail: 'Versand ist deaktiviert.' }
    if (diagnosticSending) return { ok: false, detail: 'Ein Fehlerbericht wird bereits gesendet.' }
    diagnosticSending = true
    try {
      const health = await selfHealDashboard(24)
      return await sendDiagnosticReport(config, getSecret('diagnosticReportToken'),
        diagnosticReport(app.getVersion(), process.platform, health.report.problems.length, health.report.healed))
    } catch {
      return { ok: false, detail: 'Bericht konnte nicht erstellt werden. Diagnose und verschlüsselten Schlüsselspeicher prüfen.' }
    } finally { diagnosticSending = false }
  })

  // ── Recherche ──────────────────────────────────────────────
  handle('research:list', () => listResearch())
  handle('research:get', ({ id }) => getResearch(id))

  // ── Gedächtnis ─────────────────────────────────────────────
  //
  // Eintragen und Berichtigen gehen über `agent/memory` und nicht direkt in die
  // Datenbank, und das ist der ganze Punkt: Dort wird die Einbettung berechnet.
  // Ein Wortlaut, der ohne sie in der Tabelle landet, steht danach in der Liste
  // und ist über `recall` trotzdem nicht zu finden — gemerkt, gespeichert,
  // unauffindbar. Beide geben die frische Liste zurück, damit die Oberfläche
  // nach dem Speichern nicht ein zweites Mal fragen muss.
  handle('memory:list', ({ limit }) => listMemories(limit ?? 200))
  handle('memory:delete', ({ id }) => deleteMemory(id))
  handle('memory:add', ({ text, kind }) => addMemory(text, kind))
  handle('memory:update', ({ id, text }) => reviseMemory(id, text))

  // ── Kontaktbuch ────────────────────────────────────────────
  // Eingetragen wird hier, nicht per Stimme: Eine Mailadresse übersteht den
  // Weg durch ein Mikrofon nicht zuverlässig, und eine Mail an die falsche
  // Adresse lässt sich nicht zurückholen.
  handle('contacts:list', () => listContacts())
  handle('contacts:upsert', (entry) => upsertContact(entry))
  handle('contacts:delete', ({ id }) => deleteContact(id))

  // ── Zeitplan ───────────────────────────────────────────────
  //
  // Nach jeder Änderung den Planer neu laden. Ohne das feuert ein hier
  // gelöschter Auftrag bis zum nächsten Start der App weiter, und ein neu
  // angelegter läuft gar nicht erst an — die Aufträge leben in der Datenbank,
  // die laufenden Cron-Jobs aber nur im Speicher.
  handle('schedule:list', () => listSchedules())
  handle('reminder:list', () => listReminders())
  handle('hermes:health', () => hermesHealth())
  handle('hermes:start', () => startHermesGateway())
  handle('hermes:cancel', ({ requestId }) => { hermesRequests.get(requestId)?.abort() })
  handle('hermes:run', async ({ requestId, sessionId, input }) => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(requestId) || hermesRequests.has(requestId)) return { ok: false, error: 'Ungültige oder laufende Auftragskennung.' }
    const abort = new AbortController()
    hermesRequests.set(requestId, abort)
    activityStart({ id: requestId, label: 'Hermes arbeitet', source: 'agent', tool: 'hermes' })
    try {
      const text = await hermesRun(input, sessionId, abort.signal, {
        onText: text => sendToCrystal('hermes:delta', { requestId, text }),
        onProgress: thought => activityAnnotate(requestId, { thought })
      })
      activityEnd(requestId, true)
      return { ok: true, text }
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      activityEnd(requestId, false, message)
      return { ok: false, error: message }
    }
    finally { hermesRequests.delete(requestId) }
  })
  handle('reminder:create', (input) => createReminder(input))
  handle('reminder:done', ({ id }) => completeReminder(id))
  handle('reminder:snooze', ({ id, minutes }) => snoozeReminder(id, minutes))
  handle('schedule:upsert', (entry) => {
    const saved = upsertSchedule(entry)
    reloadSchedules()
    return saved
  })
  handle('schedule:delete', ({ id }) => {
    deleteSchedule(id)
    reloadSchedules()
  })

  // ── Preiswächter ───────────────────────────────────────────
  handle('watch:list', () => listWatches())
  handle('watch:delete', ({ id }) => deleteWatch(id))

  // ── Kosten ─────────────────────────────────────────────────
  handle('cost:get', () => {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const startOfMonth = new Date()
    startOfMonth.setDate(1)
    startOfMonth.setHours(0, 0, 0, 0)
    return {
      todayUsd: costSince(startOfDay.getTime()),
      monthUsd: costSince(startOfMonth.getTime()),
      liveAudioSeconds: 0,
      researchRuns: countSince('research', startOfMonth.getTime())
    }
  })

  // ── Sparmodus ──────────────────────────────────────────────
  handle('budget:admit', ({ budgetId }) => withModelBudget(budgetId, getSettings().tokenSaver.enabled, consumeModelCall))
  handle('tokens:get', () => tokenReport())
  handle('tokens:reset', () => {
    clearSavings()
    clearResultCache()
  })
  handle('tokens:record', ({ kind, tokens }) => recordExternalSaving(kind, tokens))

  // ── Timer ──────────────────────────────────────────────────
  handle('timers:list', () => listTimers())
  handle('timers:cancel', ({ id }) => deleteTimer(id))

  // ── Verbindungen ───────────────────────────────────────────
  // Vom Knopf aus darf die Prüfung den Browser starten: eine Antwort
  // "weiß ich nicht, er läuft ja nicht" wäre genau die Auskunft, wegen der
  // es diese Seite gibt.
  handle('connect:status', (req) => checkConnections(req?.start ?? true))
  handle('connect:login', async ({ target }) => {
    const LOGIN_PAGES = {
      gmail: 'https://mail.google.com/mail/u/0/#inbox',
      yahoo: 'https://login.yahoo.com/',
      amazon: 'https://www.amazon.de/gp/cart/view.html',
      whatsapp: 'https://web.whatsapp.com/'
    } as const

    try {
      await openForLogin(LOGIN_PAGES[target] ?? LOGIN_PAGES.gmail)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ── Telefon ────────────────────────────────────────────────
  handle('companion:status', () => companionStatus())
  handle('companion:rotateToken', () => {
    rotateToken()
    return companionStatus()
  })
  handle('companion:hostKey', () => companionHostKey())
  handle('companion:setup', () => companionSetup())
  handle('companion:runSetup', async ({ action }) => {
    await runSetupAction(action as never)
    // Direkt danach neu prüfen: Der Knopf soll seinen eigenen Erfolg anzeigen,
    // statt den Nutzer raten zu lassen, ob etwas passiert ist.
    return companionSetup()
  })
  handle('companion:wakeReadiness', () => wakeReadiness())
  handle('companion:armWake', () => armWake())


  // ── Stimme ─────────────────────────────────────────────────
  handle('speech:status', async (req) => {
    if (req?.start) return startVoiceService()
    return voiceServiceStatus()
  })
  handle('speech:stop', async () => {
    await stopVoiceService()
    return voiceServiceStatus()
  })

  // ── Telefongespräch ────────────────────────────────────────
  handle('telephony:test', async () => testTelephonySetup())
  handle('telephony:stop', async () => {
    // Vom Nutzer ausgelöst — hier wird die Adresse bei Twilio mit ausgetragen.
    await shutdownTelephony(true)
    return telephonyStatus()
  })
  handle('telephony:incoming', async () => startIncoming())
  handle('sip:status', () => sipStatus())
  handle('sip:restart', () => startSip())
  handle('update:get', () => updateStatus())
  handle('update:installNow', () => installUpdateNow())
  handle('update:postpone', () => postponeUpdate())
  handle('sip:testCall', async () => {
    console.info('[sip] Testanruf aus den Einstellungen')
    try {
      await callUser('Das ist ein Testanruf von James. Wenn du mich hörst, sag einfach etwas.')
      return { ok: true, message: 'Abgenommen — das Gespräch läuft jetzt am Telefon.' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[sip] Testanruf gescheitert: ${message}`)
      return { ok: false, message }
    }
  })

  // ── Lokales Modell ─────────────────────────────────────────
  handle('local:status', async (req) => {
    // Die Adresse kommt aus dem Eingabefeld mit, damit die Anzeige schon
    // während des Tippens auf die neue Adresse schaut und nicht erst nach
    // dem Speichern — sonst prüft der Knopf noch die alte.
    const local = getSettings().localFallback
    const baseUrl = req?.baseUrl || local?.baseUrl
    forgetOllamaReachability()
    const reachable = await ollamaReachable(baseUrl)

    // Wer hier nachsieht, will die Reserve gleich benutzen können. Das Modell
    // jetzt in den Speicher zu holen kostet nichts, was der Nutzer merkt —
    // und erspart ihm die Minute Kaltstart im Ernstfall. Nicht abwarten: die
    // Anzeige soll sofort erscheinen.
    if (reachable && local?.enabled && local.model) void warmOllama(local.model, baseUrl)

    return {
      reachable,
      // Auch dann gemeldet, wenn es gerade läuft — die Anzeige braucht beides,
      // um „läuft nicht" von „gibt es hier nicht" zu unterscheiden.
      installed: ollamaInstalled(),
      baseUrl: baseUrl ?? 'http://127.0.0.1:11434',
      models: reachable ? await listOllamaModels(baseUrl) : []
    }
  })

  // ── Kamera ─────────────────────────────────────────────────
  // Die Gegenrichtung zu `camera:capture`. Der Renderer meldet entweder ein
  // Bild oder den Grund, warum keines kam — beides landet bei dem Werkzeug,
  // das gerade wartet.
  handle('camera:frame', ({ id, frame, error }) => {
    deliverCameraFrame(id, frame ?? null, error ?? null)
  })

  // ── Smart Home ─────────────────────────────────────────────
  handle('home:status', async () => smartHomeStatus())

  // ── Musik ──────────────────────────────────────────────────
  handle('music:status', async () => musicStatus())
  handle('music:connectSpotify', async () => {
    const result = await connectSpotify()
    // Kontoart und Anzeigename werden gemerkt; nach einer Neuanmeldung kann
    // beides ein anderes Konto betreffen.
    forgetMusicCaches()
    return result
  })
  handle('music:disconnectSpotify', () => {
    disconnectSpotify()
    forgetMusicCaches()
  })

  // ── Alexa ──────────────────────────────────────────────────
  handle('alexa:status', () => alexaStatus())
  handle('alexa:start', async () => {
    // Der Fehler wird nicht geworfen, sondern mitgeliefert: Er ist ein
    // ganzer Satz darüber, was noch fehlt, und gehört ins Fenster — nicht in
    // eine abgewiesene Zusage, die dort als „etwas ist schiefgelaufen" ankommt.
    try {
      return { ok: true, status: await startAlexa() }
    } catch (err) {
      return {
        ok: false,
        status: alexaStatus(),
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })
  handle('alexa:stop', async () => stopAlexa())

  // ── MCP ────────────────────────────────────────────────────
  handle('mcp:reload', async () => {
    await reloadMcpServers()
    return toolMetas()
  })
  // Nur Server, die in den Einstellungen stehen, und nur Namen, die dort als
  // Schlüssel vermerkt sind. Sonst ließe sich über diesen Kanal beliebig in
  // den Keystore schreiben.
  const mcpServer = (id: string) => {
    const server = getSettings().mcpServers.find((s) => s.id === id)
    if (!server) throw new Error('Diesen MCP-Server gibt es nicht.')
    return server
  }
  handle('mcp:secretStatus', ({ id }) => {
    const server = mcpServer(id)
    return mcpSecretStatus(id, server.secretEnv ?? [])
  })
  handle('mcp:setSecret', ({ id, name, value }) => {
    const server = mcpServer(id)
    if (!ENV_NAME.test(name) || !(server.secretEnv ?? []).includes(name)) {
      throw new Error(`„${name}" ist für diesen Server nicht als Schlüssel eingetragen.`)
    }
    setMcpSecret(id, name, value)
    return mcpSecretStatus(id, server.secretEnv ?? [])
  })
  handle('mcp:clearSecrets', ({ id }) => {
    // Der Server ist an dieser Stelle meist schon aus den Einstellungen
    // gelöscht — deshalb hier keine Prüfung auf Bestand.
    if (typeof id === 'string' && id) {
      clearMcpSecrets(id)
      forgetMcpLogin(id)
    }
  })
  handle('mcp:status', () => mcpStatus())
  handle('activity:get', () => activitySnapshot())
  handle('mcp:login', async ({ id }) => {
    try {
      await loginMcpServer(id)
      const state = mcpStatus()[id]
      return state?.state === 'ok'
        ? { ok: true }
        : { ok: false, error: state?.error ?? 'Die Anmeldung hat nicht geklappt.' }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  handle('mcp:logout', async ({ id }) => {
    mcpServer(id)
    forgetMcpLogin(id)
    await reloadMcpServers()
  })

  // ── Google / Gmail ─────────────────────────────────────────
  handle('google:connect', async () => {
    try {
      return await connectGoogle()
    } catch (err) {
      // Der Nutzer soll den Grund im Fenster sehen, nicht nur im Log.
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  handle('google:disconnect', () => disconnectGoogle())
  handle('google:status', () => ({ connected: hasGoogleAuth(), calendar: hasCalendarAuth() }))

  // ── ChatGPT-Abo ────────────────────────────────────────────
  handle('chatgpt:connect', async () => {
    try {
      return { ok: true, ...(await connectChatGpt()) }
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) console.error('[chatgpt] Anmeldung fehlgeschlagen:', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  handle('chatgpt:disconnect', async () => { await disconnectChatGpt() })
  handle('chatgpt:cancelSignIn', () => cancelChatGptSignIn())
  handle('chatgpt:status', () => chatGptStatus())
  handle('chatgpt:models', () => chatGptModels())
  handle('chatgpt:respond', async ({ requestId, model, instructions, input, tools, budgetId }) => {
    const controller = new AbortController()
    chatGptRequests.set(requestId, controller)
    try {
      const schemas = tools ? chatGptTools(openAiToolSchemas((name) => permissionFor(name) === 'ask')) : undefined
      const response = await withModelBudget(budgetId ?? requestId, getSettings().tokenSaver.enabled, () => chatGptResponse(model, instructions, input, {
        tools: schemas,
        signal: controller.signal,
        onText: (text) => sendToCrystal('chatgpt:delta', { requestId, text })
      }))
      return { ok: true as const, response }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    } finally {
      chatGptRequests.delete(requestId)
    }
  })
  handle('chatgpt:cancel', ({ requestId }) => {
    chatGptRequests.get(requestId)?.abort()
  })

  handle('openrouter:models', async () => {
    try {
      return await listOpenRouterModels()
    } catch {
      return []
    }
  })

  handle('ollama:health', () => ollamaHealth())

  // ── Ohren und Mund auf diesem Rechner ──────────────────────
  //
  // Die einzigen Kanäle, über die Ton läuft, und das ist eine erzwungene
  // Ausnahme von der Grundregel oben in `shared/ipc.ts`: whisper und piper sind
  // fremde Programme, und ein Kindprozess lässt sich aus dem Renderer nicht
  // starten. Also müssen sie hierher, und damit ihr Ton über diese Leitung.
  //
  // `whisper:health` und `piper:health` fahren den jeweiligen Dienst dabei hoch,
  // wenn er nicht läuft. Das kann beim ersten Mal eine Minute dauern — sie
  // gehören deshalb an einen Knopf und nicht an das Öffnen einer Seite.
  handle('whisper:health', () => whisperHealth())
  handle('whisper:transcribe', ({ wavBase64, seconds }) => transcribe(wavBase64, seconds))

  handle('piper:health', () => piperHealth())
  handle('piper:prewarm', () => piperPrewarm())
  // Beide kehren sofort zurück. Gesprochen wird in der Warteschlange, und ein
  // Fehler kommt deshalb nicht von hier, sondern als `piper:failed` mit
  // derselben Stromnummer — hier zu warten hieße, den Renderer für die Dauer
  // eines Satzes anzuhalten.
  handle('piper:speak', ({ stream, text }) => piperSpeak(stream, text))
  handle('piper:abort', ({ stream }) => piperAbort(stream))

  // ── Beschaffung ────────────────────────────────────────────
  //
  // Geladen wird ausschließlich auf ausdrücklichen Klick. Der Fortschritt geht
  // als `local:progress` an alle Fenster, nicht nur an den Kristall — geklickt
  // wird in den Einstellungen, und die sind ein eigenes Fenster.
  handle('local:assets', () => localAssets())
  handle('local:install', ({ id, choice }) => installLocalAsset(id, choice))

  // ── App ────────────────────────────────────────────────────
  handle('app:openSettings', (payload) => {
    const section = payload && typeof payload.section === 'string' ? payload.section : undefined
    createSettingsWindow(section && /^[a-z]{2,20}$/.test(section) ? section : undefined)
  })
  // Nur Fenster zu schließen reicht nicht: das Tray-Symbol hält die App am
  // Leben, und zurück bliebe ein Prozess ohne Oberfläche, der beim nächsten
  // Start die Einzelinstanz-Sperre hält.
  handle('app:quit', () => {
    app.quit()
  })
  handle('app:showLog', () => {
    revealLog()
  })
  // Im Browser, nicht im App-Fenster: Die Anleitung soll sich ausdrucken
  // lassen, und ein rahmenloses Electron-Fenster hat keinen Druckbefehl.
  handle('app:openGuide', () => {
    void shell.openPath(resourceFile('kurzanleitung.html'))
  })
  // Der Kristall führt die Pause aus, der Hauptprozess führt sie: Tray und
  // Hotkey lesen hier ab, und der Wecker einer befristeten Pause läuft hier.
  handle('app:pauseState', ({ paused, until }) => setPaused(paused, until ?? null))
  handle('app:pauseGet', () => pauseState())
  handle('diag:ping', () => ({ ok: true as const, version }))

  // ── Fenstersteuerung (frameless) ───────────────────────────
  ipcMain.on('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  ipcMain.on('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
  ipcMain.on('window:alwaysOnTop', (_event, value: boolean) => {
    setAlwaysOnTop(Boolean(value))
  })
}
