import { useEffect, useState, type JSX } from 'react'
import { CHATGPT_USAGE_URL, type ChatGptModel, type ChatGptStatus } from '@shared/chatgpt'

interface Props {
  onChange?: (connected: boolean) => void
  model?: string
  onModelChange?: (id: string) => Promise<unknown>
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
      if (!model && available.length && onModelChange) await onModelChange(available[0].id)
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
        {onModelChange && <select aria-label="ChatGPT-Abo-Modell" value={model ?? ''}
          disabled={busy || models.length === 0}
          onChange={(e) => { void onModelChange(e.target.value).catch((err) => setError(String(err))) }}>
          <option value="">Modell aus deinem Konto auswählen</option>
          {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          {model && !models.some((m) => m.id === model) && <option value={model}>{model} (Verfügbarkeit prüfen)</option>}
        </select>}
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
