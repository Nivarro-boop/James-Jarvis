import { useEffect, useState } from 'react'
import type { WeatherCard as Data } from '@shared/types'

const METRICS = [
  { key: 'temperature', label: 'Temperatur', unit: '°C' },
  { key: 'rain', label: 'Regen', unit: '%' },
  { key: 'wind', label: 'Wind', unit: 'km/h' }
] as const

/** WMO-Code grob als Zeichen — reicht für eine ruhige Kopfzeile. */
function symbol(code: number): string {
  if (code === 0) return '☀'
  if (code <= 3) return '⛅'
  if (code <= 48) return '🌫'
  if (code <= 67 || (code >= 80 && code <= 82)) return '🌧'
  if (code <= 77 || code === 85 || code === 86) return '❄'
  return '⛈'
}

export function WeatherCard() {
  const [card, setCard] = useState<Data | null>(null)
  const [metric, setMetric] = useState<'temperature' | 'rain' | 'wind'>('temperature')
  useEffect(() => window.jarvis.on('display:card', data => { if (data.kind === 'weather') { setCard(data); setMetric('temperature') } }), [])
  if (!card) return null
  const hours = card.hourly.filter(h => Number.isFinite(h[metric])).slice(0, 24)
  const values = hours.map(h => h[metric])
  const lo = Math.min(...values), hi = Math.max(...values)
  const points = hours.map((h, i) => `${i * 600 / Math.max(1, hours.length - 1)},${70 - (h[metric] - lo) / Math.max(1, hi - lo) * 56}`).join(' ')
  const unit = METRICS.find(m => m.key === metric)!.unit
  return <section className="home-card weather-card" aria-label={`Wetter ${card.place}`}>
    <div className="home-card-head">
      <span className="home-card-tag">Wetter · {card.place}</span>
      <button className="home-card-x" onClick={() => setCard(null)} aria-label="Wetter schließen">×</button>
    </div>
    <div className="weather-now">
      <span className="weather-symbol" aria-hidden="true">{symbol(card.code)}</span>
      <strong>{Math.round(card.temperature)}°</strong>
      <div><b>{card.description}</b><small>gefühlt {Math.round(card.apparent)}° · Feuchte {card.humidity ?? '–'} % · Wind {Math.round(card.wind)} km/h</small></div>
    </div>
    <nav className="weather-metrics" aria-label="Verlauf zeigen">
      {METRICS.map(m => <button key={m.key} aria-pressed={metric === m.key} onClick={() => setMetric(m.key)}>{m.label}</button>)}
    </nav>
    {values.length > 0 && <>
      <svg className="weather-chart" viewBox="0 0 600 76" preserveAspectRatio="none" role="img" aria-label={`Nächste 24 Stunden: ${Math.round(lo)} bis ${Math.round(hi)} ${unit}`}>
        <polygon points={`0,76 ${points} 600,76`} className="weather-area" />
        <polyline points={points} className="weather-line" />
      </svg>
      <small className="weather-range">Nächste 24 h · {Math.round(lo)}–{Math.round(hi)} {unit}</small>
    </>}
    <div className="weather-days">{card.daily.map(day => <article key={day.date}>
      <b>{new Date(day.date).toLocaleDateString('de-DE', { weekday: 'short' })}</b>
      <span aria-label={day.description} title={day.description}>{symbol(day.code)}</span>
      <strong>{Math.round(day.max)}°</strong><small>{Math.round(day.min)}°</small>
    </article>)}</div>
    <small className="weather-source">Open-Meteo · Vorhersage, keine Garantie</small>
  </section>
}
