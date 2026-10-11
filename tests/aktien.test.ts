import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { looksLikeSymbol, marketStateAt, parseChart } from '@main/tools/impl/stocks'
import { thoughtFor } from '@main/agent/activity'

/** Gekürzte Antwort der Chart-Endstelle, Werte vom 2. Oktober 2026 (Apple). */
const PERIOD = {
  pre: { start: 1790928000, end: 1790947800 },
  regular: { start: 1790947800, end: 1790971200 },
  post: { start: 1790971200, end: 1790985600 }
}

function chart(extra: Record<string, unknown> = {}): unknown {
  return {
    chart: {
      result: [
        {
          meta: {
            symbol: 'AAPL',
            longName: 'Apple Inc.',
            fullExchangeName: 'NasdaqGS',
            currency: 'USD',
            exchangeTimezoneName: 'America/New_York',
            regularMarketPrice: 333.69,
            previousClose: 330.32,
            regularMarketTime: 1790971201,
            regularMarketDayHigh: 334.54,
            regularMarketDayLow: 330.61,
            fiftyTwoWeekHigh: 345.34,
            fiftyTwoWeekLow: 243.42,
            regularMarketVolume: 31878433,
            currentTradingPeriod: PERIOD,
            ...extra
          },
          timestamp: [1790940000, 1790947800, 1790960000, 1790971200, 1790980000],
          indicators: {
            quote: [{ open: [331, 333.26, 333.5, 333.6, 333.5], close: [331.2, 333.4, 333.8, 333.69, 333.6] }]
          }
        }
      ]
    }
  }
}

describe('Aktienkurs von Yahoo', () => {
  it('liest Kurs, Veränderung und Eckdaten wie auf der Google-Karte', () => {
    const card = parseChart(chart(), 1790985000_000)
    assert.ok(card)
    assert.equal(card.name, 'Apple Inc.')
    assert.equal(card.price, 333.69)
    assert.equal(card.previousClose, 330.32)
    assert.equal(card.change.toFixed(2), '3.37')
    assert.equal(card.changePct.toFixed(2), '1.02')
    assert.equal(card.open, 333.26)
    assert.equal(card.high, 334.54)
    assert.equal(card.points.length, 5)
  })

  it('erkennt den nachbörslichen Kurs', () => {
    const card = parseChart(chart(), 1790985000_000)
    assert.equal(card?.extended?.label, 'Nachbörse')
    assert.equal(card?.extended?.price, 333.6)
    assert.equal(card?.extended?.change.toFixed(2), '-0.09')
  })

  it('berechnet die Handelsphase aus den Zeiten statt sie immer „regulär" zu nennen', () => {
    const meta = { currentTradingPeriod: PERIOD }
    assert.equal(marketStateAt(meta, 1790930000), 'PRE')
    assert.equal(marketStateAt(meta, 1790950000), 'REGULAR')
    assert.equal(marketStateAt(meta, 1790975000), 'POST')
    assert.equal(marketStateAt(meta, 1791000000), 'CLOSED')
  })

  it('lehnt eine Antwort ohne Kurs ab', () => {
    assert.equal(parseChart({ chart: { result: [{ meta: {} }] } }), null)
    assert.equal(parseChart({}), null)
  })

  it('unterscheidet Symbol und Firmennamen', () => {
    for (const s of ['AAPL', 'RHM.DE', 'BTC-USD', '^GDAXI', 'EURUSD=X']) assert.ok(looksLikeSymbol(s), s)
    for (const s of ['APPLE INC', 'RHEINMETALL AKTIE', 'NO RISK']) assert.ok(!looksLikeSymbol(s), s)
  })
})

describe('Denkblase', () => {
  it('sagt beim Öffnen, was geöffnet wird', () => {
    assert.equal(thoughtFor('open_app', { name: 'NoRisk Client' }), 'Öffne NoRisk Client …')
    assert.equal(thoughtFor('stock_price', { symbol: 'Apple' }), 'Schaue mir den aktuellen Kurs von Apple an …')
  })

  it('überlässt unbekannte Werkzeuge der Listenzeile', () => {
    assert.equal(thoughtFor('mcp_github_create_issue', { title: 'x' }), undefined)
  })
})
