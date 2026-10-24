import { useEffect, useRef, useState, type JSX } from 'react'
import { useCrystal } from '../store/crystalStore'

const DRAFT = 'james:message-draft'
export function CommandBar(): JSX.Element {
  const [text, setText] = useState(() => { try { return sessionStorage.getItem(DRAFT) ?? '' } catch { return '' } })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const locked = useRef(false)
  const alive = useRef(true)
  const input = useRef<HTMLTextAreaElement>(null)
  const state = useCrystal(s => s.state)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  useEffect(() => { try { sessionStorage.setItem(DRAFT, text) } catch { /* storage unavailable */ } }, [text])
  useEffect(() => {
    if (!input.current) return
    input.current.style.height = 'auto'
    input.current.style.height = `${Math.min(112, input.current.scrollHeight)}px`
  }, [text])
  const submit = (): void => {
    if (!text.trim() || locked.current) return
    locked.current = true; setPending(true); setError('')
    const sentText = text
    window.dispatchEvent(new CustomEvent('jarvis:text', { detail: {
      text: sentText.trim(), onResult: (sent: boolean) => {
        locked.current = false
        if (!alive.current) return
        setPending(false)
        if (sent) setText(current => current === sentText ? '' : current)
        else setError('Nicht gesendet. Dein Entwurf bleibt erhalten. Prüfe den Sprachzugang und versuche es erneut.')
        input.current?.focus()
      }
    } }))
  }
  return <div className="command-bar">
    <form className="command-form" onSubmit={event => { event.preventDefault(); submit() }} aria-label="Nachricht schreiben">
      <span className="command-symbol" aria-hidden="true">✦</span>
      <textarea ref={input} aria-label="Nachricht an James" placeholder="Frag James oder gib ihm eine Aufgabe …" rows={1}
        value={text} maxLength={12000} onChange={event => setText(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit() } }} />
      <button type="submit" className="command-send" disabled={pending || !text.trim()} aria-label="Nachricht senden">
        {pending ? <span className="composer-spinner" /> : <span aria-hidden="true">↑</span>}
      </button>
    </form>
    <div className="command-meta"><span><kbd>Enter</kbd> senden <span aria-hidden="true">·</span> <kbd>Shift + Enter</kbd> neue Zeile</span>
      <span role="status">{pending ? 'Wird übergeben …' : text ? 'Entwurf bleibt in diesem Fenster erhalten' : state === 'offline' ? 'Offline' : 'Sprich oder schreib. Du entscheidest.'}</span></div>
    {error && <p className="command-error" role="alert">{error}</p>}
  </div>
}

export function ConversationHistory(): JSX.Element | null {
  const captions = useCrystal(s => s.captions)
  if (!captions.length) return null
  return <details className="conversation-history">
    <summary>Gespräch ansehen <span>{captions.length} Beiträge</span></summary>
    <div className="conversation-lines">{captions.map(line => <article key={line.id} data-speaker={line.who}>
      <header><strong>{line.who === 'user' ? 'Du' : 'James'}</strong><time>{new Date(line.at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</time></header>
      <p>{line.text}</p>
    </article>)}</div>
  </details>
}
