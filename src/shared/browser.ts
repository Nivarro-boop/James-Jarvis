export interface BrowserTabState {
  id: string
  title: string
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error: string | null
}

/**
 * Wozu das Browserfenster gerade offen ist.
 *
 * Der Browser ist kein allgemeiner Webbrowser, sondern ein Fenster für einen
 * Schritt, den nur der Nutzer selbst erledigen kann: anmelden, freigeben,
 * auswählen. Der Zweck steht oben im Fenster, damit klar ist, was zu tun ist.
 */
export interface BrowserPurpose {
  kind: 'login' | 'approval' | 'choice'
  title: string
  hint: string
  /** Erkennt die Anmeldung selbst und meldet „fertig“. */
  watch?: 'icloud'
}

export interface BrowserPanelState {
  open: boolean
  activeId: string | null
  tabs: BrowserTabState[]
  purpose: BrowserPurpose | null
  /** Der Zweck ist erfüllt (z. B. Anmeldung erkannt). */
  done: boolean
}

export const DEFAULT_PURPOSE: BrowserPurpose = {
  kind: 'choice',
  title: 'Dein Schritt im Browser',
  hint: 'Erledige den Schritt auf der Webseite und tippe danach auf „Fertig“.'
}

export function cleanPurpose(raw: unknown): BrowserPurpose {
  if (!raw || typeof raw !== 'object') return DEFAULT_PURPOSE
  const value = raw as Partial<BrowserPurpose>
  const kind = value.kind === 'login' || value.kind === 'approval' || value.kind === 'choice' ? value.kind : 'choice'
  const text = (input: unknown, fallback: string, max: number): string =>
    typeof input === 'string' && input.trim() ? input.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : fallback
  return {
    kind,
    title: text(value.title, DEFAULT_PURPOSE.title, 80),
    hint: text(value.hint, DEFAULT_PURPOSE.hint, 400),
    ...(value.watch === 'icloud' ? { watch: 'icloud' as const } : {})
  }
}

/** Nur der Rechnername — er steht im Fenster, damit der Nutzer sieht, wem er Daten gibt. */
export function browserHost(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.hostname : ''
  } catch { return '' }
}

export interface BrowserBounds { x: number; y: number; width: number; height: number }

/** Browser navigation never grants access to files, custom protocols or URL credentials. */
export function browserUrl(input: unknown): string {
  if (typeof input !== 'string' || input.length > 8192) throw new Error('Bitte eine gültige Webadresse eingeben.')
  const raw = input.trim()
  if (!raw || /[\u0000-\u0020\u007f]/.test(raw)) throw new Error('Bitte eine Webadresse ohne Leerzeichen eingeben.')
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Nur HTTP- und HTTPS-Webseiten ohne Zugangsdaten in der Adresse sind erlaubt.')
  }
  return url.href
}

export function allowedBrowserNavigation(raw: string): boolean {
  if (raw === 'about:blank') return true
  try { browserUrl(raw); return /^https?:\/\//i.test(raw) } catch { return false }
}

/** Native views must stay inside their host, including during resize or a bad IPC payload. */
export function clampBrowserBounds(raw: unknown, width: number, height: number): BrowserBounds | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as BrowserBounds
  if (![b.x, b.y, b.width, b.height].every(v => typeof v === 'number' && Number.isFinite(v))) return null
  const x = Math.max(0, Math.min(width, Math.round(b.x)))
  const y = Math.max(0, Math.min(height, Math.round(b.y)))
  const w = Math.max(0, Math.min(width - x, Math.round(b.width)))
  const h = Math.max(0, Math.min(height - y, Math.round(b.height)))
  return w >= 1 && h >= 1 ? { x, y, width: w, height: h } : null
}
