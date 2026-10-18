import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserContext, Page } from 'playwright-core'
import { browserGate } from '@shared/browserGate'

/**
 * Anbindung an einen Chrome, der James gehört.
 *
 * Ursprünglich lief das über das Standardprofil des Nutzers — nur so sind
 * Amazon, Gmail und Twitch ohne eine einzige Anmeldung erreichbar. Dieser Weg
 * ist seit Chrome 136 versperrt: `--remote-debugging-port` wird auf dem
 * Standard-Datenverzeichnis stillschweigend verworfen. Die Zeichenkette steckt
 * wörtlich in der chrome.dll dieses Rechners (Chrome 150):
 *
 *   "DevTools remote debugging requires a non-default data directory.
 *    Specify this using --user-data-dir."
 *
 * Das ist eine Sicherheitsmaßnahme gegen das Abgreifen fremder Sitzungen, und
 * sie lässt sich nicht sauber umgehen: Ein Verzeichnis-Link auf das echte
 * Profil käme zwar an der Prüfung vorbei, würde aber zwei Chrome-Prozesse auf
 * dieselben Profildateien loslassen — mit der Profilsperre als einzigem Schutz,
 * die genau dann nicht greift, weil sie am Pfad hängt. Die Anmeldungen aus dem
 * echten Profil herüberzukopieren ist derselbe Griff, gegen den die Maßnahme
 * gebaut wurde.
 *
 * Also bekommt James ein eigenes Profil. Der Preis ist eine einmalige
 * Anmeldung bei Gmail und Amazon; wer die Chrome-Synchronisierung einschaltet,
 * bringt sie sich gleich mit. Dafür fällt der schlimmste Teil des alten Wegs
 * weg: Der Nutzer muss sein Chrome nicht mehr schließen, seine Tabs bleiben
 * unangetastet, und beide Browser laufen nebeneinander.
 */

let context: BrowserContext | null = null
let launching: Promise<BrowserContext> | null = null

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe')
]

function chromeExecutable(): string {
  const found = CHROME_PATHS.find((p) => p && existsSync(p))
  if (!found) throw new Error('Ich finde die Chrome-Installation nicht.')
  return found
}

/**
 * Das Datenverzeichnis für den James-Chrome.
 *
 * Muss vom Standardverzeichnis verschieden sein, sonst schaltet Chrome die
 * Fernsteuerung ab. Es liegt neben den übrigen App-Daten und überlebt damit
 * Updates — die Anmeldungen darin gelten auf Dauer.
 */
export function browserProfileDir(): string {
  return join(app.getPath('userData'), 'chrome-profile')
}

/** Ob schon einmal ein Fenster in diesem Profil lief. */
export function browserProfileExists(): boolean {
  return existsSync(join(browserProfileDir(), 'Default'))
}

/**
 * Wie `getContext`, startet Chrome aber nicht.
 *
 * Für die Verbindungsprüfung: die soll berichten, was gerade der Fall ist,
 * und nicht durch das Nachsehen selbst einen Browser aufmachen.
 */
export async function probeContext(): Promise<BrowserContext | null> {
  return context?.browser()?.isConnected() ? context : null
}

export async function getContext(): Promise<BrowserContext> {
  if (context?.browser()?.isConnected()) return context
  if (launching) return launching

  launching = (async () => {
    const { chromium } = await import('playwright-core')
    try {
      const next = await chromium.launchPersistentContext(browserProfileDir(), {
        executablePath: chromeExecutable(),
        headless: false,
        // Der Browser arbeitet außerhalb des sichtbaren Bildschirms; ohne diese
        // Schalter drosselt Chrome verdeckte Fenster und Bildschirmfotos hängen.
        args: ['--no-first-run', '--no-default-browser-check', '--window-position=-32000,-32000',
          '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
        viewport: null,
        acceptDownloads: true
      })
      context = next
      next.on('close', () => {
        if (context === next) context = null
      })
      return next
    } catch (err) {
      throw new Error(
        'Der Browser für James ließ sich nicht starten. Schließ ein eventuell noch offenes ' +
          `James-Chrome-Fenster und versuch es erneut. (${err instanceof Error ? err.message : String(err)})`
      )
    } finally {
      launching = null
    }
  })()
  return launching
}

/**
 * Öffnet eine Seite in einem neuen Tab und wartet, bis sie ruhig ist.
 * `domcontentloaded` statt `networkidle`: Shops laden dauernd Tracker nach,
 * `networkidle` läuft dort regelmäßig in den Timeout.
 */
let preferredPage: Page | null = null
export function selectActivePage(page: Page): void { preferredPage = page }
export async function activePage(): Promise<Page | null> {
  const pages = (await getContext()).pages()
  for (const page of pages) {
    if (await page.evaluate(() => document.hasFocus()).catch(() => false)) return page
  }
  if (preferredPage && pages.includes(preferredPage) && !preferredPage.isClosed()) return preferredPage
  return pages.at(-1) ?? null
}

export async function openPage(url: string): Promise<Page> {
  const ctx = await getContext()
  // Unsichtbar sammelt niemand Tabs von Hand ein: ab zehn den ältesten schließen.
  const open = ctx.pages()
  if (open.length >= 10) await open.find((p) => p !== preferredPage)?.close().catch(() => undefined)
  const page = await ctx.newPage()
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    if (!(await declineCookies(page))) { await page.waitForTimeout(800); await declineCookies(page) }
    return page
  } catch (err) {
    // Der Aufrufer bekommt bei einem Navigationsfehler nie einen Verweis auf
    // den gerade erzeugten Tab und kann ihn deshalb auch nicht schließen.
    // Netzfehler sammelten so bei jedem Versuch einen leeren Renderer an.
    await page.close().catch(() => undefined)
    throw err
  }
}

const COOKIE_REJECT_SELECTORS = [
  '#onetrust-reject-all-handler', '#CybotCookiebotDialogBodyButtonDecline', '[data-testid="uc-deny-all-button"]',
  '.cmpboxbtnno', '.sp_choice_type_REJECT_ALL', 'button[mode="secondary"][title*="Ablehnen" i]'
]
const COOKIE_REJECT_NAME = /^(alle )?(ablehnen|zurückweisen)$|^nur (notwendige|erforderliche|essenzielle)( cookies)?( (akzeptieren|zulassen|erlauben))?$|^(reject|decline)( all)?( cookies)?$|^(only|use) (necessary|essential)( cookies)?( only)?$|^nicht zustimmen$/i

/**
 * Lehnt Cookie-Banner ab — nie zustimmen.
 *
 * Im unsichtbaren Browser klickt niemand das Banner weg, und es verdeckt
 * Knöpfe und Text. Gedrückt wird nur, was eindeutig „ablehnen" oder „nur
 * notwendige" heißt; findet sich das nicht, bleibt das Banner stehen.
 */
export async function declineCookies(page: Page): Promise<boolean> {
  for (const frame of page.frames().slice(0, 8)) {
    for (const selector of COOKIE_REJECT_SELECTORS) {
      const el = frame.locator(selector).first()
      if (await el.isVisible().catch(() => false)) { await el.click({ timeout: 2000 }).catch(() => undefined); return true }
    }
    const byName = frame.getByRole('button', { name: COOKIE_REJECT_NAME }).first()
    if (await byName.isVisible().catch(() => false)) { await byName.click({ timeout: 2000 }).catch(() => undefined); return true }
  }
  return false
}

/** Für kurze Abfragen: Seite öffnen, auslesen, wieder schließen. */
export async function withPage<T>(url: string, fn: (page: Page) => Promise<T>): Promise<T> {
  const page = await openPage(url)
  try {
    return await fn(page)
  } finally {
    await page.close().catch(() => undefined)
  }
}

/** Bestehenden Tab finden, sonst neuen öffnen. */
export async function findOrOpen(urlPattern: string, url: string): Promise<Page> {
  const ctx = await getContext()
  for (const page of ctx.pages()) {
    if (page.url().includes(urlPattern)) {
      await page.bringToFront()
      return page
    }
  }
  return openPage(url)
}

/**
 * Macht den James-Browser sichtbar und öffnet eine Seite zum Anmelden.
 *
 * Der einzige Einrichtungsschritt, den es noch gibt. Absichtlich ein Knopf in
 * den Einstellungen statt einer gesprochenen Anleitung: Anmelden muss der
 * Nutzer selbst, James tippt keine Zugangsdaten.
 */
export async function openForLogin(url: string): Promise<{ titel: string; adresse: string }> {
  const page = await openPage(url)
  await page.bringToFront()
  await setWindowVisible(page, true)
  return { titel: await page.title().catch(() => ''), adresse: page.url() }
}

/**
 * Ob auf einer Amazon-Seite eine Anmeldung gilt. `null` heißt: nicht erkennbar.
 *
 * An der Adresse ist das nicht abzulesen. Den Warenkorb zeigt Amazon auch ohne
 * Anmeldung — dann eben den leeren Gast-Warenkorb, mit derselben Adresse und
 * ohne Weiterleitung nach `/ap/signin`. Wer nur darauf prüft, hält "gar nicht
 * angemeldet" für "angemeldet, Korb ist leer" und sagt dem Nutzer genau das.
 * Der Kontobereich in der Kopfzeile ist dagegen eindeutig: "Hallo, anmelden"
 * gegen "Hallo, <Name>".
 */
export async function amazonSignedIn(page: Page): Promise<boolean | null> {
  try {
    return await page.evaluate(() => {
      const nav = document.querySelector('#nav-link-accountList')
      if (!nav) return null
      return !/anmelden|sign in/i.test(nav.textContent ?? '')
    })
  } catch {
    return null
  }
}

/**
 * Erkennt die typischen Abwehrseiten. Wir lösen sie nicht — James übergibt
 * an den Nutzer, statt sich an einer Bot-Erkennung zu versuchen.
 */
export async function detectBlock(page: Page, options: { allowLogin?: boolean } = {}): Promise<string | null> {
  const title = (await page.title().catch(() => '')) || ''
  const text = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '')
  const selectors = ['iframe[src*="recaptcha"][src*="anchor"]', 'iframe[src*="recaptcha"][src*="bframe"]', 'iframe[src*="hcaptcha"]', 'iframe[src*="challenges.cloudflare.com"]']
  // A solved checkbox may remain on the page. Read only whether the response exists, never the token itself.
  const solved = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[name="g-recaptcha-response"], [name="h-captcha-response"], [name="cf-turnstile-response"]')).some(e => Boolean(e.value.trim()))).catch(() => false)
  let visibleChallenge = false
  if (!solved) for (const selector of selectors) {
    const frames = page.locator(selector)
    for (let i = 0, count = Math.min(await frames.count(), 10); i < count; i++) {
      if (await frames.nth(i).isVisible().catch(() => false)) { visibleChallenge = true; break }
    }
    if (visibleChallenge) break
  }
  const gate = browserGate({ url: page.url(), title, text: text.slice(0, 6000), visibleChallenge })
  if (gate === 'captcha') return 'Die Seite verlangt eine menschliche Sicherheitsprüfung. Bitte löse sie selbst im Browserfenster, das James dafür kurz zeigt, und klicke anschließend auf „Ich bin fertig – prüfen“.'
  const credentials = page.locator(options.allowLogin ? 'input[autocomplete="one-time-code"]' : 'input[type="password"], input[autocomplete="one-time-code"]')
  let loginVisible = false
  for (let i = 0, count = Math.min(await credentials.count(), 20); i < count; i++) {
    if (await credentials.nth(i).isVisible().catch(() => false)) { loginVisible = true; break }
  }
  if ((!options.allowLogin && gate === 'login') || loginVisible) return 'Die Seite verlangt eine Anmeldung. Bitte melde dich im James-Browser an und klicke anschließend auf „Ich bin fertig – prüfen“.'
  return null
}

/**
 * Schiebt das Browserfenster auf den Bildschirm oder wieder daneben.
 *
 * James arbeitet unsichtbar; der Nutzer sieht nur die Statuszeile. Sichtbar
 * wird das Fenster nur, wenn er selbst etwas tun muss: Anmeldung über die
 * Einstellungen, Einmalcode oder eine Sicherheitsprüfung.
 */
let windowShown = false
export async function setWindowVisible(page: Page, visible: boolean): Promise<void> {
  if (windowShown === visible && !visible) return
  windowShown = visible
  try {
    const cdp = await page.context().newCDPSession(page)
    const { windowId } = await cdp.send('Browser.getWindowForTarget') as { windowId: number }
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: visible ? { left: 80, top: 60 } : { left: -32000, top: -32000 } })
    await cdp.detach().catch(() => undefined)
  } catch {
    // Fensterlage ist Komfort, kein Grund, den Auftrag abzubrechen.
  }
}

export async function disconnect(): Promise<void> {
  try {
    await context?.close()
  } catch {
    // Verbindung war schon weg.
  }
  context = null
}
