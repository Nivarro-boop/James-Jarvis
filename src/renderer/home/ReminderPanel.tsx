import { useEffect, useState, type JSX } from 'react'
import type { ReminderEntry } from '@shared/types'

export function ReminderPanel(): JSX.Element {
  const [items, setItems] = useState<ReminderEntry[]>([])
  const [text, setText] = useState('')
  const [at, setAt] = useState('')
  const [repeat, setRepeat] = useState<ReminderEntry['repeat']>('none')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = async (): Promise<void> => { setItems(await window.jarvis.invoke('reminder:list')) }
  useEffect(() => {
    let disposed = false
    const refresh = (): void => {
      void window.jarvis.invoke('reminder:list').then(list => { if (!disposed) setItems(list) })
        .catch(e => { if (!disposed) setError(String(e)) })
    }
    refresh()
    const off = window.jarvis.on('reminder:changed', refresh)
    const timer = window.setInterval(refresh, 60_000)
    return () => { disposed = true; off(); window.clearInterval(timer) }
  }, [])
  const act = async (work: () => Promise<unknown>): Promise<void> => {
    if (busy) return
    setBusy(true); setError('')
    try { await work(); await load() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <section style={{ marginTop: 20 }} aria-label="Erinnerungen">
    <h3>Erinnerungen</h3>
    {items.length === 0 && <p className="hint">Zum Beispiel: „Erinnere mich morgen um neun an den Termin.“</p>}
    {items.map(item => <div key={item.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
      <strong>{item.text}</strong>
      <div className="hint">{item.state === 'notified' ? 'Fällig · noch nicht erledigt' : new Date(item.dueAt).toLocaleString('de-DE')}
        {item.repeat !== 'none' && ` · ${item.repeat === 'daily' ? 'täglich' : 'wöchentlich'}`}</div>
      <button disabled={busy} onClick={() => void act(() => window.jarvis.invoke('reminder:done', { id: item.id }))}>Erledigt</button>{' '}
      <button disabled={busy} onClick={() => void act(() => window.jarvis.invoke('reminder:snooze', { id: item.id, minutes: 10 }))}>In 10 Minuten</button>
    </div>)}
    <details style={{ marginTop: 12 }}><summary>Erinnerung hinzufügen</summary>
      <form onSubmit={event => {
        event.preventDefault()
        void act(async () => {
          await window.jarvis.invoke('reminder:create', { text, at: new Date(at).toISOString(), repeat })
          setText(''); setAt('')
        })
      }}>
        <input aria-label="Erinnerungstext" placeholder="Woran soll James erinnern?" value={text}
          maxLength={2000} required onChange={e => setText(e.target.value)} />
        <input aria-label="Zeitpunkt" type="datetime-local" required value={at} onChange={e => setAt(e.target.value)} />
        <select aria-label="Wiederholung" value={repeat} onChange={e => setRepeat(e.target.value as ReminderEntry['repeat'])}>
          <option value="none">Einmalig</option><option value="daily">Täglich</option><option value="weekly">Wöchentlich</option>
        </select>
        <button type="submit" disabled={busy || !text.trim() || !at}>Speichern</button>
      </form>
    </details>
    {error && <p role="alert" className="hint err">{error}</p>}
  </section>
}
