import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react'

/** Keep the draft until the controller has actually accepted it. */
export function TextBar({ disabled }: { disabled: boolean }): JSX.Element {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const pending = useRef(false)

  useEffect(() => {
    const focusInput = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l' && !event.altKey && !document.querySelector('[aria-modal="true"]')) {
        event.preventDefault()
        field.current?.focus()
      }
    }
    window.addEventListener('keydown', focusInput)
    return () => window.removeEventListener('keydown', focusInput)
  }, [])

  useEffect(() => {
    const input = field.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(132, Math.max(52, input.scrollHeight))}px`
  }, [text])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const message = text.trim()
    if (!message || disabled || pending.current) return
    if (message.toLowerCase() === '/skills') {
      window.dispatchEvent(new Event('jarvis:skills'))
      setText('')
      setFailed(false)
      return
    }
    pending.current = true
    setSending(true)
    setFailed(false)
    window.dispatchEvent(new CustomEvent('jarvis:text', { detail: {
      text: message,
      onResult: (sent: boolean) => {
        pending.current = false
        setSending(false)
        setFailed(!sent)
        if (sent) setText(draft => draft.trim() === message ? '' : draft)
      }
    } }))
  }

  return (
    <div className="composer">
      <form className="home-ask" onSubmit={submit} aria-busy={sending}>
        <textarea
          ref={field}
          rows={1}
          className="home-ask-field"
          value={text}
          onChange={event => { setText(event.target.value); setFailed(false) }}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault()
              if (!event.repeat) event.currentTarget.form?.requestSubmit()
            }
          }}
          placeholder={disabled ? 'James wird gestartet…' : 'Frag James oder beschreibe eine Aufgabe…'}
          aria-label="Nachricht an James"
          aria-describedby="composer-help composer-status"
          aria-keyshortcuts="Control+L Meta+L"
          disabled={disabled}
          autoComplete="off"
          maxLength={2000}
        />
        <button type="submit" className="home-ask-send" aria-label="Abschicken" title={sending ? 'Nachricht wird gesendet…' : 'Abschicken (Enter)'} disabled={disabled || sending || !text.trim()}>
          {sending ? <span className="composer-spinner" aria-hidden="true" /> : <svg viewBox="0 0 24 24" width="19" height="19" fill="none" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>}
        </button>
      </form>
      <div className="composer-meta">
        <span id="composer-help"><kbd>Enter</kbd> senden <span aria-hidden="true">·</span> <kbd>Shift + Enter</kbd> neue Zeile</span>
        <span id="composer-status" role="status">{sending ? 'Wird gesendet…' : failed ? 'Senden fehlgeschlagen · Entwurf bleibt erhalten' : text.length > 1600 ? `${text.length} / 2000` : 'Strg + L zum Schreiben'}</span>
      </div>
    </div>
  )
}
