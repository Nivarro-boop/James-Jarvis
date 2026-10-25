import { useEffect, useRef, useState, type JSX } from 'react'
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
  const [pending, setPending] = useState<{ url: string; browserError?: string } | null>(null)
  const [callback, setCallback] = useState('')
  const [callbackBusy, setCallbackBusy] = useState(false)
  const operation = useRef(false)
  const refreshVersion = useRef(0)
  useEffect(() => {
    if (!signingIn) { setPending(null); setCallback(''); return }
    let alive = true
    const load = (): void => { void window.jarvis.invoke('chatgpt:pendingSignIn').then(value => { if (alive) setPending(value) }).catch(() => {}) }
    load()
    const timer = window.setInterval(load, 600)
    return () => { alive = false; window.clearInterval(timer) }
  }, [signingIn])

  const refresh = async (): Promise<void> => {
    const version = ++refreshVersion.current
    const status = await window.jarvis.invoke('chatgpt:status')
    if (version !== refreshVersion.current) return
    setState(status)
    onChange?.(status.connected)
    if (!status.connected) setModels([])
    if (status.connected) {
      const available = await window.jarvis.invoke('chatgpt:models')
      if (version !== refreshVersion.current) return
      setModels(available)
      if (!model && available.length && onModelChange) await onModelChange('auto')
      if (!available.length) setError('Das Konto liefert keine verfügbaren Modelle. Prüfe die Freigabe und lade die Modelle erneut.')
    }
  }
  const reload = async (): Promise<void> => {
    if (operation.current) return
    operation.current = true
    setBusy(true); setError('')
    try { await refresh() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { operation.current = false; setBusy(false) }
  }
  useEffect(() => { void reload() }, [])

  const connect = async (): Promise<void> => {
    if (operation.current) return
    operation.current = true
    ++refreshVersion.current
    setBusy(true)
    setSigningIn(true)
    setError('')
    try {
      const result = await window.jarvis.invoke('chatgpt:connect')
      if (!result.ok) throw new Error(result.error ?? 'Die Anmeldung ist fehlgeschlagen.')
      await refresh()
    } catch (e) { setError(e instanceof Error ? e.message : 'Die Anmeldung ist fehlgeschlagen.') }
    finally { operation.current = false; setBusy(false); setSigningIn(false) }
  }
  const disconnect = async (): Promise<void> => {
    if (operation.current) return
    operation.current = true
    ++refreshVersion.current
    setBusy(true)
    setError('')
    try { await window.jarvis.invoke('chatgpt:disconnect'); await refresh() }
    catch (e) { setError(e instanceof Error ? e.message : 'Abmelden fehlgeschlagen.') }
    finally { operation.current = false; setBusy(false) }
  }

  const modelName = !model || model === 'auto' ? 'Automatisch (empfohlen)' : models.find((m) => m.id === model)?.name ?? model

  return <div style={{ marginTop: 8 }}>
    {!state ? <p className="hint">Anmeldestatus wird geprüft …</p> : !state.enabled ?
      <p className="hint">{state.reason}</p> : state.connected ? <>
        <p className="hint ok">Angemeldet{state.email ? ` als ${state.email}` : ''}. James denkt über dein ChatGPT-Abo.</p>
        {onModelChange && <p className="hint">Denkweise: <strong>{modelName}</strong></p>}
        <button type="button" disabled={busy} onClick={() => void disconnect()}>Abmelden</button>
        {/* Für die meisten reicht „Automatisch“. Wer selbst wählen oder einen
            Fehler beheben will, klappt auf — sonst stehen hier vier Knöpfe
            und zehn Modellnamen, die niemand auseinanderhalten kann. */}
        <details className="settings-fold">
          <summary>Modell selbst wählen oder Anmeldung reparieren</summary>
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
          <button type="button" disabled={busy} onClick={() => void connect()}>Neu anmelden</button>{' '}
          <button type="button" disabled={busy} onClick={() => { void reload() }}>Modelle neu laden</button>
          <p className="hint"><a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">Nutzung und Limits in ChatGPT</a> · Live-Sprache über die OpenAI API wird separat abgerechnet.</p>
        </details>
      </> : <>
        <button type="button" className="primary" disabled={busy} onClick={() => void connect()}>
          {busy ? 'Warte auf den Browser …' : 'Continue with ChatGPT'}
        </button>
        <p className="hint">{busy
          ? 'Im Browser hat sich ChatGPT geöffnet. Dort anmelden und auf „Zulassen“ drücken. Danach hierher zurückkommen.'
          : 'Ein Klick öffnet ChatGPT in deinem Browser. Du nutzt das freigegebene Kontingent deines Abos. Einen API-Schlüssel musst du dafür nicht eingeben.'}</p>
      </>}
    {signingIn && <button type="button" onClick={() => {
      void window.jarvis.invoke('chatgpt:cancelSignIn').catch((e) => setError(String(e)))
    }}>Anmeldung abbrechen</button>}
    {signingIn && pending && <details className="settings-fold">
      <summary>Browser zeigt am Ende einen Fehler oder läuft auf einem anderen Gerät?</summary>
      <p className="hint">Öffne den Anmeldelink. Falls der Browser am Ende 127.0.0.1 nicht erreicht, kopiere die komplette Adresse aus seiner Adresszeile hierher. James prüft sie auf diesem Rechner.</p>
      {pending.browserError && <p className="hint err">{pending.browserError}</p>}
      <button type="button" onClick={() => { void navigator.clipboard.writeText(pending.url).catch(() => setError('Kopieren fehlgeschlagen. Bitte den Link markieren.')) }}>Anmeldelink kopieren</button>
      <input aria-label="Anmeldelink" readOnly value={pending.url} onFocus={event => event.target.select()} />
      <label htmlFor="chatgpt-callback">Rückleitungsadresse aus dem Browser</label>
      <textarea id="chatgpt-callback" aria-label="Rückleitungsadresse" value={callback} onChange={event => setCallback(event.target.value)} placeholder="http://127.0.0.1:…/auth/callback?code=…" autoComplete="off" spellCheck={false} />
      <button type="button" disabled={callbackBusy || !callback.trim()} onClick={() => {
        setCallbackBusy(true); setError('')
        void window.jarvis.invoke('chatgpt:submitCallback', { url: callback }).then(() => setCallback(''))
          .catch(err => setError(err instanceof Error ? err.message : String(err))).finally(() => setCallbackBusy(false))
      }}>Anmeldung abschließen</button>
    </details>}
    {error && <><p className="hint err" role="alert">{error}</p><button type="button" disabled={busy} onClick={() => { void reload() }}>Erneut versuchen</button></>}
  </div>
}
