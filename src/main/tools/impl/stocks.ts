import { z } from 'zod'
import type { StockCard, StockPoint } from '@shared/types'
import { defineTool, type ToolDefinition } from '../registry'

/**
 * Aktien, Krypto und Wechselkurse — ohne Registrierung.
 *
 * Aktien und Krypto: Yahoo Finance (inoffizielle JSON-Endstelle, kein Key).
 * Wechselkurse: Frankfurter.app (Open Source, täglich aktualisiert, kein Key).
 *
 * Warum kein „richtiges" API? Weil der Nutzer nichts einrichten soll. Die
 * Kurse kommen bei jeder Frage frisch, ohne Zwischenspeicher, und sind bei
 * den großen Börsen höchstens ein paar Minuten alt.
 */

const YAHOO_HEADERS = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }

const SEARCHABLE_TYPES = ['EQUITY', 'ETF', 'INDEX', 'CRYPTOCURRENCY', 'MUTUALFUND', 'CURRENCY', 'FUTURE']

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Aus einem Firmennamen ein Tickersymbol machen.
 *
 * Gesprochen kommt „Rheinmetall" an, nicht „RHM.DE". Das Modell rät Symbole
 * für bekannte US-Werte meistens richtig, für alles andere oft nicht — und ein
 * falsch geratenes Symbol liefert entweder nichts oder still ein anderes
 * Papier. Deshalb fragt das Werkzeug Yahoos Suche, sobald das Eingegebene
 * nicht nach Symbol aussieht oder kein Kurs dazu kommt.
 */
export async function searchSymbol(query: string): Promise<string | null> {
  const url =
    'https://query2.finance.yahoo.com/v1/finance/search' +
    `?q=${encodeURIComponent(query)}&quotesCount=6&newsCount=0&listsCount=0`
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: YAHOO_HEADERS })
  if (!res.ok) return null
  const data = (await res.json()) as any
  const quotes: any[] = Array.isArray(data?.quotes) ? data.quotes : []
  const usable = quotes.filter((q) => typeof q?.symbol === 'string' && SEARCHABLE_TYPES.includes(q.quoteType))
  return usable[0]?.symbol ?? null
}

/** Sieht die Eingabe schon wie ein Symbol aus (AAPL, RHM.DE, BTC-USD, ^GDAXI)? */
export function looksLikeSymbol(input: string): boolean {
  return /^\^?[A-Z0-9]{1,6}([.=-][A-Z0-9]{1,5})?$/.test(input.trim())
}

/**
 * Handelsphase aus den Zeiten der Börse.
 *
 * Yahoos Chart-Endstelle liefert kein `marketState`. Die alte Fassung las das
 * Feld trotzdem und meldete deshalb immer „regulärer Handel" — auch um
 * Mitternacht. Die Handelszeiten stehen aber mit in der Antwort.
 */
export function marketStateAt(meta: any, nowSec: number): StockCard['marketState'] {
  const period = meta?.currentTradingPeriod
  const within = (p: any): boolean => Boolean(p) && nowSec >= p.start && nowSec < p.end
  if (within(period?.regular)) return 'REGULAR'
  if (within(period?.pre)) return 'PRE'
  if (within(period?.post)) return 'POST'
  return 'CLOSED'
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * Kurs, Tageskurve und Eckdaten aus einer einzigen Abfrage.
 *
 * Fünf-Minuten-Kerzen über den Tag samt Vor- und Nachbörse: daraus entsteht
 * die Kurve auf der Karte, und der letzte Punkt ist der aktuelle Kurs
 * außerhalb der Handelszeit.
 */
export function parseChart(data: any, nowMs = Date.now()): StockCard | null {
  const result = data?.chart?.result?.[0]
  const meta = result?.meta
  if (!meta || typeof meta.regularMarketPrice !== 'number') return null

  const times: number[] = Array.isArray(result.timestamp) ? result.timestamp : []
  const quote = result.indicators?.quote?.[0] ?? {}
  const closes: unknown[] = Array.isArray(quote.close) ? quote.close : []
  const opens: unknown[] = Array.isArray(quote.open) ? quote.open : []
  const points: StockPoint[] = []
  for (let i = 0; i < times.length; i++) {
    const p = num(closes[i])
    if (p !== null) points.push({ t: times[i] * 1000, p })
  }

  const price: number = meta.regularMarketPrice
  const previousClose = num(meta.previousClose) ?? num(meta.chartPreviousClose)
  const change = previousClose !== null ? price - previousClose : 0
  const changePct = previousClose ? (change / previousClose) * 100 : 0

  const regular = meta.currentTradingPeriod?.regular
  const regularStart = typeof regular?.start === 'number' ? regular.start * 1000 : null
  const regularEnd = typeof regular?.end === 'number' ? regular.end * 1000 : null

  // Eröffnung: der erste Kurs ab Handelsbeginn.
  let open: number | null = null
  for (let i = 0; i < times.length && open === null; i++) {
    if (regularStart !== null && times[i] * 1000 < regularStart) continue
    open = num(opens[i])
  }

  // Vor- oder Nachbörse: der letzte Punkt außerhalb des regulären Handels.
  let extended: StockCard['extended'] = null
  const last = points[points.length - 1]
  if (last && regularStart !== null && regularEnd !== null && (last.t >= regularEnd || last.t < regularStart)) {
    const afterHours = last.t >= regularEnd
    const base = afterHours ? price : (previousClose ?? price)
    if (Math.abs(last.p - base) > 1e-9) {
      extended = {
        price: last.p,
        change: last.p - base,
        changePct: base ? ((last.p - base) / base) * 100 : 0,
        label: afterHours ? 'Nachbörse' : 'Vorbörse'
      }
    }
  }

  return {
    kind: 'stock',
    id: `${String(meta.symbol)}-${nowMs}`,
    symbol: String(meta.symbol ?? ''),
    name: String(meta.longName || meta.shortName || meta.symbol || ''),
    exchange: String(meta.fullExchangeName || meta.exchangeName || ''),
    currency: String(meta.currency || ''),
    price,
    change,
    changePct,
    previousClose,
    marketState: marketStateAt(meta, Math.floor(nowMs / 1000)),
    asOf: typeof meta.regularMarketTime === 'number' ? meta.regularMarketTime * 1000 : nowMs,
    timezone: String(meta.exchangeTimezoneName || 'UTC'),
    open,
    high: num(meta.regularMarketDayHigh),
    low: num(meta.regularMarketDayLow),
    yearHigh: num(meta.fiftyTwoWeekHigh),
    yearLow: num(meta.fiftyTwoWeekLow),
    volume: num(meta.regularMarketVolume),
    extended,
    regularStart,
    regularEnd,
    points
  }
}

/** Aktie oder Krypto über Yahoo Finance abrufen — immer frisch, ohne Zwischenspeicher. */
async function fetchQuote(symbol: string): Promise<StockCard | null> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=5m&range=1d&includePrePost=true&_=${Date.now()}`

  const res = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: YAHOO_HEADERS,
    cache: 'no-store'
  })
  if (!res.ok) return null
  return parseChart(await res.json())
}

/** Wechselkurs über Frankfurter.app. */
async function fetchExchangeRate(from: string, to: string): Promise<number | null> {
  const url = `https://api.frankfurter.app/latest?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) return null
  const data = (await res.json()) as any
  return data?.rates?.[to.toUpperCase()] ?? null
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/** Formatiert eine Zahl lesbar für die Sprachausgabe. */
function fmt(n: number, decimals = 2): string {
  return n.toLocaleString('de-AT', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  })
}

// ─────────────────────────────────────────────────────────────
// Werkzeuge
// ─────────────────────────────────────────────────────────────

const stockPrice = defineTool({
  name: 'stock_price',
  group: 'web',
  description:
    'Holt den AKTUELLEN Kurs einer Aktie, eines Index oder einer Kryptowährung live von der Börse ' +
    'und zeigt dem Nutzer dazu eine Kurskarte mit Tagesverlauf. Rufe das bei JEDER Frage nach ' +
    'einem Kurs auf, auch wenn du glaubst, ihn zu kennen — Kurse aus dem Gedächtnis sind veraltet. ' +
    'Auch für "kannst du Aktien anschauen", "wie steht Apple", "Bitcoin-Kurs", "DAX heute". ' +
    'Firmennamen gehen direkt (z. B. "Rheinmetall", "Apple"); Symbole wie AAPL, NVDA, BTC-USD, ' +
    '^GDAXI (DAX), ^ATX, ^STOXX50E auch.',
  schema: z.object({
    symbol: z
      .string()
      .describe('Tickersymbol oder Firmenname, z. B. AAPL, Apple, Rheinmetall, BTC-USD, ^GDAXI.'),
    vergleich: z
      .boolean()
      .optional()
      .describe('Auch Veränderung zum Vortag nennen. Standard ja.')
  }),
  spokenHint: 'Okay.',
  async execute({ symbol, vergleich = true }, ctx) {
    const input = symbol.trim()
    let quote: StockCard | null = null
    if (looksLikeSymbol(input.toUpperCase())) quote = await fetchQuote(input.toUpperCase())
    if (!quote) {
      const found = await searchSymbol(input)
      if (found) quote = await fetchQuote(found)
    }
    if (!quote) {
      throw new Error(`Zu "${symbol}" finde ich keinen Kurs. Frag nach dem genauen Namen oder Tickersymbol.`)
    }

    ctx.show(quote)

    const marketNote =
      quote.marketState === 'CLOSED'
        ? 'Börse geschlossen, Schlusskurs.'
        : quote.marketState === 'PRE'
          ? 'Vorbörslich.'
          : quote.marketState === 'POST'
            ? 'Nachbörslich.'
            : 'Handel läuft.'

    const sign = (n: number): string => (n >= 0 ? '+' : '')
    const changeStr =
      vergleich && quote.previousClose !== null
        ? `${sign(quote.change)}${fmt(quote.change)} ${quote.currency} ` +
          `(${sign(quote.change)}${fmt(quote.changePct, 2)} Prozent) zum Vortag`
        : undefined

    return {
      name: quote.name,
      symbol: quote.symbol,
      kurs: `${fmt(quote.price)} ${quote.currency}`,
      veraenderung: changeStr,
      stand: new Date(quote.asOf).toLocaleString('de-AT', { dateStyle: 'short', timeStyle: 'short' }),
      markt: marketNote,
      ausserboerslich: quote.extended
        ? `${quote.extended.label}: ${fmt(quote.extended.price)} ${quote.currency} ` +
          `(${sign(quote.extended.change)}${fmt(quote.extended.changePct, 2)} Prozent)`
        : undefined,
      tageshoch: quote.high !== null ? fmt(quote.high) : undefined,
      tagestief: quote.low !== null ? fmt(quote.low) : undefined,
      hinweis:
        'Die Kurskarte ist schon auf dem Bildschirm. Antworte in ein bis zwei Sätzen mit Name, Kurs ' +
        'und Veränderung. Keine Kaufempfehlung.'
    }
  }
}) as ToolDefinition

const exchangeRate = defineTool({
  name: 'exchange_rate',
  group: 'web',
  description:
    'Gibt den aktuellen Wechselkurs zwischen zwei Währungen aus. ' +
    'Für "wie viel ist ein Dollar in Euro", "USD in CHF", "Pfund Kurs". ' +
    'Unterstützt EUR, USD, GBP, CHF, JPY, CAD, AUD, CNY, und viele mehr.',
  schema: z.object({
    von: z.string().describe('Ausgangswährung, z.B. USD, EUR, GBP.'),
    nach: z.string().describe('Zielwährung, z.B. EUR, USD, CHF.'),
    betrag: z.number().optional().describe('Betrag zum Umrechnen. Standard ist 1.')
  }),
  spokenHint: 'Mhm.',
  async execute({ von, nach, betrag = 1 }) {
    const fromUpper = von.toUpperCase().trim()
    const toUpper = nach.toUpperCase().trim()

    if (fromUpper === toUpper) {
      return {
        von: fromUpper,
        nach: toUpper,
        kurs: 1,
        ergebnis: `${fmt(betrag)} ${fromUpper} sind ${fmt(betrag)} ${toUpper}.`
      }
    }

    const rate = await fetchExchangeRate(fromUpper, toUpper)
    if (!rate) {
      throw new Error(
        `Kurs ${fromUpper}→${toUpper} nicht verfügbar. Prüfe die Währungscodes (ISO 4217).`
      )
    }

    const converted = betrag * rate

    return {
      von: fromUpper,
      nach: toUpper,
      kurs: `1 ${fromUpper} = ${fmt(rate, 4)} ${toUpper}`,
      ergebnis:
        betrag !== 1
          ? `${fmt(betrag)} ${fromUpper} sind ${fmt(converted)} ${toUpper}.`
          : undefined,
      hinweis: 'Nenne Kurs und falls ein Betrag angegeben war, das Ergebnis. Ein Satz reicht.'
    }
  }
}) as ToolDefinition

export const stocksTools: ToolDefinition[] = [stockPrice, exchangeRate]
