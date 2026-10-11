import { z } from 'zod'
import type { PriceOffer } from '@shared/types'
import { defineTool, type ToolDefinition } from '../registry'
import { amazonSignedIn, detectBlock, findOrOpen, withPage } from '../../automation/chromeCdp'
import { extractPrice, parsePriceString } from '../../automation/priceParser'
import { domainOf, extractSources, friendlyGeminiError, generateWithFallback } from '../../providers/gemini'
import { getSettings } from '../../store/settings'

/**
 * Preisvergleich und Amazon-Warenkorb.
 *
 * Zur harten Grenze: James sucht, vergleicht, legt in den Warenkorb und
 * öffnet die Kasse. Er schließt keinen Kauf ab und gibt keine Zahlungsdaten
 * ein — nicht weil es technisch nicht ginge, sondern weil eine Fehlentscheidung
 * hier echtes Geld kostet und nicht rückgängig zu machen ist.
 */

const AMAZON = 'https://www.amazon.de'

// ─────────────────────────────────────────────────────────────
// Preisvergleich
// ─────────────────────────────────────────────────────────────

const findBestPrice = defineTool({
  name: 'find_best_price',
  group: 'shopping',
  description:
    'Sucht den günstigsten Preis für ein Produkt über mehrere Shops und Preisvergleiche. ' +
    'Nutze das für "was kostet X am günstigsten" oder "wo krieg ich X billig".',
  schema: z.object({
    product: z.string().describe('Das Produkt, so genau wie möglich benannt.'),
    maxResults: z.number().optional().describe('Wie viele Angebote, Standard fünf.')
  }),
  spokenHint: 'Ich vergleiche gerade die Preise.',
  async execute({ product, maxResults }) {
    // Nach unten begrenzen, nicht nur nach oben: `maxResults: 0` kommt vom
    // Modell durchaus vor, kam durch das Schema (eine Zahl ist es ja) und
    // ergab eine leere Angebotsliste, die wie "nichts gefunden" aussah.
    const limit = Math.min(10, Math.max(1, maxResults ?? 5))
    const settings = getSettings()

    // Zwei Wege parallel: Google-Grounding liefert die Marktübersicht,
    // Geizhals die belastbaren Zahlen für den DACH-Raum. Einzeln ist beides
    // lückenhaft — Grounding nennt oft veraltete Preise, Geizhals hat nicht
    // jeden Shop.
    const [grounded, geizhals] = await Promise.allSettled([
      generateWithFallback({
        model: settings.brainModel,
        contents:
          `Wo bekommt man "${product}" aktuell am günstigsten in Deutschland oder Österreich? ` +
          'Nenne konkrete Händler mit konkreten Preisen in Euro und sag, ob lieferbar.',
        config: {
          tools: [{ googleSearch: {} }],
          systemInstruction:
            'Antworte kurz und in ganzen Sätzen auf Deutsch. Nenne höchstens fünf Angebote mit ' +
            'Händlername und Preis. Keine Aufzählungszeichen, keine URLs im Text.'
        }
      }),
      scrapeGeizhals(product, limit)
    ])

    const offers: PriceOffer[] =
      geizhals.status === 'fulfilled' ? geizhals.value.slice(0, limit) : []

    const marketAnswer =
      grounded.status === 'fulfilled'
        ? grounded.value.text
        : 'Die Websuche hat gerade nichts geliefert.'

    const sources =
      grounded.status === 'fulfilled' ? extractSources(grounded.value).slice(0, 5).map(domainOf) : []

    if (offers.length === 0 && grounded.status === 'rejected') {
      throw new Error(friendlyGeminiError(grounded.reason))
    }

    return {
      marktübersicht: marketAnswer,
      quellen: sources,
      angebote: offers.map((o) => ({
        händler: o.vendor,
        preis: `${o.price.toFixed(2).replace('.', ',')} Euro`,
        versand: o.shipping !== null ? `${o.shipping.toFixed(2).replace('.', ',')} Euro` : 'unbekannt',
        gesamt: `${o.totalPrice.toFixed(2).replace('.', ',')} Euro`,
        verfügbarkeit: o.availability ?? 'unbekannt',
        url: o.url
      })),
      hinweis:
        offers.length > 0
          ? 'Nenne dem Nutzer die drei günstigsten mit Händler und Gesamtpreis. Lies keine Adressen vor.'
          : 'Fass die Marktübersicht in zwei Sätzen zusammen.'
    }
  }
}) as ToolDefinition

/**
 * Geizhals eignet sich für den DACH-Raum am besten: eine Ergebnisseite
 * enthält bereits Händler, Preis und Verfügbarkeit, ohne dass man jedes
 * Angebot einzeln öffnen muss.
 */
async function scrapeGeizhals(product: string, limit: number): Promise<PriceOffer[]> {
  const url = `https://geizhals.at/?fs=${encodeURIComponent(product)}&hloc=at&hloc=de`

  return withPage(url, async (page) => {
    const blocked = await detectBlock(page)
    if (blocked) return []

    await page.waitForSelector('.productlist__product, .cat__product', { timeout: 8000 }).catch(
      () => undefined
    )

    const rows = await page.evaluate((max) => {
      const items = document.querySelectorAll('.productlist__product, .cat__product')
      const out: { name: string; price: string; href: string }[] = []
      for (let i = 0; i < items.length && out.length < max; i++) {
        const item = items[i]
        const nameEl = item.querySelector('.productlist__link, a.cat__product-link, h3 a')
        const priceEl = item.querySelector('.productlist__price, .gh_price, [class*="price"]')
        const name = nameEl?.textContent?.trim()
        const price = priceEl?.textContent?.trim()
        const href = (nameEl as HTMLAnchorElement | null)?.href
        if (name && price) out.push({ name, price, href: href ?? '' })
      }
      return out
    }, limit)

    const offers: PriceOffer[] = []
    for (const row of rows) {
      const price = parsePriceString(row.price)
      if (!price) continue
      offers.push({
        vendor: 'Geizhals',
        productName: row.name.slice(0, 120),
        price,
        currency: 'EUR',
        shipping: null,
        totalPrice: price,
        availability: null,
        url: row.href
      })
    }
    return offers
    // Geizhals kann sperren oder das Markup ändern — dann liefert der zweite
    // Weg über die Websuche allein. Kein Grund, den ganzen Aufruf scheitern zu lassen.
  }).catch((): PriceOffer[] => [])
}

const checkPrice = defineTool({
  name: 'check_price',
  group: 'shopping',
  description: 'Liest den aktuellen Preis einer konkreten Produktseite.',
  schema: z.object({
    url: z.string().describe('Die Adresse der Produktseite.')
  }),
  async execute({ url }) {
    return withPage(url, async (page) => {
      const blocked = await detectBlock(page)
      if (blocked) throw new Error(blocked)

      const parsed = await extractPrice(page)
      if (!parsed) throw new Error('Auf der Seite finde ich keinen Preis.')

      return {
        produkt: parsed.productName ?? (await page.title()).slice(0, 120),
        preis: `${parsed.price.toFixed(2).replace('.', ',')} ${parsed.currency === 'EUR' ? 'Euro' : parsed.currency}`,
        verfügbarkeit: parsed.availability ?? 'unbekannt',
        shop: domainOf(url)
      }
    })
  }
}) as ToolDefinition

// ─────────────────────────────────────────────────────────────
// Amazon
// ─────────────────────────────────────────────────────────────

const amazonSearch = defineTool({
  name: 'amazon_search',
  group: 'shopping',
  description: 'Sucht ein Produkt bei Amazon und liefert die ersten Treffer mit Preis.',
  schema: z.object({
    query: z.string().describe('Der Suchbegriff.'),
    maxResults: z.number().optional().describe('Wie viele Treffer, Standard fünf.')
  }),
  async execute({ query, maxResults }) {
    const limit = Math.min(10, Math.max(1, maxResults ?? 5))
    const url = `${AMAZON}/s?k=${encodeURIComponent(query)}`

    return withPage(url, async (page) => {
      const blocked = await detectBlock(page)
      if (blocked) throw new Error(blocked)

      await page
        .waitForSelector('[data-component-type="s-search-result"]', { timeout: 10_000 })
        .catch(() => undefined)

      const results = await page.evaluate((max) => {
        const cards = document.querySelectorAll('[data-component-type="s-search-result"]')
        const out: { asin: string; title: string; price: string; rating: string }[] = []
        for (let i = 0; i < cards.length && out.length < max; i++) {
          const card = cards[i]
          const asin = card.getAttribute('data-asin') ?? ''
          // Gesponserte Treffer haben oft keinen brauchbaren Preis.
          const title = card.querySelector('h2 span, h2 a span')?.textContent?.trim() ?? ''
          const price = card.querySelector('.a-price .a-offscreen')?.textContent?.trim() ?? ''
          const rating = card.querySelector('[class*="a-icon-star"] span')?.textContent?.trim() ?? ''
          if (asin && title && price) out.push({ asin, title, price, rating })
        }
        return out
      }, limit)

      if (results.length === 0) {
        throw new Error('Amazon hat zu dieser Suche nichts Brauchbares geliefert.')
      }

      return {
        treffer: results.map((r) => ({
          asin: r.asin,
          titel: r.title.slice(0, 110),
          preis: r.price,
          bewertung: r.rating || 'keine',
          url: `${AMAZON}/dp/${r.asin}`
        }))
      }
    })
  }
}) as ToolDefinition

const cartView = defineTool({
  name: 'amazon_cart_view',
  group: 'shopping',
  description: 'Liest, was gerade im Amazon-Warenkorb liegt, mit Einzelpreisen und Summe.',
  schema: z.object({}),
  async execute() {
    const page = await findOrOpen('amazon.de/gp/cart', `${AMAZON}/gp/cart/view.html`)
    await page.goto(`${AMAZON}/gp/cart/view.html`, { waitUntil: 'domcontentloaded' })

    const blocked = await detectBlock(page)
    if (blocked) throw new Error(blocked)

    const cart = await page.evaluate(() => {
      const items: { titel: string; preis: string; menge: string }[] = []
      const rows = document.querySelectorAll('[data-name="Active Items"] [data-asin], .sc-list-item')
      rows.forEach((row) => {
        const titel = row.querySelector('.sc-product-title, .a-truncate-full')?.textContent?.trim()
        const preis = row.querySelector('.sc-product-price, .sc-price')?.textContent?.trim()
        const menge =
          (row.querySelector('select.a-native-dropdown') as HTMLSelectElement | null)?.value ??
          row.querySelector('.sc-quantity-textfield')?.textContent?.trim() ??
          '1'
        if (titel) items.push({ titel: titel.slice(0, 100), preis: preis ?? '?', menge })
      })

      const summe =
        document.querySelector('#sc-subtotal-amount-activecart, #sc-subtotal-amount-buybox')
          ?.textContent?.trim() ?? null

      return { items, summe }
    })

    if (cart.items.length === 0) {
      // Ohne Anmeldung zeigt Amazon den leeren Gast-Warenkorb. "Dein Warenkorb
      // ist leer" wäre dann eine falsche Auskunft über den richtigen Korb.
      if ((await amazonSignedIn(page)) === false) {
        throw new Error(
          'Im James-Browser bist du bei Amazon nicht angemeldet — ich sehe deshalb nur einen ' +
            'leeren Gast-Warenkorb. Unter Einstellungen, Verbindungen gibt es einen Knopf zum Anmelden.'
        )
      }
      return { leer: true, note: 'Der Warenkorb ist leer.' }
    }

    return {
      artikel: cart.items,
      summe: cart.summe ?? 'unbekannt',
      hinweis: 'Nenne dem Nutzer die Artikel und die Summe, keine Adressen.'
    }
  }
}) as ToolDefinition

const cartAdd = defineTool({
  name: 'amazon_cart_add',
  group: 'shopping',
  description:
    'Legt ein Produkt in den Amazon-Warenkorb. Vorher mit amazon_search die Kennung heraussuchen. ' +
    'Gekauft wird nichts — das macht der Nutzer selbst.',
  schema: z.object({
    asin: z.string().describe('Die Amazon-Produktkennung, zehn Zeichen.'),
    productName: z.string().describe('Wie das Produkt heißt, für die Rückfrage.'),
    quantity: z.number().optional().describe('Stückzahl, Standard eins.')
  }),
  alwaysAsk: true,
  async execute({ asin, productName, quantity }) {
    const page = await findOrOpen(`dp/${asin}`, `${AMAZON}/dp/${asin}`)
    await page.goto(`${AMAZON}/dp/${asin}`, { waitUntil: 'domcontentloaded' })

    const blocked = await detectBlock(page)
    if (blocked) throw new Error(blocked)

    if (quantity && quantity > 1) {
      const select = page.locator('#quantity')
      if ((await select.count()) > 0) {
        await select.selectOption(String(Math.min(10, quantity))).catch(() => undefined)
      }
    }

    // Der Warenkorb-Knopf hat je nach Seitenvariante unterschiedliche
    // Kennungen — deshalb mehrere Kandidaten der Reihe nach.
    const buttons = ['#add-to-cart-button', 'input[name="submit.add-to-cart"]', '#submit\\.add-to-cart']
    let clicked = false
    for (const selector of buttons) {
      const locator = page.locator(selector)
      if ((await locator.count()) > 0) {
        await locator.first().click({ timeout: 8000 })
        clicked = true
        break
      }
    }

    if (!clicked) {
      throw new Error(
        'Auf der Produktseite gibt es keinen Warenkorb-Knopf. Vielleicht ist es nicht lieferbar.'
      )
    }

    await page.waitForLoadState('domcontentloaded', { timeout: 12_000 }).catch(() => undefined)

    return {
      hinzugefügt: productName,
      menge: quantity ?? 1,
      hinweis: 'Sag dem Nutzer kurz, dass es im Warenkorb liegt. Gekauft ist noch nichts.'
    }
  }
}) as ToolDefinition

const cartRemove = defineTool({
  name: 'amazon_cart_remove',
  group: 'shopping',
  description: 'Nimmt einen Artikel aus dem Amazon-Warenkorb.',
  schema: z.object({
    productName: z.string().describe('Teil des Produktnamens, wie er im Warenkorb steht.')
  }),
  alwaysAsk: true,
  async execute({ productName }) {
    const page = await findOrOpen('amazon.de/gp/cart', `${AMAZON}/gp/cart/view.html`)
    await page.goto(`${AMAZON}/gp/cart/view.html`, { waitUntil: 'domcontentloaded' })

    const blocked = await detectBlock(page)
    if (blocked) throw new Error(blocked)

    const removed = await page.evaluate((needle) => {
      const rows = Array.from(document.querySelectorAll('.sc-list-item, [data-asin]'))
      for (const row of rows) {
        const title = row.querySelector('.sc-product-title, .a-truncate-full')?.textContent ?? ''
        if (title.toLowerCase().includes(needle.toLowerCase())) {
          const button = row.querySelector(
            '[value="Löschen"], [data-action="delete"], input[name*="submit.delete"]'
          ) as HTMLElement | null
          if (button) {
            button.click()
            return title.trim().slice(0, 100)
          }
        }
      }
      return null
    }, productName)

    if (!removed) throw new Error(`Im Warenkorb finde ich nichts, das auf "${productName}" passt.`)

    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined)
    return { entfernt: removed }
  }
}) as ToolDefinition

const openCheckout = defineTool({
  name: 'amazon_open_checkout',
  group: 'shopping',
  description:
    'Öffnet die Amazon-Kasse im Browser, damit der Nutzer selbst bestellen kann. ' +
    'James schließt den Kauf nicht ab.',
  schema: z.object({}),
  alwaysAsk: true,
  async execute() {
    const page = await findOrOpen('amazon.de/gp/cart', `${AMAZON}/gp/cart/view.html`)
    await page.goto(`${AMAZON}/gp/cart/view.html`, { waitUntil: 'domcontentloaded' })
    await page.bringToFront()

    return {
      geöffnet: 'Warenkorb',
      hinweis:
        'Sag dem Nutzer, dass der Warenkorb offen ist und er den Kauf selbst abschließen muss. ' +
        'Du drückst grundsätzlich keinen Bestellknopf.'
    }
  }
}) as ToolDefinition

export const shoppingTools: ToolDefinition[] = [
  findBestPrice,
  checkPrice,
  amazonSearch,
  cartView,
  cartAdd,
  cartRemove,
  openCheckout
]
