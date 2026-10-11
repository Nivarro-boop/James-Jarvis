import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserContext, Page } from 'playwright-core'

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
        args: ['--no-first-run', '--no-default-browser-check'],
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
export async function openPage(url: string): Promise<Page> {
  const ctx = await getContext()
  const page = await ctx.newPage()
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    return page
  } catch (err) {
    // Der Aufrufer bekommt bei einem Navigationsfehler nie einen Verweis auf
    // den gerade erzeugten Tab und kann ihn deshalb auch nicht schließen.
    // Netzfehler sammelten so bei jedem Versuch einen leeren Renderer an.
    await page.close().catch(() => undefined)
    throw err
  }
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
export async function detectBlock(page: Page): Promise<string | null> {
  const url = page.url()
  if (url.includes('/errors/validateCaptcha') || url.includes('/ap/signin')) {
    return url.includes('signin')
      ? 'Amazon verlangt eine Anmeldung. Melde dich einmal im James-Browser an — unter ' +
          'Einstellungen, Verbindungen gibt es dafür einen Knopf. Danach geht es dauerhaft.'
      : 'Amazon zeigt eine Sicherheitsabfrage. Die musst du im Browser selbst lösen.'
  }
  const title = (await page.title().catch(() => '')) || ''
  if (/robot|captcha|sicherheitsabfrage/i.test(title)) {
    return 'Die Seite zeigt eine Sicherheitsabfrage. Die musst du im Browser selbst lösen.'
  }
  return null
}

export async function disconnect(): Promise<void> {
  try {
    await context?.close()
  } catch {
    // Verbindung war schon weg.
  }
  context = null
}
