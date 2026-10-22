import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS } from '../src/shared/config/defaults'
import { classifyServiceAddress, deriveTransparencyItems, isLoopbackHost, safeHostLabel } from '../src/shared/dataTransparency'
import type { Settings } from '../src/shared/types'

function settings(): Settings { return structuredClone(DEFAULT_SETTINGS) }
function find(s: Settings, id: string) { return deriveTransparencyItems(s).find(row => row.id === id)! }

test('classifies only exact loopback hosts as local', () => {
  for (const host of ['localhost', '127.0.0.1', '::1', '[::1]']) assert.equal(isLoopbackHost(host), true, host)
  for (const host of ['127.0.0.2', '192.168.1.2', 'localhost.example', 'my-localhost']) assert.equal(isLoopbackHost(host), false, host)
  assert.match(classifyServiceAddress('http://127.0.0.1:11434/secret/path?key=x'), /Loopback auf diesem Rechner/)
  assert.match(classifyServiceAddress('http://192.168.1.5:11434/api?token=x'), /extern\/Netzwerk/)
})

test('unloaded settings yield unknown states rather than guessed defaults', () => {
  const rows = deriveTransparencyItems(null)
  assert.ok(rows.length > 5)
  assert.ok(rows.every(row => row.status === 'unknown'))
})

test('host-only redaction never returns URL credentials, path, query, fragment or port', () => {
  const label = safeHostLabel('https://user:super-secret@example.org:8443/private/path?api_key=hidden#anchor')
  assert.equal(label, 'example.org')
  for (const secret of ['super-secret', 'private', 'api_key', 'hidden', 'anchor', '8443']) assert.equal(label?.includes(secret), false)
  assert.equal(safeHostLabel('file:///tmp/private'), null)
  assert.equal(safeHostLabel('not a URL with api_key=secret'), null)
})

test('LM Studio and Ollama only appear local on exact loopback URLs', () => {
  const s = settings()
  s.brainProvider = 'ollama'
  s.ollama.baseUrl = 'http://localhost:11434'
  assert.match(find(s, 'text-brain').detail, /Loopback auf diesem Rechner \(localhost\)/)
  assert.equal(find(s, 'gemini-special').status, 'optional')
  assert.match(find(s, 'gemini-special').detail, /Einbettungen.*Gemini/)
  s.brainProvider = 'lmstudio'
  s.lmStudio.baseUrl = 'http://models.example:1234/v1/private?token=secret'
  const detail = find(s, 'text-brain').detail
  assert.match(detail, /Host models\.example – extern\/Netzwerk/)
  assert.doesNotMatch(detail, /private|token|secret|1234/)
})

test('diagnostic toggles distinguish opt-in, automatic and capability-gap reporting', () => {
  const s = settings()
  s.diagnosticReporting = { ...s.diagnosticReporting, enabled: false, automatic: true, capabilityGaps: true }
  assert.equal(find(s, 'diagnostics').status, 'off')
  assert.equal(find(s, 'auto-diagnostics').status, 'off')
  assert.equal(find(s, 'capability-gaps').status, 'off')
  s.diagnosticReporting.enabled = true
  assert.equal(find(s, 'diagnostics').status, 'optional')
  assert.equal(find(s, 'auto-diagnostics').status, 'active')
  assert.equal(find(s, 'capability-gaps').status, 'optional')
  s.diagnosticReporting.automatic = false
  s.diagnosticReporting.capabilityGaps = false
  assert.equal(find(s, 'auto-diagnostics').status, 'off')
  assert.equal(find(s, 'capability-gaps').status, 'off')
})

test('native voice modes disclose their vendor routes; cascade discloses local and remote stages', () => {
  const s = settings()
  s.speech.provider = 'gemini'
  assert.match(find(s, 'speech-route').detail, /Gemini Live hört, verarbeitet und spricht/)
  s.speech.provider = 'openai'
  assert.match(find(s, 'speech-route').detail, /OpenAI Realtime hört, verarbeitet und spricht/)
  s.speech.provider = 'piper'
  s.speech.hearProvider = 'whisper'
  s.speech.thinkProvider = 'ollama'
  s.ollama.baseUrl = 'http://127.0.0.1:11434'
  const cascade = find(s, 'speech-route').detail
  assert.match(cascade, /Whisper \(lokale Audio-Erkennung\)/)
  assert.match(cascade, /Ollama \(Loopback auf diesem Rechner/)
  assert.match(cascade, /Piper lokal/)
  assert.match(cascade, /nicht automatisch Denken oder den gesamten Ablauf offline/)
})

test('background learning, companion, phone and calendar reflect configured switches without displaying secrets', () => {
  const s = settings()
  s.learnSkills = false
  s.companion.enabled = true
  s.sip.enabled = false
  s.telephony.incoming = true
  s.telephony.conversation = false
  assert.equal(find(s, 'learning').status, 'off')
  assert.equal(find(s, 'companion').status, 'active')
  assert.equal(find(s, 'sip').status, 'off')
  assert.equal(find(s, 'phone').status, 'active')
  assert.equal(find(s, 'calendar').status, 'optional')
  assert.doesNotMatch(JSON.stringify(deriveTransparencyItems(s)), /calendarIcsUrl|diagnosticReportToken|secret/i)
})

test('calendar board opt-in reads are distinct from forwarding tool results to an AI', () => {
  const detail = find(settings(), 'calendar').detail
  assert.match(detail, /erst nach der dortigen Aktivierung/)
  assert.match(detail, /Anzeige allein sendet die Termine nicht an eine KI/)
  assert.match(detail, /Werkzeugaufruf.*Modell-Kontexts/)
})

test('Alexa discloses Amazon processing and does not imply that disabling the app disables Echo', () => {
  const s = settings()
  s.alexa.enabled = true
  assert.equal(find(s, 'alexa').status, 'active')
  assert.match(find(s, 'alexa').detail, /Amazon verarbeitet/)
  s.alexa.enabled = false
  assert.equal(find(s, 'alexa').status, 'off')
  assert.match(find(s, 'alexa').detail, /schaltet die eigenständige Sprachverarbeitung.*nicht ab/)
})
