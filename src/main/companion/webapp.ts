import { JAMES_WEB_APP, parseJamesWebAppInfo, type JamesWebAppInfo } from '@shared/companion'

/**
 * Wo die James-App fürs iPhone gerade liegt und in welcher Fassung.
 *
 * Jeder Push auf `main` im Repo jarvis-iphone baut die App neu, legt ein
 * GitHub-Release an und schreibt `version.json` neben die App. Von dort kommt
 * hier Adresse und Version für den Kopplungs-Code — der Code folgt damit jeder
 * neuen Fassung, ohne dass James am PC selbst ein Update braucht.
 *
 * Abgefragt im Hauptprozess, weil die Einstellungsseite per CSP nur mit sich
 * selbst sprechen darf. Zehn Minuten gemerkt; ohne Netz gilt die eingebaute
 * Adresse, damit der Code trotzdem erscheint.
 */

const CACHE_MS = 10 * 60_000
const TIMEOUT_MS = 5_000

let cached: { at: number; info: JamesWebAppInfo } | null = null

export async function jamesWebApp(fetcher: typeof fetch = fetch, now = Date.now()): Promise<JamesWebAppInfo> {
  if (cached && now - cached.at < CACHE_MS) return cached.info
  try {
    const response = await fetcher(`${JAMES_WEB_APP}version.json?t=${now}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!response.ok) throw new Error(`GitHub antwortet mit ${response.status}`)
    const info = parseJamesWebAppInfo(await response.json())
    cached = { at: now, info }
    return info
  } catch {
    // Kein Merken: Beim nächsten Öffnen der Seite wird neu gefragt.
    return { url: JAMES_WEB_APP, version: null, date: null, fromGitHub: false }
  }
}

/** Nur für Tests. */
export function forgetJamesWebApp(): void {
  cached = null
}
