/** Was der Empfänger annimmt: vier Pflichtfelder, `kind` nur beim neuen Empfänger. */
export interface DiagnosticPayload {
  level: string
  message: string
  source: string
  details: string
  kind?: string
}

export async function sendDiagnosticReport(
  config: { enabled: boolean; url: string },
  token: string | null,
  report: DiagnosticPayload,
  request: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<{ ok: boolean; detail: string }> {
  if (!config.enabled) return { ok: false, detail: 'Versand ist deaktiviert.' }
  try {
    const endpoint = new URL(config.url)
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) {
      return { ok: false, detail: 'Gültige HTTPS-Adresse ohne Zugangsdaten erforderlich.' }
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`
    const response = await request(endpoint, {
      method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000), headers,
      body: JSON.stringify(report)
    })
    await response.body?.cancel()
    if (response.ok) return { ok: true, detail: 'Technische Statistik gesendet.' }
    const detail = response.status === 404
      ? 'API-Route fehlt (HTTP 404). Netlify Function auf dem Host dieser Adresse bereitstellen.'
      : response.status === 401 || response.status === 403
        ? `Zugang abgelehnt (HTTP ${response.status}). Fehlerbericht-Token und Serverfreigabe prüfen.`
        : response.status === 429
          ? 'Zu viele Berichte (HTTP 429). Bitte später erneut versuchen.'
          : response.status >= 500
            ? `Fehler beim Empfänger (HTTP ${response.status}). Backend und Speicher prüfen.`
            : `Empfänger lehnt ab (HTTP ${response.status}).`
    return { ok: false, detail }
  } catch {
    return { ok: false, detail: 'Versand fehlgeschlagen. HTTPS-Adresse und Verbindung prüfen; Zeitlimit: 10 Sekunden.' }
  }
}
