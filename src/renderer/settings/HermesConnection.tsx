import { useEffect, useState, type JSX } from 'react'
import type { Settings } from '@shared/types'

export function HermesConnection({ settings, patch }: { settings: Settings; patch: (p: Partial<Settings>) => Promise<Settings> }): JSX.Element {
  const [baseUrl, setBaseUrl] = useState(settings.hermes.baseUrl)
  const [model, setModel] = useState(settings.hermes.model)
  const [detail, setDetail] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { setBaseUrl(settings.hermes.baseUrl); setModel(settings.hermes.model) }, [settings.hermes.baseUrl, settings.hermes.model])
  const check = async (): Promise<void> => {
    setBusy(true)
    try {
      await patch({ hermes: { baseUrl, model } })
      let result = await window.jarvis.invoke('hermes:health')
      if (!result.ok) {
        setDetail('Gateway nicht erreichbar. Die vorhandene lokale Installation wird gestartet …')
        result = await window.jarvis.invoke('hermes:start')
      }
      setDetail(result.detail)
    } catch (error) { setDetail(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <div>
    <label>Lokaler Hermes-Gateway</label>
    <input aria-label="Hermes-Adresse" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />
    <input aria-label="Hermes-Modellroute" value={model} onChange={e => setModel(e.target.value)} />
    <button disabled={busy} onClick={() => void check()}>{busy ? 'Prüft / startet …' : 'Speichern, verbinden und bei Bedarf starten'}</button>
    <button disabled={busy} onClick={() => {
      setBusy(true)
      void (async () => {
        await patch({ hermes: { baseUrl, model } })
        const result = await window.jarvis.invoke('hermes:start')
        setDetail(result.detail)
      })()
        .catch(error => setDetail(String(error))).finally(() => setBusy(false))
    }}>Lokalen Hermes starten</button>
    <p className="hint">Hermes muss auf diesem Rechner mit aktiviertem API-Server laufen.
      Beim verwalteten Start speichert James den Gateway-Schlüssel automatisch.
      Für einen selbst gestarteten Gateway API_SERVER_KEY unter Zugänge speichern. Modellzugänge, Skills, Kanäle und Werkzeugrechte
      werden in Hermes eingerichtet. James übernimmt Mikrofon und Stimme; Hermes erledigt
      die Agentenarbeit. Ohne Bestätigungen in James werden Hermes-Rückfragen für den
      laufenden Auftrag automatisch einmalig freigegeben.</p>
    {detail && <p role="status" className="hint">{detail}</p>}
  </div>
}
