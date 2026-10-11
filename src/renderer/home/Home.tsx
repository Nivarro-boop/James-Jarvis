import { useEffect, useState, type CSSProperties, type FormEvent, type JSX } from 'react'
import { ORB_LOOKS, PixelOrb } from '../crystal/PixelOrb'
import { useCrystal } from '../store/crystalStore'
import { ActivityPanel, ActivityToggle, useActivityPanel } from './ActivityPanel'
import { useDisplayCards } from './StockCard'
import { AnswerCard } from './AnswerCard'
import { LiveStage } from './LiveStage'
import { WeatherCard } from './WeatherCard'
import { HealthPanel } from './HealthPanel'
import { UpdateBar, useUpdateStatus } from './UpdateBar'
import type { ResearchRun, TimerEntry } from '@shared/types'

/**
 * Die Startseite im Design „James GUI".
 *
 * VHS und Röhrenfernseher: tiefes Lila, Magenta, Cyan, Gelb; die Kugel aus
 * groben Pixeln, darunter der Zustand in Pixelschrift und in seiner Farbe.
 * Was gerade im Hintergrund läuft — Timer, Recherchen —, steht als Karte
 * unter der Kugel, statt nur auf Nachfrage gesagt zu werden.
 *
 * Getippt wird weiterhin unten in der Zeile. Die Antwort kommt gesprochen.
 */

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
}

function mmss(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const two = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`
}

function GearIcon(): JSX.Element {
  const teeth = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4
    return (
      <line key={i} x1={12 + Math.cos(a) * 6.4} y1={12 + Math.sin(a) * 6.4} x2={12 + Math.cos(a) * 9.4} y2={12 + Math.sin(a) * 9.4} />
    )
  })
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="6.4" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="12" cy="12" r="2.4" stroke="currentColor" strokeWidth="1.7" opacity="0.75" />
      <g stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
        {teeth}
      </g>
    </svg>
  )
}

function CloseIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true">
      <path d="M5 5l14 14M19 5L5 19" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

function SendIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">
      <path d="M4 12h14M12 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="square" />
    </svg>
  )
}

function openSettings(section?: string): void {
  void window.jarvis.invoke('app:openSettings', section ? { section } : undefined)
}

/** Schickt Text wie die Eingabezeile — über den Controller in `crystal.tsx`. */
function sendText(text: string, onResult?: (sent: boolean) => void): void {
  window.dispatchEvent(new CustomEvent('jarvis:text', { detail: onResult ? { text, onResult } : text }))
}

function TextBar({ disabled }: { disabled: boolean }): JSX.Element {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const message = text.trim()
    if (!message || disabled || sending) return
    setSending(true)
    // Sofort leeren: Der Aufbau der Sitzung dauert, und ein stehen
    // gebliebener Satz sieht aus, als wäre nichts passiert.
    setText('')
    sendText(message, (sent) => {
      setSending(false)
      if (!sent) setText(draft => draft || message)
    })
  }

  return (
    <form className="home-ask" onSubmit={submit} aria-busy={sending}>
      <input
        type="text"
        className="home-ask-field"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={disabled ? 'Erst einrichten — oben rechts' : 'Oder tippen…'}
        aria-label="Nachricht an James"
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        maxLength={2000}
      />
      <button type="submit" className="home-ask-send" aria-label="Abschicken" title={sending ? 'Nachricht wird gesendet…' : 'Abschicken'} disabled={disabled || sending || !text.trim()}>
        <SendIcon />
      </button>
    </form>
  )
}

/** Laufende Timer. Neu geladen alle fünf Sekunden und wenn einer abläuft. */
function useTimers(): TimerEntry[] {
  const [timers, setTimers] = useState<TimerEntry[]>([])
  const [, tick] = useState(0)

  useEffect(() => {
    let disposed = false
    const load = (): void => {
      void window.jarvis
        .invoke('timers:list')
        .then((list) => !disposed && setTimers(list.filter((t) => !t.fired)))
        .catch(() => undefined)
    }
    load()
    const poll = window.setInterval(load, 5000)
    const clock = window.setInterval(() => tick((n) => n + 1), 1000)
    const off = window.jarvis.on('timer:due', load)
    return () => {
      disposed = true
      window.clearInterval(poll)
      window.clearInterval(clock)
      off()
    }
  }, [])

  return timers.filter((t) => t.dueAt > Date.now() - 1000)
}

/**
 * Recherchen von heute: die laufenden und die zuletzt fertige.
 *
 * Eine fertige Karte bleibt, bis man sie wegklickt oder den Bericht öffnet —
 * die gesprochene Zusammenfassung geht sonst im Raum verloren.
 */
function useResearch(): { runs: ResearchRun[]; thoughts: Record<string, string>; dismiss: (id: string) => void } {
  const [runs, setRuns] = useState<ResearchRun[]>([])
  const [thoughts, setThoughts] = useState<Record<string, string>>({})
  const [dismissed, setDismissed] = useState<string[]>([])

  useEffect(() => {
    let disposed = false
    const seen: Record<string, true> = {}
    const load = (): void => {
      void window.jarvis
        .invoke('research:list')
        .then((list) => {
          if (disposed) return
          for (const r of list) seen[r.id] = true
          setRuns(list)
        })
        .catch(() => undefined)
    }
    load()
    const offProgress = window.jarvis.on('research:progress', ({ id, thought }) => {
      // Eine neue Recherche meldet sich zuerst hier — dann die Liste holen.
      if (!(id in seen)) load()
      seen[id] = true
      setThoughts((prev) => ({ ...prev, [id]: thought }))
    })
    const offDone = window.jarvis.on('research:done', load)
    return () => {
      disposed = true
      offProgress()
      offDone()
    }
  }, [])

  const since = Date.now() - 12 * 60 * 60 * 1000
  const running = runs.filter((r) => r.status === 'in_progress')
  const finished = runs
    .filter((r) => r.status !== 'in_progress' && (r.finishedAt ?? 0) > since && !dismissed.includes(r.id))
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .slice(0, 1)

  return {
    runs: [...running, ...finished],
    thoughts,
    dismiss: (id) => setDismissed((prev) => [...prev, id])
  }
}

function ResearchCard({ run, thought, onDismiss }: { run: ResearchRun; thought?: string; onDismiss: () => void }): JSX.Element {
  const done = run.status === 'completed'
  const failed = run.status === 'failed'
  const minutes = Math.max(1, Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 60000))
  return (
    <section className="home-card home-card-research" data-done={done ? 'true' : 'false'} data-failed={failed ? 'true' : 'false'}>
      <div className="home-card-head">
        <span className="home-card-tag">{done ? 'Recherche fertig' : failed ? 'Recherche gescheitert' : 'Recherche'}</span>
        <span className="home-card-meta">{minutes} min</span>
      </div>
      <div className="home-card-title">{run.query}</div>
      {!done && !failed && <div className="home-progress" aria-hidden="true"><span /></div>}
      <div className="home-card-foot">
        <span className="home-card-note">{done ? 'Bericht liegt bereit' : failed ? 'Ohne Ergebnis' : thought || 'Meldet sich von selbst'}</span>
        {done ? (
          <button className="home-btn-pop" onClick={() => { onDismiss(); openSettings('research') }}>
            Bericht lesen
          </button>
        ) : failed ? (
          <button className="home-card-x" title="Ausblenden" aria-label="Ausblenden" onClick={onDismiss}>
            <CloseIcon />
          </button>
        ) : null}
      </div>
    </section>
  )
}

function TimerCard({ timer }: { timer: TimerEntry }): JSX.Element {
  return (
    <section className="home-card home-card-timer">
      <div className="home-card-body">
        <span className="home-card-tag">Timer</span>
        <div className="home-card-title">{timer.label}</div>
      </div>
      <span className="home-timer-time">{mmss(timer.dueAt - Date.now())}</span>
      <button
        className="home-card-x"
        title="Stoppen"
        aria-label={`Timer ${timer.label} stoppen`}
        onClick={() => void window.jarvis.invoke('timers:cancel', { id: timer.id })}
      >
        <CloseIcon />
      </button>
    </section>
  )
}

/**
 * Die Rückfrage als Dialog.
 *
 * James stellt sie laut, und „ja" oder „nein" sagen genügt. Die Knöpfe
 * schicken dasselbe Wort als getippte Antwort — derselbe Weg, dieselbe
 * Prüfung im Hauptprozess, kein zweiter Freigabekanal.
 */
function ConfirmDialog({ toolName, question }: { toolName: string; question: string }): JSX.Element {
  return (
    <div className="home-modal">
      <div className="home-dialog" role="dialog" aria-modal="true" aria-labelledby="home-dialog-q">
        <div className="home-dialog-head">
          <span className="home-card-tag">Rückfrage</span>
          <code>{toolName}</code>
        </div>
        <p id="home-dialog-q" className="home-dialog-q">{question}</p>
        <div className="home-dialog-actions">
          <button className="home-btn-yes" onClick={() => sendText('Ja')} autoFocus>
            Ja
          </button>
          <button className="home-btn-no" onClick={() => sendText('Nein')}>
            Nein
          </button>
        </div>
        <p className="home-dialog-note">Oder einfach „ja" oder „nein" sagen.</p>
      </div>
    </div>
  )
}

export function Home(): JSX.Element {
  const state = useCrystal((s) => s.state)
  const paused = useCrystal((s) => s.paused)
  const pauseUntil = useCrystal((s) => s.pauseUntil)
  const lastError = useCrystal((s) => s.lastError)
  const confirmation = useCrystal((s) => s.confirmation)
  const settings = useCrystal((s) => s.settings)
  const wakeAvailable = useCrystal((s) => s.wakeAvailable)
  const [hasVoiceAccess, setHasVoiceAccess] = useState(true)
  const [wakePhrase, setWakePhrase] = useState('Hey James')
  const activity = useActivityPanel()
  const timers = useTimers()
  const research = useResearch()
  const display = useDisplayCards()
  const update = useUpdateStatus()

  // Der Schlüssel wird im Einstellungsfenster gesetzt — beim Zurückkommen
  // erneut nachsehen, sonst fehlt hier minutenlang etwas, das längst da ist.
  useEffect(() => {
    let disposed = false
    const check = async (): Promise<void> => {
      try {
        const wakeStatus = await window.jarvis.invoke('wake:status')
        if (!disposed) setWakePhrase(wakeStatus.model.includes('jarvis') ? 'Hey Jarvis' : 'Hey James')
        const status = await window.jarvis.invoke('secrets:status')
        const speech = settings?.speech
        const key = speech?.provider === 'openai' ? 'openai' : 'gemini'
        const local = speech && !['gemini', 'openai'].includes(speech.provider)
        const ready = local && speech.thinkProvider === 'ollama' ? true
          : local && speech.thinkProvider === 'hermes' ? (await window.jarvis.invoke('hermes:health')).ok
          : local && speech.thinkProvider === 'chatgpt' ? (await window.jarvis.invoke('chatgpt:status')).connected
          : status.some((s) => s.key === key && s.present)
        if (!disposed) setHasVoiceAccess(ready)
      } catch {
        // Kein Grund, die Startseite deswegen anders aussehen zu lassen.
      }
    }
    void check()
    window.addEventListener('focus', check)
    return () => {
      disposed = true
      window.removeEventListener('focus', check)
    }
  }, [settings?.speech.provider, settings?.speech.thinkProvider])

  const hotkey = settings?.wake.pushToTalkHotkey || 'Alt+Space'

  let hint: string
  // Nur die Bedienungsanleitung darf verblassen. Fehler, Rückfrage und
  // fehlender Schlüssel bleiben stehen, bis sie erledigt sind.
  if (state === 'error' && lastError) {
    hint = lastError
  } else if (!hasVoiceAccess) {
    hint = 'Öffne Einstellungen → Stimme, um deinen Sprachzugang einzurichten.'
  } else if (state === 'confirm' && confirmation) {
    hint = confirmation.spokenQuestion
  } else if (paused) {
    hint =
      pauseUntil === null
        ? 'Kein Mikrofon, kein Weckwort. Klick auf die Kugel holt ihn zurück.'
        : `Kein Mikrofon, kein Weckwort. Um ${clockTime(pauseUntil)} kommt er von selbst zurück — ein Klick auf die Kugel früher.`
  } else if (state === 'research') {
    hint = 'Läuft im Hintergrund — rede ruhig weiter.'
  } else if (state === 'offline') {
    hint = 'Kein Netz. Lokale Funktionen und Hotkey bleiben verfügbar.'
  } else {
    hint = wakeAvailable && settings?.wake.enabled
      ? `„${wakePhrase}" sagen, ${hotkey} drücken oder die Kugel anklicken.`
      : `${hotkey} drücken oder die Kugel anklicken.${settings?.wake.enabled && wakeAvailable === false ? ' Weckwort-Modell fehlt oder konnte nicht geladen werden.' : ''}`
  }

  const look = ORB_LOOKS[state] ?? ORB_LOOKS.idle
  const tone = { '--state': look.c } as CSSProperties
  const activeResearch = research.runs.filter(run => run.status === 'in_progress')
  const hasCards = timers.length > 0 || activeResearch.length > 0 || display.cards.length > 0

  return (
    <div className="home" data-state={state} style={tone}>
      <header className="home-bar">
        <div className="home-top-left">
          <ActivityToggle open={activity.open} busy={activity.busy} onToggle={activity.toggle} />
          <span className="home-brand"><span className="home-mark">James<span className="brand-dot">.</span></span></span>
        </div>
        <div className="home-actions">
          <HealthPanel />
          <button className="home-gear" title="Einstellungen" aria-label="Einstellungen" onClick={() => openSettings()}>
            <GearIcon /><span>Einstellungen</span>
          </button>
        </div>
      </header>

      <UpdateBar status={update} state={state} />

      <div className="home-main">
        <div className="home-center">
          <main className="home-stage">
            <PixelOrb />
            <h1>{paused ? 'Ich bin gleich wieder da.' : ['thinking', 'tool', 'research'].includes(state) ? 'Ich kümmere mich darum.' : state === 'speaking' ? 'Hier ist meine Antwort.' : 'Wie kann ich dir helfen?'}</h1>
            <p className="home-hint" role={state === 'error' ? 'alert' : undefined}>{hint}</p>
          </main>
          <WeatherCard />
          <div className="home-context">
            {hasCards && (
              <div className="home-cards">
                {display.cards.map((card) => (
                  <AnswerCard key={card.id} card={card} onDismiss={() => display.dismiss(card.id)} />
                ))}
                {activeResearch.map((run) => (
                  <ResearchCard key={run.id} run={run} thought={research.thoughts[run.id]} onDismiss={() => research.dismiss(run.id)} />
                ))}
                {timers.map((timer) => (
                  <TimerCard key={timer.id} timer={timer} />
                ))}
              </div>
            )}

          </div>
        </div>

        {activity.open && <ActivityPanel snapshot={activity.snapshot} />}
      </div>

      <footer className="home-dock">
        <LiveStage snapshot={activity.snapshot} />
        <TextBar disabled={!settings} />
      </footer>

      {state === 'confirm' && confirmation && (
        <ConfirmDialog toolName={confirmation.toolName} question={confirmation.spokenQuestion} />
      )}
    </div>
  )
}
