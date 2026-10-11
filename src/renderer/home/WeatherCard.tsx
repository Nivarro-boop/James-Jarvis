import { useEffect, useState } from 'react'
import type { WeatherCard as Data } from '@shared/types'

export function WeatherCard() {
  const [card, setCard] = useState<Data | null>(null)
  const [metric, setMetric] = useState<'temperature' | 'rain' | 'wind'>('temperature')
  useEffect(() => window.jarvis.on('display:card', data => { if (data.kind === 'weather') { setCard(data); setMetric('temperature') } }), [])
  if (!card) return null
  const hours = card.hourly.filter(h => Number.isFinite(h[metric])).slice(0, 24)
  const values = hours.map(h => h[metric]).filter(Number.isFinite)
  const lo = Math.min(...values), hi = Math.max(...values)
  const points = hours.map((h, i) => `${i * 600 / Math.max(1, hours.length - 1)},${90 - (h[metric] - lo) / Math.max(1, hi - lo) * 70}`).join(' ')
  const unit = metric === 'temperature' ? '°C' : metric === 'rain' ? '%' : 'km/h'
  return <section className="weather-card" aria-label={`Wetter ${card.place}`}>
    <header><strong>🌤 {Math.round(card.temperature)} °C</strong><div><b>{card.place}</b><br />{card.description}</div><button onClick={() => setCard(null)} aria-label="Wetter schließen">×</button></header>
    <p>Luftfeuchte {card.humidity ?? '–'} % · Wind {Math.round(card.wind)} km/h</p>
    <nav>{(['temperature', 'rain', 'wind'] as const).map((key, i) => <button key={key} aria-pressed={metric === key} onClick={() => setMetric(key)}>{['Temperatur', 'Niederschlag', 'Wind'][i]}</button>)}</nav>
    {values.length > 0 && <><svg viewBox="0 0 600 110" role="img" aria-label={`${unit}: ${Math.round(lo)} bis ${Math.round(hi)}`}><polygon points={`0,110 ${points} 600,110`} fill="#685715" opacity=".5" /><polyline points={points} fill="none" stroke="#ffd65a" strokeWidth="3" /></svg><p>{hours[0]?.time.slice(11,16)} – {hours.at(-1)?.time.slice(11,16)} · {Math.round(lo)}–{Math.round(hi)} {unit}</p></>}
    <div className="weather-days">{card.daily.map(day => <article key={day.date}><b>{new Date(day.date).toLocaleDateString('de-DE', { weekday: 'short' })}</b><span>{day.description}</span><strong>{Math.round(day.max)}° / {Math.round(day.min)}°</strong><small>Regen {day.rain} %</small></article>)}</div>
    <small>Quelle: Open-Meteo · letzte Abfrage · Vorhersage, keine Garantie</small>
  </section>
}
