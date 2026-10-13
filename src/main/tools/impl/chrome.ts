import { websiteAccounts, websiteAccount } from '../../secrets/keystore'
import { performWebsiteLogin } from '../../automation/websiteLogin'
import type { Page } from 'playwright-core'
import { z } from 'zod'
import { defineTool, type ToolDefinition, type ToolContext } from '../registry'
import { detectBlock, getContext, openPage, activePage, selectActivePage, setWindowVisible } from '../../automation/chromeCdp'

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

/**
 * Der Browser läuft unsichtbar. Nur wenn der Nutzer selbst etwas tun muss,
 * kommt das Fenster mit genau diesem Tab nach vorne — sonst sieht er nur die
 * Statuszeile.
 */
function showBrowserHandoff(page: Page, message: string, toolContext: ToolContext): void {
  const domain = new URL(page.url()).hostname
  void page.bringToFront().catch(() => undefined)
  void setWindowVisible(page, true)
  toolContext.show({ kind: 'browser-handoff', id: `browser-handoff:${domain}`, query: 'Bitte im Browser übernehmen', domain, message,
    actions: [{ type: 'ask', label: 'Ich bin fertig – prüfen', prompt: `Ich habe meinen Schritt im James-Browser für ${domain} erledigt. Hole genau diesen Tab nach vorne, lies seinen aktuellen Zustand und setze meinen bisherigen Auftrag fort, falls die Anmeldung oder Sicherheitsprüfung erledigt ist. Behaupte keine erfolgreiche Anmeldung ohne erkennbaren Nachweis.` }] })
}
function savedAccountFor(page: Page): boolean {
  try { return Boolean(websiteAccount(new URL(page.url()).origin)) } catch { return false }
}
async function requireUserIfBlocked(page: Page, toolContext: ToolContext): Promise<string | null> {
  const blocked = await detectBlock(page)
  if (!blocked) { void setWindowVisible(page, false); return null }
  selectActivePage(page)
  // Mit gespeichertem Konto meldet website_login an, ohne dass der Nutzer etwas sieht.
  if (/Anmeldung/.test(blocked) && savedAccountFor(page)) return `Die Seite verlangt eine Anmeldung. Für ${new URL(page.url()).hostname} ist ein Konto gespeichert: zuerst website_login aufrufen, danach weitermachen.`
  showBrowserHandoff(page, blocked, toolContext)
  return blocked
}

const signingIn = new Set<string>()
const loginAccount = defineTool({
  name: 'website_login', group: 'chrome',
  description: 'Meldet den Nutzer auf ausdrücklichen Auftrag mit einem in Einstellungen → Zugänge gespeicherten Website-Konto an. Schema enthält nur die Website, niemals Benutzername oder Passwort. Standard-Anmeldeformulare werden direkt bedient; CAPTCHA und Zwei-Faktor-Prüfungen bleiben beim Nutzer. submitted bedeutet nur abgesendet, nicht erfolgreich angemeldet: danach chrome_read_page prüfen. rejected heißt: Die Website hat die Daten abgelehnt — nicht erneut versuchen, sondern dem Nutzer sagen.',
  schema: z.object({ site: z.string().describe('HTTPS-Website des gespeicherten Kontos, z. B. https://example.com') }),
  async execute({ site }, toolContext) {
    const account = websiteAccount(site)
    if (!account) return { status: 'needs-user', reason: 'Für diese Website ist kein Konto gespeichert. Bitte unter Einstellungen → Zugänge → Website-Konten eintragen. Keine Passwörter im Gespräch nennen.' }
    const origin = new URL(account.loginUrl).origin
    if (signingIn.has(origin)) return { status: 'needs-user', reason: 'Für diese Website läuft bereits eine Anmeldung.' }
    signingIn.add(origin)
    try {
      toolContext.signal.throwIfAborted()
      const page = await openPage(account.loginUrl)
      await page.bringToFront(); selectActivePage(page)
      const result = await performWebsiteLogin(page, account, toolContext.signal)
      if (result.status === 'needs-user') showBrowserHandoff(page, result.reason ?? 'Bitte im Browser übernehmen.', toolContext)
      return { ...result, website: new URL(origin).hostname, hinweis: 'Anmeldung erst anhand des aktuellen Seitenzustands bestätigen.' }
    } catch { return { status: 'needs-user', reason: 'Die Anmeldung konnte nicht gestartet werden. Bitte im Browser übernehmen.' } }
    finally { signingIn.delete(origin) }
  }
}) as ToolDefinition
const listAccounts = defineTool({ name: 'website_accounts', group: 'chrome', description: 'Listet Websites mit gespeicherten Konten. Liefert keine Benutzernamen oder Passwörter.', schema: z.object({}), async execute() { return websiteAccounts().map(a => ({ website: a.origin })) } }) as ToolDefinition

const prepareLogin = defineTool({
  name: 'chrome_prepare_login', group: 'chrome',
  description: 'Öffnet eine Website zur Anmeldung im James-Browser. Nutzt vorhandene Sitzungen. Passwörter, Einmalcodes und menschliche Sicherheitsprüfungen erledigt der Nutzer selbst; dafür erscheint eine Karte. Nach dem Nutzer-Schritt den Tab gezielt nach vorne holen und mit chrome_read_page prüfen.',
  schema: z.object({ url: z.string().url().describe('HTTPS-Adresse der gewünschten Website oder Anmeldeseite') }),
  async execute({ url }, toolContext) {
    const target = new URL(url)
    if (target.protocol !== 'https:' || target.username || target.password) throw new Error('Bitte eine HTTPS-Adresse ohne Zugangsdaten in der URL angeben.')
    const page = await openPage(target.toString())
    await page.bringToFront(); selectActivePage(page)
    const blocked = await requireUserIfBlocked(page, toolContext)
    const passwordVisible = await page.locator('input[type="password"]').first().isVisible().catch(() => false)
    if (blocked || passwordVisible) {
      const reason = blocked ?? 'Bitte melde dich selbst im James-Browser an. Passwort und gegebenenfalls Einmalcode bleiben bei dir.'
      if (!blocked) showBrowserHandoff(page, reason, toolContext)
      return { status: 'needs-user', reason, weiter: 'Warte auf den Nutzer. Danach genau diesen Tab nach vorne holen und seinen Zustand neu lesen.' }
    }
    return { geöffnet: await page.title(), adresse: page.url(), hinweis: 'Die Seite ist geöffnet. Ob du bereits angemeldet bist, muss anhand des Seiteninhalts geprüft werden.' }
  }
}) as ToolDefinition

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
    await page.bringToFront(); selectActivePage(page)
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
  async execute({ url, maxChars }, toolContext) {
    const limit = Math.min(20_000, Math.max(200, maxChars ?? 8000))

    let page
    if (url) {
      page = await openPage(url)
    } else {
      page = await activePage()
      if (!page) throw new Error('Chrome hat keinen offenen Tab.')
    }

    const blocked = await requireUserIfBlocked(page, toolContext)
    if (blocked) return { status: 'needs-user', reason: blocked, weiter: 'Warte auf den Nutzer. Danach diesen Tab erneut prüfen.' }

    const text = await page.evaluate(() => {
      // Read without modifying the page; account/navigation cues are needed after a login.
      return document.body.innerText.replace(/\n{3,}/g, '\n\n').trim()
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
  async execute({ text, exact }, toolContext) {
    const page = await activePage()
    if (!page) throw new Error('Chrome hat keinen offenen Tab.')

    const blocked = await requireUserIfBlocked(page, toolContext)
    if (blocked) return { status: 'needs-user', reason: blocked }

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
  async execute({ field, value, submit }, toolContext) {
    // Zugangs- und Zahlungsdaten trägt James grundsätzlich nicht ein.
    if (/passwor[dt]|kennwort|kartennummer|card|cvv|cvc|iban|pin/i.test(field)) {
      throw new Error(
        'In Passwort- und Zahlungsfelder trage ich nichts ein. Das musst du selbst machen.'
      )
    }

    const page = await activePage()
    if (!page) throw new Error('Chrome hat keinen offenen Tab.')

    const blocked = await requireUserIfBlocked(page, toolContext)
    if (blocked) return { status: 'needs-user', reason: blocked }

    const candidates = [
      page.getByLabel(field, { exact: false }),
      page.getByPlaceholder(field, { exact: false }),
      page.locator(`input[name*="${field}" i], textarea[name*="${field}" i]`)
    ]

    for (const locator of candidates) {
      const count = await locator.count().catch(() => 0)
      if (count > 0) {
        const sensitive = await locator.first().evaluate(e => e instanceof HTMLInputElement && (e.type === 'password' || /password|one-time-code|cc-number|cc-csc/i.test(e.autocomplete)))
        if (sensitive) throw new Error('Dieses Feld enthält Zugangsdaten oder einen Sicherheitscode. Bitte selbst im Browser ausfüllen.')
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
        await page.bringToFront(); selectActivePage(page)
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
    await page.bringToFront(); selectActivePage(page)
    return { aktiv: await page.title() }
  }
}) as ToolDefinition

/**
 * Bedienelemente mit Nummern statt Rätselraten über Beschriftungen.
 *
 * chrome_click trifft bei „Weiter" auf Seiten mit fünf solchen Knöpfen oft den
 * falschen. Hier bekommt jedes sichtbare Element eine Nummer, und
 * chrome_interact spricht genau diese an.
 */
const listElements = defineTool({
  name: 'chrome_elements',
  group: 'chrome',
  description: 'Listet die sichtbaren Bedienelemente des aktiven Tabs (Knöpfe, Links, Felder, Auswahllisten, Häkchen) mit Nummer. Danach mit chrome_interact über die Nummer bedienen.',
  schema: z.object({ filter: z.string().optional().describe('Nur Elemente, deren Text diesen Teil enthält.') }),
  async execute({ filter }, toolContext) {
    const page = await activePage()
    if (!page) throw new Error('Chrome hat keinen offenen Tab.')
    const blocked = await requireUserIfBlocked(page, toolContext)
    if (blocked) return { status: 'needs-user', reason: blocked }
    const elements = await page.evaluate((needle) => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>('a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [role=option], [contenteditable=true]'))
      const out: { ref: number; art: string; text: string; wert?: string }[] = []
      let ref = 0
      for (const el of nodes) {
        el.removeAttribute('data-james-ref')
        const r = el.getBoundingClientRect(), style = getComputedStyle(el)
        if (r.width < 2 || r.height < 2 || style.visibility === 'hidden' || style.display === 'none') continue
        const input = el as HTMLInputElement
        const label = (el.getAttribute('aria-label') || (input.labels?.[0]?.innerText) || el.innerText || input.placeholder || el.getAttribute('title') || input.name || '').replace(/\s+/g, ' ').trim().slice(0, 80)
        if (needle && !label.toLowerCase().includes(needle.toLowerCase())) continue
        ref++
        el.setAttribute('data-james-ref', String(ref))
        const art = el.tagName === 'INPUT' ? `feld:${input.type}` : el.tagName === 'SELECT' ? 'auswahl' : el.tagName === 'TEXTAREA' ? 'textfeld' : el.tagName === 'A' ? 'link' : el.getAttribute('role') ?? 'knopf'
        const sensitive = input.type === 'password' || /cc-|one-time-code/.test(input.autocomplete ?? '')
        out.push({ ref, art, text: label, ...(el.tagName === 'INPUT' && !sensitive && input.type !== 'checkbox' && input.value ? { wert: input.value.slice(0, 60) } : {}), ...(input.type === 'checkbox' || input.type === 'radio' ? { wert: input.checked ? 'an' : 'aus' } : {}) })
        if (ref >= 150) break
      }
      return out
    }, filter ?? '')
    return { seite: await page.title(), adresse: page.url(), elemente: elements }
  }
}) as ToolDefinition

const interact = defineTool({
  name: 'chrome_interact',
  group: 'chrome',
  description: 'Bedient ein Element aus chrome_elements über seine Nummer: klicken, Text eintragen, Auswahl setzen, Häkchen setzen oder eine Taste drücken (z. B. Enter, Escape, Tab). In Passwort- und Zahlungsfelder wird nichts eingetragen; Anmeldungen laufen über website_login.',
  schema: z.object({
    ref: z.number().int().describe('Nummer aus chrome_elements.'),
    action: z.enum(['click', 'fill', 'select', 'check', 'uncheck', 'press', 'hover']),
    value: z.string().optional().describe('Text für fill, Option für select, Taste für press.')
  }),
  async execute({ ref, action, value }, toolContext) {
    const page = await activePage()
    if (!page) throw new Error('Chrome hat keinen offenen Tab.')
    const blocked = await requireUserIfBlocked(page, toolContext)
    if (blocked) return { status: 'needs-user', reason: blocked }
    const el = page.locator(`[data-james-ref="${ref}"]`).first()
    if (!(await el.count())) throw new Error(`Element ${ref} gibt es nicht mehr. Erst chrome_elements erneut aufrufen.`)
    if (action === 'fill') {
      const sensitive = await el.evaluate(e => e instanceof HTMLInputElement && (e.type === 'password' || /password|one-time-code|cc-/i.test(e.autocomplete)))
      if (sensitive) throw new Error('Dieses Feld enthält Zugangs- oder Zahlungsdaten. Anmeldungen laufen über website_login, alles andere bitte selbst eintragen.')
    }
    const opts = { timeout: 8000 }
    const before = page.url()
    if (action === 'click') await el.click(opts)
    else if (action === 'fill') await el.fill(value ?? '', opts)
    else if (action === 'select') await el.selectOption({ label: value ?? '' }, opts).catch(() => el.selectOption(value ?? '', opts))
    else if (action === 'check') await el.check(opts)
    else if (action === 'uncheck') await el.uncheck(opts)
    else if (action === 'hover') await el.hover(opts)
    else await el.press(value || 'Enter', opts)
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined)
    const after = await detectBlock(page)
    if (after) { showBrowserHandoff(page, after, toolContext); return { status: 'needs-user', reason: after } }
    return { erledigt: action, element: ref, seite: await page.title(), seiteGewechselt: page.url() !== before, hinweis: 'Nummern gelten nach Seitenwechsel nicht mehr.' }
  }
}) as ToolDefinition

const navigate = defineTool({
  name: 'chrome_navigate',
  group: 'chrome',
  description: 'Steuert den aktiven Tab: zu einer Adresse gehen, zurück, vorwärts, neu laden oder scrollen.',
  schema: z.object({
    action: z.enum(['goto', 'back', 'forward', 'reload', 'scroll_down', 'scroll_up']),
    url: z.string().optional().describe('Nur für goto.')
  }),
  async execute({ action, url }, toolContext) {
    const page = await activePage()
    if (!page) throw new Error('Chrome hat keinen offenen Tab.')
    const opts = { waitUntil: 'domcontentloaded' as const, timeout: 30_000 }
    if (action === 'goto') {
      if (!url) throw new Error('Für goto fehlt die Adresse.')
      await page.goto(/^https?:\/\//i.test(url) ? url : `https://${url}`, opts)
    } else if (action === 'back') await page.goBack(opts)
    else if (action === 'forward') await page.goForward(opts)
    else if (action === 'reload') await page.reload(opts)
    else await page.mouse.wheel(0, action === 'scroll_down' ? 800 : -800)
    const blocked = await requireUserIfBlocked(page, toolContext)
    if (blocked) return { status: 'needs-user', reason: blocked }
    return { seite: await page.title(), adresse: page.url() }
  }
}) as ToolDefinition

const waitFor = defineTool({
  name: 'chrome_wait_for',
  group: 'chrome',
  description: 'Wartet im aktiven Tab, bis ein Text erscheint (oder verschwindet), etwa nach dem Absenden eines Formulars oder beim Nachladen von Ergebnissen. Höchstens 30 Sekunden.',
  schema: z.object({
    text: z.string().describe('Text, auf den gewartet wird.'),
    gone: z.boolean().optional().describe('true: warten, bis der Text verschwunden ist.'),
    seconds: z.number().optional().describe('Höchstwartezeit, Standard 10.')
  }),
  async execute({ text, gone, seconds }, toolContext) {
    const page = await activePage()
    if (!page) throw new Error('Chrome hat keinen offenen Tab.')
    const timeout = Math.min(30, Math.max(1, seconds ?? 10)) * 1000
    const ok = await page.getByText(text, { exact: false }).first().waitFor({ state: gone ? 'hidden' : 'visible', timeout }).then(() => true, () => false)
    const blocked = await requireUserIfBlocked(page, toolContext)
    if (blocked) return { status: 'needs-user', reason: blocked }
    return { erfüllt: ok, seite: await page.title() }
  }
}) as ToolDefinition

const closeTab = defineTool({
  name: 'chrome_close_tab',
  group: 'chrome',
  description: 'Schließt den aktiven Tab oder den Tab, dessen Titel oder Adresse passt. Hält den unsichtbaren Browser aufgeräumt.',
  schema: z.object({ match: z.string().optional().describe('Teil von Titel oder Adresse; ohne Angabe der aktive Tab.') }),
  async execute({ match }) {
    const pages = (await getContext()).pages()
    let target: Page | null = null
    if (match) {
      const needle = match.toLowerCase()
      for (const p of pages) if (p.url().toLowerCase().includes(needle) || (await p.title().catch(() => '')).toLowerCase().includes(needle)) { target = p; break }
    } else target = await activePage()
    if (!target) throw new Error('Kein passender Tab offen.')
    // Den letzten Tab nicht schließen, sonst beendet sich der Browser samt Sitzung.
    if (pages.length <= 1) { await target.goto('about:blank').catch(() => undefined); return { geleert: true } }
    const title = await target.title().catch(() => '')
    await target.close()
    return { geschlossen: title }
  }
}) as ToolDefinition

export const chromeTools: ToolDefinition[] = [
  waitFor,
  closeTab,
  listElements,
  interact,
  navigate,
  loginAccount,
  listAccounts,
  prepareLogin,
  openTab,
  readPage,
  clickElement,
  fillField,
  listTabs,
  switchTab
]
