import type { DisplayCard as Data, CardAction } from '@shared/types'
import { formatDistance, formatDuration, clock } from '@shared/format'
import { MapView } from '../map/MapView'
import { StockCard } from './StockCard'
export function safeCardUrl(url: string): boolean { try { return new URL(url).protocol === 'https:' } catch { return false } }
function Actions({ actions = [] }: { actions?: CardAction[] }) {
  return <div className="answer-actions">{actions.map((a, i) => a.type === 'open' ? safeCardUrl(a.url) && <a key={i} href={a.url} target="_blank" rel="noopener noreferrer">{a.label}</a> : <button key={i} onClick={() => window.dispatchEvent(new CustomEvent('jarvis:text', { detail: a.prompt }))}>{a.label}</button>)}</div>
}
export function AnswerCard({ card, onDismiss }: { card: Data; onDismiss: () => void }) {
  if (card.kind === 'stock') return <StockCard card={card} onDismiss={onDismiss} />
  const title = card.kind === 'weather' ? card.place : card.kind === 'route' ? `${card.from.label} → ${card.to.label}` : card.kind === 'agenda' ? card.range : card.kind === 'briefing' ? card.greeting : card.query
  return <section className="home-card answer-card" aria-label={title}>
    <div className="home-card-head"><span className="home-card-tag">{({ weather: 'Wetter', route: 'Route', places: 'Orte', agenda: 'Termine', sources: 'Quellen', 'browser-handoff': 'Dein Schritt im Browser', briefing: 'Tagesbriefing' })[card.kind]}</span><button className="home-card-x" aria-label="Karte ausblenden" onClick={onDismiss}>×</button></div>
    <h2 className="home-card-title">{title}</h2>
    {card.kind === 'browser-handoff' && <><p>{card.message}</p><small>{card.domain} · James wartet auf deinen Schritt. Eine Anmeldung wird erst nach Prüfung bestätigt.</small></>}
    {card.kind === 'route' && <><div className="answer-metric">{formatDuration(card.durationS)} · {formatDistance(card.distanceM)}</div><p>{card.mode === 'auto' ? 'Auto · ohne aktuelle Verkehrslage' : card.mode === 'zu_fuss' ? 'Zu Fuß' : 'Fahrrad'} · Ankunft {clock(card.arrivalAt)}</p><MapView path={card.path} markers={[{ ...card.from, index: 1 }, { ...card.to, index: 2 }]} interactive label={title} /><p>{card.summary}</p><small>Start und Ziel werden auf das nutzbare Straßennetz gesetzt.</small></>}
    {card.kind === 'places' && <><MapView markers={card.places.map((p, i) => ({ ...p, index: i + 1 }))} interactive label={title} /><ol>{card.places.map((p, i) => <li key={i}><strong>{p.name}</strong>{p.distanceM !== undefined && ` · ${formatDistance(p.distanceM)} Luftlinie`}<div>{p.address}</div></li>)}</ol></>}
    {card.kind === 'weather' && <><div className="answer-metric">{Math.round(card.temperature)} °C · {card.description}</div><p>Gefühlt {Math.round(card.apparent)} °C · Wind {card.wind} km/h · Feuchte {card.humidity} %</p><div className="answer-scroll">{card.hourly.map(h => <div key={h.time}>{h.time.slice(11, 16)}<strong>{Math.round(h.temperature)} °C</strong><small>{h.rain} % Regen</small></div>)}</div><div className="answer-scroll">{card.daily.map(d => <div key={d.date}>{new Date(d.date + 'T12:00').toLocaleDateString('de-DE', { weekday: 'short' })}<strong>{d.max}° / {d.min}°</strong><small>{d.description} · {d.rain} %</small></div>)}</div><MapView center={card} markers={[card]} height={120} /></>}
    {card.kind === 'agenda' && (card.events.length ? <ul>{card.events.map((e, i) => <li key={i}><strong>{e.title}</strong><div>{new Date(e.start).toLocaleDateString('de-DE')} · {e.allDay ? 'Ganztägig' : `${clock(e.start)}${e.end ? '–' + clock(e.end) : ''}`}{e.location && ` · ${e.location}`}</div></li>)}</ul> : <p>Keine Termine.</p>)}
    {card.kind === 'briefing' && card.sections.map(s => <section key={s.title} className="briefing-section"><strong>{s.title}</strong><ul>{s.items.map((item, i) => <li key={i}>{item}</li>)}</ul></section>)}
    {card.kind === 'sources' && <ul>{card.sources.map((s, i) => <li key={i}>{safeCardUrl(s.url) ? <a href={s.url} target="_blank" rel="noopener noreferrer">{s.title || s.domain}</a> : s.title || s.domain}<small> {s.domain}</small></li>)}</ul>}
    <Actions actions={card.actions} />
    {typeof card.at === 'number' && Number.isFinite(card.at) && Math.abs(card.at) <= 8.64e15 && <p className="answer-updated">Stand: <time dateTime={new Date(card.at).toISOString()}>{new Date(card.at).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</time></p>}
  </section>
}
