import { useEffect, useState, type JSX } from 'react'
import { CHATGPT_USAGE_URL, type ChatGptModel, type ChatGptStatus } from '@shared/chatgpt'
import { ChoiceCards } from './ChoiceCards'

interface Props {
  onChange?: (connected: boolean) => void
  model?: string
  onModelChange?: (id: string) => Promise<unknown>
}

/** Ein Satz pro Modell, aus dem Namen geschlossen. */
function modelHint(m: ChatGptModel): string {
  const id = m.id.toLowerCase()
  if (/codex/.test(id)) return 'Spezialisiert auf Code'
  if (/mini|nano|luna|flash|fast|spark|lite/.test(id)) return 'Schnell für leichte Aufgaben'
  if (/pro|astra|max|high|think/.test(id)) return 'Für schwierige Aufgaben'
  return 'Standardmodell für Alltag und Arbeit'
}

/** The same account and model controls in first setup and normal settings. */
export function ChatGptConnection({ onChange, model, onModelChange }: Props): JSX.Element {
  const [state, setState] = useState<ChatGptStatus | null>(null)
  const [models, setModels] = useState<ChatGptModel[]>([])
  const [busy, setBusy] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const [error, setError] = useState('')

  const refresh = async (): Promise<void> => {
    const status = await window.jarvis.invoke('chatgpt:status')
    setState(status)
    onChange?.(status.connected)
    setModels([])
    if (status.connected) {
      const available = await window.jarvis.invoke('chatgpt:models')
      setModels(available)
      if (!model && available.length && onModelChange) await onModelChange('auto')
      if (!available.length) setError('Das Konto liefert keine verfügbaren Modelle. Prüfe die Freigabe und lade die Modelle erneut.')
    }
  }
  useEffect(() => { void refresh().catch((e) => setError(String(e))) }, [])

  const connect = async (): Promise<void> => {
    setBusy(true)
    setSigningIn(true)
    setError('')
    try {
      const result = await window.jarvis.invoke('chatgpt:connect')
      if (!result.ok) throw new Error(result.error ?? 'Die Anmeldung ist fehlgeschlagen.')
      await refresh()
    } catch (e) { setError(e instanceof Error ? e.message : 'Die Anmeldung ist fehlgeschlagen.') }
    finally { setBusy(false); setSigningIn(false) }
  }
  const disconnect = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try { await window.jarvis.invoke('chatgpt:disconnect'); await refresh() }
    catch (e) { setError(e instanceof Error ? e.message : 'Abmelden fehlgeschlagen.') }
    finally { setBusy(false) }
  }

  return <div style={{ marginTop: 8 }}>
    {!state ? <p className="hint">Anmeldestatus wird geprüft …</p> : !state.enabled ?
      <p className="hint">{state.reason}</p> : state.connected ? <>
        <p className="hint">Anmeldung gespeichert{state.email ? ` als ${state.email}` : ''}.
          Geeignete Textanfragen zählen gegen deinen ChatGPT-Plan.</p>
        {onModelChange && <ChoiceCards
          title="Denkweise"
          value={model ?? ''}
          disabled={busy || models.length === 0}
          options={[
            { value: 'auto', label: 'Automatisch (empfohlen)', hint: 'Schnell im Gespräch, gründlich bei schwierigen Aufgaben.' },
            ...models.map((m) => ({ value: m.id, label: m.name, hint: modelHint(m) })),
            ...(model && model !== 'auto' && !models.some((m) => m.id === model) ? [{ value: model, label: model, hint: 'Nicht mehr in deinem Konto – Verfügbarkeit prüfen.' }] : [])
          ]}
          onChange={(id) => { void onModelChange(id).catch((err) => setError(String(err))) }}
        />}
        <button type="button" disabled={busy} onClick={() => void disconnect()}>Abmelden</button>{' '}
        <button type="button" disabled={busy} onClick={() => void connect()}>Erneut anmelden</button>{' '}
        <button type="button" disabled={busy} onClick={() => { void refresh().catch((e) => setError(String(e))) }}>Modelle erneut prüfen</button>
      </> : <button type="button" className="primary" disabled={busy} onClick={() => void connect()}>
        {busy ? 'Warte auf den Browser …' : 'Continue with ChatGPT'}
      </button>}
    {signingIn && <button type="button" onClick={() => {
      void window.jarvis.invoke('chatgpt:cancelSignIn').catch((e) => setError(String(e)))
    }}>Anmeldung abbrechen</button>}
    <p className="hint"><a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">Nutzung und Limits in ChatGPT verwalten</a>.
      {' '}James zeigt keine geschätzten Abo-Prozente an. OpenAI setzt die Konto-Limits durch.
      Direkte OpenAI-Live-Sprache benötigt einen separat abgerechneten API-Schlüssel.
      Mit lokalen Ohren und einer lokalen Stimme kann das Abo den Text-Denkmotor einer Sprachunterhaltung versorgen.</p>
    {error && <><p className="hint err">{error}</p><button type="button" disabled={busy} onClick={() => {
      setBusy(true); setError('')
      void refresh().catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false))
    }}>Status und Modelle erneut laden</button></>}
  </div>
}
