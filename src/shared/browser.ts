export interface BrowserTabState {
  id: string
  title: string
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error: string | null
}

export interface BrowserPanelState {
  open: boolean
  activeId: string | null
  tabs: BrowserTabState[]
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
