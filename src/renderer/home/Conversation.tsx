import { useEffect, useRef } from 'react'
import { useCrystal } from '../store/crystalStore'
import type { ActivitySnapshot } from '@shared/types'

export function Conversation({ snapshot }: { snapshot: ActivitySnapshot }) {
  const captions = useCrystal(s => s.captions)
  const state = useCrystal(s => s.state)
  const end = useRef<HTMLDivElement>(null)
  const scroll = useRef<HTMLElement>(null)
  const follow = useRef(true)
  useEffect(() => { if (captions.length > 0 && follow.current) end.current?.scrollIntoView({ block: 'nearest' }) }, [captions])
  const failed = snapshot.items.some(i => i.status === 'error')
  const suggestions = failed
    ? ['Was ist fehlgeschlagen?', 'Versuche einen anderen Lösungsweg']
    : captions.length ? ['Fasse das Ergebnis zusammen', 'Was ist der nächste Schritt?']
    : ['Was kannst du für mich tun?', 'Was steht heute an?', 'Hilf mir bei einer Aufgabe']
  const busy = ['thinking', 'tool', 'connecting', 'speaking', 'confirm'].includes(state)
  return <section ref={scroll} className="conversation" aria-label="Gespräch mit James" onScroll={() => { const el = scroll.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
    {captions.map(c => <article key={c.id} className={`chat-message chat-message-${c.who}`}><small>{c.who === 'user' ? 'Du' : 'James'}</small><p>{c.text}</p></article>)}
    <div className="chat-suggestions" aria-label="Passende Vorschläge">{suggestions.map(text => <button key={text} disabled={busy} onClick={() => window.dispatchEvent(new CustomEvent('jarvis:text', { detail: text }))}>{text}</button>)}</div>
    <div ref={end} />
  </section>
}
