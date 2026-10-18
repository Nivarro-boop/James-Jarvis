import { WebsiteAccounts } from './WebsiteAccounts'
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type {
  SipStatus,
  AlexaStatus,
  AuditEntry,
  ConnectionStatus,
  Contact,
  ElevenQuota,
  ElevenVoice,
  LocalAsset,
  LocalAssetId,
  LocalInstallProgress,
  LocalModelStatus,
  MemoryEntry,
  MusicStatus,
  PiperHealth,
  PriceWatch,
  ResearchRun,
  SelfHealDashboard,
  ScheduleEntry,
  SecretKey,
  SecretStatus,
  Settings,
  SmartHomeStatus,
  TelephonyStatus,
  TimerEntry,
  TokenReport,
  ToolGroup,
  ToolMeta,
  ToolPermission,
  VoiceServiceStatus,
  WhisperHealth
} from '@shared/types'
import { PHONE_COUNTRIES, VOICES } from '@shared/types'
import type { OllamaHealth } from '@shared/types'
import { ELEVEN, PIPER, WHISPER } from '@shared/config/defaults'
import type { CompanionSetup, CompanionStatus, WakeReadiness } from '@shared/companion'
import { CHATGPT_USAGE_URL, type ChatGptModel } from '@shared/chatgpt'
import { ChatGptConnection as ChatGptLogin } from './ChatGptConnection'
import { ReminderPanel } from '../home/ReminderPanel'
import { HermesConnection } from './HermesConnection'
import { VoiceAccess } from './VoiceAccess'
import { encodeQr, qrToSvgPath } from '@shared/qr'
import { listAudioDevices } from '../audio/capture'

interface Props {
  settings: Settings
  patch: (p: Partial<Settings>) => Promise<Settings>
}

// ─────────────────────────────────────────────────────────────
// Zugänge
// ─────────────────────────────────────────────────────────────

const SECRET_FIELDS: { key: SecretKey; label: string; hint: string; required?: boolean }[] = [
  {
    key: 'diagnosticReportToken',
    label: 'Fehlerbericht-Token',
    hint: 'Optional. Muss JARVIS_REPORT_TOKEN auf deinem Server entsprechen. Wird verschlüsselt gespeichert und ausschließlich an den eingestellten Fehlerbericht-Empfänger gesendet.'
  },
  {
    key: 'gemini',
    label: 'Gemini API-Schlüssel',
    hint: 'Für Gemini Live, Google-Recherche und Bildschirmsteuerung. Alternative Sprachwege können ohne Gemini arbeiten.'
  },
  {
    key: 'elevenlabs',
    label: 'ElevenLabs API-Schlüssel',
    hint: 'Für die Stimme. Ohne ihn spricht Gemini selbst — alles andere bleibt gleich. Steht bei ElevenLabs unter Profil, API Keys.'
  },
  {
    key: 'openrouter',
    label: 'OpenRouter API-Schlüssel',
    hint: 'Optional. Ein Schlüssel für Hunderte Modelle, auch GPT und Claude. Von openrouter.ai/keys.'
  },
  {
    key: 'openai',
    label: 'OpenAI API-Schlüssel',
    hint: 'Für direktes OpenAI Realtime und API-Textaufgaben. Separat vom ChatGPT-Abo abgerechnet. Von platform.openai.com/api-keys.'
  },
  {
    key: 'anthropic',
    label: 'Claude (Anthropic) API-Schlüssel',
    hint: 'Optional. Für Textaufgaben über Claude. Von console.anthropic.com, beginnt mit sk-ant-.'
  },
  {
    key: 'higgsfield',
    label: 'Higgsfield Zugang',
    hint: 'Format: Schlüssel:Geheimnis, mit Doppelpunkt getrennt. Braucht den Creator-Tarif.'
  },
  {
    key: 'googleOAuthClientId',
    label: 'Google OAuth Client-ID',
    hint: 'Für Gmail. Aus der Google Cloud Console, Anwendungstyp Desktop.'
  },
  { key: 'googleOAuthClientSecret', label: 'Google OAuth Geheimnis', hint: '' },
  {
    key: 'calendarIcsUrl',
    label: 'Kalender-Link (iCal)',
    hint: 'Optional, nur lesen. Google: Kalender-Einstellungen, Privatadresse im iCal-Format. Outlook: Einstellungen, Kalender freigeben, ICS-Link. iCloud: Kalender teilen, öffentlicher Kalender. Beginnt mit https:// oder webcal://.'
  },
]

export function KeysSection({ settings, patch }: Props): JSX.Element {
  const [reportBusy, setReportBusy] = useState(false)
  const [reportNote, setReportNote] = useState('')
  const [status, setStatus] = useState<SecretStatus[]>([])
  const [values, setValues] = useState<Partial<Record<SecretKey, string>>>({})
  const [saving, setSaving] = useState<SecretKey | null>(null)
  /** Ergebnis der Gemini-Prüfung, bis der nächste Tastendruck es verwirft. */
  const [keyNote, setKeyNote] = useState<{ key: SecretKey; ok: boolean; text: string } | null>(null)
  /** Der Empfänger, wie er beim Betreten des Feldes galt — er entscheidet, ob die Zusage noch gilt. */
  const reportUrlAtFocus = useRef(settings.diagnosticReporting.url)

  useEffect(() => {
    void window.jarvis.invoke('secrets:status').then(setStatus).catch(() => undefined)
  }, [])

  const present = (key: SecretKey): boolean => status.find((s) => s.key === key)?.present ?? false

  /**
   * Speichern heißt beim Gemini-Schlüssel: erst ausprobieren.
   *
   * Der Assistent macht das beim ersten Mal, aber ersetzt wird ein Schlüssel
   * hier — nach einem abgelaufenen Kontingent, einem neuen Konto, einem
   * Rechnerwechsel. Genau dann ist die Wahrscheinlichkeit für einen halb
   * kopierten Schlüssel am höchsten, und genau dann fiel es bisher erst beim
   * nächsten Ansprechen auf: Die Kugel leuchtet kurz, geht aus, keine Erklärung.
   *
   * Beim ElevenLabs-Schlüssel genauso, über die Modellliste. Die übrigen
   * Zugänge werden weiterhin nur abgelegt: Für sie gibt es keine Prüfung, die
   * nichts kostet und nichts auslöst.
   */
  const save = async (key: SecretKey): Promise<void> => {
    const value = values[key]
    if (!value) return
    setSaving(key)
    try {
      if (key === 'gemini') {
        setKeyNote(null)
        const result = await window.jarvis.invoke('secrets:checkGemini', { value })
        if (!result.ok) {
          setKeyNote({ key, ok: false, text: result.error ?? 'Der Schlüssel wurde nicht angenommen.' })
          return
        }
        // `secrets:checkGemini` legt bei Erfolg selbst ab — hier bleibt nur,
        // den Stand neu zu holen.
        setStatus(await window.jarvis.invoke('secrets:status'))
        setKeyNote({ key, ok: true, text: 'Geprüft und gespeichert. Google nimmt den Schlüssel an.' })
      } else if (key === 'elevenlabs') {
        setKeyNote(null)
        const result = await window.jarvis.invoke('secrets:checkEleven', { value })
        if (!result.ok) {
          setKeyNote({ key, ok: false, text: result.error ?? 'Der Schlüssel wurde nicht angenommen.' })
          return
        }
        setStatus(await window.jarvis.invoke('secrets:status'))
        setKeyNote({ key, ok: !result.note, text: result.note ?? 'Geprüft und gespeichert. ElevenLabs nimmt den Schlüssel an.' })
      } else if (key === 'openai') {
        const result = await window.jarvis.invoke('secrets:checkOpenai', { value })
        if (!result.ok) {
          setKeyNote({ key, ok: false, text: result.error ?? 'Der Schlüssel wurde nicht angenommen.' })
          return
        }
        setStatus(await window.jarvis.invoke('secrets:status'))
        setKeyNote({ key, ok: true, text: 'API-Zugang geprüft und gespeichert. Realtime-Modellzugriff und Guthaben werden beim Gespräch geprüft.' })
      } else {
        setStatus(await window.jarvis.invoke('secrets:set', { key, value }))
      }
      setValues((v) => ({ ...v, [key]: '' }))
    } catch (error) {
      setKeyNote({ key, ok: false, text: error instanceof Error ? error.message : 'Der Schlüssel konnte nicht gespeichert werden.' })
    } finally {
      setSaving(null)
    }
  }

  const clear = async (key: SecretKey): Promise<void> => {
    try { setStatus(await window.jarvis.invoke('secrets:clear', { key })) }
    catch (e) { setKeyNote({ key, ok: false, text: e instanceof Error ? e.message : 'Löschen fehlgeschlagen.' }) }
  }

  const renderFields = (fields: typeof SECRET_FIELDS): JSX.Element => (<>
      {fields.map((field) => (
        <div className="field" key={field.key}>
          {field.key === 'openai' && (
            <>
              <h3>ChatGPT verbinden</h3>
              <ChatGptLogin model={settings.chatGptModel} onModelChange={(id) => patch({ chatGptModel: id })} />
            </>
          )}
          <label id={`secret-label-${field.key}`}>
            {field.label}{' '}
            {present(field.key) ? (
              <span className="badge ok">hinterlegt</span>
            ) : field.required ? (
              <span className="badge err">fehlt</span>
            ) : (
              <span className="badge missing">optional</span>
            )}
          </label>
          <div className="row">
            <input
              aria-labelledby={`secret-label-${field.key}`}
              type="password"
              placeholder={present(field.key) ? '••••••••••••  (neu eingeben zum Ersetzen)' : 'einfügen…'}
              value={values[field.key] ?? ''}
              onChange={(e) => {
                setValues((v) => ({ ...v, [field.key]: e.target.value }))
                if (keyNote?.key === field.key) setKeyNote(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save(field.key)
              }}
            />
            <button
              className="primary"
              disabled={!values[field.key] || saving === field.key}
              onClick={() => void save(field.key)}
            >
              {field.key !== 'gemini' && field.key !== 'elevenlabs' && field.key !== 'openai'
                ? 'Speichern'
                : saving === field.key
                  ? 'Wird geprüft…'
                  : 'Prüfen und speichern'}
            </button>
            {present(field.key) && <button onClick={() => void clear(field.key)}>Löschen</button>}
          </div>
          {keyNote?.key === field.key && (
            <div className={keyNote.ok ? 'hint ok' : 'hint err'} role="status">{keyNote.text}</div>
          )}
          {field.hint && <div className="hint">{field.hint}</div>}
        </div>
      ))}
  </>)

  return (
    <>
      <h2>Zugänge</h2>
      <WebsiteAccounts />
      <p className="lede">
        Lege deinen Standardort fest und entscheide, ob James technische Fehlerberichte senden darf.
        Den Sprachzugang richtest du unter „Stimme“ ein. Weitere Dienste findest du unten.
      </p>

      <GoogleConnect />
      <div className="field"><label>Standardstandort</label>
        <input aria-label="Standardstandort" placeholder="z. B. Wien" value={settings.homeLocation} onChange={e => void patch({ homeLocation: e.target.value })} />
        <p className="hint">Ohne Ortsangabe verwenden Wetter, Ortssuche und Routen diesen Ort. Keine heimliche GPS-Ortung. Ein ausdrücklich genannter Ort hat Vorrang.</p>
      </div>
      <div className="field"><label>Optionale Fehlerberichte</label>
        {/* Eine veränderte Adresse ist eine andere Zusage: Gesendet würde nun
            an jemand anderes. Deshalb poussiert das Ändern den Versand aus —
            aber erst beim Verlassen des Feldes, nicht bei jedem Buchstaben.
            Sonst ließe sich der Empfänger nicht einmal korrigieren, ohne die
            Häkchen darunter bei jedem Tastenanschlag neu zu setzen. */}
        <input aria-label="Empfänger für Fehlerberichte" placeholder="HTTPS-Adresse deines Servers" value={settings.diagnosticReporting.url} onFocus={e => { reportUrlAtFocus.current = e.target.value }} onChange={e => void patch({ diagnosticReporting: { ...settings.diagnosticReporting, url: e.target.value } })} onBlur={e => { const url = e.target.value.trim(); if (url !== reportUrlAtFocus.current) void patch({ diagnosticReporting: { ...settings.diagnosticReporting, url, enabled: false } }) }} />
        <label><input type="checkbox" checked={settings.diagnosticReporting.enabled} onChange={e => void patch({ diagnosticReporting: { ...settings.diagnosticReporting, enabled: e.target.checked } })} /> Versand technischer Statistik erlauben</label>
        <label><input type="checkbox" checked={settings.diagnosticReporting.enabled && settings.diagnosticReporting.automatic} onChange={e => void patch({ diagnosticReporting: { ...settings.diagnosticReporting, automatic: e.target.checked, enabled: e.target.checked || settings.diagnosticReporting.enabled } })} /> Neue Fehler automatisch anonymisiert senden</label>
        <p className="hint">Standardmäßig aus. Automatisch: neue technische Fehler nach 30 Sekunden gebündelt, höchstens ein Bericht je 5 Minuten; gleiche Fehler höchstens alle 15 Minuten. Versandfehler werden später erneut versucht. Statistik und automatische Berichte enthalten nur App-Version, Betriebssystem und Fehleranzahl, keine Gesprächstexte, Logtexte, Schlüssel, Namen oder Standorte. Gesprächsausschnitte sendet nur die eigene Option „Fähigkeitslücken“ darunter. Der Empfänger sieht technisch deine IP-Adresse. Ausschalten verwirft wartende Berichte.</p>
        {/* Eigene Zustimmung: Anders als die Statistik enthält ein Lückenbericht Gesprächstext. */}
        <label><input type="checkbox" checked={settings.diagnosticReporting.enabled && settings.diagnosticReporting.capabilityGaps} onChange={e => void patch({ diagnosticReporting: { ...settings.diagnosticReporting, capabilityGaps: e.target.checked, enabled: e.target.checked || settings.diagnosticReporting.enabled } })} /> Fähigkeitslücken mit Gesprächsausschnitt senden</label>
        <p className="hint">Standardmäßig aus. Sagt James, dass er etwas nicht kann, oder fehlt oder scheitert ein Werkzeug, geht ein Bericht an den Empfänger oben, damit die Fähigkeit in ein späteres Update kommen kann. Gesendet werden deine Bitte, James’ Antwort, der erkannte Grund, ein Lösungsvorschlag, die beteiligten Werkzeuge, App-Version und Betriebssystem. E-Mail-Adressen, Telefonnummern, IBANs, Schlüssel und Linkpfade werden vorher entfernt. Namen oder andere persönliche Angaben in deiner Bitte können aber enthalten bleiben. Nur einschalten, wenn du damit einverstanden bist.</p>
        <button disabled={reportBusy || !settings.diagnosticReporting.enabled || !settings.diagnosticReporting.url.startsWith('https://')} onClick={async () => {
          setReportBusy(true)
          setReportNote('Sende technische Statistik…')
          try { setReportNote((await window.jarvis.invoke('diagnostics:send')).detail) }
          catch { setReportNote('Versand konnte nicht gestartet werden. Bitte erneut versuchen.') }
          finally { setReportBusy(false) }
        }}>{reportBusy ? 'Wird gesendet…' : 'Statistik senden'}</button>
        {reportNote && <p role="status">{reportNote}</p>}
      </div>
      <hr className="section-divider" />

      {renderFields(SECRET_FIELDS.filter(field => field.key === 'diagnosticReportToken'))}
      <details className="settings-disclosure"><summary>Weitere Dienste und Zugänge verbinden</summary>
      {renderFields(SECRET_FIELDS.filter(field => field.key !== 'diagnosticReportToken'))}

      <hr className="section-divider" />
      <LinphoneSetup settings={settings} patch={patch} />

      <hr className="section-divider" />
      <TextProviderChoice
        settings={settings}
        patch={patch}
        openRouterPresent={present('openrouter')}
        present={present}
      />

      <hr className="section-divider" />
      <LocalFallback settings={settings} patch={patch} />

      <hr className="section-divider" />
      <SpeechEngine settings={settings} patch={patch} />
      </details>
    </>
  )
}

/**
 * Die Innereien des lokalen Sprachdienstes.
 *
 * Gewählt wird der Weg nicht hier, sondern einmal unter Stimme — es gibt
 * genau einen Schalter dafür, und zwei Auswahlfelder für dieselbe Frage an
 * zwei Orten wären der sichere Weg zu einer Einstellung, die man für kaputt
 * hält. Was hier steht, sind die Angaben, die nur VibeVoice braucht:
 * Sprecher, Port, Pfade, und der Zustand des Dienstes.
 *
 * Die Zahl, an der die Entscheidung hängt, steht drüben: Geminis native
 * Stimme beginnt nach einer halben Sekunde zu sprechen, VibeVoice nach gut
 * zwei.
 */
function SpeechEngine({ settings, patch }: Props): JSX.Element {
  const speech = settings.speech ?? {
    provider: 'gemini' as const,
    speaker: 'de-Spk0_man',
    port: 8791,
    pythonPath: '',
    voicesPath: ''
  }
  const [status, setStatus] = useState<VoiceServiceStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    void window.jarvis.invoke('speech:status').then(setStatus).catch(() => undefined)
  }, [])

  const update = (p: Partial<typeof speech>): void => void patch({ speech: { ...speech, ...p } })

  const start = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      setStatus(await window.jarvis.invoke('speech:status', { start: true }))
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const stop = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      setStatus(await window.jarvis.invoke('speech:stop'))
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // Die Stimmen kommen vom Dienst selbst. Läuft er nicht, bleibt wenigstens
  // die eingestellte in der Liste — sonst stellte das Auswahlfeld beim
  // Öffnen still auf etwas anderes um.
  const available = status?.voices.length ? status.voices : [speech.speaker]

  return (
    <div className="field">
      <label>VibeVoice</label>
      {note && (
        <div className="hint err" role="alert">
          {note}
        </div>
      )}
      {speech.provider !== 'vibevoice' && (
        <div className="hint">
          Der lokale Sprachdienst ist gerade nicht der gewählte Weg. Unter Stimme steht das
          Auswahlfeld, das ihn einschaltet.
        </div>
      )}

      {speech.provider === 'vibevoice' && (
        <>
          <label style={{ marginTop: 8 }}>
            Sprecher{' '}
            {status?.phase === 'bereit' ? (
              <span className="badge ok">Dienst läuft</span>
            ) : status?.phase === 'lädt' || status?.phase === 'startet' ? (
              <span className="badge missing">startet…</span>
            ) : (
              <span className="badge err">aus</span>
            )}
          </label>
          <select aria-label="Sprecher" value={speech.speaker} onChange={(e) => update({ speaker: e.target.value })}>
            {available.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>

          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" disabled={busy} onClick={() => void start()}>
              {busy ? 'einen Moment…' : 'Dienst starten'}
            </button>
            {status?.running && (
              <button disabled={busy} onClick={() => void stop()}>
                Dienst beenden
              </button>
            )}
          </div>

          {status?.detail && (
            <div className={status.phase === 'fehler' ? 'hint err' : 'hint'} style={{ marginTop: 8 }}>
              {status.detail}
            </div>
          )}

          {/*
            Was vorliegen muss, einzeln abgehakt.

            Vorher stand hier nur der Fehlersatz zu dem Teil, der zuerst
            auffiel — wer beides nicht hatte, behob eines und bekam denselben
            Satz mit einem anderen Pfad. Und der Pfad steckte mitten im Text,
            wo er sich schlecht kopieren lässt, obwohl genau das der nächste
            Schritt ist: dorthin gehört die Umgebung.
          */}
          {status && !status.running && (
            <table style={{ marginTop: 10, marginBottom: 4 }}>
              <tbody>
                {(
                  [
                    ['Python mit PyTorch', status.requirements.python],
                    ['Sprecherprofile', status.requirements.voices]
                  ] as const
                ).map(([label, req]) => (
                  <tr key={label}>
                    <td style={{ width: 150 }}>{label}</td>
                    <td style={{ width: 80 }}>
                      {req.ok ? (
                        <span className="badge ok">liegt vor</span>
                      ) : (
                        <span className="badge err">fehlt</span>
                      )}
                    </td>
                    <td>
                      <code>{req.path}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <label style={{ marginTop: 8 }}>Python mit PyTorch</label>
          <input aria-label="Python mit PyTorch"
            type="text"
            value={speech.pythonPath}
            placeholder="leer lassen für ~/JamesAI/vibevoice/venv"
            onChange={(e) => update({ pythonPath: e.target.value })}
          />
          <label style={{ marginTop: 8 }}>Sprecherprofile</label>
          <input aria-label="Sprecherprofile"
            type="text"
            value={speech.voicesPath}
            placeholder="leer lassen für ~/JamesAI/vibevoice/voices"
            onChange={(e) => update({ voicesPath: e.target.value })}
          />
        </>
      )}

      <div className="hint">
        Gemini erzeugt den Ton selbst, mit Betonung und Tempo aus dem Gespräch heraus, und beginnt
        nach etwa einer halben Sekunde zu sprechen. VibeVoice läuft auf dieser Grafikkarte: Der Ton
        gehört dir, kostet kein Kontingent — braucht aber gut zwei Sekunden bis zum ersten Wort, und
        die Betonung kommt dann aus dem Satzbau statt aus der Lage.
        <br />
        <br />
        Gesprochen wird satzweise. Am Stück wären es sechzehn Sekunden Stille vor dem ersten Ton,
        gemessen auf diesem Rechner; satzweise sind es gut zwei, und danach läuft es lückenlos.
        Fällt der Dienst aus, spricht James mit Geminis Stimme weiter, statt zu verstummen.
      </div>
    </div>
  )
}

/**
 * Das lokale Modell als Reserve.
 *
 * Bewusst ein Schalter und kein Auswahlfeld „lokal oder Gemini“. Ein solches
 * Feld hätte versprochen, dass James komplett lokal laufen kann, und das
 * stimmt nicht: die Sprachschleife braucht natives Audio über die Live API,
 * Websuche und Preisvergleich brauchen Googles Grounding. Was hier steht,
 * wirkt auch — und der Hinweis sagt, wo.
 */
function LocalFallback({ settings, patch }: Props): JSX.Element {
  const local = settings.localFallback ?? { enabled: false, baseUrl: 'http://127.0.0.1:11434', model: '' }
  const [status, setStatus] = useState<LocalModelStatus | null>(null)
  const [checking, setChecking] = useState(false)
  /** Gescheiterte Prüfung: sonst bliebe das Abzeichen für immer auf „wird geprüft…". */
  const [checkError, setCheckError] = useState<string | null>(null)

  const check = async (baseUrl?: string): Promise<void> => {
    setChecking(true)
    setCheckError(null)
    try {
      const next = await window.jarvis.invoke('local:status', { baseUrl: baseUrl ?? local.baseUrl })
      setStatus(next)

      /*
       * Ein vorhandenes Modell einsetzen, wenn keines gewählt ist.
       *
       * Sonst bliebe die Reserve nach dem Einschalten stumm: eingeschaltet,
       * Ollama läuft, Modelle liegen bereit — und im Feld steht nichts, also
       * scheitert der Rückfall genau dann, wenn er gebraucht wird.
       *
       * Einbettungsmodelle fallen zuerst heraus, und das ist der wichtigere
       * Teil: `nomic-embed-text` erzeugt Vektoren und kann keinen einzigen
       * Satz schreiben. Da `/api/tags` nach Änderungsdatum sortiert, wäre
       * genau das die Wahl gewesen, sobald jemand zuletzt ein solches Modell
       * geholt hat — und der Fehler fiele erst im Ernstfall auf.
       *
       * Danach bevorzugt eines, das Werkzeuge kann. Fürs Übersetzen ist das
       * egal, aber es kostet nichts und hält die Tür für später auf.
       */
      const usable = next.models.filter((m) => !m.embedding)
      const chosen = usable.some((m) => m.name === local.model)
      if (!chosen && usable.length > 0) {
        const best = usable.find((m) => m.tools) ?? usable[0]
        patch({ localFallback: { ...local, model: best.name } })
      }
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : String(err))
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    void check()
    // Einmal beim Öffnen. Weitere Prüfungen löst der Knopf aus — ein Ollama,
    // das nicht läuft, läuft auch nach dem dritten Nachsehen nicht.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const update = (p: Partial<typeof local>): void => void patch({ localFallback: { ...local, ...p } })

  return (
    <div className="field">
      <label>
        Lokales Modell als Reserve{' '}
        {checkError ? (
          <span className="badge err">Prüfung fehlgeschlagen</span>
        ) : status === null ? (
          <span className="badge missing">wird geprüft…</span>
        ) : status.reachable ? (
          <span className="badge ok">Ollama läuft</span>
        ) : status.installed ? (
          <span className="badge missing">installiert, läuft nicht</span>
        ) : (
          <span className="badge missing">nicht installiert</span>
        )}
      </label>
      {checkError && (
        <div className="hint err" role="alert">
          {checkError} Bitte erneut versuchen.
        </div>
      )}

      <label style={{ fontWeight: 400 }}>
        <input
          type="checkbox"
          checked={local.enabled}
          onChange={(e) => update({ enabled: e.target.checked })}
          style={{ width: 'auto', marginRight: 8 }}
        />
        Einspringen, wenn Gemini nicht antwortet
      </label>

      {local.enabled && (
        <>
          {/*
            Was jetzt zu tun ist, je nachdem woran es liegt. Vorher stand hier
            in beiden Fällen dasselbe „nicht erreichbar" — und das beantwortet
            weder die Frage nach dem Download noch die nach dem Doppelklick.
          */}
          {status && !status.reachable && (
            <div className="hint err" style={{ marginTop: 8 }}>
              {status.installed ? (
                <>
                  Ollama liegt auf diesem Rechner, antwortet aber nicht unter {status.baseUrl}.
                  Starte es einmal — es legt sich danach selbst in den Autostart und ist beim
                  nächsten Mal schon da.
                </>
              ) : (
                <>
                  Auf diesem Rechner ist kein Ollama installiert. Es gibt es kostenlos unter{' '}
                  <a href="https://ollama.com/download" target="_blank" rel="noreferrer">
                    ollama.com/download
                  </a>
                  ; danach einmal <code>ollama pull llama3.1</code> ausführen. Bis dahin bleibt
                  dieser Schalter wirkungslos — James läuft ohne ihn vollständig weiter.
                </>
              )}
            </div>
          )}

          {status?.reachable && status.models.length === 0 && (
            <div className="hint err" style={{ marginTop: 8 }}>
              Ollama läuft, es liegt aber kein einziges Modell darin. Ein{' '}
              <code>ollama pull llama3.1</code> in der Eingabeaufforderung holt eines.
            </div>
          )}

          <div className="row" style={{ marginTop: 8 }}>
            <input
              aria-label="Adresse des Ollama-Diensts"
              type="text"
              placeholder="http://127.0.0.1:11434"
              value={local.baseUrl}
              onChange={(e) => update({ baseUrl: e.target.value })}
              onBlur={(e) => void check(e.target.value)}
            />
            <button disabled={checking} onClick={() => void check()}>
              {checking ? 'prüft…' : 'Nachsehen'}
            </button>
          </div>

          <select aria-label="Ollama-Modell" value={local.model} onChange={(e) => update({ model: e.target.value })} style={{ marginTop: 8 }}>
            {/* Das eingestellte Modell steht auch dann in der Liste, wenn Ollama
                gerade nicht läuft — sonst verlöre die Auswahl beim Öffnen ihren
                eigenen Wert und stellte still auf etwas anderes um. */}
            {!status?.models.some((m) => m.name === local.model) && (
              <option value={local.model}>{local.model || '— kein Modell gewählt —'}</option>
            )}
            {/* Einbettungsmodelle stehen gar nicht erst zur Wahl: Sie
                erzeugen Vektoren und können keinen Satz schreiben. Das
                Gedächtnis benutzt sie von selbst, siehe db/embeddings.ts. */}
            {status?.models
              .filter((m) => !m.embedding)
              .map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                  {m.parameterSize ? ` · ${m.parameterSize}` : ''}
                  {m.tools ? ' · kann Werkzeuge' : ''}
                </option>
              ))}
          </select>

          {/* Ein Ollama, in dem nur Einbettungsmodelle liegen, meldet
              „erreichbar" und hat trotzdem nichts anzubieten. Ohne diesen
              Satz sieht der Nutzer eine leere Liste ohne Grund. */}
          {status?.reachable &&
            status.models.length > 0 &&
            status.models.every((m) => m.embedding) && (
              <div className="hint err">
                In diesem Ollama liegen nur Einbettungsmodelle. Die erzeugen Vektoren fürs
                Gedächtnis — schreiben können sie nichts. Ein <code>ollama pull llama3.1</code>{' '}
                holt eines, das übersetzen kann.
              </div>
            )}

          {/* Eingeschaltet und kein Modell heißt: Die Reserve scheitert genau
              dann, wenn sie gebraucht wird. Das gehört gesagt, bevor es so
              weit ist. */}
          {!local.model && (
            <div className="hint err">
              Kein Modell gewählt — die Reserve würde nichts tun. Auf „Nachsehen" drücken; steht
              eines bereit, trägt es sich selbst ein.
            </div>
          )}
        </>
      )}

      <div className="hint">
        Greift beim Übersetzen, wenn Gemini gerade nicht erreichbar oder das Kontingent leer ist.
        Nicht mehr: Websuche, Seitenabruf und Preisvergleich hängen an Googles Grounding, die
        Bildschirmarbeit am Bildeingang, die Sprachschleife an nativem Audio der Live-API — dafür
        gibt es lokal kein Gegenstück. Antwortet auch das lokale Modell nicht, meldet James den
        ursprünglichen Gemini-Fehler, statt ihn zu verschlucken.
        <br />
        <br />
        „Nachsehen“ holt das Modell gleich in den Speicher und hält es dort. Das lohnt sich: kalt
        braucht ein Achtmilliarden-Modell über eine Minute bis zum ersten Wort, warm ein paar
        Sekunden.
        <br />
        <br />
        Unabhängig von diesem Schalter: Liegt in Ollama ein Einbettungsmodell — etwa{' '}
        <code>nomic-embed-text</code> —, benutzt das Gedächtnis es von selbst für seine Vektoren,
        sobald Gemini nicht antwortet. Dafür muss hier nichts eingestellt werden.
      </div>
    </div>
  )
}

/**
 * Kontoart, Guthaben und Landesvorwahl.
 *
 * Steht über dem Testknopf, weil es die zwei Fragen beantwortet, die sonst
 * nach einem misslungenen Anruf offenbleiben: Warum hört der Angerufene erst
 * eine englische Ansage (Testkonto), und warum wird eine im Adressbuch
 * stehende Nummer nicht gewählt (falsches Land).
 */
/**
 * Linphone: kostenlos zwischen dir und James telefonieren. James hat ein
 * eigenes Konto, du hast eins in der Linphone-App auf dem iPhone.
 */
function LinphoneSetup({ settings, patch }: Props): JSX.Element {
  const sip = settings.sip
  const [status, setStatus] = useState<SipStatus | null>(null)
  const [password, setPassword] = useState('')
  const [hasPassword, setHasPassword] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const update = (p: Partial<typeof sip>): Promise<Settings> => patch({ sip: { ...sip, ...p } })

  const testCall = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await window.jarvis.invoke('sip:testCall'))
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  useEffect(() => {
    const load = (): void => {
      void window.jarvis.invoke('sip:status').then(setStatus).catch(() => undefined)
      void window.jarvis
        .invoke('secrets:status')
        .then((all) => setHasPassword(all.some((s) => s.key === 'sipPassword' && s.present)))
        .catch(() => undefined)
    }
    load()
    const timer = window.setInterval(load, 4000)
    return () => window.clearInterval(timer)
  }, [])

  const savePassword = async (): Promise<void> => {
    if (!password.trim()) return
    try {
      const all = await window.jarvis.invoke('secrets:set', { key: 'sipPassword', value: password.trim() })
      setHasPassword(all.some((s) => s.key === 'sipPassword' && s.present))
      setPassword('')
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Das Passwort konnte nicht gespeichert werden.')
    }
  }

  return (
    <>
      <div className="field">
        <label>
          Linphone — mit James telefonieren, kostenlos{' '}
          {status?.enabled &&
            (status.registered ? (
              <span className="badge ok">angemeldet</span>
            ) : (
              <span className="badge err">nicht angemeldet</span>
            ))}
        </label>
        <ol className="hint">
          <li>Auf subscribe.linphone.org zwei kostenlose Konten anlegen: eins für James, eins für dich.</li>
          <li>
            Linphone aufs Handy laden, mit deinem Konto anmelden und Mitteilungen erlauben — sonst klingelt
            es nicht, wenn die App im Hintergrund ist. In der App unter Einstellungen, Anrufe die
            Medienverschlüsselung auf „Keine" stellen.
          </li>
          <li>Hier unten James’ Konto und deine Adresse eintragen, einschalten, dann „Testanruf".</li>
        </ol>
      </div>
      <div className="field">
        <label>James’ Benutzername</label>
        {/* Leerraum wird erst beim Verlassen geschnitten — ein Feld, das den
            Leertaste-Anschlag verschluckt, liest sich kaputt. */}
        <input aria-label="James’ Benutzername" value={sip.username} placeholder="z. B. james-void" onChange={(e) => void update({ username: e.target.value })} onBlur={(e) => { const v = e.target.value.trim(); if (v !== e.target.value) void update({ username: v }) }} />
      </div>
      <div className="field">
        <label>James’ Passwort {hasPassword && <span className="badge ok">gespeichert</span>}</label>
        <div className="row">
          <input
            aria-label="James’ Passwort"
            type="password"
            value={password}
            placeholder={hasPassword ? '•••••••• (neu eingeben zum Ändern)' : 'Passwort von James’ Konto'}
            onChange={(e) => { setPassword(e.target.value); setSaveError(null) }}
          />
          <button disabled={!password.trim()} onClick={() => void savePassword()}>
            Speichern
          </button>
        </div>
        {saveError && <div className="hint err" role="alert">{saveError}</div>}
      </div>
      <div className="field">
        <label>Deine Linphone-Adresse</label>
        <input aria-label="Deine Linphone-Adresse"
          value={sip.userAddress}
          placeholder="name@sip.linphone.org"
          onChange={(e) => void update({ userAddress: e.target.value })}
          onBlur={(e) => { const v = e.target.value.trim(); if (v !== e.target.value) void update({ userAddress: v }) }}
        />
        <div className="hint">Nur von dieser Adresse nimmt James Anrufe an, und nur sie ruft er an.</div>
      </div>
      <label style={{ fontWeight: 400 }}>
        <input type="checkbox" checked={sip.enabled} onChange={(e) => void update({ enabled: e.target.checked })} />
        Eingeschaltet
      </label>
      {status?.enabled && <div className={status.registered ? 'hint ok' : 'hint err'}>{status.detail}</div>}
      <div className="field">
        <div className="row">
          <button
            disabled={!status?.registered || !sip.userAddress || testing || status.inCall}
            onClick={() => void testCall()}
          >
            {testing ? 'Klingelt bei dir …' : 'Testanruf'}
          </button>
        </div>
        {testResult ? (
          <div className={testResult.ok ? 'hint ok' : 'hint err'} role="status">{testResult.message}</div>
        ) : (
          status?.lastCall && <div className="hint">Letzter Anruf: {status.lastCall}</div>
        )}
      </div>
      <details className="advanced-choice">
        <summary>Mehr</summary>
        <div className="field">
          <label>Domain</label>
          <input aria-label="Domain" value={sip.domain} onChange={(e) => void update({ domain: e.target.value })} onBlur={(e) => { const v = e.target.value.trim(); if (v !== e.target.value) void update({ domain: v }) }} />
        </div>
        <label style={{ fontWeight: 400 }}>
          <input type="checkbox" checked={sip.fullAccess} onChange={(e) => void update({ fullAccess: e.target.checked })} />
          Am Telefon alles können wie am Rechner (Programme, Dateien, Mails …)
        </label>
      </details>
    </>
  )
}

/**
 * Wer die reinen Textaufgaben erledigt.
 *
 * Bewusst ein Schalter mit drei Stellungen und nicht drei Schalter: Es kann
 * immer nur einer von ihnen zuständig sein, und was hier steht, muss auch
 * wirken. Der Hinweis darunter sagt deshalb beides — wo die Einstellung
 * greift und wo nicht. Eine Auswahl „Ollama", nach der die Sprachschleife
 * unverändert über Google läuft, wäre sonst schlicht eine Lüge.
 *
 * Ollama steht auch dann zur Wahl, wenn es gerade nicht läuft. Das ist
 * Absicht: Wer es einstellt und danach startet, soll nicht erst zurück in die
 * Einstellungen müssen — der Zustand daneben sagt, woran es liegt.
 */
/**
 * Anmeldung mit dem ChatGPT-Abo. Erscheint nur, wenn OpenAI James dafür
 * freigegeben hat, siehe `providers/chatgptAuth` — bis dahin bleibt es beim
 * API-Schlüssel, und hier steht nichts.
 */
/** LM Studio: Serveradresse und Modell, mit Live-Prüfung ob der Server läuft. */
function LmStudioSetup({ settings, patch }: Props): JSX.Element {
  const lm = settings.lmStudio ?? { baseUrl: 'http://127.0.0.1:1234/v1', model: '' }
  const [status, setStatus] = useState<{ reachable: boolean; models: string[] } | null>(null)
  useEffect(() => {
    let current = true
    const timer = window.setTimeout(() => {
      void window.jarvis
        .invoke('lmstudio:models', { baseUrl: lm.baseUrl })
        // Gescheiterter look: „antwortet nicht" ist die ehrliche Darstellung.
        .then((s) => { if (current) setStatus(s) })
        .catch(() => { if (current) setStatus({ reachable: false, models: [] }) })
    }, 300)
    return () => { current = false; window.clearTimeout(timer) }
  }, [lm.baseUrl])
  return (
    <>
      <input type="text" value={lm.baseUrl} placeholder="http://127.0.0.1:1234/v1" aria-label="LM-Studio-Adresse"
        onChange={(e) => patch({ lmStudio: { ...lm, baseUrl: e.target.value } })} style={{ marginTop: 8 }} />
      <select value={lm.model} aria-label="LM-Studio-Modell" onChange={(e) => patch({ lmStudio: { ...lm, model: e.target.value } })} style={{ marginTop: 8 }}>
        <option value="">Das gerade geladene Modell</option>
        {status?.models.map((m) => <option key={m} value={m}>{m}</option>)}
        {lm.model && !status?.models.includes(lm.model) && <option value={lm.model}>{lm.model}</option>}
      </select>
      <div className={status?.reachable === false ? 'hint err' : 'hint'} style={{ marginTop: 8 }}>
        {status === null ? 'Prüfe LM Studio …'
          : status.reachable ? `LM Studio läuft · ${status.models.length} Modell${status.models.length === 1 ? '' : 'e'} verfügbar.`
            : 'LM Studio antwortet nicht. In LM Studio unter „Developer" den Server starten und ein Modell laden — bis dahin läuft es über Gemini weiter.'}
      </div>
    </>
  )
}

function TextProviderChoice({
  settings,
  patch,
  openRouterPresent,
  present
}: Props & { openRouterPresent: boolean; present: (key: SecretKey) => boolean }): JSX.Element {
  const [models, setModels] = useState<{ id: string; name: string }[]>([])
  const [localReachable, setLocalReachable] = useState<boolean | null>(null)
  const chosen = settings.brainProvider

  // Erst laden, wenn ein Schlüssel da ist — ohne ihn ist die Liste nur Ballast.
  useEffect(() => {
    if (!openRouterPresent) return
    void window.jarvis.invoke('openrouter:models').then(setModels).catch(() => undefined)
  }, [openRouterPresent])

  /*
   * Nur nachsehen, wenn Ollama auch gewählt ist.
   *
   * Der Abruf wartet im schlechtesten Fall zwei Sekunden auf einen Port, an
   * dem nichts horcht. Für alle, die bei Gemini bleiben — also die meisten —
   * wäre das eine Wartezeit beim Öffnen der Einstellungen für eine Auskunft,
   * die sie nie zu sehen bekommen.
   */
  useEffect(() => {
    if (chosen !== 'ollama') return
    let current = true
    void window.jarvis
      .invoke('local:status', { baseUrl: settings.localFallback?.baseUrl })
      .then((s) => {
        if (current) setLocalReachable(s.reachable)
      })
      // „Antwortet gerade nicht" ist hier die ehrliche Darstellung.
      .catch(() => {
        if (current) setLocalReachable(false)
      })
    return () => {
      current = false
    }
  }, [chosen, settings.localFallback?.baseUrl])

  const localModel = settings.localFallback?.model ?? ''

  return (
    <div className="field">
      <label>Textaufgaben über</label>
      <select aria-label="Textaufgaben über"
        value={chosen}
        onChange={(e) => patch({ brainProvider: e.target.value as never })}
      >
        <option value="gemini">Gemini — schnell, braucht Netz</option>
        <option value="ollama">Ollama — lokal, kostet nichts, langsamer</option>
        <option value="lmstudio">LM Studio — lokal, kostet nichts</option>
        <option value="openrouter">OpenRouter</option>
        <option value="openai">OpenAI API — separate API-Abrechnung</option>
        <option value="chatgpt">ChatGPT-Abo — Plan-Kontingent</option>
        <option value="anthropic">Claude (Anthropic)</option>
      </select>

      {chosen === 'chatgpt' && <ChatGptLogin model={settings.chatGptModel}
        onModelChange={(id) => patch({ chatGptModel: id })} />}

      {(chosen === 'openai' || chosen === 'anthropic') && (
        <>
          {!present(chosen) && (
            <div className="hint err" style={{ marginTop: 8 }}>
              Es ist kein {chosen === 'openai' ? 'OpenAI' : 'Anthropic'}-Schlüssel hinterlegt. Trag
              ihn oben ein — bis dahin läuft es über Gemini weiter.
            </div>
          )}
          <input
            aria-label={chosen === 'openai' ? 'OpenAI-Modellname' : 'Anthropic-Modellname'}
            type="text"
            value={chosen === 'openai' ? settings.openAiModel : settings.anthropicModel}
            placeholder={chosen === 'openai' ? 'gpt-5-mini' : 'claude-haiku-4-5'}
            onChange={(e) =>
              patch(chosen === 'openai' ? { openAiModel: e.target.value } : { anthropicModel: e.target.value })
            }
            style={{ marginTop: 8 }}
          />
        </>
      )}

      {chosen === 'ollama' && (
        <div className={localReachable === false ? 'hint err' : 'hint'} style={{ marginTop: 8 }}>
          {localReachable === false
            ? 'Ollama antwortet gerade nicht — solange läuft es weiter über Gemini. Weiter unten ' +
              'unter „Lokales Modell" steht, ob es installiert ist und welche Modelle bereitliegen.'
            : localModel
              ? `Läuft über ${localModel}. Das Modell wird weiter unten ausgewählt.`
              : 'Es ist noch kein Modell ausgewählt. Weiter unten unter „Lokales Modell" auswählen — ' +
                'ohne das läuft weiter alles über Gemini.'}
        </div>
      )}

      {chosen === 'lmstudio' && <LmStudioSetup settings={settings} patch={patch} />}

      {chosen === 'openrouter' && !openRouterPresent && (
        <div className="hint err" style={{ marginTop: 8 }}>
          Es ist kein OpenRouter-Schlüssel hinterlegt. Trag ihn oben ein — bis dahin läuft es
          über Gemini weiter.
        </div>
      )}

      {settings.brainProvider === 'openrouter' && (
        <>
          <input
            aria-label="OpenRouter-Modellname"
            type="text"
            list="openrouter-models"
            value={settings.openRouterModel}
            placeholder="anthropic/claude-3.5-haiku"
            onChange={(e) => patch({ openRouterModel: e.target.value })}
            style={{ marginTop: 8 }}
          />
          <datalist id="openrouter-models">
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </datalist>
        </>
      )}

      <div className="hint">
        Betrifft alles, wo Text hinein- und Text herausgeht — heute das Übersetzen, und alles,
        was künftig dazukommt. Den Sprachweg und seinen Denkmotor wählst du unter Stimme
        getrennt. Websuche, Preisvergleich, Seitenabruf und Bildschirmarbeit verwenden
        weiterhin die dafür eingerichteten Werkzeuge und Zugänge.
        <br />
        <br />
        Antwortet der Gewählte nicht, springt der nächste ein, statt dass die Aufgabe
        fehlschlägt. James sagt in dem Fall dazu, von wem die Antwort kam.
      </div>
    </div>
  )
}

/**
 * Gmail-Anmeldung.
 *
 * Läuft über den Systembrowser mit lokalem Rückkanal. Das ist nicht nur
 * Googles Vorgabe für Desktop-Anwendungen — es sorgt auch dafür, dass das
 * Passwort im eigenen Browser eingegeben wird und James es nie zu sehen
 * bekommt.
 */
function GoogleConnect(): JSX.Element {
  const [connected, setConnected] = useState(false)
  /** Ob die bestehende Anmeldung auch den Kalender abdeckt. */
  const [calendar, setCalendar] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  /** Ob die Meldung ein Fehlschlag ist — grau gesetzt liest sich einer wie ein Hinweis. */
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    void window.jarvis
      .invoke('google:status')
      .then((s) => {
        setConnected(s.connected)
        setCalendar(s.calendar)
      })
      .catch(() => undefined)
  }, [])

  const connect = async (): Promise<void> => {
    setBusy(true)
    setFailed(false)
    setMessage('Im Browser anmelden…')
    try {
      const result = await window.jarvis.invoke('google:connect')
      setConnected(result.ok)
      setFailed(!result.ok)
      setMessage(result.ok ? `Verbunden als ${result.email ?? 'unbekannt'}` : (result.error ?? 'Fehlgeschlagen'))
      // Nach dem Verbinden neu nachfragen statt anzunehmen: Im
      // Zustimmungsdialog lassen sich einzelne Häkchen wegnehmen, und dann
      // ist die Anmeldung erfolgreich und der Kalender trotzdem nicht dabei.
      const status = await window.jarvis.invoke('google:status')
      setCalendar(status.calendar)
    } catch (err) {
      setFailed(true)
      setMessage(err instanceof Error ? err.message : 'Die Anmeldung ging nicht.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="field">
      <label>
        Gmail und Kalender über die Google-Schnittstelle{' '}
        {connected && calendar ? (
          <span className="badge ok">verbunden</span>
        ) : connected ? (
          <span className="badge missing">ohne Kalender</span>
        ) : (
          <span className="badge missing">optional</span>
        )}
      </label>

      {/*
        Der wichtigste Fall in diesem Abschnitt: verbunden, aber die
        Zustimmung stammt aus der Zeit vor dem Kalender. Ohne diesen Hinweis
        steht oben „verbunden“, und James antwortet auf jede Terminfrage mit
        einem Fehler — was wie ein Programmfehler aussieht und keiner ist.
      */}
      {connected && !calendar && (
        <div className="hint err" style={{ marginBottom: 10 }}>
          Diese Anmeldung ist älter als der Kalender und deckt ihn nicht ab. Einmal auf „Mit
          Google verbinden" drücken — danach kann James Termine nachsehen, eintragen,
          verschieben und absagen. Für Mails ändert sich nichts.
        </div>
      )}

      <div className="hint" style={{ marginBottom: 10 }}>
        <strong style={{ color: 'var(--text)' }}>Für Mails brauchst du das nicht.</strong> Lesen,
        öffnen, durchsuchen, herauskopieren und schreiben läuft über den James-Browser und kostet
        dich eine einmalige Anmeldung — einzurichten unter „Verbindungen". Dieser Weg hier ist nur
        schneller und kann Mails direkt versenden.
        <br />
        <br />
        <strong style={{ color: 'var(--text)' }}>Für den Kalender brauchst du ihn schon.</strong>{' '}
        Termine gibt es nur über diese Schnittstelle; einen Browserweg wie bei den Mails gibt es
        dafür nicht. Beides verlangt einen eigenen OAuth-Client vom Typ{' '}
        <strong style={{ color: 'var(--text)' }}>Desktop</strong> aus der Google Cloud Console,
        eingetragen unten als Client-ID und Geheimnis.
      </div>
      <div className="row">
        <button className="primary" onClick={() => void connect()} disabled={busy}>
          {busy ? 'Warte auf den Browser…' : 'Mit Google verbinden'}
        </button>
        {connected && (
          <button
            onClick={() => {
              void window.jarvis
                .invoke('google:disconnect')
                .then(() => {
                  setConnected(false)
                  setFailed(false)
                  setMessage(null)
                })
                .catch((err: unknown) => {
                  setFailed(true)
                  setMessage(err instanceof Error ? err.message : 'Das Trennen ging nicht.')
                })
            }}
          >
            Trennen
          </button>
        )}
      </div>
      <div className={failed ? 'hint err' : 'hint'}>
        {message ??
          'Die Anmeldung läuft in deinem Browser — dein Passwort sieht James nie. Nach dem Klick öffnet sich ein Google-Fenster; danach kannst du es schließen.'}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Stimme
// ─────────────────────────────────────────────────────────────

/**
 * Der ElevenLabs-Teil.
 *
 * Er steht bewusst über der Gemini-Auswahl und nicht daneben: Solange
 * ElevenLabs spricht, ist die Gemini-Stimme die Rückfallebene, und eine
 * Rückfallebene gehört nach unten. Angezeigt wird außerdem das Kontingent —
 * die einzige Zahl, die erklärt, warum es morgen anders klingen könnte.
 */
function ElevenVoicePicker({ settings, patch }: Props): JSX.Element {
  const speech = settings.speech
  const [voices, setVoices] = useState<ElevenVoice[]>([])
  const [quota, setQuota] = useState<ElevenQuota | null>(null)
  const [busy, setBusy] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  /** Laden von Kontingent und Stiemen schlug fehl — sonst bliebe „Noch nicht nachgefragt". */
  const [loadError, setLoadError] = useState<string | null>(null)

  /**
   * Die Hörprobe.
   *
   * Sie spricht genau die Stimme, die auch im Gespräch spräche — auch die
   * automatisch gewählte. Eine Probe, die etwas anderes vorführt als das, was
   * später herauskommt, wäre schlimmer als keine.
   */
  const play = async (): Promise<void> => {
    const voiceId =
      speech.elevenVoiceId ||
      voices.find((v) => fitsJarvis(v.name))?.id ||
      voices[0]?.id ||
      ''
    let started = false
    setPlaying(true)
    setPreviewError(null)
    try {
      const result = await window.jarvis.invoke('eleven:preview', {
        voiceId,
        text: PREVIEW_TEXT
      })
      if (!result.ok || !result.audio) {
        setPreviewError(result.error ?? 'Die Hörprobe ging nicht.')
        return
      }
      // Über einen Blob und nicht über eine data-Adresse: Die CSP des
      // Einstellungsfensters lässt blob: zu und data: für Ton nicht — und sie
      // dafür aufzumachen wäre der falsche Weg herum.
      const raw = atob(result.audio)
      const bytes = new Uint8Array(raw.length)
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }))
      const audio = new Audio(url)
      const done = (): void => {
        URL.revokeObjectURL(url)
        setPlaying(false)
      }
      audio.onended = done
      audio.onerror = done
      await audio.play()
      started = true
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err))
    } finally {
      // Läuft etwas, gibt `done` den Knopf frei; auf jedem anderen Weg muss er
      // hier zurück. Sonst steht dort für immer "spricht…", und zwar
      // ausgerechnet im Fehlerfall — also genau dann, wenn man ihn nach dem
      // Eintragen des Schlüssels gleich noch einmal drücken will.
      if (!started) setPlaying(false)
    }
  }

  const refresh = async (fresh: boolean): Promise<void> => {
    setBusy(true)
    setLoadError(null)
    try {
      const [nextQuota, nextVoices] = await Promise.all([
        window.jarvis.invoke('eleven:quota', { fresh }),
        window.jarvis.invoke('eleven:voices')
      ])
      setQuota(nextQuota)
      setVoices(nextVoices)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void refresh(false)
  }, [])

  const active = speech.provider === 'elevenlabs'
  const local = speech.provider === 'piper'
  const composite = speech.provider !== 'gemini' && speech.provider !== 'openai'

  return (
    <>
      <div className="field">
        <label>Stimme</label>
        <div className="choice-switch three" role="group" aria-label="Stimme auswählen">
          <button
            className={speech.provider === 'gemini' ? 'active' : ''}
            aria-pressed={speech.provider === 'gemini'}
            onClick={() => patch({ speech: { ...speech, provider: 'gemini' } })}
          >
            Gemini Live
            <small>schnell · Gemini-API-Schlüssel</small>
          </button>
          <button
            className={active ? 'active' : ''}
            aria-pressed={active}
            onClick={() => patch({ speech: { ...speech, provider: 'elevenlabs' } })}
          >
            ElevenLabs
            <small>natürlicher · Kontingent</small>
          </button>
          <button
            className={speech.provider === 'openai' ? 'active' : ''}
            aria-pressed={speech.provider === 'openai'}
            onClick={() => patch({ speech: { ...speech, provider: 'openai' } })}
          >
            OpenAI Realtime
            <small>OpenAI Realtime · Schlüssel</small>
          </button>
        </div>
        <div className="hint">
          Gemini hört, denkt und spricht in einem Weg. ElevenLabs klingt natürlicher; Denken und
          Stimme bleiben dabei getrennt, damit auch Ollama Werkzeuge verwenden kann.
        </div>
        <details className="advanced-choice" open={speech.provider === 'piper' || speech.provider === 'vibevoice'}>
          <summary>Lokale Stimmen</summary>
          <select
            aria-label="Lokale Stimmen"
            value={speech.provider === 'piper' || speech.provider === 'vibevoice' ? speech.provider : ''}
            onChange={(e) => {
              if (e.target.value) patch({ speech: { ...speech, provider: e.target.value as never } })
            }}
          >
            <option value="">Lokale Stimme wählen…</option>
            <option value="piper">piper — schnell und kostenlos</option>
            <option value="vibevoice">VibeVoice — natürlicher, aber langsamer</option>
          </select>
        </details>
      </div>

      {/* Der Denkmotor gehört zu beiden fremden Sprechern: Es ist derselbe
          zusammengesetzte Weg, und wer denkt, ist davon unabhängig. */}
      {(active || speech.provider === 'openai') && <VoiceAccess key={speech.provider} provider={active ? 'elevenlabs' : 'openai'} onSaved={() => void refresh(true)} />}

      {composite && <BrainPicker settings={settings} patch={patch} />}

      {local && <PiperPicker settings={settings} patch={patch} />}

      {speech.provider === 'openai' && (
        <div className="field">
          <label>OpenAI Realtime</label>
          <select aria-label="OpenAI Realtime"
            value={speech.realtimeVoice}
            onChange={(e) => patch({ speech: { ...speech, realtimeVoice: e.target.value } })}
          >
            {['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <input
            aria-label="OpenAI Realtime – Modellname"
            value={speech.realtimeModel}
            placeholder="gpt-realtime"
            onChange={(e) => patch({ speech: { ...speech, realtimeModel: e.target.value } })}
          />
          <div className="hint">
            Braucht einen OpenAI API-Schlüssel unter Zugänge und wird separat abgerechnet.
            Das ChatGPT-Abo deckt diesen Audio-Endpunkt nicht ab. Verbindungsfehler werden angezeigt;
            der gewählte Sprachweg bleibt erhalten.
          </div>
        </div>
      )}

      {active && (
        <>
          <div className="field">
            <label>Sparplan</label>
            <div className="choice-switch three" role="group" aria-label="ElevenLabs-Sparplan">
              {([
                ['saving', 'Sparsam', '≈ doppelte Laufzeit'],
                ['balanced', 'Ausgewogen', 'etwas ausführlicher'],
                ['quality', 'Beste Qualität', 'höherer Verbrauch']
              ] as const).map(([value, title, detail]) => (
                <button
                  key={value}
                  className={speech.elevenPlan === value ? 'active' : ''}
                  aria-pressed={speech.elevenPlan === value}
                  onClick={() => patch({ speech: { ...speech, elevenPlan: value } })}
                >
                  {title}
                  <small>{detail}</small>
                </button>
              ))}
            </div>
            <div className="hint">
              Sparsam nutzt Flash zum halben Zeichenpreis, vermeidet Wiederholungen und hält
              Antworten normalerweise bei höchstens drei kurzen Sätzen. Ausführliche Antworten
              bleiben möglich, wenn du sie ausdrücklich verlangst.
            </div>
          </div>

          <div className="field">
            <label>ElevenLabs-Stimme</label>
            <select aria-label="ElevenLabs-Stimme"
              value={speech.elevenVoiceId}
              onChange={(e) => patch({ speech: { ...speech, elevenVoiceId: e.target.value } })}
            >
              <option value="">Passende automatisch wählen</option>
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                  {fitsJarvis(v.name) ? ' — passt zu James' : ''}
                  {v.category === 'cloned' ? ' — eigene' : ''}
                  {/* Bibliotheksstimmen sind im Gratistarif gesperrt, und der
                      Anbieter sagt das erst beim Sprechen. Besser vorher. */}
                  {v.category === 'professional' ? ' — Bibliothek, nur mit bezahltem Tarif' : ''}
                </option>
              ))}
            </select>
            <div className="row">
              <button
                className="primary"
                disabled={playing || voices.length === 0}
                onClick={() => void play()}
              >
                {playing ? 'spricht…' : 'Hörprobe'}
              </button>
              <button className="ghost" disabled={busy} onClick={() => void refresh(true)}>
                {busy ? 'frage nach…' : 'Stimmen und Kontingent neu laden'}
              </button>
            </div>
            <div className="hint">
              {loadError
                ? 'Nachfragen ging nicht: ' + loadError + ' — Bitte Schlüssel prüfen und noch einmal laden.'
                : previewError ??
                  (quota === null
                    ? 'Noch nicht nachgefragt.'
                    : quota.reason
                      ? quota.reason
                      : quota.limit === 0
                        ? 'Kontingent: unbegrenzt.'
                        : `Kontingent: ${quota.remaining.toLocaleString('de-DE')} von ` +
                          `${quota.limit.toLocaleString('de-DE')} Credits übrig.` +
                          (quota.resetsAt
                            ? ` Füllt sich am ${new Date(quota.resetsAt * 1000).toLocaleDateString('de-DE')} wieder auf.`
                            : ''))}
            </div>
            <div className="hint">
              Ohne Auswahl nimmt James die erste Stimme, die zu ihm passt — tief, ruhig, britisch.
              Vorher war es schlicht die erste des Kontos, und die ist bei den meisten eine junge
              Frauenstimme. Die Hörprobe kostet ein paar Credits vom Kontingent und erspart den
              Umweg über das Gespräch.
            </div>
            <div className="hint">
              Sparsam und Ausgewogen sprechen mit Flash v2.5 zum halben Credit je Zeichen. Beste
              Qualität bevorzugt Multilingual v2; es klingt voller, verbraucht aber ungefähr das
              Doppelte. Zahlen, Uhrzeiten und Datumsangaben werden für Sprache normalisiert.
            </div>
          </div>

          <div className="field">
            <label>Gleichmäßigkeit — {Math.round(speech.stability * 100)} %</label>
            <input aria-label="Gleichmäßigkeit —"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={speech.stability}
              onChange={(e) =>
                patch({ speech: { ...speech, stability: Number(e.target.value) } })
              }
            />
            <div className="hint">
              Niedrig heißt ausdrucksstark, aber wechselhaft; hoch heißt ruhig, aber flacher. Um
              35 % entsteht Betonung, ohne dass zwei Sätze hintereinander verschieden klingen.
            </div>
          </div>

          <div className="field">
            <label>Tempo — {speech.speed.toFixed(2)}×</label>
            <input aria-label="Tempo —"
              type="range"
              min={0.8}
              max={1.15}
              step={0.01}
              value={speech.speed}
              onChange={(e) => patch({ speech: { ...speech, speed: Number(e.target.value) } })}
            />
            <div className="hint">
              Eine Spur unter eins klingt gesetzt statt gehetzt und ist nebenbei verständlicher.
              Über eins wird es hastig, ohne wirklich Zeit zu sparen — der Weg zur Antwort ist
              länger als der Satz.
            </div>
          </div>

          <div className="field">
            <label>Ausdruck — {Math.round(speech.style * 100)} %</label>
            <input aria-label="Ausdruck —"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={speech.style}
              onChange={(e) => patch({ speech: { ...speech, style: Number(e.target.value) } })}
            />
            <div className="hint">
              Wie viel Absicht in der Betonung steckt. Kostet auf der Gegenseite Rechenzeit und
              damit Wartezeit — bei null wird es gar nicht erst mitgeschickt, und genau dann klingt
              es nach Ansage statt nach Antwort. Ein Drittel reicht, damit Fragen wie Fragen
              klingen; über der Hälfte fangen die Sätze an, untereinander zu schwanken.
            </div>
          </div>
        </>
      )}
      <hr className="section-divider" />
    </>
  )
}

/** Fällt der Name unter die, die zu James passen? */
function fitsJarvis(name: string): boolean {
  return ELEVEN.jarvisVoiceNames.some((wanted) => wanted.toLowerCase() === name.toLowerCase())
}

/** Die Gemini-Modelle, die auf diesem Weg zur Wahl stehen. */
const GEMINI_BRAINS = [
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite — am schnellsten' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash — überlegter, etwas träger' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash — am gründlichsten' }
]

/**
 * Wer denkt, während ElevenLabs spricht.
 *
 * Ein Menü und nicht zwei. Vorher stand hier erst die Frage nach dem Anbieter
 * und darunter, je nach Antwort, eine zweite nach dem Modell — zwei Schritte
 * für eine Entscheidung, deren zweite Hälfte die erste ohnehin schon festlegt.
 * Wer "das da auf meinem Rechner" wählen will, meint ein Modell, nicht einen
 * Anbieter. Also stehen beide Seiten in einer Liste, in Gruppen getrennt, und
 * die Wahl setzt Anbieter und Modell in einem Zug.
 *
 * Die folgenreichere Hälfte ist dabei die Gruppe: Sie entscheidet, ob das
 * Gespräch diesen Rechner verlässt. Was sie *nicht* entscheidet, steht als
 * Hinweis darunter — gehört wird weiterhin über Gemini, denn ein Textmodell
 * hört nichts. Das ist unbefriedigend und wahr, und es hier zu verschweigen
 * hieße, jemandem "lokal" zu verkaufen, was keines ist.
 */
function BrainPicker({ settings, patch }: Props): JSX.Element {
  const speech = settings.speech
  const [health, setHealth] = useState<OllamaHealth | null>(null)
  const [busy, setBusy] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)

  const check = async (): Promise<void> => {
    setBusy(true)
    setCheckError(null)
    try {
      setHealth(await window.jarvis.invoke('ollama:health'))
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Einmal beim Öffnen nachsehen, unabhängig von der aktuellen Wahl.
   *
   * Das gemeinsame Menü zeigt beide Seiten nebeneinander — also müssen auch
   * beide bekannt sein, bevor jemand wählt. Früher wurde erst gefragt, wenn
   * Ollama schon eingestellt war; damit stand in der Liste nie etwas, worauf
   * man hätte umstellen können. Läuft Ollama nicht, kostet die Frage eine
   * Frist und bleibt folgenlos.
   */
  useEffect(() => {
    void check()
  }, [])

  const local = health?.models ?? []
  const isLocal = speech.thinkProvider === 'ollama'
  const isChatGpt = speech.thinkProvider === 'chatgpt'
  const [chatGpt, setChatGpt] = useState<{ connected: boolean; models: ChatGptModel[]; error?: string }>({
    connected: false,
    models: []
  })

  /** Modelle erst fragen, wenn eine Anmeldung da ist — sonst gibt es nichts zu zeigen. */
  const loadChatGpt = async (): Promise<void> => {
    let status
    try {
      status = await window.jarvis.invoke('chatgpt:status')
    } catch (err) {
      setChatGpt({ connected: false, models: [], error: err instanceof Error ? err.message : String(err) })
      return
    }
    if (!status.connected) {
      setChatGpt({ connected: false, models: [] })
      return
    }
    try {
      const models = await window.jarvis.invoke('chatgpt:models')
      setChatGpt({ connected: true, models })
      if (!settings.chatGptModel && models[0]) patch({ chatGptModel: models[0].id })
    } catch (err) {
      // Angemeldet ja, aber die Modellliste blieb aus — das gehört zur Fehlermeldung.
      setChatGpt({ connected: true, models: [], error: err instanceof Error ? err.message : String(err) })
    }
  }
  useEffect(() => {
    void loadChatGpt()
  }, [])

  /**
   * Ein eingestelltes Modell, das die Liste nicht kennt, kommt trotzdem hinein.
   *
   * Ollama aus, Modell gelöscht, Name vertippt — in all diesen Fällen fände ein
   * Auswahlfeld seinen eigenen Wert nicht und zeigte stillschweigend den ersten
   * Eintrag an. Es stünde dann etwas anderes da als das, was gilt, und niemand
   * hätte es geändert.
   */
  const stray =
    isLocal && settings.ollama.model && !local.some((m) => m.name === settings.ollama.model)

  const localModels = local.filter((model) => !model.embedding)

  const chooseProvider = (provider: 'gemini' | 'ollama' | 'chatgpt'): void => {
    if (provider !== 'ollama') {
      patch({ speech: { ...speech, thinkProvider: provider } })
      return
    }
    const selected = localModels.some((model) => model.name === settings.ollama.model)
      ? settings.ollama.model
      : (localModels.find((model) => model.tools)?.name ?? localModels[0]?.name ?? '')
    if (!selected) return
    patch({
      speech: { ...speech, thinkProvider: 'ollama' },
      ollama: { ...settings.ollama, model: selected }
    })
  }

  return (
    <>
      <div className="field">
        <label>
          Wer denkt{' '}
          {/* Das Abzeichen gilt dem lokalen Weg und steht deshalb nur dort.
              Drei Zustände, nicht zwei: Ein Modell ohne Werkzeuge ist nicht
              kaputt. Ohne native Tool Calls nutzt es den langsameren,
              zweistufigen JSON-Kompatibilitätsmodus. */}
          {!isLocal || health === null ? null : health.ok && health.tools ? (
            <span className="badge ok">läuft</span>
          ) : health.ok ? (
            <span className="badge missing">Kompatibilitätsmodus</span>
          ) : (
            <span className="badge err">geht nicht</span>
          )}
        </label>
        {checkError && (
          <div className="hint err" role="alert">
            Prüfung fehlgeschlagen: {checkError} Bitte versuche es noch einmal.
          </div>
        )}
        <div className="choice-switch three" role="group" aria-label="Denkmotor auswählen">
          <button
            className={!isLocal && !isChatGpt ? 'active' : ''}
            aria-pressed={!isLocal && !isChatGpt}
            onClick={() => chooseProvider('gemini')}
          >
            Gemini API
            <small>schnell · Cloud</small>
          </button>
          <button
            className={isLocal ? 'active' : ''}
            aria-pressed={isLocal}
            disabled={localModels.length === 0}
            onClick={() => chooseProvider('ollama')}
          >
            Ollama lokal
            <small>{localModels.length > 0 ? 'privat · Werkzeuge kompatibel' : 'kein Textmodell'}</small>
          </button>
          <button
            className={isChatGpt ? 'active' : ''}
            aria-pressed={isChatGpt}
            disabled={!chatGpt.connected}
            onClick={() => chooseProvider('chatgpt')}
          >
            ChatGPT-Abo
            <small>{chatGpt.connected ? 'dein Plan · Cloud' : 'erst unter Zugänge anmelden'}</small>
          </button>
        </div>
        {isChatGpt ? (
          <>
            <select
              aria-label="ChatGPT-Modell"
              value={settings.chatGptModel}
              onChange={(e) => patch({ chatGptModel: e.target.value })}
            >
              {chatGpt.models.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
              {settings.chatGptModel && !chatGpt.models.some((m) => m.id === settings.chatGptModel) && (
                <option value={settings.chatGptModel}>{settings.chatGptModel}</option>
              )}
            </select>
            {chatGpt.error && <div className="hint err">{chatGpt.error}</div>}
            <div className="hint">
              Zählt gegen das Kontingent deines ChatGPT-Plans, nicht gegen einen API-Schlüssel.{' '}
              <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">
                Verbrauch ansehen
              </a>
              . Gehört wird weiter über die Einstellung unter Ohren.
            </div>
          </>
        ) : isLocal ? (
          <select
            aria-label="Ollama-Modell für das Denken"
            value={settings.ollama.model}
            onChange={(e) => patch({ ollama: { ...settings.ollama, model: e.target.value } })}
          >
            {localModels.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}{m.parameterSize ? ` — ${m.parameterSize}` : ''}
                {m.tools ? ' · native Werkzeuge' : ' · kompatibler Werkzeugmodus'}
              </option>
            ))}
            {stray && <option value={settings.ollama.model}>{settings.ollama.model} — nicht gefunden</option>}
          </select>
        ) : (
          <select
            aria-label="Gemini-Gehirnmodell"
            value={speech.brainModel}
            onChange={(e) => patch({ speech: { ...speech, brainModel: e.target.value } })}
          >
            {GEMINI_BRAINS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        )}
        <div className="row">
          <button className="ghost" disabled={busy} onClick={() => void check()}>
            {busy ? 'sehe nach…' : 'Nachsehen, was hier liegt'}
          </button>
        </div>

        {isLocal ? (
          <>
            <div className="hint">{health?.detail ?? 'Noch nicht nachgesehen.'}</div>
            <div className="hint">
              <strong style={{ color: 'var(--text)' }}>Was das bedeutet.</strong> Was hier lokal
              bleibt, ist das Denken — und damit alles, was James über dich weiß.{' '}
              {speech.hearProvider === 'whisper' ? (
                <>
                  Gehört wird ebenfalls hier, über whisper unter Ohren. Damit verlässt dein
                  gesprochenes Wort diesen Rechner nicht mehr — vorausgesetzt, unter „Wer spricht"
                  steht auch kein fremder Sprecher.
                </>
              ) : (
                <>
                  Gehört wird dagegen weiterhin über Google: Ein Textmodell hört nichts, und die
                  Abschrift deines Beitrags muss dafür hinaus. Unter Ohren lässt sich auch das auf
                  diesen Rechner umstellen.
                </>
              )}{' '}
              Modelle mit nativer Werkzeug-Unterstützung sind schneller und zuverlässiger. Andere
              Textmodelle bleiben trotzdem nutzbar: James wählt erst das Werkzeug und extrahiert
              danach dessen Argumente mit einem einzelnen, strengen Schema. Fällt Ollama ganz aus,
              übernimmt vorübergehend Gemini API das Denken; die gewählte Stimme bleibt unverändert.
            </div>
          </>
        ) : (
          <div className="hint">
            Auf diesem Weg denkt nicht das Live-Modell, sondern ein gewöhnliches: Kein Live-Modell
            gibt Text aus, sie sprechen alle selbst. Damit ist aber gleichgültig, wer den Text
            geschrieben hat — auch ein Modell auf diesem Rechner kann das. Hier wartet jemand mit
            offenem Mund; ein klügeres Modell, das eine Sekunde länger braucht, ist an dieser
            Stelle das schlechtere.
          </div>
        )}
      </div>

      <div className="field">
        <label>Wartezeit bis zur Antwort — {settings.speech.endpointMs} ms</label>
        <input aria-label="Wartezeit bis zur Antwort —"
          type="range"
          min={250}
          max={1000}
          step={10}
          value={settings.speech.endpointMs}
          onChange={(e) => patch({ speech: { ...speech, endpointMs: Number(e.target.value) } })}
        />
        <div className="hint">
          So lange muss es still sein, bis dein Satz als beendet gilt. Der Regler, an dem man „zu
          langsam" merkt: Alles, was hier steht, wartest du vor jeder Antwort. Zu kurz gesetzt
          fällt er dir ins Wort, sobald du mitten im Satz überlegst. Gilt nur für diesen Weg — die
          Live-Sitzung entscheidet das selbst und hört dabei schon beim Reden zu.
        </div>
      </div>
    </>
  )
}

/**
 * Der Sprecher auf diesem Rechner.
 *
 * Das Gegenstück zu den ElevenLabs-Reglern, und es hat weniger davon: Stimme,
 * Tempo, Rückseite. Gleichmäßigkeit, Ausdruck und Kontingent gibt es hier nicht,
 * weil es sie nicht gibt — piper hat keine Regler dafür und rechnet nichts ab.
 */
function PiperPicker({ settings, patch }: Props): JSX.Element {
  const piper = settings.piper
  const [health, setHealth] = useState<PiperHealth | null>(null)
  const [busy, setBusy] = useState(false)
  /** Gescheiterte Prüfung — sonst bliebe die Anzeige auf „Noch nicht nachgesehen". */
  const [checkError, setCheckError] = useState<string | null>(null)
  /** Eine Stimme wird gerade beschafft; ohne Sperrung ließe sich mehrfach wählen. */
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)

  /**
   * Auch hier nur auf Knopfdruck: Die Frage startet den Prozess und lädt die
   * ONNX-Sitzung. Das ist billiger als bei whisper, aber nicht umsonst — und
   * beim Öffnen einer Einstellungsseite hat es niemand bestellt.
   */
  const check = async (): Promise<void> => {
    setBusy(true)
    setCheckError(null)
    try {
      setHealth(await window.jarvis.invoke('piper:health'))
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  /** Ein eingestellter Pfad, den die Liste nicht kennt — wie beim Denkmodell. */
  const chosen = PIPER.voices.find((v) => piper.voicePath.includes(v.id))?.id ?? ''

  // Während die Beschaffung läuft, weiß der Vorhang (`local:install`) nichts von
  // dieser Tabelle — hier reicht eine kurze Zeile, dass sie gehört wird.
  const choose = async (id: string): Promise<void> => {
    const voice = PIPER.voices.find((v) => v.id === id)
    if (!voice) return
    setFetching(true)
    setFetchError(null)
    try {
      // Nur die Wahl merken. Wo die Datei liegt, entscheidet die
      // Beschaffung — sie schreibt den Pfad selbst zurück, sobald die
      // Stimme wirklich da ist. Hier einen Pfad einzutragen, unter dem
      // nichts liegt, sähe eingerichtet aus und wäre es nicht.
      await window.jarvis.invoke('local:install', { id: 'piper-voice', choice: voice.id })
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'Beschaffung fehlgeschlagen.')
    } finally {
      setFetching(false)
    }
  }

  return (
    <>
      <div className="field">
        <label>
          Stimme{' '}
          {health === null ? null : health.ok ? (
            <span className="badge ok">läuft</span>
          ) : (
            <span className="badge err">geht nicht</span>
          )}
        </label>
        <select aria-label="Stimme"
          value={chosen}
          disabled={fetching}
          onChange={(e) => void choose(e.target.value)}
        >
          {chosen === '' && <option value="">— noch keine Stimme geholt —</option>}
          {PIPER.voices.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </select>
        {fetching && <div className="hint">Die Stimme wird geholt — das dauert je nach Größe einen Moment.</div>}
        {fetchError && (
          <div className="hint err" role="alert">
            {fetchError}
          </div>
        )}
        <div className="row">
          <button className="ghost" disabled={busy} onClick={() => void check()}>
            {busy ? 'starte und wärme auf…' : 'Nachsehen, ob piper spricht'}
          </button>
        </div>
        <div className="hint">
          {checkError
            ? 'Nachsehen ging nicht: ' + checkError + ' — Bitte noch einmal versuchen.'
            : health?.detail ??
              'Noch nicht nachgesehen. Eine andere Stimme zu wählen holt sie — das dauert je ' +
                'nach Größe einen Moment und stellt danach von selbst um.'}
        </div>
      </div>

      <div className="field">
        <label>
          Sprechtempo — {piper.lengthScale.toFixed(2)}×{' '}
          {piper.lengthScale > 1 ? '(langsamer)' : piper.lengthScale < 1 ? '(schneller)' : ''}
        </label>
        <input aria-label="Sprechtempo —"
          type="range"
          min={0.7}
          max={1.4}
          step={0.05}
          value={piper.lengthScale}
          onChange={(e) => patch({ piper: { ...piper, lengthScale: Number(e.target.value) } })}
        />
        <div className="hint">
          Achtung, der Wert läuft andersherum als man denkt: Er streckt die Laute, über eins wird
          es also <strong style={{ color: 'var(--text)' }}>langsamer</strong>, nicht schneller.
          Eins ist die Vorgabe der Stimme und meistens richtig.
        </div>
      </div>

      <div className="field">
        <label>Welche Fassung</label>
        <select aria-label="Welche Fassung"
          value={piper.backend}
          onChange={(e) => patch({ piper: { ...piper, backend: e.target.value as never } })}
        >
          <option value="auto">Erst die eigenständige, bei Absturz Python</option>
          <option value="exe">Nur die eigenständige Fassung</option>
          <option value="python">Nur die gepflegte Python-Fassung</option>
        </select>
        <div className="hint">
          piper gibt es unter Windows zweimal, und keine Fassung ist ohne Haken. Die eigenständige
          piper.exe stammt vom November 2023 aus einem inzwischen archivierten Projekt und stürzt
          auf manchen Windows-Ständen beim Laden des Modells ab. Die gepflegte gibt es nur als
          Python-Paket und braucht deshalb ein Python auf diesem Rechner. Darum die Vorgabe: erst
          die schnelle versuchen, und wenn sie stirbt, die andere nehmen. Was wirklich läuft,
          steht oben in der Auskunft — geraten wird nichts.
        </div>
      </div>

      <hr className="section-divider" />
      <h2>Was piper dafür braucht</h2>
      <LocalAssets
        only={['piper-runtime', 'piper-voice']}
        choices={{ 'piper-voice': PIPER.voices.map((v) => ({ value: v.id, label: v.label })) }}
      />
      <hr className="section-divider" />
    </>
  )
}

// ─────────────────────────────────────────────────────────────
// Beschaffung — die Stücke, die die App nicht mitliefert
// ─────────────────────────────────────────────────────────────

/** Byte in etwas, das man mit einer Leitung vergleichen kann. */
function megabytes(bytes: number): string {
  if (bytes <= 0) return 'unbekannt groß'
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`
  return `${(bytes / 1024 / 1024).toFixed(bytes < 100 * 1024 * 1024 ? 1 : 0)} MB`
}

/**
 * Was zum lokalen Reden fehlt — und der Knopf, der es holt.
 *
 * Eine Komponente für beide Abschnitte, gefiltert nach den Kennungen, die
 * dorthin gehören. Zwei Fassungen liefen unweigerlich auseinander, und
 * ausgerechnet hier wäre das teuer: Was hier steht, ist die einzige Stelle, an
 * der jemand erfährt, was er sich gerade auf den Rechner lädt.
 *
 * Deshalb steht die Herkunft sichtbar daneben und nicht in einem Hinweisfeld.
 * Geladen wird ausschließlich auf ausdrücklichen Klick — nichts davon holt sich
 * die App von selbst, und nichts davon liegt im Installer. Ein Sprachmodell von
 * einer halben Gigabyte gehört dort nicht hinein, und fremde Binärdateien unter
 * fremden Lizenzen sollen eine Entscheidung sein, die jemand trifft, und keine,
 * die er beim Auspacken geschenkt bekommt.
 */
function LocalAssets({
  only,
  choices
}: {
  only: LocalAssetId[]
  /** Wo es etwas zu wählen gibt: Kennung → Liste aus Wert und Beschriftung. */
  choices?: Partial<Record<LocalAssetId, { value: string; label: string }[]>>
}): JSX.Element {
  const [assets, setAssets] = useState<LocalAsset[] | null>(null)
  const [progress, setProgress] = useState<Partial<Record<LocalAssetId, LocalInstallProgress>>>({})
  const [picked, setPicked] = useState<Partial<Record<LocalAssetId, string>>>({})
  /** Die Bestandsfrage schlug fehl — sonst bliebe die Tabelle für immer auf „Sehe nach…". */
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    void window.jarvis
      .invoke('local:assets')
      .then(setAssets)
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : String(err)))
    // Der Fortschritt kommt als Ereignis und nicht als Antwort auf den Aufruf:
    // Ein Balken, der erst am Ende auf hundert springt, ist keiner.
    return window.jarvis.on('local:progress', (p) => {
      setProgress((current) => ({ ...current, [p.id]: p }))
      // Fertig oder gescheitert — beides ändert, was auf der Platte liegt.
      if (p.done || p.error) void window.jarvis.invoke('local:assets').then(setAssets).catch(() => undefined)
    })
  }, [])

  /**
   * Was im Menü steht, ist auch das, was geholt wird.
   *
   * Ohne diesen Rückfall zeigte das Auswahlfeld seinen ersten Eintrag an,
   * während `picked` noch leer wäre — und ein leeres `choice` heißt drüben
   * „nimm die Vorgabe". Bei den Sprachmodellen sind das zwei verschiedene
   * Dateien: angezeigt stünde `base`, geladen würde `small`. Der Nutzer hätte
   * eine halbe Gigabyte geholt, die er nicht bestellt hat, und in der Liste
   * stünde danach etwas anderes, als er gewählt zu haben glaubte.
   */
  const choiceFor = (id: LocalAssetId): string | undefined =>
    picked[id] ?? choices?.[id]?.[0]?.value

  const install = (id: LocalAssetId): void => {
    setProgress((current) => ({
      ...current,
      [id]: { id, received: 0, total: 0, done: false, error: null }
    }))
    void window.jarvis
      .invoke('local:install', { id, choice: choiceFor(id) })
      .then(setAssets)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        setProgress((current) => ({
          ...current,
          [id]: { id, received: 0, total: 0, done: false, error: message }
        }))
      })
  }

  if (loadError !== null)
    return <p className="hint err" role="alert">Der Bestand ließ sich nicht aufnehmen: {loadError} Bitte schließe die Einstellungen und öffne sie wieder.</p>
  if (assets === null) return <p className="hint">Sehe nach, was schon da ist…</p>

  const shown = assets.filter((a) => only.includes(a.id))

  return (
    <table>
      <tbody>
        {shown.map((asset) => {
          const state = progress[asset.id]
          const busy = Boolean(state) && !state?.done && !state?.error
          const percent =
            state && state.total > 0 ? Math.min(100, Math.round((state.received / state.total) * 100)) : null
          const options = choices?.[asset.id]

          return (
            <tr key={asset.id}>
              <td>
                {asset.label}{' '}
                {asset.present ? (
                  <span className="badge ok">liegt da</span>
                ) : (
                  <span className="badge missing">fehlt</span>
                )}
                <div className="hint">{asset.purpose}</div>
                <div className="hint">
                  {megabytes(asset.bytes)} · {asset.license}
                </div>
                {/* Die Herkunft im Klartext. Wer das nicht lesen will, überliest
                    es; wer es lesen will, soll nicht danach suchen müssen. */}
                <div className="hint" style={{ wordBreak: 'break-all', opacity: 0.7 }}>
                  {asset.url}
                </div>
                {state?.error && <div className="hint">{state.error}</div>}
                {busy && (
                  <div className="hint">
                    {percent === null
                      ? `${megabytes(state?.received ?? 0)} geladen…`
                      : `${percent} % — ${megabytes(state?.received ?? 0)} von ${megabytes(state?.total ?? 0)}`}
                  </div>
                )}
              </td>
              <td style={{ width: options ? 260 : 150 }}>
                <div className="row" style={{ gap: 8 }}>
                  {options && (
                    <select
                      aria-label={`Fassung für ${asset.id}`}
                      value={choiceFor(asset.id) ?? ''}
                      disabled={busy}
                      onChange={(e) => setPicked({ ...picked, [asset.id]: e.target.value })}
                    >
                      {options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    className={asset.present ? 'ghost' : 'primary'}
                    disabled={busy}
                    onClick={() => install(asset.id)}
                  >
                    {busy ? 'lädt…' : asset.present ? 'Erneut holen' : 'Holen'}
                  </button>
                </div>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// ─────────────────────────────────────────────────────────────
// Ohren
// ─────────────────────────────────────────────────────────────

/**
 * Wer zuhört.
 *
 * Ein eigener Abschnitt und nicht ein Feld unter „Zuhören", weil hier die
 * Fehlermeldungen des Dienstes hinzeigen: whisper schickt den Nutzer wörtlich
 * „in die Einstellungen unter Ohren", wenn ihm eine Datei fehlt. Ein Verweis auf
 * einen Abschnitt, den es nicht gibt, ist schlimmer als gar keiner.
 */
export function EarsSection({ settings, patch }: Props): JSX.Element {
  const whisper = settings.whisper
  const speech = settings.speech
  const [health, setHealth] = useState<WhisperHealth | null>(null)
  const [busy, setBusy] = useState(false)
  /** Gescheiterte Prüfung — Whisper fängt der fortlaufende Zustand auf, dies nicht. */
  const [checkError, setCheckError] = useState<string | null>(null)

  /**
   * Nur auf Knopfdruck, nie beim Öffnen der Seite.
   *
   * Diese Frage startet den Dienst, wenn er nicht läuft, lädt ein halbes
   * Gigabyte Modell in den Speicher und schickt einen Aufwärmsatz hinterher.
   * Beim ersten Mal dauert das bis zu einer Minute. Wer die Einstellungen nur
   * aufmacht, um den Lautstärkeregler zu suchen, soll dafür weder warten noch
   * den Lüfter hören.
   */
  const check = async (): Promise<void> => {
    setBusy(true)
    setCheckError(null)
    try {
      setHealth(await window.jarvis.invoke('whisper:health'))
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const local = speech.hearProvider === 'whisper'

  return (
    <>
      <h2>Ohren</h2>
      <p className="lede">
        Wer den Ton in Wortlaut übersetzt. Das ist der Schalter, der aus „lokal" endlich lokal
        macht: Solange die Abschrift über Google lief, verließ jeder Satz die Wohnung, auch wenn
        Denken und Sprechen längst hier passierten.
      </p>

      <div className="field">
        <label>
          Wer zuhört{' '}
          {!local || health === null ? null : health.ok ? (
            <span className="badge ok">läuft</span>
          ) : (
            <span className="badge err">geht nicht</span>
          )}
        </label>
        <select aria-label="Wer zuhört"
          value={speech.hearProvider}
          onChange={(e) =>
            patch({ speech: { ...speech, hearProvider: e.target.value as never } })
          }
        >
          <option value="whisper">whisper — auf diesem Rechner, nichts geht hinaus</option>
          <option value="gemini">Google — schneller, dein Wort geht hinaus</option>
        </select>
        <div className="hint">
          {local
            ? 'whisper rechnet auf deiner CPU, und diese Zeit liegt vor jeder Antwort. Wie lang ' +
              'sie auf diesem Rechner wirklich ist, sagt dir nur eine Messung — dafür ist der ' +
              'Knopf unten da. Geraten wird hier nichts.'
            : 'Der Ton deines Beitrags geht zur Abschrift an Google. Das ist schnell und kostet ' +
              'Token, und es gilt auch dann, wenn das Denken auf diesem Rechner läuft.'}
        </div>
      </div>

      {local && (
        <>
          <div className="field">
            <div className="row">
              <button className="ghost" disabled={busy} onClick={() => void check()}>
                {busy ? 'starte und wärme auf…' : 'Nachsehen, ob whisper läuft'}
              </button>
            </div>
            <div className="hint">
              {checkError
                ? 'Nachsehen ging nicht: ' + checkError + ' — Bitte noch einmal versuchen.'
                : health?.detail ??
                  'Noch nicht nachgesehen. Der erste Versuch startet den Dienst und lädt das ' +
                    'Modell — das kann eine Minute dauern und passiert bewusst nicht von selbst.'}
            </div>
          </div>

          <hr className="section-divider" />
          <h2>Was whisper dafür braucht</h2>
          <LocalAssets
            only={['whisper-runtime', 'whisper-model', 'whisper-vad']}
            choices={{
              'whisper-model': WHISPER.models.map((m) => ({ value: m.file, label: m.label }))
            }}
          />

          <hr className="section-divider" />
          <h2>Feineinstellung</h2>

          <div className="field">
            <label>
              Rechenfäden — {whisper.threads === 0 ? 'aus der Kernzahl abgeleitet' : whisper.threads}
            </label>
            <input aria-label="Rechenfäden —"
              type="range"
              min={0}
              max={16}
              step={1}
              value={whisper.threads}
              onChange={(e) => patch({ whisper: { ...whisper, threads: Number(e.target.value) } })}
            />
            <div className="hint">
              Null heißt: die Hälfte der logischen Kerne, also ungefähr die Zahl der physischen.
              Das ist fast immer richtig. Mehr Fäden als physische Kerne machen whisper messbar
              langsamer, nicht schneller — die Vorgabe des Dienstes selbst wäre vier und ließe auf
              einem Achtkerner die Hälfte liegen.
            </div>
          </div>

          <div className="field">
            <label>Zeitfenster — mindestens {whisper.audioCtx}</label>
            <input aria-label="Zeitfenster — mindestens"
              type="range"
              min={768}
              max={1500}
              step={64}
              value={whisper.audioCtx}
              onChange={(e) => patch({ whisper: { ...whisper, audioCtx: Number(e.target.value) } })}
            />
            <div className="hint">
              Der einzige Regler, der die Wartezeit wirklich senkt. Der Encoder rechnet sonst immer
              dreißig Sekunden, auch für ein „ja" von zweien — die Eingabe wird schlicht mit Stille
              aufgefüllt. Was ein einzelner Beitrag davon braucht, rechnet der Dienst aus seiner
              Länge aus; hier steht nur die Untergrenze. Unter 768 kippt die Erkennung, deshalb
              geht der Regler nicht tiefer.
            </div>
          </div>

          <div className="field">
            <label className="row" style={{ gap: 8 }}>
              <input
                type="checkbox"
                checked={whisper.vad}
                onChange={(e) => patch({ whisper: { ...whisper, vad: e.target.checked } })}
              />
              Sprache von Stille trennen, bevor das Modell sie sieht
            </label>
            <div className="hint">
              Nicht nur eine Ersparnis, sondern die wichtigste Sicherung: Bei Stille erfindet
              whisper Text, und auf Deutsch mit erschütternder Beharrlichkeit denselben — den
              Abspann einer Untertitelung, den es aus seinen Trainingsdaten auswendig kann.
              Ausgeschaltet antwortet James irgendwann auf einen Satz, den nie jemand gesagt hat.
            </div>
          </div>

          <div className="field">
            <label>Port des Dienstes</label>
            <input aria-label="Port des Dienstes"
              type="number"
              value={whisper.port}
              onChange={(e) => patch({ whisper: { ...whisper, port: Number(e.target.value) } })}
            />
            <div className="hint">
              Bewusst nicht 8080: Der ist unter Windows notorisch belegt, und ein Dienst, der beim
              Start auf einen fremden Server trifft, meldet keinen Fehler — er schickt seine
              Anfragen dorthin.
            </div>
          </div>
        </>
      )}
    </>
  )
}

/** Was die Hörprobe sagt — kurz, mit Zahlen und einem Nebensatz. */
const PREVIEW_TEXT =
  'Guten Abend, Sir. Der Rechner läuft seit vier Stunden, die Temperatur ist unauffällig, ' +
  'und Ihr Paket kommt morgen zwischen zehn und zwölf.'

/**
 * Die Haltung.
 *
 * Der Unterschied zwischen einem Assistenten und diesem Assistenten sind keine
 * Fähigkeiten, sondern ein Ton — und den kann man wollen oder nicht.
 */
function PersonaPicker({ settings, patch }: Props): JSX.Element {
  return (
    <div className="field">
      <label>Haltung</label>
      <select aria-label="Haltung"
        value={settings.persona}
        onChange={(e) => patch({ persona: e.target.value as never })}
      >
        <option value="jarvis">James — siezt dich, förmlich, knapp, trocken</option>
        <option value="sachlich">Sachlich — duzt dich, ohne den trockenen Zusatz</option>
        <option value="herzlich">Herzlich — duzt dich, warm und ruhig</option>
      </select>
      <div className="hint">
        James spricht dich förmlich an. „Sachlich“ und „Herzlich“ verwenden du. Deine Wahl ändert nur den Ton.
      </div>
    </div>
  )
}

const HUMOR_LABELS = ['keiner', 'selten', 'gelegentlich', 'gern']

/** Feinregler über der Haltung: Humor, Anrede, Name. */
function PersonalityControls({ settings, patch }: Props): JSX.Element {
  const p = settings.personality
  const [name, setName] = useState(p.name)
  const set = (next: Partial<typeof p>): void => { void patch({ personality: { ...p, ...next } }) }
  const nameOk = /^[\p{L}][\p{L}\p{M} .'-]{0,31}$/u.test(name.trim())
  return (
    <>
      <div className="field">
        <label>Humor: {HUMOR_LABELS[p.humor] ?? p.humor}</label>
        <input type="range" aria-label="Humor" min={0} max={3} step={1}
          value={p.humor} onChange={(e) => set({ humor: Number(e.target.value) })} />
      </div>
      <div className="field">
        <label>Anrede</label>
        <select aria-label="Anrede" value={p.address}
          onChange={(e) => set({ address: e.target.value as typeof p.address })}>
          <option value="auto">Wie die Haltung</option>
          <option value="du">Du</option>
          <option value="sie">Sie</option>
        </select>
      </div>
      <div className="field">
        <label>Name</label>
        <input type="text" aria-label="Name des Assistenten" value={name} maxLength={32}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => { if (nameOk && name.trim() !== p.name) set({ name: name.trim() }) }} />
        <div className="hint">
          {nameOk ? 'So stellt er sich vor. Das Weckwort bleibt davon unberührt.' : 'Nur Buchstaben, höchstens 32 Zeichen.'}
        </div>
      </div>
      <div className="field">
        <button type="button" onClick={() => { void window.jarvis.invoke('persona:preview') }}>Probe hören</button>
        <div className="hint">Spricht einen Beispielsatz im eingestellten Ton.</div>
      </div>
    </>
  )
}

export function VoiceSection({ settings, patch }: Props): JSX.Element {
  return (
    <>
      <h2>Stimme</h2>
      <p className="lede">
        Wähle eine Stimme und verbinde den passenden Anbieter. Die Einrichtung findest du direkt darunter.
      </p>

      <PersonaPicker settings={settings} patch={patch} />
      <PersonalityControls settings={settings} patch={patch} />
      <hr className="section-divider" />

      <ElevenVoicePicker settings={settings} patch={patch} />

      <details className="settings-disclosure"><summary>Stimme und Modelle genauer einstellen</summary>
      <div className="field">
        <label>Gemini-Stimme</label>
        <select aria-label="Gemini-Stimme" value={settings.voice} onChange={(e) => patch({ voice: e.target.value as never })}>
          {VOICES.map((v) => (
            <option key={v.name} value={v.name}>
              {v.name} — {v.trait} · {v.hint}
            </option>
          ))}
        </select>
        <div className="hint">
          Die Stimme steckt im Verbindungsaufbau. Beim Wechsel baut James die Sitzung neu auf, das
          dauert einen Moment.
        </div>
      </div>

      <div className="field">
        <label>Modell</label>
        <select aria-label="Modell"
          value={settings.liveModel}
          onChange={(e) => patch({ liveModel: e.target.value as never })}
        >
          <option value="gemini-3.8-live">Gemini 3.8 Live — aktuelle Live-Sprache</option>
          <option value="gemini-3.1-flash-live-preview">
            Gemini 3.1 Flash Live — versteht dich besser, geringere Latenz
          </option>
          <option value="gemini-2.5-flash-native-audio-preview-12-2025">
            Gemini 2.5 Native Audio — klingt emotionaler, erkennt Stimmung
          </option>
        </select>
        <div className="hint">
          3.8 ist das aktuelle Standardmodell für flüssige Unterhaltungen. 3.1 filtert laute
          Hintergrundgeräusche, 2.5 reagiert auf deine Stimmung.
        </div>
      </div>

      <div className="field">
        <label>Gehirn (Werkzeuge, Recherche, Befehle)</label>
        <input aria-label="Gehirn (Werkzeuge, Recherche, Befehle)"
          type="text"
          list="brain-models"
          value={settings.brainModel}
          onChange={(e) => patch({ brainModel: e.target.value })}
          spellCheck={false}
        />
        <datalist id="brain-models">
          <option value="gemini-3.6-flash" />
          <option value="gemini-2.5-pro" />
          <option value="gemini-2.5-flash" />
        </datalist>
        <div className="hint">
          Führt Werkzeuge aus (Kalender, Notizen, Telefon, Browser) und denkt über deine Anfragen
          nach. Jede ID, die dein Konto kennt, funktioniert. Das Live-Gespräch selbst führt immer
          das Modell oben — dieses hier macht die „Hausarbeit" dahinter.
        </div>
      </div>

      <div className="field">
        <label>Bildschirm (was James sieht)</label>
        <input aria-label="Bildschirm (was James sieht)"
          type="text"
          list="vision-models"
          value={settings.visionModel}
          onChange={(e) => patch({ visionModel: e.target.value })}
          spellCheck={false}
        />
        <datalist id="vision-models">
          <option value="gemini-3.6-flash" />
          <option value="gemini-2.5-flash" />
          <option value="gemini-2.5-pro" />
        </datalist>
        <div className="hint">
          Vorgabe, wenn James etwas sehen soll — etwa auf dem Bildschirm, oder für ein Bild, das du
          ihm gibst.
        </div>
      </div>

      <div className="field">
        <label>Agent — Hermes</label>
        <div className="hint">
          Hermes ist immer der Agent hinter James: Aufträge, Unteragenten, Fertigkeiten und
          Werkzeuge laufen über den lokalen Hermes-Gateway. Ist er nicht erreichbar, startet James
          ihn selbst und übernimmt notfalls mit dem gewählten Denkmotor.
        </div>
        <HermesConnection settings={settings} patch={patch} />
      </div>

      <div className="field">
        <label>Recherche-Agent</label>
        <select aria-label="Recherche-Agent"
          value={settings.researchAgent}
          onChange={(e) => patch({ researchAgent: e.target.value as never })}
        >
          <option value="deep-research-preview-04-2026">
            Deep Research (Preview 04/2026) — gründlich, aber langsam
          </option>
          <option value="deep-research-max-preview-04-2026">
            Deep Research Max (Preview 04/2026) — noch gründlicher, noch langsamer
          </option>
        </select>
        <div className="hint">
          Wenn du ihn um eine Recherche bittest, geht eine eigene Sitzung los: Der Agent liest
          Quellen und schreibt einen Bericht in deine Notizen. Geduld lohnt sich — er arbeitet
          Minuten, nicht Sekunden.
        </div>
      </div>

      <div className="field">
        <label>Sprache</label>
        <select aria-label="Sprache" value={settings.language} onChange={(e) => patch({ language: e.target.value as never })}>
          <option value="de-DE">Deutsch</option>
          <option value="en-US">Englisch</option>
        </select>
      </div>
      </details>
    </>
  )
}

// ─────────────────────────────────────────────────────────────
// Audio
// ─────────────────────────────────────────────────────────────

export function AudioSection({ settings, patch }: Props): JSX.Element {
  const [devices, setDevices] = useState<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }>({
    inputs: [],
    outputs: []
  })
  const [level, setLevel] = useState(0)
  const [testing, setTesting] = useState(false)
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  /** Gescheiterter Test: sonst bliebe der Balken still, ohne dass jemand weiß, warum. */
  const [testError, setTestError] = useState<string | null>(null)

  useEffect(() => {
    void listAudioDevices().then(setDevices).catch(() => undefined)
    /*
     * Die Kameraliste ohne vorherige Freigabe.
     *
     * `enumerateDevices` nennt vor dem ersten Zugriff keine Gerätenamen — es
     * liefert Einträge mit leerem `label`. Deshalb wird hier bewusst *nicht*
     * `getUserMedia` aufgerufen, nur um an die Namen zu kommen: Das ließe für
     * einen Moment die Kamera angehen, während der Nutzer eine
     * Audioeinstellung sucht. Bleibt die Liste leer, sagt der Hinweis unten,
     * warum.
     */
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((all) => setCameras(all.filter((d) => d.kind === 'videoinput')))
      .catch(() => undefined)
  }, [])

  /**
   * Mikrofontest. Ohne den rät man bei Problemen ins Blaue —
   * ist das Gerät falsch, ist es stummgeschaltet, oder liegt es am Modell?
   *
   * Der Test läuft über rAF und hält nichts fest: Ein zweiter Klick würde
   * deshalb zwei Mikrofone gleichzeitig aufnehmen. Die Sperrung über die
   * laufende Nummer verhindert das, ohne sich auf ein `testing`-Flag zu
   * verlassen, das von `finally` zu spät abgeräumt werden müsste. Und beim
   * Wegblättern räumt der Rückruf das wieder ab, was offen bliebe.
   *
   * Der Knopf sperrt sich zwar, aber von außen kann jederzeit ein zweiter
   * Versuch starten — deshalb bricht jeder Start zuerst den vorigen Test ab.
   * Dasselbe Abräumen gilt, wenn die Seite weg geht, während der Test läuft.
   */
  const cancelRef = useRef<(() => void) | null>(null)

  const runTest = async (): Promise<void> => {
    cancelRef.current?.()
    let cancelled = false
    let stream: MediaStream | undefined
    let ctx: AudioContext | undefined
    let raf = 0
    let timer: number | undefined
    cancelRef.current = () => {
      cancelled = true
      window.clearTimeout(timer)
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
      void ctx?.close()
      cancelRef.current = null
    }
    setTesting(true)
    setLevel(0)
    setTestError(null)
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: settings.audio.inputDeviceId ? { exact: settings.audio.inputDeviceId } : undefined,
          echoCancellation: settings.audio.echoCancellation,
          noiseSuppression: settings.audio.noiseSuppression,
          autoGainControl: settings.audio.autoGainControl
        }
      })
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      ctx = new AudioContext()
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)

      const buffer = new Float32Array(analyser.fftSize)
      const tick = (): void => {
        if (cancelled) return
        analyser.getFloatTimeDomainData(buffer)
        let sum = 0
        for (const s of buffer) sum += s * s
        setLevel(Math.min(1, Math.sqrt(sum / buffer.length) * 4))
        raf = requestAnimationFrame(tick)
      }
      const finish = (): void => {
        if (cancelled) return
        cancelRef.current?.()
        setTesting(false)
        setLevel(0)
      }
      timer = window.setTimeout(finish, 12_000)
      tick()
    } catch (err) {
      if (cancelled) return
      cancelRef.current?.()
      setTesting(false)
      setTestError(
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'Der Zugang zum Mikrofon wurde verweigert. Erlaube ihn in den Windows-Datenschutz­einstellungen.'
          : err instanceof Error
            ? err.message
            : 'Der Test lief nicht an.'
      )
    }
  }

  useEffect(() => () => cancelRef.current?.(), [])

  const audio = settings.audio

  return (
    <>
      <h2>Audio</h2>
      <p className="lede">
        Die drei Schalter unter Verarbeitung sind der Unterschied zwischen brauchbar und
        unbenutzbar. Ohne Echounterdrückung hört James seine eigene Ausgabe und unterbricht sich
        endlos selbst.
      </p>

      <div className="field">
        <label>Mikrofon</label>
        <select aria-label="Mikrofon"
          value={audio.inputDeviceId ?? ''}
          onChange={(e) =>
            patch({ audio: { ...audio, inputDeviceId: e.target.value || null } })
          }
        >
          <option value="">Systemstandard</option>
          {devices.inputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || 'Unbenanntes Gerät'}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label>Ausgabegerät</label>
        <select aria-label="Ausgabegerät"
          value={audio.outputDeviceId ?? ''}
          onChange={(e) => patch({ audio: { ...audio, outputDeviceId: e.target.value || null } })}
        >
          <option value="">Systemstandard</option>
          {devices.outputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || 'Unbenanntes Gerät'}
            </option>
          ))}
        </select>
        <div className="hint">
          Wo James spricht. Über Kopfhörer kannst du unten die Mikrofonpause abschalten und ihm
          jederzeit ins Wort fallen.
        </div>
      </div>

      <div className="field">
        <label>Mikrofontest</label>
        <div className="row">
          <button onClick={() => void runTest()} disabled={testing}>
            {testing ? 'Sprich jetzt…' : 'Test starten'}
          </button>
          <div className="meter" style={{ flex: 1 }}>
            <div style={{ width: `${Math.round(level * 100)}%` }} />
          </div>
        </div>
        <div className="hint">
          Der Balken sollte beim normalen Sprechen etwa bis zur Mitte ausschlagen. Bleibt er ganz
          links, ist das falsche Gerät gewählt oder das Mikrofon stummgeschaltet.
        </div>
        {testError && (
          <div className="hint err" role="alert">
            {testError}
          </div>
        )}
      </div>

      <hr className="section-divider" />

      <div className="field">
        <label>Verarbeitung</label>
        {(
          [
            ['echoCancellation', 'Echounterdrückung', 'Verhindert, dass James sich selbst hört. Ohne Headset zwingend.'],
            ['noiseSuppression', 'Rauschunterdrückung', 'Filtert Lüfter und Tastatur heraus.'],
            ['autoGainControl', 'Pegelautomatik', 'Gleicht aus, wenn du mal lauter oder leiser sprichst.']
          ] as const
        ).map(([key, label, hint]) => (
          <div key={key} style={{ marginBottom: 8 }}>
            <label style={{ fontWeight: 400 }}>
              <input
                type="checkbox"
                checked={audio[key]}
                onChange={(e) => patch({ audio: { ...audio, [key]: e.target.checked } })}
                style={{ width: 'auto', marginRight: 8 }}
              />
              {label}
            </label>
            <div className="hint" style={{ marginLeft: 24 }}>
              {hint}
            </div>
          </div>
        ))}
      </div>

      <div className="field">
        <label style={{ fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={audio.halfDuplex}
            onChange={(e) => patch({ audio: { ...audio, halfDuplex: e.target.checked } })}
            style={{ width: 'auto', marginRight: 8 }}
          />
          Mikrofon pausieren, während James spricht
        </label>
        <div className="hint" style={{ marginLeft: 24 }}>
          Mit Lautsprechern anlassen. Mit Headset ausschalten — dann kannst du ihm jederzeit ins
          Wort fallen.
        </div>
      </div>

      <hr className="section-divider" />

      <div className="field">
        <label>Klangbearbeitung der Ausgabe</label>
        <label style={{ fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={audio.outputEqEnabled}
            onChange={(e) => patch({ audio: { ...audio, outputEqEnabled: e.target.checked } })}
            style={{ width: 'auto', marginRight: 8 }}
          />
          Präsenzanhebung ({audio.outputHighShelfGainDb} dB)
        </label>
        <input
          aria-label="Präsenzanhebung in Dezibel"
          type="range"
          min={0}
          max={8}
          step={0.5}
          value={audio.outputHighShelfGainDb}
          onChange={(e) =>
            patch({ audio: { ...audio, outputHighShelfGainDb: Number(e.target.value) } })
          }
          disabled={!audio.outputEqEnabled}
        />
        <div className="hint">
          Hebt den Bereich an, in dem die Konsonanten sitzen. Auf kleinen Lautsprechern macht das
          den größten Unterschied bei der Verständlichkeit.
        </div>
      </div>

      <div className="field">
        <label>Pufferzeit: {audio.jitterBufferMs} ms</label>
        <input aria-label="Pufferzeit:"
          type="range"
          min={40}
          max={300}
          step={10}
          value={audio.jitterBufferMs}
          onChange={(e) => patch({ audio: { ...audio, jitterBufferMs: Number(e.target.value) } })}
        />
        <div className="hint">
          Höher heißt robuster gegen Aussetzer, aber James antwortet minimal später. Bei
          stotternder Ausgabe erhöhen.
        </div>
      </div>

      <h3>Kamera</h3>
      <p className="hint" style={{ marginBottom: 12 }}>
        Für „was halte ich hier in der Hand". Die Kamera geht nur für das eine Bild an und sofort
        wieder aus — kein laufender Strom, kein dauerhaft leuchtendes Lämpchen.
      </p>

      <div className="field">
        <label>Kamera</label>
        <select aria-label="Kamera"
          value={settings.cameraDeviceId ?? ''}
          onChange={(e) => patch({ cameraDeviceId: e.target.value || null })}
        >
          <option value="">Standardkamera</option>
          {cameras.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || 'Unbenannte Kamera'}
            </option>
          ))}
        </select>
        <div className="hint">
          {cameras.length === 0
            ? 'Noch keine Kamera gefunden. Windows gibt die Namen erst preis, nachdem einmal ' +
              'zugegriffen wurde — nach dem ersten „was siehst du hier" steht die Liste hier.'
            : 'An einem Notebook ist die Standardkamera die eingebaute.'}
        </div>
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────
// Zuhören
// ─────────────────────────────────────────────────────────────

export function ListeningSection({ settings, patch }: Props): JSX.Element {
  const vad = settings.vad
  const wake = settings.wake
  const [wakeAssets, setWakeAssets] = useState<{ installed: boolean; missing: string[]; model: string } | null>(null)
  /** Die Modellfrage schlug fehl — sonst bliebe der Hinweis für immer „Prüft …". */
  const [wakeError, setWakeError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void window.jarvis
      .invoke('wake:status')
      .then((value) => { if (active) setWakeAssets(value) })
      .catch((err: unknown) => { if (active) setWakeError(err instanceof Error ? err.message : String(err)) })
    return () => { active = false }
  }, [wake.modelName])

  return (
    <>
      <h2>Zuhören</h2>
      <p className="lede">
        Der wichtigste Wert der ganzen App steht gleich oben. Ist die Sprechpause zu kurz
        eingestellt, schneidet James dich ab, sobald du mitten im Satz kurz überlegst.
      </p>

      <div className="field">
        <label>Sprechpause bis er antwortet: {vad.silenceDurationMs} ms</label>
        <input aria-label="Sprechpause bis er antwortet:"
          type="range"
          min={200}
          max={1500}
          step={50}
          value={vad.silenceDurationMs}
          onChange={(e) => patch({ vad: { ...vad, silenceDurationMs: Number(e.target.value) } })}
        />
        <div className="hint">
          Ab 700 lässt er dich ausreden, unter 400 wird er ungeduldig. Wenn er dich ständig
          unterbricht: erhöhen. Wenn er zu träge reagiert: senken.
        </div>
      </div>

      <div className="field">
        <label>Vorlauf: {vad.prefixPaddingMs} ms</label>
        <input aria-label="Vorlauf:"
          type="range"
          min={0}
          max={300}
          step={20}
          value={vad.prefixPaddingMs}
          onChange={(e) => patch({ vad: { ...vad, prefixPaddingMs: Number(e.target.value) } })}
        />
        <div className="hint">
          Wie viel Ton vor dem erkannten Sprechbeginn mitgeschickt wird. Verhindert abgeschnittene
          erste Silben.
        </div>
      </div>

      <div className="field">
        <label style={{ fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={vad.localGateEnabled}
            onChange={(e) => patch({ vad: { ...vad, localGateEnabled: e.target.checked } })}
            style={{ width: 'auto', marginRight: 8 }}
          />
          Stille lokal wegfiltern
        </label>
        <div className="hint" style={{ marginLeft: 24 }}>
          Tastaturgeklapper und Pausen werden gar nicht erst hochgeladen. Der größte einzelne
          Sparposten, weil Live-Audio pro Sekunde abgerechnet wird.
        </div>
      </div>

      <div className="field">
        <label>Ab welchem Pegel es als Sprache gilt: {vad.localGateThreshold.toFixed(2)}</label>
        <input aria-label="Ab welchem Pegel es als Sprache gilt:"
          type="range"
          min={0.02}
          max={0.4}
          step={0.01}
          value={vad.localGateThreshold}
          onChange={(e) => patch({ vad: { ...vad, localGateThreshold: Number(e.target.value) } })}
          disabled={!vad.localGateEnabled}
        />
        <div className="hint">
          Dieselbe Skala wie der Balken im Mikrofontest. Zu hoch eingestellt schneidet er leise
          Satzanfänge ab — im Zweifel lieber niedriger. Nach dem Ende einer Äußerung läuft der
          Upload noch kurz weiter, sonst merkt die Gegenseite nie, dass du fertig bist.
        </div>
      </div>

      <hr className="section-divider" />

      <div className="field">
        <label style={{ fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={wake.enabled}
            onChange={(e) => patch({ wake: { ...wake, enabled: e.target.checked } })}
            style={{ width: 'auto', marginRight: 8 }}
          />
          Auf das installierte Weckwort reagieren
        </label>
        <div className="hint" style={{ marginLeft: 24 }}>
          {wakeError
            ? 'Prüfen ging nicht: ' + wakeError + ' — Bitte Zuhören erneut öffnen.'
            : wakeAssets?.installed ? `Aktiv: ${wakeAssets.model === 'jarvis.onnx' ? '„Hey Jarvis“' : wakeAssets.model === 'hey_james.onnx' ? '„Hey James“' : wakeAssets.model}. Die Erkennung läuft lokal.`
              : wakeAssets ? `Noch nicht verfügbar: ${wakeAssets.missing.join(', ')} fehlt. Verwende Klick oder Hotkey.`
                : 'Prüft die lokalen Modelldateien …'}
        </div>
      </div>

      <div className="field">
        <label>Weckwort</label>
        <div className="hint">Geladenes Modell: {wakeAssets?.model ?? wake.modelName}. „James“ allein ist kein bestätigtes Weckwort. Für ein anderes Weckwort ist ein passender Klassifikator erforderlich.</div>
      </div>

      <div className="field">
        <label>Empfindlichkeit des Weckworts: {wake.threshold.toFixed(2)}</label>
        <input aria-label="Empfindlichkeit des Weckworts:"
          type="range"
          min={0.2}
          max={0.9}
          step={0.05}
          value={wake.threshold}
          onChange={(e) => patch({ wake: { ...wake, threshold: Number(e.target.value) } })}
        />
        <div className="hint">
          Niedriger heißt, er springt leichter an — auch mal fälschlich. Höher heißt, du musst
          deutlicher sprechen.
        </div>
      </div>

      <div className="field">
        <label>Tastenkürzel zum Aufwecken</label>
        <input aria-label="Tastenkürzel zum Aufwecken"
          type="text"
          value={wake.pushToTalkHotkey}
          onChange={(e) => patch({ wake: { ...wake, pushToTalkHotkey: e.target.value } })}
          placeholder="Alt+Space"
        />
        <div className="hint">
          Gilt systemweit, also auch während Minecraft im Vordergrund läuft. Dreimal Escape bricht
          alles Laufende ab.
        </div>
      </div>

      <div className="field">
        <label>Tastenkürzel zum Stilllegen</label>
        <input aria-label="Tastenkürzel zum Stilllegen"
          type="text"
          value={wake.pauseHotkey}
          onChange={(e) => patch({ wake: { ...wake, pauseHotkey: e.target.value } })}
          placeholder="Alt+Shift+Space"
        />
        <div className="hint">
          Legt James komplett still: keine Verbindung, kein Mikrofon, kein Weckwort. Nochmal
          drücken holt ihn zurück. Dasselbe macht ein Klick auf die Kugel, während er läuft.
        </div>
      </div>

      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={wake.clap}
            onChange={(e) => patch({ wake: { ...wake, clap: e.target.checked } })}
          />{' '}
          Zweimal klatschen weckt James
        </label>
        <div className="hint">
          Läuft lokal ohne Modell. Zwei kurze, kräftige Klatscher kurz hintereinander.
        </div>
      </div>

      <div className="field">
        <label>Verbindung nach Stille trennen: {wake.idleDisconnectSec} s</label>
        <input aria-label="Verbindung nach Stille trennen:"
          type="range"
          min={0}
          max={300}
          step={15}
          value={wake.idleDisconnectSec}
          onChange={(e) => patch({ wake: { ...wake, idleDisconnectSec: Number(e.target.value) } })}
        />
        <div className="hint">
          Live-Audio wird pro Sekunde abgerechnet. Auf null steht die Verbindung dauerhaft — das
          kostet spürbar.
        </div>
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────
// Rechte
// ─────────────────────────────────────────────────────────────

/**
 * Die Überschrift über jeder Rechtegruppe.
 *
 * Vollständig zu bleiben ist hier keine Kosmetik: Fehlt ein Eintrag, steht in
 * der Rechte-Matrix die rohe Kennung — `smarthome`, `messaging` —, und das ist
 * genau die Stelle, an der jemand entscheidet, ob ein Werkzeug ohne Rückfrage
 * laufen darf. Sieben Gruppen fehlten hier, seit sie nacheinander dazukamen.
 */
const GROUP_LABELS: Record<ToolGroup, string> = {
  research: 'Recherche',
  web: 'Web und Alltag',
  system: 'System und Programme',
  chrome: 'Chrome',
  shopping: 'Einkaufen',
  gmail: 'Gmail',
  calendar: 'Kalender',
  mail: 'Yahoo Mail',
  contacts: 'Kontakte',
  media: 'Bilder und Videos',
  office: 'Dokumente',
  messaging: 'Nachrichten',
  smarthome: 'Smart Home',
  music: 'Musik',
  minecraft: 'Minecraft',
  memory: 'Gedächtnis',
  schedule: 'Zeitplan',
  timer: 'Timer',
  agent: 'Agent (Plan, Fertigkeiten, Unteragenten)',
  mcp: 'MCP-Server',
  twilio: 'Telefon'
}

export function PermissionsSection({ settings, patch }: Props): JSX.Element {
  const [tools, setTools] = useState<ToolMeta[]>([])
  /** Die Werkzeugliste blieb aus — sonst stünde da stillschweigend gar nichts. */
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    void window.jarvis
      .invoke('tools:list')
      .then(setTools)
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : String(err)))
  }, [])

  const grouped = tools.reduce<Record<string, ToolMeta[]>>((acc, tool) => {
    ;(acc[tool.group] ??= []).push(tool)
    return acc
  }, {})

  const set = (name: string, value: ToolPermission): void => {
    patch({ permissions: { ...settings.permissions, [name]: value } })
  }

  return (
    <>
      <h2>Rechte</h2>
      <p className="lede">
        Im autonomen Profil führt James erlaubte Aktionen direkt aus. Explizit gesperrte
        Werkzeuge bleiben gesperrt. Bei eingeschalteten Bestätigungen wartet er auf dein Ja.
      </p>
      {loadError ? (
        <p className="hint err" role="alert">Die Liste der Werkzeuge ließ sich nicht aufnehmen: {loadError} Bitte die Einstellungen einmal schließen und wieder öffnen.</p>
      ) : Object.keys(grouped).length === 0 ? (
        <p className="hint">Sehe nach, was James kann…</p>
      ) : null}
      <label className="row">
        <input type="checkbox" checked={settings.confirmActions}
          onChange={(e) => patch({ confirmActions: e.target.checked })} />
        Vor Aktionen nachfragen
      </label>

      {Object.entries(grouped).map(([group, list]) => (
        <div key={group} style={{ marginBottom: 26 }}>
          <h3 style={{ fontSize: 14, margin: '0 0 8px', color: 'var(--muted)' }}>
            {GROUP_LABELS[group as ToolGroup] ?? group}
          </h3>
          <table>
            <tbody>
              {list.map((tool) => (
                <tr key={tool.name}>
                  <td style={{ width: '55%' }}>
                    <code>{tool.name}</code>
                    <div className="hint">{tool.description.slice(0, 110)}</div>
                  </td>
                  <td>
                    {tool.alwaysAsk && settings.confirmActions ? (
                      <span className="badge missing">fragt immer</span>
                    ) : (
                      <select
                        aria-label={`Berechtigung für ${tool.name}`}
                        value={settings.permissions[tool.name] ?? ''}
                        onChange={(e) => set(tool.name, e.target.value as ToolPermission)}
                      >
                        <option value="">Standard</option>
                        <option value="allow">erlaubt</option>
                        <option value="ask">fragt nach</option>
                        <option value="deny">gesperrt</option>
                      </select>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  )
}

// ─────────────────────────────────────────────────────────────
// Sparmodus
// ─────────────────────────────────────────────────────────────

const SAVING_LABELS: Record<string, string> = {
  result: 'gekürzte Werkzeugergebnisse',
  cache: 'wiederholte Aufrufe aus dem Zwischenspeicher',
  declarations: 'kürzere Werkzeugbeschreibungen',
  silence: 'nicht hochgeladene Stille',
  vision: 'gesparte Bildschirmfotos'
}

export function SaverSection({ settings, patch }: Props): JSX.Element {
  const [report, setReport] = useState<TokenReport | null>(null)
  const saver = settings.tokenSaver

  const load = (): void => {
    void window.jarvis.invoke('tokens:get').then(setReport).catch(() => undefined)
  }

  useEffect(load, [])

  return (
    <>
      <h2>Sparmodus</h2>
      <p className="hint">OpenAI Realtime hält im Sparmodus höchstens 8.000 Gesprächstoken nach den Anweisungen vor und behält bei Kürzung 80 Prozent. Antworten sind auf 2.048 Ausgabetoken begrenzt. Ältere Gesprächsdetails können entfallen; für sehr ausführliche Antworten den Sparmodus ausschalten.</p>
      <div className="field">
        <label>
          <input type="checkbox" checked={settings.gamingMode}
            onChange={(e) => patch({ gamingMode: e.target.checked })} /> Gaming-Modus
        </label>
        <div className="hint">Niedrige Prozesspriorität und Pause für automatische Lern- und Wartungsarbeiten. Nach dem Spielen wieder ausschalten.</div>
      </div>
      <p className="lede">
        Die Rechnung entsteht an vier Stellen, und an allen vieren lässt sich etwas wegnehmen,
        ohne dass James dümmer wird. Der größte Posten steht nicht hier, sondern unter „Zuhören":
        die Trennung nach Stille und der lokale Sprachfilter.
      </p>

      <div className="field">
        <label style={{ fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={saver.enabled}
            onChange={(e) => patch({ tokenSaver: { ...saver, enabled: e.target.checked } })}
            style={{ width: 'auto', marginRight: 8 }}
          />
          Sparmodus aktiv
        </label>
      </div>

      <div className="field">
        <label>
          Werkzeugergebnisse kürzen auf {saver.maxResultChars || 'unbegrenzt'}
          {saver.maxResultChars ? ' Zeichen' : ''}
        </label>
        <input aria-label="Werkzeugergebnisse kürzen auf"
          type="range"
          min={0}
          max={6000}
          step={200}
          value={saver.maxResultChars}
          onChange={(e) =>
            patch({ tokenSaver: { ...saver, maxResultChars: Number(e.target.value) } })
          }
          disabled={!saver.enabled}
        />
        <div className="hint">
          Eine gelesene Mail kommt mit sechstausend Zeichen zurück, vorgelesen wird davon nie mehr
          als ein Absatz. Auf null steht das Kürzen aus. Im Aktionslog steht immer das
          vollständige Ergebnis.
        </div>
      </div>

      <div className="field">
        <label>
          Gleiche Aufrufe zwischenspeichern:{' '}
          {saver.cacheTtlSec ? `${saver.cacheTtlSec} Sekunden` : 'aus'}
        </label>
        <input aria-label="Gleiche Aufrufe zwischenspeichern:"
          type="range"
          min={0}
          max={600}
          step={30}
          value={saver.cacheTtlSec}
          onChange={(e) => patch({ tokenSaver: { ...saver, cacheTtlSec: Number(e.target.value) } })}
          disabled={!saver.enabled}
        />
        <div className="hint">
          Zweimal hintereinander nach dem Warenkorb gefragt wird nur einmal geladen. Gilt
          ausschließlich für Werkzeuge, die nichts verändern.
        </div>
      </div>

      <div className="field">
        <label style={{ fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={saver.slimDeclarations}
            onChange={(e) =>
              patch({ tokenSaver: { ...saver, slimDeclarations: e.target.checked } })
            }
            style={{ width: 'auto', marginRight: 8 }}
            disabled={!saver.enabled}
          />
          Werkzeugbeschreibungen kürzen
        </label>
        <div className="hint" style={{ marginLeft: 24 }}>
          Die gehen bei jedem Verbindungsaufbau erneut über die Leitung, also alle fünfzehn
          Minuten und nach jeder Trennung wegen Stille. Sollte James anfangen, das falsche
          Werkzeug zu greifen, schalte das hier aus.
        </div>
      </div>

      <hr className="section-divider" />

      <div className="field">
        <label>Geschätzte Einsparung</label>
        {!report || report.totalTokens === 0 ? (
          <p className="hint">Noch keine Einsparschätzung verfügbar.</p>
        ) : (
          <>
            <table>
              <tbody>
                <tr>
                  <td>Heute</td>
                  <td>
                    {report.todayTokens.toLocaleString('de-DE')} Token · rund{' '}
                    {report.todayUsd.toFixed(2)} $
                  </td>
                </tr>
                <tr>
                  <td>Diesen Monat</td>
                  <td>{report.monthTokens.toLocaleString('de-DE')} Token</td>
                </tr>
                <tr>
                  <td>Insgesamt</td>
                  <td>{report.totalTokens.toLocaleString('de-DE')} Token</td>
                </tr>
                <tr>
                  <td>Stille heute nicht hochgeladen</td>
                  <td>{Math.round(report.silenceSecondsToday / 60)} Minuten</td>
                </tr>
              </tbody>
            </table>

            {report.byKind.length > 0 && (
              <table style={{ marginTop: 14 }}>
                <tbody>
                  {report.byKind.map((k) => (
                    <tr key={k.kind}>
                      <td>{SAVING_LABELS[k.kind] ?? k.kind}</td>
                      <td>{k.tokens.toLocaleString('de-DE')} Token</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}

        <div className="hint" style={{ marginTop: 14 }}>
          Gemeldete ChatGPT-Nutzung der letzten bis zu 100 abgeschlossenen Anfragen seit dem Start: {report?.usage?.totalTokens == null ? 'keine Tokenzahl gemeldet' : `${report.usage.totalTokens.toLocaleString('de-DE')} Token`}.
          {' '}Anfragen mit Tokenangabe: {report?.usage?.knownCalls ?? 0}/{report?.usage?.calls ?? 0}. Dies ist keine Anzeige des verbleibenden Kontingents.
          {report?.usage?.last && <> Letzte Antwort: {(report.usage.last.ms / 1000).toFixed(1)} s.</>}
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <button onClick={load}>Aktualisieren</button>
          <button
            onClick={() => {
              void window.jarvis.invoke('tokens:reset').then(load).catch(() => undefined)
            }}
          >
            Zähler zurücksetzen
          </button>
        </div>
        <div className="hint">
          Geschätzt, nicht abgerechnet: vier Zeichen je Token ist für deutschen Text ein
          Daumenwert. Es geht um die Größenordnung.
        </div>
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────
// Verbindungen
// ─────────────────────────────────────────────────────────────

/**
 * Was gerade wirklich funktioniert.
 *
 * "Gmail geht nicht" kann fünf Ursachen haben — kein Chrome-Zugang, nicht
 * angemeldet, kein OAuth-Client, abgelaufene Zustimmung, gesperrte
 * Fernsteuerung. Ohne diese Seite rät man.
 */
/**
 * Welche Zeile einen Anmelde-Knopf bekommt und wohin er führt.
 *
 * Nicht jede: Der James-Browser selbst und die Eingabesteuerung lassen sich
 * nicht „anmelden", und die Google-Schnittstelle geht über OAuth unter
 * „Zugänge". Ein Knopf, der nichts bewirken kann, ist schlimmer als keiner.
 */
const LOGIN_TARGETS: Partial<
  Record<ConnectionStatus['id'], 'gmail' | 'yahoo' | 'amazon' | 'whatsapp'>
> = {
  gmailWeb: 'gmail',
  yahoo: 'yahoo',
  amazon: 'amazon',
  // Bei WhatsApp heißt „anmelden" QR-Code scannen. Der Knopf macht dieselbe
  // Seite auf; was dort zu tun ist, steht im Hinweis der Zeile.
  whatsapp: 'whatsapp'
}

// ─────────────────────────────────────────────────────────────
// Smart Home
// ─────────────────────────────────────────────────────────────

/**
 * Die Bereiche, die man einzeln freigeben kann.
 *
 * Nur die heiklen stehen hier. Licht und Steckdose lassen sich nicht sperren,
 * weil sie nie gesperrt sind — und ein Haken, der immer steht, ist keine
 * Einstellung, sondern Dekoration.
 */
const GUARDED_DOMAINS: { id: string; label: string; hint: string }[] = [
  {
    id: 'cover',
    label: 'Rollos, Jalousien und Tore',
    hint: 'Dieselbe Geräteart. Wenn bei dir nur Jalousien dranhängen, ist der Haken harmlos — hängt ein Garagentor dran, überleg es dir.'
  },
  {
    id: 'lock',
    label: 'Türschlösser',
    hint: 'Damit sperrt James auf Zuruf auf. Was das Mikrofon hört, kann auch aus dem Fernseher kommen.'
  },
  {
    id: 'alarm_control_panel',
    label: 'Alarmanlage',
    hint: 'Scharf und unscharf schalten.'
  }
]

export function SmartHomeSection({ settings, patch }: Props): JSX.Element {
  const [status, setStatus] = useState<SmartHomeStatus | null>(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const home = settings.smartHome

  const check = async (): Promise<void> => {
    setBusy(true)
    try {
      setStatus(await window.jarvis.invoke('home:status'))
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Die Verbindung ging nicht.')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void check()
  }, [])

  const saveToken = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      await window.jarvis.invoke('secrets:set', { key: 'homeAssistant', value: token })
      setToken('')
      setNote('Gespeichert. Die Werkzeuge stehen ab sofort bereit.')
      await check()
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const clearToken = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.jarvis.invoke('secrets:clear', { key: 'homeAssistant' })
      setNote('Entfernt. James kann jetzt keine Geräte mehr schalten.')
      await check()
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Das Entfernen ging nicht.')
    } finally {
      setBusy(false)
    }
  }

  const toggleDomain = (id: string, on: boolean): void => {
    const next = on
      ? [...new Set([...home.freeDomains, id])]
      : home.freeDomains.filter((d) => d !== id)
    patch({ smartHome: { ...home, freeDomains: next } })
  }

  return (
    <>
      <h2>Smart Home</h2>
      <p className="lede">
        Läuft über Home Assistant. Das ist kein Umweg aus Bequemlichkeit: Apple Home hat keine
        Schnittstelle, die ein Programm unter Windows ansprechen könnte — kein REST, keine Wolke
        für Dritte, und ein Zubehör, das schon in der Home-App gekoppelt ist, nimmt in aller Regel
        keinen zweiten Steuernden an. Home Assistant ist der eine Weg, der beide Seiten erreicht:
        Es spricht über die HomeKit-Anbindung mit demselben Zubehör und ist von hier aus ganz
        normal über HTTP erreichbar.
      </p>

      <div className="field">
        <label>Adresse</label>
        <input aria-label="Adresse"
          type="text"
          value={home.baseUrl}
          placeholder="http://homeassistant.local:8123"
          onChange={(e) => patch({ smartHome: { ...home, baseUrl: e.target.value } })}
          onBlur={(e) => {
            const url = e.target.value.trim()
            if (url !== e.target.value) void patch({ smartHome: { ...home, baseUrl: url } })
          }}
        />
        <p className="hint">
          So, wie du es auch im Browser aufrufst — mit http oder https und mit Port, ohne
          Schrägstrich am Ende.
        </p>
      </div>

      <div className="field">
        <label>Langlebiger Zugriffstoken</label>
        <input aria-label="Langlebiger Zugriffstoken"
          type="password"
          value={token}
          placeholder={status?.hasToken ? '•••••••• hinterlegt' : 'Noch keiner hinterlegt'}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
        />
        <p className="hint">
          In Home Assistant unten links auf deinen Namen, dann Sicherheit, ganz unten „Langlebige
          Zugriffstoken". Der Token wird verschlüsselt abgelegt und verlässt diesen Rechner nur
          Richtung der Adresse oben. Ohne ihn gibt es die Smart-Home-Werkzeuge nicht — James
          behauptet dann gar nicht erst, er käme an die Lampen.
        </p>
      </div>

      <div className="row" style={{ marginBottom: 18 }}>
        <button
          className="primary"
          onClick={() => void saveToken()}
          disabled={busy || token.trim().length === 0}
        >
          Token speichern
        </button>
        <button onClick={() => void check()} disabled={busy}>
          {busy ? 'Prüfe…' : 'Verbindung prüfen'}
        </button>
        {status?.hasToken && (
          <button onClick={() => void clearToken()} disabled={busy}>
            Token entfernen
          </button>
        )}
      </div>

      {note && (
        <p className="hint" role="status" style={{ marginBottom: 18 }}>
          {note}
        </p>
      )}

      {status && (
        <p className="hint" style={{ marginBottom: 22 }}>
          {status.reachable
            ? `Verbunden mit Home Assistant ${status.version ?? ''} — ${status.entities ?? 0} schaltbare Geräte gefunden.`
            : status.hasToken
              ? `Nicht erreichbar: ${status.error ?? 'unbekannter Grund'}`
              : 'Noch kein Token hinterlegt.'}
        </p>
      )}

      <h3>Was ohne Rückfrage geschaltet werden darf</h3>
      <p className="hint" style={{ marginBottom: 12 }}>
        Licht, Steckdosen, Ventilatoren und Szenen schaltet James immer sofort — sie sind
        zurücknehmbar, und eine Rückfrage davor kostet zwei Sätze für etwas, das der Lichtschalter
        auch ohne erledigt. Das hier ist die andere Sorte. Ohne Haken schaltet James sie
        überhaupt nicht, auch nicht auf Nachfrage: Ein bewusst gesetzter Haken ist an dieser
        Stelle die bessere Sicherung als ein gesprochenes Ja.
      </p>

      {GUARDED_DOMAINS.map((domain) => (
        <div key={domain.id} style={{ marginBottom: 10 }}>
          <label style={{ fontWeight: 400 }}>
            <input
              type="checkbox"
              checked={home.freeDomains.includes(domain.id)}
              onChange={(e) => toggleDomain(domain.id, e.target.checked)}
              style={{ width: 'auto', marginRight: 8 }}
            />
            {domain.label}
          </label>
          <div className="hint" style={{ marginLeft: 24 }}>
            {domain.hint}
          </div>
        </div>
      ))}
    </>
  )
}

// ─────────────────────────────────────────────────────────────
// Musik
// ─────────────────────────────────────────────────────────────

/**
 * Was hier steht und warum es zwei sehr verschiedene Abschnitte sind.
 *
 * Der Unterschied zwischen den beiden Diensten ist keine Feinheit, die man
 * beiläufig erwähnt — er entscheidet, ob „spiel das im Wohnzimmer" überhaupt
 * geht. Spotify hat mit Connect eine offene Fernbedienung, Apple Music hat
 * keine. Wer das nicht weiß, hält es für einen Fehler dieser App, und genau
 * deshalb steht es hier oben und nicht in einer Fußnote.
 */
export function MusicSection({ settings, patch }: Props): JSX.Element {
  const [status, setStatus] = useState<MusicStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [clientId, setClientId] = useState('')
  const [apple, setApple] = useState({ teamId: '', keyId: '', privateKey: '' })

  const music = settings.music

  const load = async (): Promise<void> => {
    setBusy(true)
    try {
      setStatus(await window.jarvis.invoke('music:status'))
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Der Musikstatus ließ sich nicht aufnehmen.')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void load()
    // Einmal beim Öffnen. Die Geräteliste holt der Knopf — sie kostet einen
    // Aufruf zu Spotify und einen PowerShell-Start, und beides bei jedem
    // Tastendruck im Feld daneben wäre Unfug.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const update = (p: Partial<typeof music>): void => void patch({ music: { ...music, ...p } })

  const saveClientId = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      await window.jarvis.invoke('secrets:set', { key: 'spotifyClientId', value: clientId })
      setClientId('')
      setNote('Gespeichert. Jetzt auf „Bei Spotify anmelden" drücken.')
      await load()
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const connect = async (): Promise<void> => {
    setBusy(true)
    setNote('Der Browser geht auf — melde dich dort an.')
    try {
      const result = await window.jarvis.invoke('music:connectSpotify')
      setNote(
        result.ok
          ? `Verbunden${result.name ? ` als ${result.name}` : ''}.`
          : (result.error ?? 'Die Anmeldung ist fehlgeschlagen.')
      )
      await load()
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Die Anmeldung ging nicht.')
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.jarvis.invoke('music:disconnectSpotify')
      setNote('Abgemeldet. Fernsteuern geht jetzt nur noch über die Ausgabegeräte dieses Rechners.')
      await load()
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Das Abmelden ging nicht.')
    } finally {
      setBusy(false)
    }
  }

  const saveApple = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      for (const [key, value] of [
        ['appleMusicTeamId', apple.teamId],
        ['appleMusicKeyId', apple.keyId],
        ['appleMusicPrivateKey', apple.privateKey]
      ] as const) {
        // Leere Felder überspringen: Wer nur die Key-ID korrigiert, soll nicht
        // den privaten Schlüssel neu einfügen müssen.
        if (value.trim()) await window.jarvis.invoke('secrets:set', { key, value })
      }
      setApple({ teamId: '', keyId: '', privateKey: '' })
      setNote('Gespeichert.')
      await load()
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const connectDevices = status?.devices.filter((d) => d.kind === 'connect') ?? []
  const outputDevices = status?.devices.filter((d) => d.kind === 'output') ?? []

  return (
    <>
      <h2>Musik</h2>
      <p className="lede">
        Zwei Dienste, und sie können nicht dasselbe. <strong>Spotify</strong> hat mit Connect eine
        offene Fernbedienung: James kann die Wiedergabe auf jedes Gerät schieben, auf dem dein
        Konto angemeldet ist — auch auf einen Echo Dot, sobald in der Alexa-App einmal Spotify
        verknüpft wurde. Der Ton geht dabei nie über diesen Rechner, sondern direkt aus Spotifys
        Wolke auf den Lautsprecher. Genau deshalb braucht das hier kein Home Assistant und keine
        Brücke im Heimnetz.
      </p>
      <p className="lede">
        <strong>Apple Music</strong> hat das nicht. Apple bietet keine Schnittstelle an, mit der ein
        fremdes Programm die Wiedergabe auf ein anderes Gerät schieben könnte. Was geht: den
        richtigen Titel finden und ihn in der Apple-Music-App auf diesem Rechner aufmachen. Soll er
        trotzdem im Wohnzimmer landen, führt der Weg über das Ausgabegerät von Windows — ein Echo
        Dot, der einmal über Bluetooth gekoppelt ist, steht unten in der Liste.
      </p>

      <h3>Spotify</h3>

      <div className="field">
        <label>
          Client-ID{' '}
          {status === null ? (
            <span className="badge missing">wird geprüft…</span>
          ) : status.spotify.connected ? (
            <span className="badge ok">
              verbunden{status.spotify.displayName ? ` als ${status.spotify.displayName}` : ''}
            </span>
          ) : status.spotify.hasClientId ? (
            <span className="badge missing">nicht angemeldet</span>
          ) : (
            <span className="badge missing">keine Client-ID</span>
          )}
        </label>
        <input aria-label="Client-ID"
          type="password"
          value={clientId}
          placeholder={status?.spotify.hasClientId ? '•••••••• hinterlegt' : 'Noch keine hinterlegt'}
          onChange={(e) => setClientId(e.target.value)}
          autoComplete="off"
        />
        <p className="hint">
          Anlegen unter{' '}
          <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">
            developer.spotify.com/dashboard
          </a>{' '}
          — „Create app", einen beliebigen Namen, und bei <em>Redirect URI</em> muss{' '}
          <code>{status?.spotify.redirectUri ?? `http://127.0.0.1:${music.spotifyRedirectPort}/callback`}</code>{' '}
          stehen, Zeichen für Zeichen. Als API dann <em>Web API</em> ankreuzen. Ein Client Secret
          brauchst du nicht: Die Anmeldung läuft über PKCE, und ein Geheimnis auf deinem eigenen
          Rechner wäre ohnehin keins.
        </p>
      </div>

      <div className="row" style={{ marginBottom: 18 }}>
        <button
          className="primary"
          onClick={() => void saveClientId()}
          disabled={busy || clientId.trim().length === 0}
        >
          Client-ID speichern
        </button>
        <button onClick={() => void connect()} disabled={busy || !status?.spotify.hasClientId}>
          Bei Spotify anmelden
        </button>
        {status?.spotify.connected && (
          <button onClick={() => void disconnect()} disabled={busy}>
            Abmelden
          </button>
        )}
      </div>

      {status?.spotify.connected && !status.spotify.premium && (
        <div className="hint err" style={{ marginBottom: 18 }}>
          Dieses Konto hat kein Premium. Suchen und nachsehen geht, Abspielen und Umschalten nicht —
          Spotify beantwortet jeden Steuerbefehl eines Gratiskontos mit einer Absage. Das ist keine
          Grenze dieser App.
        </div>
      )}

      {status?.spotify.error && (
        <div className="hint err" style={{ marginBottom: 18 }}>
          {status.spotify.error}
        </div>
      )}

      <h3>Apple Music</h3>

      <p className="hint" style={{ marginBottom: 12 }}>
        {status?.apple.appInstalled
          ? 'Die Apple-Music-App ist auf diesem Rechner installiert — Titel aufmachen geht damit sofort, auch ohne die drei Felder unten.'
          : 'Auf diesem Rechner ist keine Apple-Music-App installiert. Ohne sie gibt es für Apple Music keinen Weg; sie steht kostenlos im Microsoft Store.'}{' '}
        Die Felder darunter sind für die Suche: Ohne sie öffnet James die Trefferliste in der App,
        mit ihnen findet er den Titel selbst und startet ihn. Der Zugang kostet neunundneunzig Euro
        im Jahr — dafür macht niemand nur Musik an, deshalb geht es auch ohne.
      </p>

      <div className="field">
        <label>
          Entwicklerschlüssel{' '}
          {status?.apple.hasDeveloperKey ? (
            <span className="badge ok">hinterlegt</span>
          ) : (
            <span className="badge missing">nicht hinterlegt</span>
          )}
        </label>
        <div className="row">
          <input
            aria-label="Apple Team-ID"
            type="password"
            placeholder="Team-ID"
            value={apple.teamId}
            onChange={(e) => setApple({ ...apple, teamId: e.target.value })}
            autoComplete="off"
          />
          <input
            aria-label="Apple Key-ID"
            type="password"
            placeholder="Key-ID"
            value={apple.keyId}
            onChange={(e) => setApple({ ...apple, keyId: e.target.value })}
            autoComplete="off"
          />
        </div>
        <textarea
          aria-label="Inhalt der .p8-Datei"
          rows={4}
          placeholder="Inhalt der .p8-Datei, mit BEGIN- und END-Zeile"
          value={apple.privateKey}
          onChange={(e) => setApple({ ...apple, privateKey: e.target.value })}
          style={{ marginTop: 8, width: '100%', fontFamily: 'monospace', fontSize: 12 }}
        />
        <p className="hint">
          Aus dem Apple-Developer-Portal: unter <em>Certificates, Identifiers &amp; Profiles</em> →{' '}
          <em>Keys</em> einen Schlüssel mit <em>MusicKit</em> anlegen. Die Team-ID steht dort oben
          rechts, die Key-ID beim Schlüssel selbst. Die <code>.p8</code>-Datei gibt Apple genau
          einmal heraus.
        </p>
      </div>

      <div className="row" style={{ marginBottom: 18 }}>
        <button
          className="primary"
          onClick={() => void saveApple()}
          disabled={busy || !(apple.teamId.trim() || apple.keyId.trim() || apple.privateKey.trim())}
        >
          Speichern
        </button>
      </div>

      <div className="field">
        <label>Apple-Music-Laden</label>
        <input aria-label="Apple-Music-Laden"
          type="text"
          value={music.appleStorefront}
          placeholder="at"
          maxLength={2}
          onChange={(e) => update({ appleStorefront: e.target.value.trim().toLowerCase() })}
          style={{ maxWidth: 90 }}
        />
        <p className="hint">
          Zwei Buchstaben, das Land deines Abos — <code>at</code>, <code>de</code>, <code>ch</code>.
          Aus dem falschen Laden kommen Titel, die es in deinem Abo gar nicht gibt.
        </p>
      </div>

      <h3>Wo gespielt wird</h3>

      <div className="row" style={{ marginBottom: 12 }}>
        <button onClick={() => void load()} disabled={busy}>
          {busy ? 'Suche…' : 'Geräte suchen'}
        </button>
      </div>

      {status?.devicesError && (
        <div className="hint err" style={{ marginBottom: 12 }}>
          {status.devicesError}
        </div>
      )}

      <p className="hint" style={{ marginBottom: 10 }}>
        <strong>Über Spotify Connect</strong> — dort spielt Spotify selbst, dieser Rechner ist nicht
        beteiligt.
      </p>
      {connectDevices.length === 0 ? (
        <p className="hint" style={{ marginBottom: 16 }}>
          {status?.spotify.connected
            ? 'Kein Gerät wach. Spotify zeigt nur, was gerade offen ist — mach die App auf dem Telefon oder dem Echo einmal an, danach steht es hier.'
            : 'Erst anmelden, dann stehen hier die Geräte.'}
        </p>
      ) : (
        <ul style={{ marginBottom: 16 }}>
          {connectDevices.map((d) => (
            <li key={d.id}>
              {d.name} — {d.type}
              {d.active ? ' · spielt gerade' : ''}
            </li>
          ))}
        </ul>
      )}

      <p className="hint" style={{ marginBottom: 10 }}>
        <strong>Ausgabegeräte dieses Rechners</strong> — hier kommt alles heraus, was der Rechner
        abspielt, auch James' Stimme. Der Weg für Apple Music und für alles andere.
      </p>
      {outputDevices.length === 0 ? (
        <p className="hint" style={{ marginBottom: 16 }}>
          Noch nicht nachgesehen.
        </p>
      ) : (
        <ul style={{ marginBottom: 16 }}>
          {outputDevices.map((d) => (
            <li key={d.id}>
              {d.name}
              {d.active ? ' · eingestellt' : ''}
            </li>
          ))}
        </ul>
      )}

      <div className="field">
        <label>Standardgerät</label>
        <select aria-label="Standardgerät"
          value={music.defaultDevice}
          onChange={(e) => update({ defaultDevice: e.target.value })}
        >
          <option value="">— dort, wo zuletzt gespielt wurde —</option>
          {/* Auch dann in der Liste, wenn es gerade nicht erreichbar ist: Sonst
              verlöre die Auswahl beim Öffnen ihren eigenen Wert, weil ein
              schlafender Echo Dot nicht gemeldet wird. */}
          {music.defaultDevice &&
            !status?.devices.some((d) => d.name === music.defaultDevice) && (
              <option value={music.defaultDevice}>{music.defaultDevice} (gerade nicht da)</option>
            )}
          {status?.devices.map((d) => (
            <option key={d.id} value={d.name}>
              {d.name} {d.kind === 'connect' ? '· Spotify Connect' : '· Ausgang'}
            </option>
          ))}
        </select>
        <p className="hint">
          Wo „spiel was" ohne weitere Angabe landet. Sagen geht auch — „spiel Musik immer im
          Wohnzimmer" trägt dasselbe ein.
        </p>
      </div>

      <div className="field">
        <label>Wenn kein Dienst genannt wird</label>
        <select aria-label="Wenn kein Dienst genannt wird"
          value={music.preferred}
          onChange={(e) => update({ preferred: e.target.value as typeof music.preferred })}
        >
          <option value="spotify">Spotify</option>
          <option value="apple">Apple Music</option>
        </select>
        <p className="hint">
          Ist der gewählte nicht einsatzbereit, nimmt James den anderen — und sagt dazu, dass er
          gewechselt hat.
        </p>
      </div>

      {settings.showAdvanced && (
        <div className="field">
          <label>Port für die Spotify-Rückleitung</label>
          <input aria-label="Port für die Spotify-Rückleitung"
            type="number"
            value={music.spotifyRedirectPort}
            onChange={(e) => update({ spotifyRedirectPort: Number(e.target.value) || 8888 })}
            style={{ maxWidth: 120 }}
          />
          <p className="hint">
            Nur ändern, wenn 8888 auf diesem Rechner schon belegt ist. Danach muss die neue Adresse
            auch im Spotify-Entwicklerbereich stehen, sonst schlägt die Anmeldung fehl.
          </p>
        </div>
      )}

      {note && <p className="hint" role="status">{note}</p>}
    </>
  )
}

// ─────────────────────────────────────────────────────────────
// Alexa
// ─────────────────────────────────────────────────────────────

/**
 * Die Einrichtung in der Reihenfolge, in der sie wirklich passiert.
 *
 * Zuerst einschalten (dann steht die Adresse), dann die Skill anlegen, dann
 * die Kennung zurückeintragen. Andersherum ginge es nicht: Die Adresse
 * entsteht erst mit dem Tunnel, und ohne sie kann man die Skill nicht fertig
 * bauen.
 *
 * Der Satz über das Weckwort steht ganz oben und nicht in einer Fußnote. Er
 * ist die Erwartung, die jeder mitbringt und die sich nicht erfüllen lässt —
 * wer ihn erst nach einer halben Stunde Einrichtung liest, hat die halbe
 * Stunde für etwas anderes ausgegeben, als er dachte.
 */
export function AlexaSection({ settings, patch }: Props): JSX.Element {
  const [status, setStatus] = useState<AlexaStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [skillId, setSkillId] = useState('')

  const alexa = settings.alexa

  const load = async (): Promise<void> => {
    try {
      setStatus(await window.jarvis.invoke('alexa:status'))
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Der Alexa-Status ließ sich nicht aufnehmen.')
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const update = (p: Partial<typeof alexa>): void => void patch({ alexa: { ...alexa, ...p } })

  const saveSkillId = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      await window.jarvis.invoke('secrets:set', { key: 'alexaSkillId', value: skillId })
      setSkillId('')
      setNote('Gespeichert.')
      await load()
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const start = async (): Promise<void> => {
    setBusy(true)
    setNote('Tunnel wird aufgebaut — das dauert ein paar Sekunden.')
    try {
      const result = await window.jarvis.invoke('alexa:start')
      setStatus(result.status)
      setNote(result.ok ? 'Läuft. Die Adresse unten gehört in die Skill.' : (result.error ?? null))
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Der Tunnel ließ sich nicht aufbauen.')
    } finally {
      setBusy(false)
    }
  }

  const stop = async (): Promise<void> => {
    setBusy(true)
    try {
      setStatus(await window.jarvis.invoke('alexa:stop'))
      setNote('Abgeschaltet. Von außen ist dieser Rechner jetzt nicht mehr erreichbar.')
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Das Abschalten ging nicht.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h2>Alexa</h2>
      <p className="lede">
        Macht James über den Echo Dot ansprechbar. Du sagst etwas, Amazon schickt die Wörter durch
        einen Tunnel hierher, James antwortet, der Echo liest vor. Kalender, Musik, Licht, Timer,
        Gedächtnis — dieselben Antworten wie am Rechner.
      </p>

      {/*
        Der eine Satz, der die Erwartung zurechtrückt. Er steht bewusst als
        Warnkasten und nicht im Fließtext: Wer ihn überliest, richtet eine
        halbe Stunde lang etwas ein, das er sich anders vorgestellt hat.
      */}
      <div className="hint err" style={{ marginBottom: 20 }}>
        <strong>Das Weckwort bleibt „Alexa".</strong> Es heißt immer „Alexa, frag James, …" —
        Amazon lässt Dritte das Weckwort nicht ändern, es gibt dafür keine Einstellung und keinen
        Umweg. „Hey James" sagst du weiterhin dem Rechner; der Echo ist die zweite Tür, nicht
        dieselbe.
      </div>

      <div className="field">
        <label>
          Anbindung{' '}
          {status?.running ? (
            <span className="badge ok">läuft</span>
          ) : (
            <span className="badge missing">aus</span>
          )}
        </label>
        <label style={{ fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={alexa.enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
            style={{ width: 'auto', marginRight: 8 }}
          />
          Über Alexa erreichbar sein
        </label>
        <p className="hint">
          Eingeschaltet steht ein Endpunkt im offenen Netz, hinter dem ein Assistent mit Zugriff auf
          Kalender, Musik und Licht sitzt. Was ihn schützt: Jede Anfrage muss Amazons Unterschrift
          tragen und zu deiner Skill-Kennung gehören — sonst fliegt sie raus, bevor James sie
          überhaupt sieht. Der Tunnel geht von hier nach draußen; im Router bleibt nichts offen.
        </p>
      </div>

      <h3>Schritt 1 — einschalten</h3>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="primary" onClick={() => void start()} disabled={busy || !alexa.enabled}>
          {busy ? 'Moment…' : 'Starten und Adresse holen'}
        </button>
        {status?.running && (
          <button onClick={() => void stop()} disabled={busy}>
            Abschalten
          </button>
        )}
      </div>

      {status?.endpoint ? (
        <div className="field">
          <label>Deine Endpunkt-Adresse</label>
          <input type="text" readOnly value={status.endpoint} onFocus={(e) => e.target.select()} />
          <p className="hint">
            Genau diese Adresse gehört in die Skill — mit <code>/alexa</code> am Ende. Sie kommt{' '}
            {status.source === 'tailscale'
              ? 'über Tailscale Funnel und bleibt gleich.'
              : status.source === 'cloudflared'
                ? 'aus einem cloudflared-Tunnel und ändert sich bei jedem Neustart der App — dann muss sie in der Skill nachgetragen werden. Für dauerhaft: Tailscale installieren oder oben eine feste Adresse eintragen.'
                : 'aus deiner eingetragenen Adresse.'}
          </p>
        </div>
      ) : (
        <p className="hint" style={{ marginBottom: 18 }}>
          Noch keine Adresse — erst starten. Dafür braucht es Tailscale oder cloudflared auf diesem
          Rechner, genau wie bei der Telefonie.
        </p>
      )}

      <h3>Schritt 2 — Skill anlegen</h3>
      <p className="hint" style={{ marginBottom: 18 }}>
        Im{' '}
        <a href="https://developer.amazon.com/alexa/console/ask" target="_blank" rel="noreferrer">
          Alexa-Entwicklerbereich
        </a>{' '}
        eine <em>Custom</em>-Skill anlegen, Sprache Deutsch, Hosting <em>Provision your own</em>.
        Aufrufname <code>james</code>. Dann einen Intent anlegen — Name egal, etwa{' '}
        <code>FrageIntent</code> —, mit einem einzigen Slot namens <code>frage</code> vom Typ{' '}
        <code>AMAZON.SearchQuery</code>. Der Slottyp ist der Punkt: Nur er lässt einen ganzen Satz
        durch, statt ihn gegen eine Werteliste zu prüfen. Unter <em>Endpoint</em> die Adresse von
        oben eintragen und beim Zertifikat{' '}
        <em>My development endpoint has a certificate from a trusted authority</em> wählen.
      </p>

      {/*
        Die Stelle, an der die Einrichtung sonst scheitert.

        Amazon lehnt einen Beispielsatz ab, der nur aus dem Slot besteht —
        `{frage}` allein lässt den Build des Sprachmodells fehlschlagen, mit
        einer Meldung, die den Grund nicht nennt. Es braucht Trägerwörter, und
        die werden nicht mitgeschickt: Was bei James ankommt, ist nur der
        Slot. Deshalb taugen als Träger nur Füllwörter, die nichts bedeuten —
        „wie" oder „was" wären selbst Teil der Frage und fehlten hinterher.
      */}
      <div className="hint err" style={{ marginBottom: 18 }}>
        <strong>Bei den Beispielsätzen aufpassen.</strong> Amazon nimmt keinen Satz an, der nur aus{' '}
        <code>{'{frage}'}</code> besteht — der Build scheitert dann mit einer Meldung, die den Grund
        verschweigt. Es braucht Trägerwörter davor, und die kommen hier <em>nicht</em> an. Nimm
        deshalb nur Füllwörter:
        <br />
        <code>sag mir {'{frage}'}</code> · <code>erzähl mir {'{frage}'}</code> ·{' '}
        <code>mach {'{frage}'}</code> · <code>spiel {'{frage}'}</code>
        <br />
        <br />
        „wie" oder „was" wären verlockend, aber falsch: Sie gehören zur Frage und fehlten
        hinterher — aus „wie wird das Wetter" käme bei James „wird das Wetter" an.
      </div>

      <h3>Schritt 3 — Kennung zurücktragen</h3>
      <div className="field">
        <label>
          Skill-Kennung{' '}
          {status?.hasSkillId ? (
            <span className="badge ok">hinterlegt</span>
          ) : (
            <span className="badge missing">fehlt</span>
          )}
        </label>
        <input aria-label="Skill-Kennung"
          type="password"
          value={skillId}
          placeholder={status?.hasSkillId ? '•••••••• hinterlegt' : 'amzn1.ask.skill.…'}
          onChange={(e) => setSkillId(e.target.value)}
          autoComplete="off"
        />
        <p className="hint">
          Steht im Entwicklerbereich oben bei der Skill. Ohne sie startet der Dienst nicht, und das
          ist kein Formalismus: Die Tunneladresse ist nicht geheim, und eine fremde Skill könnte auf
          sie zeigen. Deren Anfragen trügen echte Amazon-Unterschriften — sie kämen ja wirklich von
          Amazon. Nur diese Kennung unterscheidet sie.
        </p>
      </div>
      <div className="row" style={{ marginBottom: 18 }}>
        <button
          className="primary"
          onClick={() => void saveSkillId()}
          disabled={busy || skillId.trim().length === 0}
        >
          Kennung speichern
        </button>
      </div>

      <h3>Was am Echo anders ist</h3>
      <p className="hint" style={{ marginBottom: 18 }}>
        <strong>Acht Sekunden.</strong> So lange wartet Alexa auf eine Antwort. Was länger dauert,
        bekommt am Echo einen Satz („das dauert länger") und wird am Rechner zu Ende gebracht — das
        Ergebnis spricht dann James am Rechner.
        <br />
        <br />
        <strong>Weniger Werkzeuge.</strong> Auskünfte, Musik, Licht, Timer, Kalender, Gedächtnis.
        Keine Mails, keine Dateien, keine Einkäufe, keine Bildschirmsteuerung — und das lässt sich
        nicht freischalten. Ein Echo hört jeden, der im Raum steht; es gibt keine Anmeldung und
        keine Stimmerkennung, auf die man sich verlassen könnte.
      </p>

      {settings.showAdvanced && (
        <div className="field">
          <label>Feste öffentliche Adresse</label>
          <input aria-label="Feste öffentliche Adresse"
            type="text"
            value={alexa.publicUrl}
            placeholder="leer = die der Telefonie, sonst Tunnel selbst aufbauen"
            onChange={(e) => update({ publicUrl: e.target.value })}
            onBlur={(e) => {
              const url = e.target.value.trim()
              if (url !== e.target.value) void update({ publicUrl: url })
            }}
          />
          <p className="hint">
            Wer eine eigene Adresse hat — ngrok, eine Domain, ein fester cloudflared-Tunnel —,
            trägt sie hier ein. Einen eigenen Port gibt es nicht: Der Endpunkt hängt als Pfad am
            selben Server wie die Telefonie, weil es nur einen Weg von außen herein gibt. Tailscale
            bildet genau einen lokalen Port auf die öffentliche 443 ab; zwei Tunnel würden sich
            gegenseitig verdrängen.
          </p>
        </div>
      )}

      {note && <p className="hint" role="status">{note}</p>}
    </>
  )
}

export function ConnectionsSection(): JSX.Element {
  const [status, setStatus] = useState<ConnectionStatus[]>([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [timers, setTimers] = useState<TimerEntry[]>([])

  const load = async (startBrowser: boolean): Promise<void> => {
    setBusy(true)
    try {
      setStatus(await window.jarvis.invoke('connect:status', { start: startBrowser }))
      setTimers(await window.jarvis.invoke('timers:list'))
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Die Verbindungsliste ließ sich nicht aufnehmen.')
    } finally {
      setBusy(false)
    }
  }

  /**
   * Macht die Anmeldeseite im James-Browser auf.
   *
   * Danach wird bewusst nicht automatisch neu geprüft: angemeldet ist der
   * Nutzer erst, wenn er im Browser fertig getippt hat, und eine Prüfung eine
   * Sekunde später meldete zuverlässig wieder "nicht angemeldet". Stattdessen
   * sagt der Hinweis, was als Nächstes dran ist.
   */
  const login = async (target: 'gmail' | 'yahoo' | 'amazon' | 'whatsapp'): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      const result = await window.jarvis.invoke('connect:login', { target })
      setNote(
        result.ok
          ? 'Das Fenster ist offen. Melde dich dort an und klick danach auf „Jetzt prüfen".'
          : `Der Browser ließ sich nicht öffnen: ${result.error ?? 'unbekannter Fehler'}`
      )
    } catch (err) {
      // Ohne das schluckt die Oberfläche jeden Fehler und der Knopf sieht
      // aus, als hätte er nichts getan.
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    // Beim bloßen Öffnen dieser Einstellungsseite nichts Sichtbares starten.
    // Wer nur nachsehen oder zu einem anderen Abschnitt weiterklicken will,
    // soll kein leeres Chrome-Fenster bekommen. Erst der ausdrücklich
    // beschriftete Knopf unten darf den James-Browser für die Prüfung öffnen.
    void load(false)
  }, [])

  return (
    <>
      <h2>Verbindungen</h2>
      <p className="lede">
        Gmail und Amazon laufen über einen Chrome, der James gehört — mit eigenem Profil, neben
        deinem normalen Browser. Dein Chrome musst du dafür nie schließen. Einmal anmelden genügt,
        danach bleibt es. Die Google-Schnittstelle unter „Zugänge" ist zusätzlich und optional.
      </p>

      <div className="row" style={{ marginBottom: 18 }}>
        <button className="primary" onClick={() => void load(true)} disabled={busy}>
          {busy ? 'Prüfe…' : 'Jetzt prüfen'}
        </button>
      </div>

      {note && (
        <p className="hint" style={{ marginBottom: 18 }}>
          {note}
        </p>
      )}

      <table>
        <tbody>
          {status.map((s) => (
            <tr key={s.id}>
              <td style={{ width: '34%' }}>
                {s.label}
                <div className="hint">{s.detail}</div>
              </td>
              <td style={{ width: 110 }}>
                {s.ok ? (
                  <span className="badge ok">geht</span>
                ) : (
                  <span className="badge err">geht nicht</span>
                )}
              </td>
              <td className="hint">{s.ok ? '' : (s.fix ?? '')}</td>
              <td style={{ width: 150 }}>
                {!s.ok && LOGIN_TARGETS[s.id] && (
                  <button onClick={() => void login(LOGIN_TARGETS[s.id]!)} disabled={busy}>
                    Anmelden
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {status.length === 0 && !busy && <p className="hint">Noch nicht geprüft.</p>}

      <hr className="section-divider" />
      <h2>Laufende Timer</h2>
      {timers.length === 0 ? (
        <p className="hint">Gerade läuft kein Timer.</p>
      ) : (
        <table>
          <tbody>
            {timers.map((t) => (
              <tr key={t.id}>
                <td>
                  {t.label || 'Timer'}
                  <div className="hint">
                    fällig um{' '}
                    {new Date(t.dueAt).toLocaleTimeString('de-DE', {
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </div>
                </td>
                <td style={{ width: 90 }}>
                  <button
                    onClick={() => {
                      void window.jarvis.invoke('timers:cancel', { id: t.id }).then(() => load(false)).catch(() => undefined)
                    }}
                  >
                    Abbrechen
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

// ─────────────────────────────────────────────────────────────
// Aktionslog
// ─────────────────────────────────────────────────────────────

export function AuditSection(): JSX.Element {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [health, setHealth] = useState<SelfHealDashboard | null>(null)
  const [repairing, setRepairing] = useState(false)
  /** Gescheiterte Reparatur — sonst bliebe der Knopf für immer auf „Prüfe und repariere…". */
  const [repairError, setRepairError] = useState<string | null>(null)

  const load = (): void => {
    void Promise.all([
      window.jarvis.invoke('audit:list', { limit: 200 }).catch<AuditEntry[]>(() => []),
      window.jarvis.invoke('selfheal:status', { hours: 24 }).catch<SelfHealDashboard | null>(() => null)
    ]).then(([actions, dashboard]) => {
      setEntries(actions)
      setHealth(dashboard)
    })
  }

  useEffect(() => {
    load()
    const timer = window.setInterval(load, 15_000)
    return () => window.clearInterval(timer)
  }, [])

  const repair = async (): Promise<void> => {
    setRepairing(true)
    setRepairError(null)
    try {
      setHealth(await window.jarvis.invoke('selfheal:repair', { restartVoice: true }))
    } catch (err) {
      setRepairError(err instanceof Error ? err.message : String(err))
    } finally {
      setRepairing(false)
    }
  }

  return (
    <>
      <h2>Auto-Log &amp; Selbstheilung</h2>
      <p className="lede">
        James erfasst technische Fehler automatisch, entfernt Zugangsdaten aus dem Protokoll,
        versucht sichere Reparaturen und hält fest, ob sie funktioniert haben.
      </p>

      <section className="health-panel" aria-live="polite">
        <div className="health-heading">
          <div>
            <strong>Systemzustand</strong>
            <div className="hint">Automatische Prüfung alle fünf Minuten</div>
          </div>
          <span className={`badge ${repairError ?? (health?.automatic === undefined ? 'missing' : health?.automatic ? 'ok' : 'err')}`}>
            {repairError
              ? 'Prüfung fehlgeschlagen'
              : health?.automatic === undefined
                ? 'wird geladen…'
                : health?.automatic ? 'Automatik aktiv' : 'Automatik aus'}
          </span>
        </div>

        <p className={health?.report.problems.length ? 'hint err' : 'hint ok'}>
          {repairError
            ? `Die Zustandsprüfung ging nicht: ${repairError} — Bitte erneut versuchen.`
            : (health?.report.summary ?? 'Zustand wird geladen…')}
        </p>

        <div className="health-metrics">
          <div><strong>{health?.report.total ?? '–'}</strong><span>Störungen / 24 h</span></div>
          <div><strong>{health?.report.healed ?? '–'}</strong><span>automatisch behoben</span></div>
          <div><strong>{health?.report.problems.length ?? '–'}</strong><span>aktuell offen</span></div>
        </div>

        <div className="row">
          <button className="primary" onClick={() => void repair()} disabled={repairing}>
            {repairing ? 'Prüfe und repariere…' : 'Jetzt prüfen und reparieren'}
          </button>
          <button className="ghost" onClick={() => void window.jarvis.invoke('app:showLog')}>
            Fehlerdatei öffnen
          </button>
          <button
            className="ghost"
            onClick={() => void window.jarvis.invoke('selfheal:clear').then(load).catch(() => undefined)}
            disabled={!health?.recent.length}
          >
            Störungen leeren
          </button>
        </div>
      </section>

      {health && health.report.problems.length > 0 && (
        <div className="health-problems">
          <h3>Offene Störungen</h3>
          {health.report.problems.map((problem) => (
            <div className="health-problem" key={`${problem.area}:${problem.code}`}>
              <div>
                <span className="badge err">offen</span>{' '}
                <code>{problem.area} · {problem.code}</code>
              </div>
              <div>{problem.message}</div>
              {problem.attempted && <div className="hint">Versucht: {problem.attempted}</div>}
            </div>
          ))}
        </div>
      )}

      {health && health.recent.length > 0 && (
        <>
          <h3 style={{ marginTop: 28 }}>Reparaturverlauf</h3>
          <table>
            <thead>
              <tr><th>Zeit</th><th>Störung</th><th>Reparatur</th></tr>
            </thead>
            <tbody>
              {health.recent.slice(0, 30).map((incident) => (
                <tr key={incident.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {new Date(incident.ts).toLocaleTimeString('de-DE')}
                  </td>
                  <td>
                    <code>{incident.area} · {incident.code}</code>
                    <div className="hint">{incident.message.slice(0, 150)}</div>
                  </td>
                  <td>
                    <span className={`badge ${incident.healed === true ? 'ok' : incident.healed === false ? 'err' : 'missing'}`}>
                      {incident.healed === true ? 'behoben' : incident.healed === false ? 'fehlgeschlagen' : 'nur protokolliert'}
                    </span>
                    {incident.remedy && <div className="hint">{incident.remedy.replace(' §ausgesetzt', ' (ausgesetzt)')}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3 style={{ marginTop: 32 }}>Ausgeführte Aktionen</h3>
      <p className="hint">
        Hier steht, was James auf deinen Wunsch tatsächlich ausgeführt hat.
      </p>

      <div className="row" style={{ marginBottom: 16 }}>
        <button onClick={load}>Aktualisieren</button>
          <button
            onClick={() => {
              void window.jarvis.invoke('audit:clear').then(load).catch(() => undefined)
            }}
          >
            Aktionen leeren
        </button>
      </div>

      {entries.length === 0 ? (
        <p className="hint">Noch nichts passiert.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Zeit</th>
              <th>Werkzeug</th>
              <th>Ergebnis</th>
              <th>Dauer</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {new Date(e.ts).toLocaleTimeString('de-DE')}
                </td>
                <td>
                  <code>{e.tool}</code>
                  {e.confirmed === true && <span className="badge ok"> bestätigt</span>}
                  <div className="hint">{e.args.slice(0, 90)}</div>
                </td>
                <td>
                  {e.ok ? (
                    <span className="badge ok">ok</span>
                  ) : (
                    <span className="badge err">Fehler</span>
                  )}
                  <div className="hint">{(e.error ?? e.result ?? '').slice(0, 110)}</div>
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>{e.durationMs} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

// ─────────────────────────────────────────────────────────────
// Recherche, Gedächtnis, Zeitplan, Preiswächter
// ─────────────────────────────────────────────────────────────

export function ResearchSection(): JSX.Element {
  const [runs, setRuns] = useState<ResearchRun[]>([])
  const [open, setOpen] = useState<ResearchRun | null>(null)
  /** Woran der Agent gerade arbeitet, je laufender Recherche. */
  const [thoughts, setThoughts] = useState<Record<string, string>>({})

  /**
   * Die Liste hörte bisher nur einmal beim Öffnen zu.
   *
   * Eine tiefe Recherche läuft fünf bis zwanzig Minuten. In dieser Zeit stand
   * hier "läuft" und sonst nichts — und weil sich auch beim Fertigwerden nichts
   * rührte, sah eine abgeschlossene Recherche so lange aus wie eine hängende,
   * bis jemand das Fenster neu aufmachte. Beide Meldungen gibt es längst; sie
   * gingen nur ins Leere.
   */
  useEffect(() => {
    const load = (): void => {
      void window.jarvis.invoke('research:list').then(setRuns).catch(() => undefined)
    }
    load()
    const offProgress = window.jarvis.on('research:progress', ({ id, thought }) =>
      setThoughts((prev) => ({ ...prev, [id]: thought }))
    )
    const offDone = window.jarvis.on('research:done', load)
    return () => {
      offProgress()
      offDone()
    }
  }, [])

  if (open) {
    return (
      <>
        <button onClick={() => setOpen(null)} style={{ marginBottom: 16 }}>
          ← Zurück
        </button>
        <h2>{open.query}</h2>
        <p className="lede">
          {new Date(open.startedAt).toLocaleString('de-DE')} · {open.agent}
        </p>
        <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{open.report}</div>
        {open.sources && open.sources.length > 0 && (
          <>
            <hr className="section-divider" />
            <h3 style={{ fontSize: 14 }}>Quellen</h3>
            <ul style={{ paddingLeft: 18 }}>
              {open.sources.map((s) => (
                <li key={s} className="hint" style={{ wordBreak: 'break-all' }}>
                  {s}
                </li>
              ))}
            </ul>
          </>
        )}
      </>
    )
  }

  return (
    <>
      <h2>Recherchen</h2>
      <p className="lede">
        Vollständige Berichte mit Quellen. Gesprochen bekommst du nur die Zusammenfassung — hier
        steht alles.
      </p>
      {runs.length === 0 ? (
        <p className="hint">Noch keine Recherche gelaufen.</p>
      ) : (
        <table>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>
                  <button
                    onClick={() => setOpen(r)}
                    disabled={r.status !== 'completed'}
                    style={{ border: 0, background: 'none', padding: 0, textAlign: 'left' }}
                  >
                    {r.query.slice(0, 90)}
                  </button>
                  <div className="hint">{new Date(r.startedAt).toLocaleString('de-DE')}</div>
                  {/* Nur solange sie läuft: Danach zählt der Bericht, nicht der
                      letzte Gedanke auf dem Weg dorthin. Der gespeicherte Stand
                      steht auch dann da, wenn das Fenster erst mitten in der
                      Recherche aufgemacht wird. */}
                  {r.status === 'in_progress' && (thoughts[r.id] ?? r.lastThought) && (
                    <div className="hint" style={{ fontStyle: 'italic' }}>
                      {(thoughts[r.id] ?? r.lastThought ?? '').slice(0, 140)}
                    </div>
                  )}
                </td>
                <td style={{ width: 120 }}>
                  {r.status === 'completed' ? (
                    <span className="badge ok">fertig</span>
                  ) : r.status === 'in_progress' ? (
                    <span className="badge missing">läuft</span>
                  ) : (
                    <span className="badge err">Fehler</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

// ─────────────────────────────────────────────────────────────
// Kontakte
// ─────────────────────────────────────────────────────────────

/**
 * Das Adressbuch — und warum es hier steht und nicht diktiert wird.
 *
 * Eine Mailadresse übersteht den Weg durch ein Mikrofon nicht zuverlässig.
 * "anna punkt müller at gmail punkt com" kommt als Transkript zurück, das an
 * drei Stellen falsch sein kann, und eine Mail an die falsche Adresse lässt
 * sich nicht zurückholen. Sie wird deshalb einmal getippt; danach genügt beim
 * Sprechen der Vorname, und die Rückfrage vor dem Versand liest die gefundene
 * Adresse zur Kontrolle vor.
 */
export function ContactsSection(): JSX.Element {
  const [items, setItems] = useState<Contact[]>([])
  const [draft, setDraft] = useState({ name: '', email: '', phone: '', note: '' })
  const [editing, setEditing] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = (): void => {
    void window.jarvis
      .invoke('contacts:list')
      .then(setItems)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }

  useEffect(load, [])

  const hasEmail = !draft.email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(draft.email.trim())
  const hasPhone = !draft.phone.trim() || /^\+?[0-9][0-9 ()\-./\s]{3,}$/.test(draft.phone.trim())
  const valid = draft.name.trim().length > 0 && Boolean(draft.email.trim() || draft.phone.trim()) && hasEmail && hasPhone

  const save = async (): Promise<void> => {
    setError(null)
    try {
      await window.jarvis.invoke('contacts:upsert', {
        id: editing ?? undefined,
        name: draft.name.trim(),
        email: draft.email.trim(),
        phone: draft.phone.trim(),
        note: draft.note.trim()
      })
      setDraft({ name: '', email: '', phone: '', note: '' })
      setEditing(null)
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <>
      <h2>Kontakte</h2>
      <p className="lede">
        Mailadressen und Telefonnummern für James. Getippt statt diktiert, damit er bei „schreib
        Anna" oder „ruf Anna an" nie raten muss. Mindestens eines von beidem ist nötig; einen
        Anruf bestätigt James immer noch einmal.
      </p>

      <div className="row" style={{ gap: 10, alignItems: 'flex-start', marginBottom: 8 }}>
        <input
          aria-label="Name des Kontakts"
          placeholder="Name, etwa Anna"
          value={draft.name}
          style={{ flex: '1 1 30%' }}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
        <input
          aria-label="Mailadresse des Kontakts"
          placeholder="anna@beispiel.at"
          value={draft.email}
          spellCheck={false}
          style={{ flex: '1 1 40%' }}
          onChange={(e) => setDraft({ ...draft, email: e.target.value })}
        />
        <input
          aria-label="Telefonnummer des Kontakts"
          placeholder="+43 660 123 4567"
          value={draft.phone}
          inputMode="tel"
          style={{ flex: '1 1 30%' }}
          onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
        />
        <input
          aria-label="Notiz zum Kontakt"
          placeholder="Notiz, optional"
          value={draft.note}
          style={{ flex: '1 1 25%' }}
          onChange={(e) => setDraft({ ...draft, note: e.target.value })}
        />
        <button className="primary" disabled={!valid} onClick={() => void save()}>
          {editing === null ? 'Eintragen' : 'Übernehmen'}
        </button>
        {editing !== null && (
          <button
            onClick={() => {
              setEditing(null)
              setDraft({ name: '', email: '', phone: '', note: '' })
            }}
          >
            Abbrechen
          </button>
        )}
      </div>

      <p className="hint" role={error ? 'alert' : undefined} style={{ marginBottom: 18 }}>
        {error ??
          (!hasEmail || !hasPhone
            ? 'Mailadresse oder Telefonnummer sieht noch nicht vollständig aus.'
            : 'Mindestens eine Mailadresse oder Telefonnummer eintragen. Die Notiz trennt gleiche Namen.')}
      </p>

      {items.length === 0 ? (
        <p className="hint">Noch niemand eingetragen.</p>
      ) : (
        <table>
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.name}
                  <div className="hint">
                    {c.email}
                    {c.phone && `${c.email ? ' · ' : ''}${c.phone}`}
                    {c.note && ` · ${c.note}`}
                  </div>
                </td>
                <td style={{ width: 100 }}>
                  <button
                    onClick={() => {
                      setEditing(c.id)
                      setDraft({ name: c.name, email: c.email, phone: c.phone, note: c.note })
                    }}
                  >
                    Ändern
                  </button>
                </td>
                <td style={{ width: 90 }}>
                  <button
                    onClick={() => {
                      void window.jarvis
                        .invoke('contacts:delete', { id: c.id })
                        .then(() => {
                          if (editing === c.id) {
                            setEditing(null)
                            setDraft({ name: '', email: '', phone: '', note: '' })
                          }
                          load()
                        })
                        .catch((err: unknown) => {
                          setError(err instanceof Error ? err.message : 'Löschen fehlgeschlagen.')
                        })
                    }}
                  >
                    Löschen
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

/** Die vier Arten einer Erinnerung, in Worten statt in Feldnamen. */
const MEMORY_KINDS: { id: MemoryEntry['kind']; label: string }[] = [
  { id: 'fact', label: 'Tatsache' },
  { id: 'preference', label: 'Vorliebe' },
  { id: 'person', label: 'Person' },
  { id: 'project', label: 'Vorhaben' }
]

export function MemorySection(): JSX.Element {
  const [items, setItems] = useState<MemoryEntry[]>([])
  const [schedules, setSchedules] = useState<ScheduleEntry[]>([])
  const [watches, setWatches] = useState<PriceWatch[]>([])

  /**
   * Entwurf, Bearbeiten-Zustand und Fehler — dasselbe Muster wie bei den
   * Kontakten weiter oben, und aus demselben Grund: Ein Feld, das beim Ändern
   * an seiner Zeile klebt, und eines, das oben steht, sind zwei Bedienungen für
   * eine Sache. Die Kontakte haben das schon entschieden; hier noch einmal
   * anders zu bauen, hieße nur, dass man in einem Fenster zweierlei lernen muss.
   */
  const [draft, setDraft] = useState('')
  const [kind, setKind] = useState<MemoryEntry['kind']>('fact')
  const [editing, setEditing] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = (): void => {
    void window.jarvis
      .invoke('memory:list', {})
      .then(setItems)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
    void window.jarvis
      .invoke('schedule:list')
      .then(setSchedules)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
    void window.jarvis
      .invoke('watch:list')
      .then(setWatches)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }

  useEffect(load, [])

  const reset = (): void => {
    setDraft('')
    setKind('fact')
    setEditing(null)
    setError(null)
  }

  /**
   * Beide Wege geben die frische Liste zurück, deshalb kein zweites Nachladen.
   *
   * Der Fehler kommt aus dem Hauptprozess und wird unverändert angezeigt: Dort
   * steht, ob der Wortlaut leer war oder die Erinnerung inzwischen gelöscht
   * wurde, und beides sind Sätze, die jemand beantworten kann.
   */
  const save = async (): Promise<void> => {
    setError(null)
    try {
      const next =
        editing === null
          ? await window.jarvis.invoke('memory:add', { text: draft, kind })
          : await window.jarvis.invoke('memory:update', { id: editing, text: draft })
      setItems(next)
      reset()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <>
      <h2>Gedächtnis</h2>
      <ReminderPanel />
      <p className="lede">
        Was James sich über dich gemerkt hat. Alles liegt lokal auf deinem Rechner — und du
        darfst hier eingreifen. Was er falsch verstanden hat, änderst du; was er nie gesagt
        bekam, trägst du selbst ein. Beides zählt danach genauso wie Gemerktes: James findet
        es beim nächsten Gespräch von selbst wieder.
      </p>

      <div className="row" style={{ gap: 10, alignItems: 'flex-start', marginBottom: 8 }}>
        <input
          aria-label="Neue Notiz: vollständiger Satz"
          placeholder="Vollständiger Satz, etwa: Ich trinke Kaffee schwarz."
          value={draft}
          style={{ flex: '1 1 60%' }}
          onChange={(e) => setDraft(e.target.value)}
        />
        {/* Die Art gehört zum Anlegen, nicht zum Ändern: Der Vertrag für
            `memory:update` kennt sie nicht, und ein Feld anzubieten, das beim
            Übernehmen folgenlos bliebe, wäre eine Lüge im Formular. */}
        {editing === null && (
          <select
            aria-label="Art der Notiz"
            value={kind}
            style={{ flex: '0 0 auto' }}
            onChange={(e) => setKind(e.target.value as MemoryEntry['kind'])}
          >
            {MEMORY_KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        )}
        <button className="primary" disabled={!draft.trim()} onClick={() => void save()}>
          {editing === null ? 'Eintragen' : 'Übernehmen'}
        </button>
        {editing !== null && <button onClick={reset}>Abbrechen</button>}
      </div>

      <p className="hint" role={error ? 'alert' : undefined} style={{ marginBottom: 18 }}>
        {error ??
          'Schreib es als ganzen Satz, so wie James es sich merken würde — daran sucht er ' +
            'später. Ein Stichwort findet er schlechter wieder.'}
      </p>

      {items.length === 0 ? (
        <p className="hint">Noch nichts gemerkt.</p>
      ) : (
        <table>
          <tbody>
            {items.map((m) => (
              <tr key={m.id}>
                <td>
                  {m.text}
                  <div className="hint">
                    {MEMORY_KINDS.find((k) => k.id === m.kind)?.label ?? m.kind} ·{' '}
                    {new Date(m.createdAt).toLocaleDateString('de-DE')}
                  </div>
                </td>
                <td style={{ width: 100 }}>
                  <button
                    onClick={() => {
                      setEditing(m.id)
                      setDraft(m.text)
                      setError(null)
                    }}
                  >
                    Ändern
                  </button>
                </td>
                <td style={{ width: 90 }}>
                  <button
                    onClick={() => {
                      void window.jarvis
                        .invoke('memory:delete', { id: m.id })
                        .then(() => {
                          // Die gerade bearbeitete Zeile zu löschen, ohne das
                          // Formular zu räumen, hinterließe ein „Übernehmen", das
                          // auf eine Nummer zeigt, die es nicht mehr gibt.
                          if (editing === m.id) reset()
                          load()
                        })
                        .catch((err: unknown) => {
                          setError(err instanceof Error ? err.message : 'Löschen fehlgeschlagen.')
                        })
                    }}
                  >
                    Löschen
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <hr className="section-divider" />
      <h2>Zeitplan</h2>
      {schedules.length === 0 ? (
        <p className="hint">Nichts eingeplant.</p>
      ) : (
        <table>
          <tbody>
            {schedules.map((s) => (
              <tr key={s.id}>
                <td>
                  {s.label || s.prompt.slice(0, 60)}
                  <div className="hint">
                    <code>{s.cron}</code>
                    {s.lastRun && ` · zuletzt ${new Date(s.lastRun).toLocaleString('de-DE')}`}
                  </div>
                </td>
                <td style={{ width: 90 }}>
                  <button
                    onClick={() => {
                      void window.jarvis
                        .invoke('schedule:delete', { id: s.id })
                        .then(load)
                        .catch((err: unknown) => {
                          setError(err instanceof Error ? err.message : 'Löschen fehlgeschlagen.')
                        })
                    }}
                  >
                    Löschen
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <hr className="section-divider" />
      <h2>Preiswächter</h2>
      {watches.length === 0 ? (
        <p className="hint">Nichts wird beobachtet.</p>
      ) : (
        <table>
          <tbody>
            {watches.map((w) => (
              <tr key={w.id}>
                <td>
                  {w.productName}
                  <div className="hint">
                    Ziel {w.targetPrice.toFixed(2)} € · aktuell{' '}
                    {w.lastPrice ? `${w.lastPrice.toFixed(2)} €` : 'unbekannt'}
                    {w.notified && ' · erreicht'}
                  </div>
                </td>
                <td style={{ width: 90 }}>
                  <button
                    onClick={() => {
                      void window.jarvis
                        .invoke('watch:delete', { id: w.id })
                        .then(load)
                        .catch((err: unknown) => {
                          setError(err instanceof Error ? err.message : 'Löschen fehlgeschlagen.')
                        })
                    }}
                  >
                    Löschen
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

// ─────────────────────────────────────────────────────────────
// Telefon
// ─────────────────────────────────────────────────────────────

/**
 * Koppeln, Marke, Aufwachbereitschaft.
 *
 * Die Marke steht hier im Klartext, und das ist der Zweck der Seite: Sie muss
 * ins Telefon, und ein Geheimnis, das man nicht mehr lesen kann, taugt dafür
 * nicht. Der Wechselknopf daneben ist der Ausweg, falls sie einmal irgendwo
 * gelandet ist, wo sie nicht hingehört.
 */
export function CompanionSection({ settings, patch }: Props): JSX.Element {
  const [status, setStatus] = useState<CompanionStatus | null>(null)
  const [readiness, setReadiness] = useState<WakeReadiness | null>(null)
  const [setup, setSetup] = useState<CompanionSetup | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async (): Promise<void> => {
    try {
      setStatus(await window.jarvis.invoke('companion:status'))
    } catch (err) {
      // Bei ausgeschalteter Fernbedienung ist „kein Status" normal und kein
      // Grund zur Meldung.
      if (settings.companion.enabled) {
        setNote(err instanceof Error ? err.message : 'Der Status ließ sich nicht aufnehmen.')
      }
    }
  }

  // Die Leiter wird nicht mitgetaktet: Sie ruft `tailscale cert` auf, und das
  // ist ein Prozessstart. Einmal beim Öffnen und nach jedem Knopfdruck reicht —
  // was sich dazwischen ändert, ändert sich nicht von selbst.
  useEffect(() => {
    void window.jarvis
      .invoke('companion:setup')
      .then(setSetup)
      .catch((err: unknown) => setNote(err instanceof Error ? err.message : String(err)))
  }, [settings.companion.enabled])

  /**
   * Führt aus, was der Knopf gerade anbietet.
   *
   * Das Einschalten bleibt hier statt im Hauptprozess: Diese Seite erfährt von
   * einer Einstellungsänderung nur, wenn sie sie selbst vornimmt. Ginge sie über
   * `runSetup`, stünde das Häkchen hinterher auf „aus", während der Server läuft.
   */
  const runSetup = async (): Promise<void> => {
    const action = setup?.action
    if (!action) return
    setBusy(true)
    try {
      if (action === 'enable' || action === 'server-off') {
        patch({ companion: { ...settings.companion, enabled: true } })
        // Der Server startet über den Melder im Hauptprozess, also nicht sofort.
        await new Promise((r) => window.setTimeout(r, 400))
        setSetup(await window.jarvis.invoke('companion:setup'))
      } else {
        setSetup(await window.jarvis.invoke('companion:runSetup', { action }))
      }
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Die Einrichtung ging nicht.')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void load()
    // Die Zahl der verbundenen Telefone ändert sich, ohne dass diese Seite
    // etwas davon mitbekommt — deshalb nachsehen, solange sie offen ist.
    const timer = window.setInterval(() => void load(), 3000)
    return () => window.clearInterval(timer)
  }, [settings.companion.enabled, settings.companion.port])

  const rotate = async (): Promise<void> => {
    setBusy(true)
    try {
      setStatus(await window.jarvis.invoke('companion:rotateToken'))
      setNote('Neue Marke. Alle gekoppelten Telefone müssen noch einmal verbunden werden.')
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Der Wechsel ging nicht.')
    } finally {
      setBusy(false)
    }
  }

  const checkWake = async (): Promise<void> => {
    setBusy(true)
    try {
      setReadiness(await window.jarvis.invoke('companion:wakeReadiness'))
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Die Prüfung ging nicht.')
    } finally {
      setBusy(false)
    }
  }

  const arm = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.jarvis.invoke('companion:armWake')
      setNote(result.note)
      setReadiness(await window.jarvis.invoke('companion:wakeReadiness'))
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Das Aufwachen ließ sich nicht einschalten.')
    } finally {
      setBusy(false)
    }
  }

  const pairingUrl =
    status?.urls[0] && status.token ? `${status.urls[0]}#host=${status.urls[0].replace(/^https?:\/\//, '').replace(/\/$/, '')}&token=${status.token}` : null

  return (
    <>
      <h2>Telefon</h2>
      <p className="lede">
        Das Telefon wird nicht zu einem zweiten James, sondern zu seiner Fernbedienung: Der Rechner
        bleibt der Agent — dort sind Chrome, Dateien, Maus und Bildschirm —, das Telefon ist
        Mikrofon, Lautsprecher und Anzeige. Ein Weckwort gibt es dort nicht; iOS lässt nichts
        dauerhaft mithören. Stattdessen die Sprechtaste.
      </p>

      {/*
        Die Einrichtung als Leiter statt als Formular: Es steht immer genau eine
        Sache da, und daneben der Knopf, der sie erledigt. Fällt sie weg, rückt
        die nächste nach.
      */}
      {setup && (
        <div className="row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
          <strong>
            {setup.ready ? '✓ ' : ''}
            {setup.headline}
          </strong>
          <p className="hint" style={{ margin: 0 }}>
            {setup.detail}
          </p>
          {setup.action && (
            <button className="primary" onClick={() => void runSetup()} disabled={busy}>
              {setup.actionLabel}
            </button>
          )}
        </div>
      )}

      {settings.companion.enabled && (
        <div className="row">
          <button
            onClick={() => {
              patch({ companion: { ...settings.companion, enabled: false } })
              setNote('Fernbedienung aus. Verbundene Telefone verlieren die Verbindung.')
            }}
            disabled={busy}
          >
            Fernbedienung ausschalten
          </button>
        </div>
      )}

      <label>
        Port
        <input
          type="number"
          value={settings.companion.port}
          min={1024}
          max={65535}
          onChange={(e) =>
            patch({
              companion: { ...settings.companion, port: Number(e.target.value) || 8788 }
            })
          }
        />
      </label>

      {/*
        Die Wahl der Quelle steht ganz unten und nur dann, wenn es überhaupt
        etwas zu wählen gibt. Wer Tailscale nicht hat, soll nicht erst lesen
        müssen, was er damit könnte — der eigene Weg reicht für zu Hause.
      */}
      {setup?.tailscaleAvailable && (
        <label>
          Zertifikat
          <select
            value={settings.companion.certSource}
            onChange={(e) =>
              patch({
                companion: {
                  ...settings.companion,
                  certSource: e.target.value as 'local' | 'tailscale'
                }
              })
            }
          >
            <option value="local">Eigenes — nur zu Hause, einmal am Telefon eintragen</option>
            <option value="tailscale">Tailscale — auch von unterwegs</option>
          </select>
        </label>
      )}

      {/*
        Zuerst das Vertrauen, dann das Koppeln. Beide Schritte sind ein
        QR-Code, und genau deshalb dürfen sie nicht gleichzeitig dastehen —
        zwei Codes nebeneinander, und der erste wird der falsche sein.
      */}
      {settings.companion.enabled &&
        status?.running &&
        setup?.blocker === 'ca-not-installed' &&
        status.caUrl && (
          <>
            <h3>Erst vertrauen</h3>
            <p className="hint">
              Diesen Code mit der iPhone-Kamera abfotografieren. Die Seite dahinter hat den Knopf
              zum Profil und darunter die zwei Schritte, mit denen es gilt. Danach hier auf
              „Erledigt" drücken — der Rechner kann von sich aus nicht sehen, ob es geklappt hat.
            </p>
            <PairingCode url={status.caUrl} label="Zertifikat aufs iPhone" />
          </>
        )}

      {settings.companion.enabled && status?.running && setup?.ready && (
        <>
          <h3>Koppeln</h3>
          {/*
            Der Hinweis steht vor dem Code, nicht darunter: Ohne sicheren Kontext
            ist die Sprechtaste tot, und das soll man lesen, bevor man
            abfotografiert und sich hinterher wundert.
          */}
          {status.secure ? (
            <p className="hint">
              QR-Code mit der iPhone-Kamera abfotografieren — Safari öffnet die Seite und trägt die
              Marke selbst ein. Dann über „Teilen" auf „Zum Home-Bildschirm".
            </p>
          ) : (
            <p className="hint">
              <strong>Ohne Verschlüsselung bleibt die Sprechtaste gesperrt.</strong> iOS gibt das
              Mikrofon nur in einem sicheren Kontext frei, und eine Adresse im Heimnetz über
              einfaches HTTP ist keiner. Anzeige, Wiedergabe und das Tippfeld gehen trotzdem.
              {setup && !setup.ready ? ` ${setup.detail}` : ''}
            </p>
          )}
          <table>
            <tbody>
              <tr>
                <td>Adresse</td>
                <td>
                  <code>{status.urls[0] ?? '—'}</code>{' '}
                  {status.secure ? (
                    <span className="badge ok">verschlüsselt</span>
                  ) : (
                    <span className="badge err">ohne Mikrofon</span>
                  )}
                </td>
              </tr>
              {status.urls[1] && (
                <tr>
                  <td>auch erreichbar</td>
                  <td>
                    <code>{status.urls[1]}</code>
                  </td>
                </tr>
              )}
              <tr>
                <td>Marke</td>
                <td>
                  <code>{status.token ?? '—'}</code>
                </td>
              </tr>
              <tr>
                <td>Verbunden</td>
                <td>{status.phones === 0 ? 'kein Telefon' : `${status.phones}`}</td>
              </tr>
            </tbody>
          </table>

          {pairingUrl && <PairingCode url={pairingUrl} />}

          <div className="row">
            <button onClick={() => void rotate()} disabled={busy}>
              Marke wechseln
            </button>
          </div>
        </>
      )}

      <h3>Rechner aufwecken</h3>
      <p className="hint">
        Schläft der Rechner, ist auch dieser Server aus — geweckt werden kann er deshalb nur von
        außen, also vom Telefon. Eine Webseite darf das nicht, ein Browser kann keine solchen
        Netzpakete verschicken. Der Weckknopf wirkt nur in der eingepackten App; wie die ohne Mac
        entsteht, steht in <code>resources/companion/README.md</code>.
      </p>

      {status?.wake && (
        <table>
          <tbody>
            <tr>
              <td>Netzwerkkarte</td>
              <td>
                <code>{status.wake.mac}</code>
              </td>
            </tr>
            <tr>
              <td>Rundruf</td>
              <td>
                <code>{status.wake.broadcast}</code>
              </td>
            </tr>
          </tbody>
        </table>
      )}

      <div className="row">
        <button onClick={() => void checkWake()} disabled={busy}>
          Bereitschaft prüfen
        </button>
        <button onClick={() => void arm()} disabled={busy}>
          Aufwachen einschalten
        </button>
      </div>

      {readiness && (
        <p className="hint">
          {readiness.adapter ? `${readiness.adapter}: ` : ''}
          {readiness.armed === true ? 'hört auf das Zauberpaket. ' : ''}
          {readiness.note}
        </p>
      )}

      {note && <p className="hint" role="status">{note}</p>}
    </>
  )
}

/**
 * Der Kopplungs-Code.
 *
 * Adresse und Marke stecken beide darin — abgetippt wird also nichts, und
 * damit fällt die häufigste Fehlerquelle weg: eine Marke aus zwanzig zufälligen
 * Zeichen, in der ein l von einem I nicht zu unterscheiden ist.
 *
 * Der Code wird bewusst nicht dauerhaft angezeigt, sondern erst auf Knopfdruck.
 * Wer ihn einmal abfotografiert hat, braucht ihn nie wieder; wer ihn ständig
 * offen auf dem Bildschirm hätte, zeigte im nächsten Videoanruf einen Zugang
 * zu seinem Mailkonto.
 */
function PairingCode({
  url,
  label = 'iPhone verbinden'
}: {
  url: string
  label?: string
}): JSX.Element {
  const [shown, setShown] = useState(false)

  const matrix = useMemo(() => {
    if (!shown) return null
    try {
      return encodeQr(url)
    } catch (err) {
      console.error('[companion] QR-Code nicht erzeugbar:', err)
      return null
    }
  }, [shown, url])

  if (!shown) {
    return (
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" onClick={() => setShown(true)}>
          {label}
        </button>
      </div>
    )
  }

  return (
    <div style={{ marginTop: 12 }}>
      <p className="hint">
        Beim ersten Start der iPhone-App abfotografieren. In Safari geht es auch ohne: Adresse und
        Marke von Hand eintragen.
      </p>
      {matrix ? (
        <svg
          // Vier Module Ruhezone rundherum — ohne sie findet kein Leser die
          // Sucherquadrate, und der Code wirkt einfach kaputt.
          viewBox={`-4 -4 ${matrix.size + 8} ${matrix.size + 8}`}
          width={260}
          height={260}
          role="img"
          aria-label="Kopplungs-Code zum Abfotografieren"
          style={{ background: '#fff', borderRadius: 8, display: 'block' }}
        >
          <path d={qrToSvgPath(matrix)} fill="#000" shapeRendering="crispEdges" />
        </svg>
      ) : (
        <p className="hint">Der Code ließ sich nicht erzeugen — nimm die Angaben aus der Tabelle.</p>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <button onClick={() => setShown(false)}>Verbergen</button>
      </div>
    </div>
  )
}
