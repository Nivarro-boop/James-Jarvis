import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useCrystal, type Caption } from '../store/crystalStore'
import type { ActivitySnapshot, CrystalState } from '@shared/types'
import './conversation.css'

const STATUS: Record<CrystalState, string> = {
  idle: 'Bereit für deine nächste Frage', listening: 'James hört zu',
  thinking: 'James denkt nach', speaking: 'James antwortet', tool: 'James arbeitet daran',
  research: 'Recherche läuft im Hintergrund', confirm: 'James wartet auf deine Antwort',
  error: 'Es gibt ein Problem', offline: 'Gerade offline', connecting: 'Verbindung wird aufgebaut',
  paused: 'James pausiert'
}

function CopyIcon({ copied }: { copied: boolean }) {
  return <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
    {copied ? <path d="m4 10 4 4 8-8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      : <><rect x="7" y="7" width="9" height="10" rx="2" stroke="currentColor" strokeWidth="1.4" /><path d="M12 4H5a2 2 0 0 0-2 2v7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></>}
  </svg>
}

function Message({ caption }: { caption: Caption }) {
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle')
  const copiedText = useRef('')
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (copyState !== 'copied') return
    const timer = window.setTimeout(() => setCopyState('idle'), 2500)
    return () => window.clearTimeout(timer)
  }, [copyState])

  // A streaming reply may have grown since the user copied it.
  const copied = copyState === 'copied' && copiedText.current === caption.text
  const copy = async (): Promise<void> => {
    setCopyState('copying')
    try {
      await navigator.clipboard.writeText(caption.text)
      if (mounted.current) {
        copiedText.current = caption.text
        setCopyState('copied')
      }
    } catch {
      if (mounted.current) setCopyState('error')
    }
  }
  const date = new Date(caption.at)

  return <article className={`chat-message chat-message-${caption.who}`} data-caption-id={caption.id}>
    <div className="chat-message-head">
      <small>{caption.who === 'user' ? 'Du' : 'James'}</small>
      <time dateTime={date.toISOString()} title={date.toLocaleString('de-DE')}>
        {date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}
      </time>
      {caption.who === 'james' && <button type="button" className="chat-copy" onClick={() => void copy()}
        disabled={copyState === 'copying'} aria-label={copied ? 'Antwort kopiert' : 'Antwort kopieren'}>
        <CopyIcon copied={copied} /><span>{copied ? 'Kopiert' : copyState === 'copying' ? 'Kopiere …' : 'Kopieren'}</span>
      </button>}
    </div>
    <p>{caption.text}</p>
    {copied && <span className="chat-copy-feedback" role="status">Antwort in die Zwischenablage kopiert.</span>}
    {copyState === 'error' && <span className="chat-copy-feedback chat-copy-error" role="alert">
      Kopieren fehlgeschlagen. Versuche es erneut oder markiere den Text und drücke Strg+C.
    </span>}
  </article>
}

interface ScrollAnchor { id: string; offset: number }

/** Remember the first visible message, including when the store drops its oldest entries. */
function readAnchor(element: HTMLElement): ScrollAnchor | null {
  const top = element.getBoundingClientRect().top
  for (const message of element.querySelectorAll<HTMLElement>('[data-caption-id]')) {
    const rect = message.getBoundingClientRect()
    if (rect.bottom > top) return { id: message.dataset.captionId!, offset: rect.top - top }
  }
  return null
}

export function Conversation({ snapshot }: { snapshot: ActivitySnapshot }) {
  const captions = useCrystal(s => s.captions)
  const state = useCrystal(s => s.state)
  const settings = useCrystal(s => s.settings)
  const scroll = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const anchor = useRef<ScrollAnchor | null>(null)
  const lastCaptions = useRef(captions)
  const [away, setAway] = useState(false)
  const [hasNew, setHasNew] = useState(false)
  const failed = snapshot.items.some(i => i.status === 'error')
  const suggestions = failed
    ? ['Was ist fehlgeschlagen?', 'Versuche einen anderen Lösungsweg']
    : captions.length ? ['Fasse das Ergebnis zusammen', 'Was ist der nächste Schritt?']
      : ['Was kannst du für mich tun?', 'Plane meinen Tag', 'Hilf mir bei einer Aufgabe']
  const busy = ['thinking', 'tool', 'connecting', 'speaking', 'confirm'].includes(state)

  const alignScroll = (): void => {
    const element = scroll.current
    if (!element) return
    if (follow.current) {
      element.scrollTop = element.scrollHeight
    } else if (anchor.current) {
      const message = element.querySelector<HTMLElement>(`[data-caption-id="${anchor.current.id}"]`)
      if (message) element.scrollTop += message.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.current.offset
      else element.scrollTop = 0
    }
    anchor.current = readAnchor(element)
  }

  useLayoutEffect(() => {
    if (captions !== lastCaptions.current && !follow.current) setHasNew(true)
    lastCaptions.current = captions
    if (!captions.length) {
      follow.current = true
      setAway(false)
      setHasNew(false)
    }
    alignScroll()
  }, [captions])

  useEffect(() => {
    const observer = new ResizeObserver(alignScroll)
    if (scroll.current) observer.observe(scroll.current)
    if (content.current) observer.observe(content.current)
    return () => observer.disconnect()
  }, [])

  const updateScroll = (): void => {
    const element = scroll.current
    if (!element) return
    follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
    setAway(!follow.current)
    if (follow.current) setHasNew(false)
    anchor.current = readAnchor(element)
  }

  const jumpToLatest = (): void => {
    follow.current = true
    setAway(false)
    setHasNew(false)
    alignScroll()
    scroll.current?.focus({ preventScroll: true })
  }

  return <section className="conversation" aria-label="Gespräch mit James" data-has-messages={captions.length > 0}>
    {captions.length > 0 && <header className="conversation-head">
      <div><h2>Dein Gespräch <span>{captions.length}</span></h2><p role="status">{STATUS[state]}</p></div>
      <span className="conversation-live" data-active={busy} aria-hidden="true"><i />{busy ? 'Live' : 'Verlauf'}</span>
    </header>}
    <div className="conversation-scroll" ref={scroll} onScroll={updateScroll} tabIndex={captions.length ? 0 : -1}
      aria-label="Gesprächsverlauf" role={captions.length ? 'region' : undefined}>
      <div ref={content} className="conversation-messages">{captions.map(c => <Message key={c.id} caption={c} />)}</div>
    </div>
    {away && <div className="conversation-jump"><button type="button" onClick={jumpToLatest}>
      <span aria-hidden="true">↓</span>{hasNew ? 'Neue Nachrichten' : 'Zur neuesten Nachricht'}
    </button></div>}
    <div className="chat-suggestions" aria-label="Passende Vorschläge">
      {!captions.length && <span className="chat-suggestions-label">Ein guter Anfang</span>}
      {suggestions.map(text => <button type="button" key={text} disabled={busy || !settings}
        title={!settings ? 'Einstellungen werden geladen' : busy ? 'James bearbeitet gerade deine Anfrage' : undefined}
        onClick={() => window.dispatchEvent(new CustomEvent('jarvis:text', { detail: text }))}>{text}<span aria-hidden="true">↗</span></button>)}
    </div>
  </section>
}
