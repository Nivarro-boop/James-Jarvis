import { useState } from 'react'

export function VoiceAccess({ provider, onSaved }: { provider: 'openai' | 'elevenlabs'; onSaved: () => void }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const run = async (save: boolean) => {
    setBusy(true)
    setMessage('Zugang wird geprüft …')
    try {
      if (save) {
        const result = provider === 'openai'
          ? await window.jarvis.invoke('secrets:checkOpenai', { value: key })
          : await window.jarvis.invoke('secrets:checkEleven', { value: key })
        if (!result.ok) { setMessage(result.error || 'Zugang abgelehnt.'); return }
        setKey('')
        onSaved()
      }
      if (provider === 'openai') {
        const result = await window.jarvis.invoke('openai:checkRealtime')
        setMessage(result.ok ? 'Realtime-Zugang und gewähltes Modell bestätigt. Jetzt im Hauptfenster sprechen.' : result.error || 'Realtime nicht verfügbar.')
      } else {
        const quota = await window.jarvis.invoke('eleven:quota', { fresh: true })
        setMessage(quota.reason || (quota.ok ? 'ElevenLabs bereit. Stimme unten wählen und Hörprobe starten.' : 'ElevenLabs ist nicht bereit.'))
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <section className="voice-access" aria-label={`${provider} einrichten`}>
    <strong>{provider === 'openai' ? 'OpenAI Realtime verbinden' : 'ElevenLabs verbinden'}</strong>
    <p className="hint">{provider === 'openai' ? 'API-Schlüssel und API-Guthaben erforderlich. Der Test prüft den tatsächlichen Realtime-Modellzugang.' : 'ElevenLabs liefert die Stimme. Der unten gewählte Denkmotor führt deine Aufträge und Werkzeuge aus.'}</p>
    <input type="password" autoComplete="off" aria-label={`${provider} API-Schlüssel`} placeholder="API-Schlüssel hier eingeben" value={key} onChange={e => setKey(e.target.value)} />
    <div className="row"><button disabled={busy || !key.trim()} onClick={() => void run(true)}>Speichern und prüfen</button>
      <button disabled={busy} onClick={() => void run(false)}>{busy ? 'Prüft …' : 'Gespeicherten Zugang testen'}</button></div>
    {message && <p role="status">{message}</p>}
  </section>
}
