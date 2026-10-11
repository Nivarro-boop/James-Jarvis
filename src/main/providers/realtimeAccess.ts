/** Mint only a short-lived token; never return the saved API key. */
export async function realtimeAccess(key: string | null, model: string, request = fetch): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  const clean = key?.trim()
  if (!clean) return { ok: false, error: 'OpenAI API-Schlüssel fehlt. Hier speichern und erneut prüfen.' }
  if (/[^\x21-\x7e]/.test(clean)) return { ok: false, error: 'Der Schlüssel enthält unsichtbare Zeichen. Bitte neu kopieren.' }
  try {
    const response = await request('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST', signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${clean}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expires_after: { anchor: 'created_at', seconds: 60 }, session: { type: 'realtime', model: model.trim() || 'gpt-realtime' } })
    })
    const body = await response.json().catch(() => ({})) as { value?: string; error?: { code?: string }; client_secret?: { value?: string } }
    if (!response.ok) {
      const code = body.error?.code ?? ''
      const message = response.status === 401 ? 'API-Schlüssel abgelehnt. Schlüssel und Projekt prüfen.'
        : /quota|billing/.test(code) ? 'OpenAI-API-Guthaben fehlt oder das Projektlimit ist erreicht.'
        : response.status === 403 ? 'Das Projekt hat keine Berechtigung für Realtime.'
        : response.status === 404 || /model/.test(code) ? `Realtime-Modell „${model}“ ist für diesen Zugang nicht verfügbar.`
        : response.status === 429 ? 'OpenAI-Anfragelimit erreicht. Kurz warten und erneut prüfen.'
        : `OpenAI Realtime ist momentan nicht verfügbar (HTTP ${response.status}).`
      return { ok: false, error: message }
    }
    const value = body.value ?? body.client_secret?.value
    return value ? { ok: true, value } : { ok: false, error: 'OpenAI hat keinen kurzlebigen Zugang geliefert.' }
  } catch {
    return { ok: false, error: 'network: OpenAI Realtime nicht erreichbar. Internet und Firewall prüfen.' }
  }
}
