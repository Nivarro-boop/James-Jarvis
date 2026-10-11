import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { detectBlock, getContext, openPage } from '../../automation/chromeCdp'

/**
 * Browsersteuerung über den James-Chrome.
 *
 * Nicht das Chrome des Nutzers: seit Chrome 136 lässt sich der Debug-Zugang
 * auf dem Standardprofil nicht mehr öffnen, deshalb hat James ein eigenes
 * Profil (siehe automation/chromeCdp.ts). Die Beschreibungen unten sagen das
 * auch so — behauptet ein Werkzeug, alle Anmeldungen seien schon da, erzählt
 * James dem Nutzer genau das, und der sucht den Fehler an der falschen Stelle.
 *
 * Gearbeitet wird über den Barrierefreiheits-Baum und Textinhalte, nicht über
 * Pixelkoordinaten. Das ist erheblich robuster als die Bildschirmsteuerung und
 * kostet keine Modellaufrufe pro Klick.
 */

const openTab = defineTool({
  name: 'chrome_open_tab',
  group: 'chrome',
  description:
    'Öffnet eine Adresse in einem neuen Tab des James-Browsers. Das ist ein eigenes ' +
    'Chrome-Profil neben dem des Nutzers — dort einmal angemeldete Seiten bleiben angemeldet.',
  schema: z.object({
    url: z.string().describe('Vollständige Adresse.')
  }),
  async execute({ url }) {
    const target = /^https?:\/\//i.test(url) ? url : `https://${url}`
    const page = await openPage(target)
    await page.bringToFront()
    return { geöffnet: await page.title(), adresse: page.url() }
  }
}) as ToolDefinition

const readPage = defineTool({
  name: 'chrome_read_page',
  group: 'chrome',
  description:
    'Liest den sichtbaren Text einer Seite. Ohne Adresse wird der gerade aktive Tab gelesen. ' +
    'Nutze das für Seiten hinter einer Anmeldung, die eine normale Websuche nicht sieht.',
  schema: z.object({
    url: z.string().optional().describe('Adresse. Ohne Angabe der aktive Tab.'),
    maxChars: z.number().optional().describe('Wie viel Text höchstens, Standard achttausend.')
  }),
  async execute({ url, maxChars }) {
    const limit = Math.min(20_000, Math.max(200, maxChars ?? 8000))

    let page
    if (url) {
      page = await openPage(url)
    } else {
      const ctx = await getContext()
      const pages = ctx.pages()
      page = pages[pages.length - 1]
      if (!page) throw new Error('Chrome hat keinen offenen Tab.')
    }

    const blocked = await detectBlock(page)
    if (blocked) throw new Error(blocked)

    const text = await page.evaluate(() => {
      // Navigation, Fußzeilen und Skripte rauswerfen — sie machen den
      // größten Teil aus und tragen inhaltlich nichts bei.
      const junk = document.querySelectorAll('script, style, nav, footer, aside, noscript, svg')
      junk.forEach((n) => n.remove())
      const main = document.querySelector('main, article, [role="main"]') ?? document.body
      return (main as HTMLElement).innerText.replace(/\n{3,}/g, '\n\n').trim()
    })

    return {
      titel: await page.title(),
      inhalt: text.slice(0, limit),
      gekürzt: text.length > limit
    }
  }
}) as ToolDefinition

const clickElement = defineTool({
  name: 'chrome_click',
  group: 'chrome',
  description:
    'Klickt auf ein Element im aktiven Tab, gefunden über seinen sichtbaren Text.',
  schema: z.object({
    text: z.string().describe('Die Beschriftung des Knopfes oder Links.'),
    exact: z.boolean().optional().describe('Ob der Text genau stimmen muss.')
  }),
  async execute({ text, exact }) {
    const ctx = await getContext()
    const pages = ctx.pages()
    const page = pages[pages.length - 1]
    if (!page) throw new Error('Chrome hat keinen offenen Tab.')

    // Rollenbasiert suchen: das trifft Knöpfe und Links zuverlässiger als
    // ein reiner Textvergleich, der auch Fließtext erwischt.
    const candidates = [
      page.getByRole('button', { name: text, exact: exact ?? false }),
      page.getByRole('link', { name: text, exact: exact ?? false }),
      page.getByText(text, { exact: exact ?? false })
    ]

    for (const locator of candidates) {
      const count = await locator.count().catch(() => 0)
      if (count > 0) {
        await locator.first().click({ timeout: 8000 })
        await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined)
        return { geklickt: text, seite: await page.title() }
      }
    }

    throw new Error(`Ich finde nichts Anklickbares mit dem Text "${text}".`)
  }
}) as ToolDefinition

const fillField = defineTool({
  name: 'chrome_fill',
  group: 'chrome',
  description:
    'Trägt Text in ein Eingabefeld im aktiven Tab ein, gefunden über Beschriftung oder Platzhalter.',
  schema: z.object({
    field: z.string().describe('Beschriftung oder Platzhalter des Feldes.'),
    value: z.string().describe('Was eingetragen werden soll.'),
    submit: z.boolean().optional().describe('Ob danach Enter gedrückt wird.')
  }),
  async execute({ field, value, submit }) {
    // Zugangs- und Zahlungsdaten trägt James grundsätzlich nicht ein.
    if (/passwor[dt]|kennwort|kartennummer|card|cvv|cvc|iban|pin/i.test(field)) {
      throw new Error(
        'In Passwort- und Zahlungsfelder trage ich nichts ein. Das musst du selbst machen.'
      )
    }

    const ctx = await getContext()
    const pages = ctx.pages()
    const page = pages[pages.length - 1]
    if (!page) throw new Error('Chrome hat keinen offenen Tab.')

    const candidates = [
      page.getByLabel(field, { exact: false }),
      page.getByPlaceholder(field, { exact: false }),
      page.locator(`input[name*="${field}" i], textarea[name*="${field}" i]`)
    ]

    for (const locator of candidates) {
      const count = await locator.count().catch(() => 0)
      if (count > 0) {
        await locator.first().fill(value, { timeout: 8000 })
        if (submit) {
          await locator.first().press('Enter')
          await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined)
        }
        return { eingetragen: field }
      }
    }

    throw new Error(`Ich finde kein Eingabefeld für "${field}".`)
  }
}) as ToolDefinition

const listTabs = defineTool({
  name: 'chrome_list_tabs',
  group: 'chrome',
  description: 'Zählt auf, welche Tabs gerade in Chrome offen sind.',
  schema: z.object({}),
  async execute() {
    const ctx = await getContext()
    const pages = ctx.pages()
    const tabs = await Promise.all(
      pages.map(async (p) => ({
        titel: (await p.title().catch(() => '')).slice(0, 70),
        seite: new URL(p.url()).hostname.replace(/^www\./, '')
      }))
    )
    return { anzahl: tabs.length, tabs }
  }
}) as ToolDefinition

const switchTab = defineTool({
  name: 'chrome_switch_tab',
  group: 'chrome',
  description: 'Holt einen bereits offenen Tab nach vorn, gefunden über Titel oder Adresse.',
  schema: z.object({
    match: z.string().describe('Teil des Titels oder der Adresse.')
  }),
  async execute({ match }) {
    const ctx = await getContext()
    const needle = match.toLowerCase().trim()

    // Auch über den Titel suchen, nicht nur über die Adresse: gesprochen kommt
    // "geh auf den Warenkorb" an, nicht "amazon.de/gp/cart".
    for (const page of ctx.pages()) {
      const title = (await page.title().catch(() => '')).toLowerCase()
      if (page.url().toLowerCase().includes(needle) || title.includes(needle)) {
        await page.bringToFront()
        return { aktiv: await page.title() }
      }
    }

    // Nichts offen. Nur wenn der Suchbegriff nach einer Adresse aussieht, wird
    // daraus eine — `https://gmail` wäre sonst der sichere Weg in einen
    // Navigationsfehler statt in eine brauchbare Antwort.
    if (!/^[\w-]+(\.[\w-]+)+/.test(needle)) {
      throw new Error(
        `Es ist kein Tab offen, der auf "${match}" passt. Nenne eine vollständige Adresse ` +
          'oder nimm chrome_open_tab.'
      )
    }

    const page = await openPage(`https://${needle}`)
    await page.bringToFront()
    return { aktiv: await page.title() }
  }
}) as ToolDefinition

export const chromeTools: ToolDefinition[] = [
  openTab,
  readPage,
  clickElement,
  fillField,
  listTabs,
  switchTab
]
