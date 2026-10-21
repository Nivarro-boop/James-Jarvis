import { useEffect, useRef, useState, type JSX } from 'react'
import type { ReminderEntry } from '@shared/types'

function toLocalInputValue(timestamp: number): string {
  const local = new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function localInputToIso(value: string): string {
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) throw new Error('Bitte einen gültigen Zeitpunkt auswählen.')
  return new Date(timestamp).toISOString()
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message
  return String(error)
}

export function ReminderPanel(): JSX.Element {
  const [items, setItems] = useState<ReminderEntry[]>([])
  const [text, setText] = useState('')
  const [at, setAt] = useState('')
  const [repeat, setRepeat] = useState<ReminderEntry['repeat']>('none')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  const [editAt, setEditAt] = useState('')
  const [editOriginalAt, setEditOriginalAt] = useState('')
  const [editRepeat, setEditRepeat] = useState<ReminderEntry['repeat']>('none')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  const load = async (): Promise<void> => {
    const list = await window.jarvis.invoke('reminder:list')
    setItems(list)
  }

  useEffect(() => {
    let disposed = false
    const refresh = (): void => {
      void window.jarvis.invoke('reminder:list')
        .then(list => { if (!disposed) setItems(list) })
        .catch(e => { if (!disposed) setError(errorMessage(e)) })
    }
    refresh()
    const off = window.jarvis.on('reminder:changed', refresh)
    const timer = window.setInterval(refresh, 60_000)
    return () => { disposed = true; off(); window.clearInterval(timer) }
  }, [])

  const act = async (work: () => Promise<unknown>): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      await work()
      await load()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const beginEdit = (item: ReminderEntry): void => {
    setEditingId(item.id)
    setEditText(item.text)
    setEditAt(toLocalInputValue(item.dueAt))
    setEditOriginalAt(toLocalInputValue(item.dueAt))
    setEditRepeat(item.repeat)
    setError('')
  }

  const stopEdit = (): void => {
    setEditingId(null)
    setEditText('')
    setEditAt('')
  }

  return <section style={{ marginTop: 20 }} aria-label="Erinnerungen">
    <h3>Erinnerungen</h3>
    {items.length === 0 && <p className="hint">Zum Beispiel: „Erinnere mich morgen um neun an den Termin.“</p>}
    {items.map(item => <div key={item.id} role="group" aria-label={`Erinnerung: ${item.text}`}
      style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
      {editingId === item.id ? <form onSubmit={event => {
        event.preventDefault()
        void act(() => window.jarvis.invoke('reminder:update', {
          id: item.id, text: editText, repeat: editRepeat,
          ...(editAt !== editOriginalAt ? { at: localInputToIso(editAt) } : {})
        }).then(result => { setItems(current => current.map(entry => entry.id === result.id ? result : entry)); stopEdit() }))
      }}>
        <input aria-label="Erinnerungstext bearbeiten" placeholder="Woran soll James erinnern?" value={editText}
          maxLength={2000} required onChange={e => setEditText(e.target.value)} />
        <input aria-label="Zeitpunkt bearbeiten" type="datetime-local" required value={editAt} onChange={e => setEditAt(e.target.value)} />
        <select aria-label="Wiederholung bearbeiten" value={editRepeat} onChange={e => setEditRepeat(e.target.value as ReminderEntry['repeat'])}>
          <option value="none">Einmalig</option><option value="daily">Täglich</option><option value="weekly">Wöchentlich</option>
        </select>
        <button type="submit" disabled={busy || !editText.trim() || !editAt}>Änderungen speichern</button>{' '}
        <button type="button" disabled={busy} onClick={stopEdit}>Abbrechen</button>
      </form> : <>
        <strong>{item.text}</strong>
        <div className="hint">{item.state === 'notified' ? 'Fällig · noch nicht erledigt' : new Date(item.dueAt).toLocaleString('de-DE')}
          {item.repeat !== 'none' && ` · ${item.repeat === 'daily' ? 'täglich' : 'wöchentlich'}`}</div>
        <button disabled={busy} onClick={() => beginEdit(item)}>Bearbeiten</button>{' '}
        <button disabled={busy} onClick={() => void act(() => window.jarvis.invoke('reminder:done', { id: item.id }))}>Erledigt</button>{' '}
        {[10, 30, 60].map(minutes => <span key={minutes}><button disabled={busy}
          onClick={() => void act(() => window.jarvis.invoke('reminder:snooze', { id: item.id, minutes }))}>
          {minutes === 10 ? 'In 10 Minuten' : `+${minutes} Min.`}
        </button>{' '}</span>)}
      </>}
    </div>)}
    <details style={{ marginTop: 12 }}><summary>Erinnerung hinzufügen</summary>
      <form onSubmit={event => {
        event.preventDefault()
        void act(async () => {
          await window.jarvis.invoke('reminder:create', { text, at: localInputToIso(at), repeat })
          setText('')
          setAt('')
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
