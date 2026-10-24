import { useEffect, useMemo, useState, type JSX, type MouseEvent } from 'react'
import type { DisplayCard, StockCard as StockData } from '@shared/types'

/**
 * Die Kurskarte, wie sie Google bei einer Aktie zeigt.
 *
 * Kommt über `display:card`, sobald `stock_price` einen Kurs geholt hat. Karte
 * und gesprochener Satz stammen aus derselben Abfrage. Die Karte bleibt ein
 * paar Minuten stehen oder bis man sie wegklickt; eine neue Abfrage desselben
 * Papiers ersetzt sie, statt eine zweite daneben zu stellen.
 */

/** So lange bleibt eine Karte stehen, wenn niemand sie wegklickt. */
const STOCK_TTL_MS = 5 * 60_000
/** Mehr als drei Karten nebeneinander liest niemand. */
const MAX_CARDS = 3

export function useDisplayCards(): { cards: DisplayCard[]; dismiss: (id: string) => void } {
  const [cards, setCards] = useState<DisplayCard[]>([])

  useEffect(() => {
    return window.jarvis.on('display:card', (card: DisplayCard) => {
      // Die ausführliche Wetterkarte besitzt ihren eigenen Empfang und Verlauf.
      if (card.kind === 'weather') return
      setCards((prev) => [{ ...card, at: card.at ?? Date.now() }, ...prev.filter((c) => c.id !== card.id && !(c.kind === 'stock' && card.kind === 'stock' && c.symbol === card.symbol))].slice(0, MAX_CARDS))
    })
  }, [])

  useEffect(() => {
    if (cards.length === 0) return
    const timer = window.setInterval(() => {
      setCards((prev) => {
        const alive = prev.filter((c) => c.kind === 'browser-handoff' || c.kind === 'briefing' || Date.now() - (c.at ?? Date.now()) < STOCK_TTL_MS)
        return alive.length === prev.length ? prev : alive
      })
    }, 10_000)
    return () => window.clearInterval(timer)
  }, [cards.length])

  return { cards, dismiss: (id) => setCards((prev) => prev.filter((c) => c.id !== id)) }
}

/** Die Id endet mit dem Empfangszeitpunkt, siehe `parseChart`. */
function receivedAt(card: StockData): number {
  const stamp = Number(card.id.slice(card.id.lastIndexOf('-') + 1))
  return Number.isFinite(stamp) ? stamp : Date.now()
}

function money(n: number): string {
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function signed(n: number, suffix = ''): string {
  return `${n >= 0 ? '+' : '−'}${money(Math.abs(n))}${suffix}`
}

function compact(n: number): string {
  return n.toLocaleString('de-DE', { notation: 'compact', maximumFractionDigits: 2 })
}

function clock(ms: number, timeZone: string): string {
  try {
    return new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone })
  } catch {
    return new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
  }
}

function stamp(ms: number, timeZone: string): string {
  try {
    return new Date(ms).toLocaleString('de-DE', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone,
      timeZoneName: 'short'
    })
  } catch {
    return new Date(ms).toLocaleString('de-DE')
  }
}

const STATE_TEXT: Record<StockData['marketState'], string> = {
  REGULAR: 'Handel läuft',
  PRE: 'Vorbörse',
  POST: 'Nachbörse',
  CLOSED: 'Geschlossen'
}

const W = 520
const H = 170
const PAD_TOP = 10
const PAD_BOTTOM = 22

function Chart({ card }: { card: StockData }): JSX.Element {
  const [hover, setHover] = useState<number | null>(null)
  const up = card.change >= 0

  const geometry = useMemo(() => {
    const pts = card.points
    if (pts.length < 2) return null
    const t0 = pts[0].t
    const t1 = pts[pts.length - 1].t
    const values = pts.map((p) => p.p)
    if (card.previousClose !== null) values.push(card.previousClose)
    let lo = Math.min(...values)
    let hi = Math.max(...values)
    const margin = (hi - lo) * 0.08 || hi * 0.002 || 1
    lo -= margin
    hi += margin
    const x = (t: number): number => ((t - t0) / Math.max(1, t1 - t0)) * W
    const y = (p: number): number => PAD_TOP + (1 - (p - lo) / (hi - lo)) * (H - PAD_TOP - PAD_BOTTOM)
    // Wie bei Google: nur der reguläre Handel in Farbe, Vor- und Nachbörse grau.
    const startAt = card.regularStart !== null ? pts.findIndex((p) => p.t >= card.regularStart!) : 0
    const endAt = card.regularEnd !== null ? pts.findIndex((p) => p.t >= card.regularEnd!) : -1
    const from = startAt > 0 ? startAt : 0
    const to = endAt > from ? endAt : pts.length - 1
    let main = pts.slice(from, to + 1)
    if (main.length < 2) main = pts
    const before = main === pts || from === 0 ? [] : pts.slice(0, from + 1)
    const after = main === pts || to >= pts.length - 1 ? [] : pts.slice(to)
    const line = (list: typeof pts): string => list.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.p).toFixed(1)}`).join('')
    const mainPath = line(main)
    const area = `${mainPath}L${x(main[main.length - 1].t).toFixed(1)},${H - PAD_BOTTOM}L${x(main[0].t).toFixed(1)},${H - PAD_BOTTOM}Z`
    // Vier gleichmäßig verteilte Zeitmarken.
    const ticks = [0, 1, 2, 3].map((i) => t0 + ((t1 - t0) * (i + 0.5)) / 4)
    return {
      x,
      y,
      mainPath,
      beforePath: before.length > 1 ? line(before) : '',
      afterPath: after.length > 1 ? line(after) : '',
      area,
      ticks
    }
  }, [card])

  if (!geometry) return <div className="stock-chart-empty">Noch kein Tagesverlauf.</div>

  const onMove = (event: MouseEvent<SVGSVGElement>): void => {
    const box = event.currentTarget.getBoundingClientRect()
    const rel = ((event.clientX - box.left) / box.width) * W
    let best = 0
    let bestDist = Infinity
    card.points.forEach((p, i) => {
      const d = Math.abs(geometry.x(p.t) - rel)
      if (d < bestDist) {
        bestDist = d
        best = i
      }
    })
    setHover(best)
  }

  const hovered = hover !== null ? card.points[hover] : null
  const color = up ? 'var(--stock-up)' : 'var(--stock-down)'
  const gradient = `stock-fill-${card.symbol.replace(/[^A-Za-z0-9]/g, '')}`

  return (
    <div className="stock-chart">
      {hovered && (
        <div className="stock-tip" style={{ left: `${(geometry.x(hovered.t) / W) * 100}%` }}>
          <strong>{money(hovered.p)} {card.currency}</strong> {clock(hovered.t, card.timezone)}
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label={`Tagesverlauf ${card.name}`}>
        <defs>
          <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.32" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {card.previousClose !== null && (
          <line className="stock-prev" x1="0" x2={W} y1={geometry.y(card.previousClose)} y2={geometry.y(card.previousClose)} />
        )}
        <path d={geometry.area} fill={`url(#${gradient})`} />
        <path d={geometry.mainPath} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {geometry.beforePath && (
          <path d={geometry.beforePath} fill="none" className="stock-after" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
        )}
        {geometry.afterPath && (
          <path d={geometry.afterPath} fill="none" className="stock-after" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
        )}
        {hovered && (
          <line className="stock-cursor" x1={geometry.x(hovered.t)} x2={geometry.x(hovered.t)} y1={PAD_TOP} y2={H - PAD_BOTTOM} />
        )}
      </svg>
      <div className="stock-axis">
        {geometry.ticks.map((t) => (
          <span key={t}>{clock(t, card.timezone)}</span>
        ))}
      </div>
      {card.previousClose !== null && (
        <div className="stock-prev-label">
          Vortag <span>{money(card.previousClose)}</span>
        </div>
      )}
    </div>
  )
}

export function StockCard({ card, onDismiss }: { card: StockData; onDismiss: () => void }): JSX.Element {
  const up = card.change >= 0
  const stats: [string, string][] = [
    ['Eröffnung', card.open !== null ? money(card.open) : '–'],
    ['Hoch', card.high !== null ? money(card.high) : '–'],
    ['Tief', card.low !== null ? money(card.low) : '–'],
    ['Volumen', card.volume !== null ? compact(card.volume) : '–'],
    ['52-W-Hoch', card.yearHigh !== null ? money(card.yearHigh) : '–'],
    ['52-W-Tief', card.yearLow !== null ? money(card.yearLow) : '–']
  ]

  return (
    <section className="home-card stock-card" data-up={up ? 'true' : 'false'} aria-label={`Kurs ${card.name}`}>
      <div className="stock-head">
        <div className="stock-id">
          <div className="stock-name">{card.name}</div>
          <div className="stock-sym">
            {card.exchange ? `${card.exchange}: ` : ''}
            {card.symbol}
          </div>
        </div>
        <button className="home-card-x" title="Ausblenden" aria-label="Kurskarte ausblenden" onClick={onDismiss}>
          <svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true">
            <path d="M5 5l14 14M19 5L5 19" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="stock-price-row">
        <span className="stock-price">{money(card.price)}</span>
        <span className="stock-cur">{card.currency}</span>
        {card.previousClose !== null && (
          <>
            <span className="stock-pill">
              {up ? '↑' : '↓'} {money(Math.abs(card.changePct))} %
            </span>
            <span className="stock-delta">{signed(card.change)} heute</span>
          </>
        )}
      </div>

      <div className="stock-meta">
        <span className={`stock-state stock-state-${card.marketState.toLowerCase()}`}>{STATE_TEXT[card.marketState]}</span>
        <span>Stand {stamp(card.asOf, card.timezone)}</span>
      </div>
      {card.extended && (
        <div className="stock-extended" data-up={card.extended.change >= 0 ? 'true' : 'false'}>
          {card.extended.label} {money(card.extended.price)}{' '}
          <span>
            {signed(card.extended.change)} ({money(Math.abs(card.extended.changePct))} %)
          </span>
        </div>
      )}

      <Chart card={card} />

      <dl className="stock-stats">
        {stats.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
