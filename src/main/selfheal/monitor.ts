import type { SelfHealDashboard } from '@shared/types'
import { listIncidents, openIncidents, updateIncidentOutcome } from '../db'
import { getSecret } from '../secrets/keystore'
import { chatGptStatus } from '../providers/chatgptAuth'
import { wakeStatus } from '../providers/wakeStatus'
import { type LogEntry, onLogEntry } from '../logging'
import { companionStatus } from '../companion/server'
import { getSettings } from '../store/settings'
import { telephonyStatus } from '../telephony'
import { piperHealth } from '../providers/piper'
import { whisperHealth } from '../providers/whisper'
import { forgetOllamaReachability, ollamaReachable } from '../providers/ollama'
import {
  healthReport,
  isIgnorableRuntimeWarning,
  report,
  retryOpenIncidents,
  type Area,
  type Incident
} from './index'

const CHECK_EVERY_MS = 5 * 60 * 1000
const INITIAL_CHECK_MS = 20 * 1000
const DUPLICATE_WINDOW_MS = 15 * 1000

let stopListening: (() => void) | null = null
let initialTimer: NodeJS.Timeout | null = null
let interval: NodeJS.Timeout | null = null
let checking: Promise<void> | null = null
let reportQueue = Promise.resolve()
const lastAutomatic = new Map<string, number>()

const AREA_BY_SCOPE: Record<string, Area> = {
  alexa: 'telefonie',
  companion: 'fernbedienung',
  crystal: 'live',
  live: 'live',
  realtime: 'live',
  wakeword: 'live',
  chatgpt: 'live',
  openai: 'live',
  gemini: 'gemini',
  db: 'system',
  embeddings: 'gemini',
  eleven: 'stimme',
  input: 'werkzeug',
  keystore: 'system',
  main: 'system',
  agent: 'werkzeug',
  mcp: 'werkzeug',
  piper: 'stimme',
  preload: 'live',
  renderer: 'live',
  scheduler: 'werkzeug',
  settings: 'system',
  telefonie: 'telefonie',
  text: 'gemini',
  uia: 'werkzeug',
  whisper: 'stimme',
  window: 'system'
}

function scopeOf(text: string): string {
  return text.match(/^\[([^:\]]+)/)?.[1]?.toLocaleLowerCase('de-DE') ?? 'system'
}

/**
 * Macht aus einer freien Protokollzeile eine stabile Störung.
 *
 * Nur Fehler und Warnungen, die wirklich einen Dienstverlust ausdrücken,
 * werden übernommen. Abgewiesene ungültige Anfragen oder ein blockierter Link
 * sind erfolgreiche Schutzmaßnahmen und dürfen nicht als Defekt erscheinen.
 */
export function classifyLogEntry(entry: LogEntry): Incident | null {
  // Electron wraps browser logs with a renderer tag and source location.
  // Recover the original scope so provider failures remain distinguishable.
  const text = entry.text.trim().replace(/^\[renderer:(?:error|warn|warning|info|log)\](?:\s+\([^\r\n]*?\))?\s*/, '')
  if (!text || text.startsWith('[selbstheilung]')) return null

  // Node kennzeichnet veraltete Bibliotheksaufrufe als Warnung im
  // Entwicklerprotokoll. Das ist kein Laufzeitdefekt und vor allem nichts,
  // was ein Gegenmittel beheben könnte. Electron reicht solche Zeilen je nach
  // Startweg als stderr/Fehler weiter; ohne diese Schranke würden sie deshalb
  // als offener `system-fehler` im Gesundheitsbericht landen.
  if (isIgnorableRuntimeWarning(text)) return null

  if (entry.level === 'warn') {
    const serviceEnded = /^\[(piper|whisper)\]\s+beendet\s+\(Code/i.test(text)
    const occupiedPort = /\bEADDRINUSE\b|\bPort\s+\d+[^\r\n]*\bbelegt\b/i.test(text)
    const missingWake = /^\[wakeword\].*(?:fehlen|nicht geladen)/i.test(text)
    if (!serviceEnded && !occupiedPort && !missingWake) return null
  } else if (entry.level !== 'error') {
    return null
  }

  const scope = scopeOf(text)
  const area = AREA_BY_SCOPE[scope] ?? 'system'
  const context = { source: 'auto-log', level: entry.level, scope }

  if (/^\[renderer\]\s+Prozess beendet:/i.test(text)) {
    return { area: 'live', code: 'renderer-beendet', message: text, context }
  }
  if (/^\[preload\]\s+Fehler/i.test(text)) {
    return { area: 'live', code: 'preload-fehler', message: text, context }
  }
  if (/\bEADDRINUSE\b|\bPort\s+\d+[^\r\n]*\bbelegt\b/i.test(text)) {
    return { area, code: 'port-belegt', message: text, context }
  }
  if (/^\[piper\]\s+beendet\s+\(Code/i.test(text)) {
    return { area: 'stimme', code: 'piper-beendet', message: text, context }
  }
  if (/^\[whisper\]\s+beendet\s+\(Code/i.test(text)) {
    return { area: 'stimme', code: 'whisper-beendet', message: text, context }
  }
  if (/^\[main\]\s+Unbehandelte/i.test(text)) {
    return { area: 'system', code: 'unbehandelter-fehler', message: text, context }
  }
  if (scope === 'settings' && /unlesbar/i.test(text)) {
    return { area: 'system', code: 'einstellungen-unlesbar', message: text, context }
  }
  if (scope === 'keystore') {
    return { area: 'system', code: 'schluessel-unlesbar', message: text, context }
  }
  if (scope === 'db') {
    return { area: 'system', code: 'datenbank-fehler', message: text, context }
  }

  const stableScope = scope.replace(/[^a-z0-9äöüß-]/gi, '').slice(0, 40) || 'system'
  return { area, code: `${stableScope}-fehler`, message: text, context }
}

function queueIncident(incident: Incident): void {
  const key = `${incident.area}:${incident.code}`
  const now = Date.now()
  if (now - (lastAutomatic.get(key) ?? 0) < DUPLICATE_WINDOW_MS) return
  lastAutomatic.set(key, now)

  reportQueue = reportQueue
    .then(() => report(incident))
    .then(() => undefined)
    .catch(() => undefined)
}

/** So lange bleibt eine fehlende Voraussetzung still, bevor das Gegenmittel es noch einmal versucht. */
const CONFIGURATION_RETRY_MS = 60 * 60 * 1000

/**
 * Meldet eine fehlende Voraussetzung einmal — und schließt sie, sobald sie da ist.
 *
 * Fehlende Zugänge und Modelldateien behebt kein Neustart. Der Prüflauf (alle
 * fünf Minuten) meldete sie trotzdem jedes Mal neu: Piper stand so 27 Mal in der
 * Stunde als Störung da, bis „piper-neustart greift nicht mehr“ im Protokoll
 * stand. Solange dieselbe Störung offen ist, bleibt es deshalb still. Hat ein
 * Gegenmittel zu tun (`retryAfterMs` endlich), darf es nach der Frist einen
 * neuen Anlauf bekommen — einen, nicht zwölf je Stunde.
 */
export async function reportConfiguration(
  area: Area,
  code: string,
  ready: boolean,
  message: string,
  options: { retryAfterMs?: number; context?: Record<string, unknown>; now?: number } = {}
): Promise<void> {
  const { retryAfterMs = Number.POSITIVE_INFINITY, context, now = Date.now() } = options
  const open = openIncidents(0).filter((i) => i.area === area && i.code === code)
  if (ready) {
    for (const incident of open) updateIncidentOutcome(incident.id, 'Konfiguration erneut geprüft', true)
    return
  }
  if (open.some((i) => now - i.ts < retryAfterMs)) return
  await report({ area, code, message, context: context ?? { source: 'configuration-check' } })
}

export async function inspectConfiguredServices(): Promise<void> {
  const settings = getSettings()
  // Missing credentials and model files cannot be repaired by restarting a
  // process. Surface the required action and close it once configuration works.
  const configuration = (code: string, ready: boolean, message: string, area: Area = 'live'): Promise<void> =>
    reportConfiguration(area, code, ready, message)
  const native = ['gemini', 'openai'].includes(settings.speech.provider)
  const needsOpenai = settings.speech.provider === 'openai'
  const needsGemini = settings.speech.provider === 'gemini' || (!native && settings.speech.thinkProvider === 'gemini')
  const needsEleven = settings.speech.provider === 'elevenlabs'
  await configuration('openai-zugang-fehlt', !needsOpenai || !!getSecret('openai'), 'OpenAI-API-Zugang fehlt oder ist nicht lesbar. Unter Stimme einen gültigen API-Schlüssel erneut eintragen und prüfen.')
  await configuration('gemini-zugang-fehlt', !needsGemini || !!getSecret('gemini'), 'Gemini-Zugang fehlt oder ist nicht lesbar. Unter Stimme den Gemini-Schlüssel erneut eintragen und prüfen.')
  await configuration('elevenlabs-zugang-fehlt', !needsEleven || !!getSecret('elevenlabs'), 'ElevenLabs-API-Zugang fehlt oder ist nicht lesbar. Unter Stimme den ElevenLabs-Schlüssel erneut eintragen und prüfen.', 'stimme')
  await configuration('chatgpt-anmeldung-fehlt', native || settings.speech.thinkProvider !== 'chatgpt' || chatGptStatus().connected, 'ChatGPT-Anmeldung fehlt oder ist nicht lesbar. Unter Stimme erneut mit ChatGPT anmelden und ein Kontomodell wählen.')
  await configuration('wake-modell-fehlt', !settings.wake.enabled || wakeStatus().installed, 'Weckwort-Modell fehlt. Einen passenden Klassifikator installieren; für Hey Jarvis ist jarvis.onnx erforderlich.')

  if (settings.speech.provider === 'piper') {
    const status = await piperHealth()
    await reportConfiguration('stimme', 'piper-nicht-bereit', status.ok, status.detail, {
      retryAfterMs: CONFIGURATION_RETRY_MS,
      context: { source: 'health-check', provider: 'piper' }
    })
  }

  if (settings.speech.hearProvider === 'whisper') {
    const status = await whisperHealth()
    await reportConfiguration('stimme', 'whisper-nicht-bereit', status.ok, status.detail, {
      retryAfterMs: CONFIGURATION_RETRY_MS,
      context: { source: 'health-check', provider: 'whisper' }
    })
  }

  if (settings.companion.enabled && !companionStatus().running) {
    await report({
      area: 'fernbedienung',
      code: 'dienst-beendet',
      message: 'Der eingeschaltete Telefon-Begleiter läuft nicht.',
      context: { source: 'health-check', port: settings.companion.port }
    })
  }

  if (settings.telephony.incoming && !telephonyStatus().running) {
    await report({
      area: 'telefonie',
      code: 'dienst-beendet',
      message: 'Der Dienst für eingehende Anrufe läuft nicht.',
      context: { source: 'health-check', port: settings.telephony.port }
    })
  }

  const localThinking = settings.speech.thinkProvider === 'ollama'
  if (settings.localFallback.enabled || localThinking) {
    const baseUrl = localThinking ? settings.ollama.baseUrl : settings.localFallback.baseUrl
    forgetOllamaReachability()
    const reachable = await ollamaReachable(baseUrl)
    if (!reachable) {
      await report({
        area: 'gemini',
        // Bestehende Installationen kennen diese Kennung schon. Ist die
        // Reserve ebenfalls aktiv, bleibt derselbe Fingerabdruck erhalten und
        // die genauere Meldung ersetzt die alte, statt einen Doppelposten zu
        // erzeugen.
        code: settings.localFallback.enabled
          ? 'reserve-nicht-erreichbar'
          : 'denkmodell-nicht-erreichbar',
        message:
          localThinking && settings.localFallback.enabled
            ? 'Ollama ist nicht erreichbar. Dadurch stehen weder das lokale Denken der Sprachstimme noch die Reserve bereit.'
            : localThinking
              ? 'Das für die Sprachstimme gewählte lokale Denkmodell Ollama ist nicht erreichbar.'
              : 'Die eingeschaltete lokale Reserve Ollama ist nicht erreichbar.',
        context: { source: 'health-check', baseUrl }
      })
    } else {
      /*
       * Ein erfolgreicher Check muss einen früheren Ausfall auch schließen.
       * Sonst bleibt „Ollama nicht erreichbar“ 24 Stunden offen, wenn jemand
       * den Dienst von Hand startet: Ohne neue Störung gäbe es keine Zeile mit
       * `healed = 1`, an der `openIncidents` die Erholung erkennen könnte.
       */
      const staleCodes = new Set(
        openIncidents(0)
          .filter(
            (incident) =>
              incident.area === 'gemini' &&
              ['reserve-nicht-erreichbar', 'denkmodell-nicht-erreichbar'].includes(
                incident.code
              )
          )
          .map((incident) => incident.code)
      )
      for (const code of staleCodes) {
        await report({
          area: 'gemini',
          code,
          message: 'Ollama ist wieder erreichbar.',
          context: { source: 'health-check', baseUrl }
        })
      }
    }
  }
}

/**
 * Führt genau einen vollständigen Prüf- und Reparaturlauf aus.
 * `manual`: vom Nutzer angestoßen — dann auch alles Offene neu behandeln.
 */
export async function runAutomaticRepair(manual = false): Promise<SelfHealDashboard> {
  if (!checking) {
    checking = inspectConfiguredServices().finally(() => {
      checking = null
    })
  }
  await checking
  await reportQueue
  if (manual) await retryOpenIncidents()
  return selfHealDashboard()
}

export function selfHealDashboard(hours = 24): SelfHealDashboard {
  const since = Date.now() - hours * 60 * 60 * 1000
  return {
    report: healthReport(hours),
    recent: listIncidents(100)
      .filter(
        (incident) => incident.ts >= since && !isIgnorableRuntimeWarning(incident.message)
      )
      .map(({ id, ts, area, code, message, remedy, healed }) => ({
        id,
        ts,
        area,
        code,
        message,
        remedy,
        healed
      })),
    automatic: stopListening !== null,
    checking: checking !== null
  }
}

/** Startet Logbeobachtung und regelmäßige Gesundheitsprüfungen. */
export function startSelfHealMonitor(): void {
  if (stopListening) return
  stopListening = onLogEntry((entry) => {
    const incident = classifyLogEntry(entry)
    if (incident) queueIncident(incident)
  })

  const check = (): void => { void runAutomaticRepair().catch(error => console.error('[selbstheilung] Prüfung fehlgeschlagen:', error)) }
  initialTimer = setTimeout(check, INITIAL_CHECK_MS)
  initialTimer.unref?.()
  interval = setInterval(check, CHECK_EVERY_MS)
  interval.unref?.()
}

export function stopSelfHealMonitor(): void {
  stopListening?.()
  stopListening = null
  if (initialTimer) clearTimeout(initialTimer)
  if (interval) clearInterval(interval)
  initialTimer = null
  interval = null
  lastAutomatic.clear()
}
