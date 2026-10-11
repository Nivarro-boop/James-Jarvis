import type { Page } from 'playwright-core'

/**
 * Preise aus Shop-Seiten lesen.
 *
 * Bewusst dreistufig, von robust nach fragil:
 *
 *   1. JSON-LD (`schema.org/Offer`). Fast alle Shops liefern das für
 *      Suchmaschinen aus, und es ist maschinenlesbar und stabil.
 *   2. Meta-Tags von OpenGraph und Microdata.
 *   3. CSS-Selektoren pro Shop.
 *
 * Auf Stufe 3 allein zu setzen wäre der übliche Fehler: Shops ändern ihr
 * Markup ständig, und dann liefert der Preiswächter stillschweigend nichts
 * mehr. Die ersten beiden Stufen überleben Redesigns.
 */

export interface ParsedPrice {
  price: number
  currency: string
  productName: string | null
  availability: string | null
  source: 'json-ld' | 'meta' | 'selector'
}

/**
 * Zuerst die Zahl finden, dann erst lesen.
 *
 * Hier stand `raw.replace(/[^\d.,]/g, '')` — alles wegwerfen, was keine Ziffer
 * und kein Trennzeichen ist. Das ist genau dann richtig, wenn im Text nichts
 * weiter steht als der Preis, und in einem Preisfeld eines Shops steht fast nie
 * nichts weiter. Drei Beispiele, alle drei aus dem Alltag:
 *
 *   "12,99 € zzgl. Versand"   Der Punkt hinter "zzgl" überlebt das Wegwerfen.
 *                             Übrig bleibt "12,99." — und weil nun der Punkt
 *                             hinter dem Komma steht, gilt das Komma als
 *                             Tausenderpunkt: 1299 statt 12,99.
 *   "1.299,00 € inkl. MwSt."  Dasselbe Spiel andersherum: 1,299 statt 1299.
 *   "ab 4,99 € statt 9,99 €"  Beide Preise werden zu einer Zahl verklebt.
 *
 * Es sind nicht drei Sonderfälle, sondern derselbe: Ein Text ist keine Zahl.
 * Deshalb werden jetzt erst alle Zahlen im Text gesucht, und dann wird eine
 * davon ausgewählt.
 *
 * Warum das nicht bloß eine schiefe Auskunft ist, steht unten bei
 * `normalizeSingleSeparator`: Der Preiswächter schlägt einmal falsch Alarm und
 * schweigt danach für immer.
 */
const NUMBER = /\d(?:[\d.,\u00a0 ]*\d)?/g

/** €, EUR, $, USD, CHF — direkt vor oder hinter der Zahl. */
const CURRENCY_AFTER = /^[\s\u00a0]*(?:€|EUR\b|\$|USD\b|CHF\b)/i
const CURRENCY_BEFORE = /(?:€|EUR|\$|USD|CHF)[\s\u00a0]*$/i

/**
 * Welche der gefundenen Zahlen der Preis ist.
 *
 * Zwei Anzeichen, und beide zählen: zwei Nachkommastellen wiegen schwerer als
 * ein Währungszeichen daneben, denn "2er Pack" steht auch mal direkt vor einem
 * Euro-Zeichen. Bei Gleichstand gewinnt die vordere — bei "ab 4,99 € statt
 * 9,99 €" ist der aktuelle Preis der erste.
 *
 * Beide Anzeichen können fehlen; "iPhone 15 128 GB 999" hat dann keinen
 * Gewinner, und es bleibt bei der ersten Zahl. Das ist keine gute Antwort, aber
 * eine ehrliche: Aus diesem Text ist der Preis nicht zu holen.
 */
function pickNumber(raw: string): string | null {
  let best: { token: string; score: number } | null = null

  for (const match of raw.matchAll(NUMBER)) {
    const token = match[0]
    const start = match.index ?? 0
    let score = 0
    if (/[.,]\d{2}$/.test(token)) score += 2
    if (
      CURRENCY_AFTER.test(raw.slice(start + token.length)) ||
      CURRENCY_BEFORE.test(raw.slice(0, start))
    ) {
      score += 1
    }
    if (!best || score > best.score) best = { token, score }
  }

  // Die Leerzeichen erst hier: Im Text trennen sie Tausender ("1 299,00"), und
  // vor der Auswahl gehören sie deshalb zur Zahl.
  return best ? best.token.replace(/[\s\u00a0]/g, '') : null
}

/** "1.299,00 €" → 1299.00, "1,299.00" → 1299.00, "1.299 €" → 1299.00 */
export function parsePriceString(raw: string): number | null {
  const cleaned = pickNumber(raw)
  if (!cleaned) return null

  const hasComma = cleaned.includes(',')
  const hasDot = cleaned.includes('.')

  let normalized: string
  if (hasComma && hasDot) {
    // Beide Zeichen da, damit ist nichts mehr zu raten: Das hintere trennt die
    // Nachkommastellen, das vordere gruppiert die Tausender.
    normalized =
      cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')
        ? cleaned.replace(/\./g, '').replace(',', '.')
        : cleaned.replace(/,/g, '')
  } else if (hasComma || hasDot) {
    normalized = normalizeSingleSeparator(cleaned, hasComma ? ',' : '.')
  } else {
    normalized = cleaned
  }

  const value = parseFloat(normalized)
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Der mehrdeutige Fall: genau ein Trennzeichen, und es steht nicht fest, wofür.
 *
 * "12.99" sind zwölf Euro neunundneunzig, "1.299" sind eintausendzweihundert-
 * neunundneunzig — dieselbe Schreibweise, tausendfacher Unterschied. Vorher
 * fiel beides in denselben Zweig und wurde als Dezimaltrenner gelesen; aus
 * einem Laptop für 1.299 € wurden dann ein Euro dreißig. Das ist nicht bloß
 * eine falsche Auskunft: Der Preiswächter vergleicht die Zahl mit dem
 * Zielpreis, schlägt Alarm und setzt dabei sein `notified`-Kennzeichen — der
 * Fehlalarm kommt also einmal, und danach schweigt die Beobachtung für immer,
 * weil der falsch gelesene Preis nie wieder über die Schwelle steigt.
 *
 * Entschieden wird an der Stellenzahl dahinter. Tausender stehen immer in
 * Dreiergruppen, Preise haben im Handel nie drei Nachkommastellen. Die Ausnahme
 * ist die führende Null: "0.750" ist kein Tausender, sondern ein Bruchteil.
 */
function normalizeSingleSeparator(cleaned: string, separator: ',' | '.'): string {
  const parts = cleaned.split(separator)
  const last = parts[parts.length - 1]

  const grouped =
    parts.length > 2 || (last.length === 3 && parts[0] !== '' && parts[0] !== '0')

  return grouped ? parts.join('') : parts.join('.')
}

const SELECTORS: Record<string, string[]> = {
  'amazon.': [
    '#corePrice_feature_div .a-price .a-offscreen',
    '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
    '.a-price .a-offscreen',
    '#priceblock_ourprice',
    '#priceblock_dealprice'
  ],
  'geizhals.': ['.gh_price span', '.gh_price', '[itemprop="price"]', '.offer__price'],
  'idealo.': [
    '[data-testid="detailed-price"]',
    '.oopStage-conditionButton-wrapper-price',
    '.productOffers-listItemOfferPrice',
    '[itemprop="price"]'
  ],
  default: ['[itemprop="price"]', '.price', '[data-price]', '[class*="price" i]']
}

export async function extractPrice(page: Page): Promise<ParsedPrice | null> {
  // ── Stufe 1: JSON-LD ──────────────────────────────────────
  const jsonLd = await page
    .$$eval('script[type="application/ld+json"]', (nodes) =>
      nodes.map((n) => n.textContent ?? '').filter(Boolean)
    )
    .catch(() => [] as string[])

  for (const block of jsonLd) {
    try {
      const parsed = JSON.parse(block) as unknown
      const found = findOffer(parsed)
      if (found) return { ...found, source: 'json-ld' }
    } catch {
      // Kaputtes JSON-LD ist häufig — einfach weitergehen.
    }
  }

  // ── Stufe 2: Meta-Tags ────────────────────────────────────
  const meta = await page
    .evaluate(() => {
      const pick = (selector: string): string | null =>
        document.querySelector(selector)?.getAttribute('content') ?? null
      return {
        price:
          pick('meta[property="product:price:amount"]') ??
          pick('meta[itemprop="price"]') ??
          pick('meta[property="og:price:amount"]'),
        currency:
          pick('meta[property="product:price:currency"]') ??
          pick('meta[itemprop="priceCurrency"]') ??
          pick('meta[property="og:price:currency"]'),
        name: pick('meta[property="og:title"]') ?? document.title
      }
    })
    .catch(() => null)

  if (meta?.price) {
    const value = parsePriceString(meta.price)
    if (value) {
      return {
        price: value,
        currency: meta.currency ?? 'EUR',
        productName: meta.name?.slice(0, 160) ?? null,
        availability: null,
        source: 'meta'
      }
    }
  }

  // ── Stufe 3: Selektoren ───────────────────────────────────
  const host = new URL(page.url()).hostname
  const key = Object.keys(SELECTORS).find((k) => k !== 'default' && host.includes(k)) ?? 'default'

  for (const selector of SELECTORS[key]) {
    const text = await page
      .locator(selector)
      .first()
      .textContent({ timeout: 1500 })
      .catch(() => null)
    if (!text) continue
    const value = parsePriceString(text)
    if (value) {
      const name = await page
        .locator('h1')
        .first()
        .textContent({ timeout: 1000 })
        .catch(() => null)
      return {
        price: value,
        currency: text.includes('$') ? 'USD' : 'EUR',
        productName: name?.trim().slice(0, 160) ?? null,
        availability: null,
        source: 'selector'
      }
    }
  }

  return null
}

/** Rekursiv nach einem Offer-Objekt suchen — JSON-LD ist oft verschachtelt. */
function findOffer(node: unknown, depth = 0): Omit<ParsedPrice, 'source'> | null {
  if (depth > 6 || node === null || typeof node !== 'object') return null

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findOffer(item, depth + 1)
      if (found) return found
    }
    return null
  }

  const obj = node as Record<string, unknown>
  const offers = obj.offers

  if (offers) {
    // Alle Angebote durchgehen, nicht nur das erste. Shops stellen gern eine
    // AggregateOffer ohne eigenen `price` voran und listen die echten Angebote
    // dahinter — wer nur `offers[0]` ansieht, hält die ganze Stufe für
    // ergebnislos und fällt auf die Selektoren zurück, die bei jedem Redesign
    // brechen. Genau davor sollen die ersten beiden Stufen schützen.
    for (const entry of Array.isArray(offers) ? offers : [offers]) {
      const offer = entry as Record<string, unknown> | undefined
      const rawPrice = offer?.price ?? offer?.lowPrice
      if (rawPrice === undefined) continue

      const value = typeof rawPrice === 'number' ? rawPrice : parsePriceString(String(rawPrice))
      if (value) {
        return {
          price: value,
          currency: String(offer?.priceCurrency ?? 'EUR'),
          productName: typeof obj.name === 'string' ? obj.name.slice(0, 160) : null,
          availability: normalizeAvailability(offer?.availability)
        }
      }
    }
  }

  for (const value of Object.values(obj)) {
    const found = findOffer(value, depth + 1)
    if (found) return found
  }
  return null
}

function normalizeAvailability(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const lower = raw.toLowerCase()
  if (lower.includes('instock')) return 'lieferbar'
  if (lower.includes('outofstock')) return 'nicht lieferbar'
  if (lower.includes('preorder')) return 'vorbestellbar'
  if (lower.includes('limited')) return 'begrenzt verfügbar'
  return null
}
