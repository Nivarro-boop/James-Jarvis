import { useEffect, useRef, useState, type JSX } from 'react'
import type { QuizQuestion } from '@shared/ipc'
import type { StudyStats } from '@shared/study'

type Deck = { id: string; title: string; stats: StudyStats }
type Feedback = { correct: boolean; solution: string; given: string }

/**
 * Lernen & Quiz auf der Startseite. Fragen, Prüfen und Planen laufen im
 * Hauptprozess ohne Modell — ein Quiz hier kostet keine Tokens.
 */
export function QuizPanel(): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [decks, setDecks] = useState<Deck[]>([])
  const [question, setQuestion] = useState<QuizQuestion | null>(null)
  const [answer, setAnswer] = useState('')
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const request = useRef(0)
  const locked = useRef(false)
  const [busy, setBusy] = useState(false)

  const loadDecks = (): void => {
    const id = ++request.current
    locked.current = true; setBusy(true); setError('')
    void window.jarvis.invoke('study:decks').then(result => { if (id === request.current) setDecks(result) })
      .catch(e => { if (id === request.current) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (id === request.current) { locked.current = false; setBusy(false) } })
  }
  const start = (deckId: string, skip?: string): void => {
    const id = ++request.current
    locked.current = true; setBusy(true)
    setQuestion(null); setFeedback(null); setAnswer(''); setError('')
    void window.jarvis.invoke('study:next', { deckId, skip }).then(q => {
      if (id !== request.current) return
      setQuestion(q)
      requestAnimationFrame(() => { if (id === request.current) input.current?.focus() })
    }).catch(e => { if (id === request.current) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (id === request.current) { locked.current = false; setBusy(false) } })
  }

  useEffect(() => {
    const toggle = (): void => { ++request.current; locked.current = false; setBusy(false); setQuestion(null); setFeedback(null); setOpen(v => !v) }
    window.addEventListener('jarvis:learn', toggle)
    const off = window.jarvis.on('study:open', ({ deckId }) => {
      setOpen(true)
      if (deckId) start(deckId)
      else { setQuestion(null); setFeedback(null); loadDecks() }
    })
    return () => { ++request.current; window.removeEventListener('jarvis:learn', toggle); off() }
  }, [])
  useEffect(() => { if (open && !locked.current) loadDecks() }, [open])

  if (!open) return null

  const submit = (given: string): void => {
    if (!question || 'done' in question || feedback || !given.trim() || locked.current) return
    const id = ++request.current
    locked.current = true; setBusy(true); setError('')
    void window.jarvis.invoke('study:answer', { deckId: question.deckId, cardId: question.cardId, questionToken: question.questionToken, answer: given })
      .then(r => { if (id === request.current) { setFeedback({ correct: r.correct, solution: r.solution, given }); setQuestion({ ...question, stats: r.stats }) } })
      .catch(e => { if (id === request.current) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (id === request.current) { locked.current = false; setBusy(false) } })
  }
  const close = (): void => { ++request.current; locked.current = false; setBusy(false); setOpen(false); setQuestion(null); setFeedback(null) }

  return <section className="home-card quiz-panel" aria-label="Lernen und Quiz" aria-busy={busy}>
    <div className="home-card-head">
      <span className="home-card-tag">{question ? question.deckTitle : 'Lernen & Quiz'}</span>
      <button className="home-card-x" aria-label="Quiz schließen" onClick={close}>×</button>
    </div>

    {busy && <p role="status" className="quiz-meta">Einen Moment …</p>}
    {!question && !busy && !error && <>
      {decks.length === 0
        ? <p className="quiz-empty">Noch keine Lernkarten. Sag zum Beispiel: „Mach mir ein Quiz zu den Hauptstädten Europas.“</p>
        : <ul className="quiz-decks">{decks.map(d => <li key={d.id}>
          <button onClick={() => start(d.id)}>
            <strong>{d.title}</strong>
            <small>{d.stats.due ? `${d.stats.due} fällig` : 'nichts fällig'} · {d.stats.learned}/{d.stats.total} gelernt</small>
          </button>
        </li>)}</ul>}
    </>}

    {question && 'done' in question && <div className="quiz-done">
      <strong>Für jetzt alles gelernt.</strong>
      <p>{question.stats.learned}/{question.stats.total} Karten sitzen. Die nächsten werden später wieder fällig.</p>
      <button onClick={() => { setQuestion(null); loadDecks() }}>Zur Übersicht</button>
    </div>}

    {question && !('done' in question) && <div className="quiz-card">
      <p className="quiz-meta">{question.stats.due} fällig · {question.stats.learned}/{question.stats.total} gelernt</p>
      <h3>{question.question}</h3>
      {question.options
        ? <div className="quiz-options">{question.options.map((o, i) => <button key={o}
            data-state={feedback ? (o === feedback.solution ? 'right' : o === feedback.given ? 'wrong' : undefined) : undefined}
            disabled={busy || Boolean(feedback)} onClick={() => submit(o)}>
            <span>{String.fromCharCode(65 + i)}</span>{o}
          </button>)}</div>
        : <form className="quiz-form" onSubmit={e => { e.preventDefault(); submit(answer) }}>
            <input ref={input} aria-label="Deine Antwort" placeholder="Deine Antwort …" value={answer} disabled={busy || Boolean(feedback)} onChange={e => setAnswer(e.target.value)} />
            {!feedback && <button type="submit" disabled={busy || !answer.trim()}>Prüfen</button>}
          </form>}
      {feedback && <div className="quiz-feedback" data-correct={feedback.correct} role="status">
        <strong>{feedback.correct ? 'Richtig.' : 'Nicht ganz.'}</strong>
        {!feedback.correct && <span>Lösung: {feedback.solution}</span>}
        <button autoFocus disabled={busy} onClick={() => start(question.deckId, question.cardId)}>Weiter</button>
      </div>}
    </div>}

    {error && <p role="alert" className="quiz-error">{error}</p>}
    {error && !question && !busy && <button onClick={loadDecks}>Lernstapel erneut laden</button>}
  </section>
}
