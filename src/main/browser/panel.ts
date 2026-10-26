import { BrowserWindow, WebContentsView, session, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { allowedBrowserNavigation, browserUrl, clampBrowserBounds, cleanPurpose, type BrowserBounds, type BrowserPanelState, type BrowserPurpose } from '@shared/browser'
import { hasICloudAuthCookie } from '@shared/icloud'

const PARTITION = 'persist:james-browser'
const MAX_TABS = 12
type Tab = { id: string; view: WebContentsView; error: string | null }
let host: BrowserWindow | null = null
let tabs: Tab[] = []
let activeId: string | null = null
let opened = false
let viewport: BrowserBounds | null = null
let sessionReady = false
let purpose: BrowserPurpose | null = null
let done = false
let watchTimer: NodeJS.Timeout | null = null

export function browserState(): BrowserPanelState {
  return { open: opened, purpose: opened ? purpose : null, done: opened && done, activeId, tabs: tabs.filter(t => !t.view.webContents.isDestroyed()).map(t => {
    const wc = t.view.webContents
    return { id: t.id, title: wc.getTitle() || 'Neuer Tab', url: wc.getURL(), loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(), error: t.error }
  }) }
}

function emit(): void {
  if (host && !host.isDestroyed() && !host.webContents.isDestroyed()) host.webContents.send('browser:state', browserState())
}

function layout(): void {
  if (!host || host.isDestroyed()) return
  const [width, height] = host.getContentSize()
  const bounds = clampBrowserBounds(viewport, width, height)
  for (const tab of tabs) {
    const show = opened && tab.id === activeId && bounds !== null && tab.view.webContents.getURL() !== 'about:blank'
    tab.view.setVisible(show)
    if (show && bounds) tab.view.setBounds(bounds)
  }
}

export function bindBrowserWindow(window: BrowserWindow): void {
  if (host === window) return
  if (host && !host.isDestroyed()) throw new Error('Der Browser ist bereits in einem Fenster geöffnet.')
  host = window
  window.on('resize', layout)
  window.webContents.on('did-start-loading', () => { viewport = null; layout() })
  window.webContents.on('did-finish-load', emit)
  window.on('closed', () => {
    const old = tabs
    tabs = []; host = null; activeId = null; opened = false; viewport = null; purpose = null; done = false
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null }
    for (const tab of old) if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
  })
}

function createTab(popupOptions?: Electron.BrowserWindowConstructorOptions): Tab {
  if (!host || host.isDestroyed()) throw new Error('Bitte zuerst das James-Fenster öffnen.')
  if (tabs.length >= MAX_TABS) throw new Error('Zwölf Tabs sind offen. Schließe zuerst einen Tab.')
  const ses = session.fromPartition(PARTITION)
  if (!sessionReady) {
    // Websites share their own persistent session, never the privileged application session.
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
    ses.on('will-download', (event) => { event.preventDefault(); const tab = tabs.find(t => t.id === activeId); if (tab) tab.error = 'Downloads bitte im normalen Browser öffnen.'; emit() })
    sessionReady = true
  }
  const view = new WebContentsView({ ...popupOptions, webPreferences: {
    ...popupOptions?.webPreferences,
    preload: undefined,
    session: ses, nodeIntegration: false, nodeIntegrationInSubFrames: false,
    contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
    webviewTag: false, navigateOnDragDrop: false
  } })
  const tab: Tab = { id: randomUUID(), view, error: null }
  tabs.push(tab); activeId = tab.id
  host.contentView.addChildView(view)
  view.setVisible(false)
  const wc = view.webContents
  wc.on('will-navigate', (event, url) => { if (!allowedBrowserNavigation(url)) event.preventDefault() })
  wc.on('will-redirect', (event, url) => { if (!allowedBrowserNavigation(url)) event.preventDefault() })
  wc.on('will-frame-navigate', event => {
    if (!allowedBrowserNavigation(event.url) && !event.url.startsWith('about:')) event.preventDefault()
  })
  wc.on('will-attach-webview', event => event.preventDefault())
  wc.on('content-bounds-updated', event => event.preventDefault())
  wc.setWindowOpenHandler(({ url }) => {
    if (!allowedBrowserNavigation(url) || tabs.length >= MAX_TABS) return { action: 'deny' }
    // Keeping Chromium's opener relationship is necessary for account-login popups.
    return { action: 'allow', createWindow: options => {
      const popup = createTab(options)
      layout(); emit()
      return popup.view.webContents
    } }
  })
  wc.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) tab.error = null
    emit()
  })
  const changed = (): void => { layout(); emit() }
  wc.on('did-start-loading', changed)
  wc.on('did-stop-loading', changed)
  wc.on('page-title-updated', changed)
  wc.on('did-navigate', changed)
  wc.on('did-navigate-in-page', changed)
  wc.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) { tab.error = `Seite konnte nicht geladen werden (${code}). Erneut laden oder Adresse prüfen.`; emit() }
  })
  wc.on('render-process-gone', () => { tab.error = 'Dieser Tab wurde beendet. Bitte erneut laden.'; emit() })
  wc.on('destroyed', () => {
    if (!tabs.includes(tab)) return
    tabs = tabs.filter(t => t !== tab)
    if (activeId === tab.id) activeId = tabs.at(-1)?.id ?? null
    layout(); emit()
  })
  return tab
}

/**
 * Lädt eine Seite. Sichtbar wird sie nur mit `visible`, und dann immer mit
 * einem Zweck: Der Browser ist das Fenster für einen Schritt des Nutzers
 * (anmelden, freigeben, auswählen), kein allgemeiner Webbrowser.
 */
export function openBrowser(url?: string, reuse = false, visible = true, why?: BrowserPurpose): BrowserPanelState {
  const target = url === undefined ? null : browserUrl(url)
  let tab = reuse && target ? tabs.find(t => t.view.webContents.getURL() === target) : undefined
  if (!tab) {
    tab = createTab()
    if (target) void tab.view.webContents.loadURL(target).catch(() => { /* did-fail-load reports navigation errors */ })
    else void tab.view.webContents.loadURL('about:blank')
  }
  activeId = tab.id
  if (visible) {
    opened = true
    purpose = cleanPurpose(why)
    done = false
    watchPurpose()
    host?.restore(); host?.show(); host?.focus()
  }
  layout(); emit()
  return browserState()
}

/** Prüft bei Anmeldezwecken, ob die Anmeldung schon geklappt hat. */
function watchPurpose(): void {
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null }
  if (!opened || purpose?.watch !== 'icloud') return
  const check = async (): Promise<void> => {
    if (!opened || purpose?.watch !== 'icloud' || done) { if (watchTimer) clearInterval(watchTimer); watchTimer = null; return }
    const cookies = await session.fromPartition(PARTITION).cookies.get({ domain: 'icloud.com' }).catch(() => [])
    if (hasICloudAuthCookie(cookies)) { done = true; emit() }
  }
  watchTimer = setInterval(() => { void check() }, 1500)
  void check()
}

export function setBrowserBounds(bounds: BrowserBounds | null): void {
  viewport = bounds
  layout()
}

export function browserAction(action: string, id?: string, url?: string): BrowserPanelState {
  const tab = tabs.find(t => t.id === (id ?? activeId))
  if (action === 'hide' || action === 'done') {
    opened = false; viewport = null; purpose = null; done = false
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null }
  }
  else if (action === 'show') { if (tabs.length) { opened = true; purpose ??= cleanPurpose(null); watchPurpose() } }
  else if (action === 'select' && tab) activeId = tab.id
  else if (action === 'close' && tab) {
    tabs = tabs.filter(t => t !== tab)
    host?.contentView.removeChildView(tab.view)
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    if (activeId === tab.id) activeId = tabs.at(-1)?.id ?? null
  } else if (tab) {
    const wc = tab.view.webContents
    if (action === 'navigate') { tab.error = null; void wc.loadURL(browserUrl(url)).catch(() => {}) }
    else if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    else if (action === 'reload') { tab.error = null; wc.reload() }
    else if (action === 'stop') wc.stop()
  }
  layout(); emit()
  return browserState()
}

export function activeBrowserContents(): WebContents | null {
  return tabs.find(t => t.id === activeId)?.view.webContents ?? null
}

/** Read only text, never password/input values. The result is untrusted website content. */
export async function readBrowserText(maxChars = 8000, allowedFrame?: (url: string) => boolean): Promise<{ url: string; title: string; text: string }> {
  const wc = activeBrowserContents()
  if (!wc || wc.isDestroyed()) throw new Error('Öffne zuerst eine Seite im integrierten Browser.')
  const url = wc.getURL()
  const title = wc.getTitle()
  const deadline = Date.now() + 5000
  let remaining = Math.min(20000, Math.max(200, Math.floor(maxChars)))
  const parts: string[] = []
  for (const frame of wc.mainFrame.framesInSubtree.slice(0, 24)) {
    if (!remaining || Date.now() >= deadline) break
    if (allowedFrame && !allowedFrame(frame.url)) continue
    let timer: NodeJS.Timeout | undefined
    const text = await Promise.race([
      frame.executeJavaScript(`(() => { return (document.body?.innerText || '').slice(0, ${remaining}) })()`).catch(() => ''),
      new Promise<string>(resolve => { timer = setTimeout(() => resolve(''), Math.max(1, deadline - Date.now())) })
    ]).finally(() => clearTimeout(timer))
    if (typeof text === 'string' && text.trim()) { parts.push(text.trim().slice(0, remaining)); remaining -= parts.at(-1)!.length }
  }
  if (wc.isDestroyed() || wc.getURL() !== url) throw new Error('Die Seite hat während des Lesens gewechselt. Bitte erneut lesen.')
  return { url, title, text: parts.join('\n\n') }
}

/** Cookies der Browser-Sitzung für eine Domain, ohne Werte. */
export async function browserCookies(domain: string): Promise<Array<{ name: string; domain?: string; expirationDate?: number }>> {
  const cookies = await session.fromPartition(PARTITION).cookies.get({ domain })
  return cookies.map(({ name, domain, expirationDate }) => ({ name, domain, expirationDate }))
}

/** Meldet die Browser-Sitzung bei einer Domain ab: Cookies und gespeicherte Seitendaten dieser Domain löschen. */
export async function clearBrowserSite(domains: string[]): Promise<void> {
  const ses = session.fromPartition(PARTITION)
  for (const domain of domains) {
    for (const cookie of await ses.cookies.get({ domain })) {
      const host = (cookie.domain ?? domain).replace(/^\./, '')
      await ses.cookies.remove(`https://${host}${cookie.path ?? '/'}`, cookie.name).catch(() => undefined)
    }
    for (const origin of [`https://${domain}`, `https://www.${domain}`]) {
      await ses.clearStorageData({ origin, storages: ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] }).catch(() => undefined)
    }
  }
  for (const tab of tabs) {
    const wc = tab.view.webContents
    if (!wc.isDestroyed() && domains.some((d) => { try { const h = new URL(wc.getURL()).hostname; return h === d || h.endsWith('.' + d) } catch { return false } })) wc.reload()
  }
}
