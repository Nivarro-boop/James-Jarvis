import { SkillsPanel } from './SkillsPanel'
import { SkillProposalPanel } from './SkillProposalPanel'
import { useEffect, useState, type CSSProperties, type JSX } from 'react'
import { ORB_LOOKS, PixelOrb } from '../crystal/PixelOrb'
import { useCrystal } from '../store/crystalStore'
import { useActivityPanel } from './ActivityPanel'
import { useDisplayCards } from './StockCard'
import { AnswerCard } from './AnswerCard'
import { LiveStage } from './LiveStage'
import { WeatherCard } from './WeatherCard'
import { useHealthSummary } from './HealthPanel'
import { UpdateBar, useUpdateStatus } from './UpdateBar'
import { BrainMap, WidgetTiles } from './BrainMap'
import { Clock, ConnectionPill, MainMenu } from './TopBar'
import { FirstRun } from './FirstRun'
import { QuizPanel } from './QuizPanel'
import { CommandBar, ConversationHistory } from './CommandBar'
import type { ResearchRun, TimerEntry } from '@shared/types'

/**
 * The orb makes voice state visible; the compact workspace leaves room for
 * conversations and results. The composer stays reachable at every window size.
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

function CloseIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true">
      <path d="M5 5l14 14M19 5L5 19" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
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

/** Laufende Timer. Neu geladen alle fünf Sekunden und wenn einer abläuft. */
function useTimers(): TimerEntry[] {
  const [timers, setTimers] = useState<TimerEntry[]>([])

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
    const off = window.jarvis.on('timer:due', load)
    return () => {
      disposed = true
      window.clearInterval(poll)
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
  const [, tick] = useState(0)
  const [cancelled, setCancelled] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => {
    if (cancelled) return
    const clock = window.setInterval(() => tick(n => n + 1), 1000)
    return () => window.clearInterval(clock)
  }, [cancelled])
  if (cancelled || timer.dueAt <= Date.now()) return <></>
  return (
    <section className="home-card home-card-timer">
      <div className="home-card-body">
        <span className="home-card-tag">Timer</span>
        <div className="home-card-title">{timer.label}</div>
        {error && <small role="alert">Stoppen fehlgeschlagen. Bitte erneut versuchen.</small>}
      </div>
      <span className="home-timer-time">{mmss(timer.dueAt - Date.now())}</span>
      <button
        className="home-card-x"
        title="Stoppen"
        aria-label={`Timer ${timer.label} stoppen`}
        disabled={cancelling}
        onClick={() => {
          setCancelling(true)
          setError(false)
          void window.jarvis.invoke('timers:cancel', { id: timer.id })
            .then(() => setCancelled(true))
            .catch(() => setError(true))
            .finally(() => setCancelling(false))
        }}
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
  const hasConversation = useCrystal((s) => s.captions.length > 0)
  const [hasVoiceAccess, setHasVoiceAccess] = useState(true)
  const [wakePhrase, setWakePhrase] = useState('Hey James')
  const activity = useActivityPanel()
  const timers = useTimers()
  const research = useResearch()
  const display = useDisplayCards()
  const health = useHealthSummary()
  const update = useUpdateStatus()
  const [brainOpen, setBrainOpen] = useState(false)

  // Der Schlüssel wird im Einstellungsfenster gesetzt — beim Zurückkommen
  // erneut nachsehen, sonst fehlt hier minutenlang etwas, das längst da ist.
  useEffect(() => {
    let disposed = false
    const check = async (): Promise<void> => {
      try {
        const wakeStatus = await window.jarvis.invoke('wake:status')
        if (!disposed) setWakePhrase(wakeStatus.model.includes('jarvis') ? 'Hey Jarvis' : 'Hey James')
        if (wakeStatus.model === 'personal.onnx') {
          const personal = await window.jarvis.invoke('wake:personal').catch(() => null)
          if (!disposed && personal) setWakePhrase(personal.phrase)
        }
        const status = await window.jarvis.invoke('secrets:status')
        const speech = settings?.speech
        const key = speech?.provider === 'openai' ? 'openai' : 'gemini'
        const local = speech && !['gemini', 'openai'].includes(speech.provider)
        const ready = local && speech.thinkProvider === 'ollama' ? true
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
  const hasCards = timers.length > 0 || research.runs.length > 0 || display.cards.length > 0
  const statusLabel = paused ? 'Pausiert' : !hasVoiceAccess && state === 'idle' ? 'Sprachzugang fehlt' : ({ idle: 'Bereit für dich', connecting: 'Verbindet sich', listening: 'Hört zu', thinking: 'Denkt nach', tool: 'Arbeitet für dich', speaking: 'Spricht', research: 'Recherchiert', confirm: 'Braucht deine Freigabe', error: 'Prüfung erforderlich', offline: 'Offline', paused: 'Pausiert' })[state]
  const heading = paused ? 'Ich bin gleich wieder da.'
    : state === 'listening' ? 'Ich höre dir zu.'
    : state === 'connecting' ? 'Einen Moment, ich verbinde mich.'
    : ['thinking', 'tool', 'research'].includes(state) ? 'Ich kümmere mich darum.'
    : state === 'speaking' ? 'Hier ist meine Antwort.'
    : state === 'confirm' ? 'Wie möchtest du fortfahren?'
    : state === 'error' ? 'Etwas ist schiefgelaufen.'
    : 'Was gibt’s Neues?'

  const healthy = health.problems === 0
  const healthLine = health.loading ? 'Prüfe, ob alles läuft …'
    : healthy ? 'Keine Fehlermeldungen'
    : health.problems === 1 ? '1 Fehler' : `${health.problems} Fehler`

  return (
    <div className="home james-ui" data-state={state} data-compact={hasConversation || hasCards} style={tone}>
      <header className="home-bar">
        <div className="home-top-left">
          <span className="home-brand"><span className="home-mark">James<span className="brand-dot">.</span></span><small>DEIN ASSISTENT</small></span>
          {(() => {
            // Statt live zuzusehen: nur der aktuelle Schritt als eine Zeile oben.
            const now = activity.snapshot.items.find((i) => i.status === 'running' || i.status === 'waiting')
            return now && <span className="home-status" role="status" title={now.label}>{now.status === 'waiting' ? 'Wartet auf dich · ' : ''}{now.label}</span>
          })()}
        </div>
        <div className="home-actions">
          <button className="home-health" data-ok={healthy} data-loading={health.loading} title={health.first || healthLine}
            onClick={() => openSettings('diagnose')}><i aria-hidden="true" />{healthLine}</button>
          {!healthy && !health.loading && (
            <button className="home-health-fix" disabled={health.fixing} title={health.first || undefined}
              onClick={() => void health.fix()}>
              {health.fixing ? 'Repariere …' : health.note || (health.reporting ? 'Beheben & senden' : 'Beheben')}
            </button>
          )}
          <ConnectionPill ready={hasVoiceAccess} />
          <Clock />
          <MainMenu onBrain={() => setBrainOpen(true)} />
        </div>
      </header>

      <UpdateBar status={update} state={state} />

      <div className="home-main">
        <div className="home-center">
          <main className="home-stage">
            <div className="home-orb-wrap"><PixelOrb /></div>
            <div className="home-stage-copy">
              <span className="home-presence"><i aria-hidden="true" />{statusLabel}</span>
              <h1>{heading}</h1>
              <p className="home-hint" role={state === 'error' ? 'alert' : undefined}>{hint}</p>
              <div className="home-voice-actions">
              <button className="voice-start" onClick={() => window.dispatchEvent(new Event('jarvis:press'))}>
                {state === 'listening' ? 'Zuhören beenden' : paused ? 'James aktivieren' : 'Mit James sprechen'}
              </button>
              <button className="home-mute" data-muted={paused} aria-pressed={paused}
                aria-label={paused ? 'Stummschaltung aufheben' : 'Stumm schalten'}
                onClick={() => window.dispatchEvent(new Event('jarvis:togglePause'))}>
                {paused ? 'Mikrofon aktivieren' : 'Mikrofon pausieren'}
              </button>
              </div>
            </div>
          </main>
          <nav className="home-shortcuts" aria-label="Schnellzugriff">
            <button onClick={() => window.dispatchEvent(new Event('jarvis:learn'))}><span aria-hidden="true">01</span><strong>Lernen & Quiz</strong><small>Wissen festigen</small><i aria-hidden="true">↗</i></button>
            <button onClick={() => setBrainOpen(true)}><span aria-hidden="true">02</span><strong>Gehirn & Projekte</strong><small>Gedanken weiterführen</small><i aria-hidden="true">↗</i></button>
            <button onClick={() => openSettings('connections')}><span aria-hidden="true">03</span><strong>Verbindungen</strong><small>Deine Dienste verbinden</small><i aria-hidden="true">↗</i></button>
          </nav>
          <FirstRun ready={hasVoiceAccess} />
          <QuizPanel />
          <SkillsPanel />
          <SkillProposalPanel />
          <WeatherCard />
          <WidgetTiles />
          <ConversationHistory />
          <div className="home-context">
            {hasCards && (
              <div className="home-cards">
                {display.cards.map((card) => (
                  <AnswerCard key={card.id} card={card} onDismiss={() => display.dismiss(card.id)} />
                ))}
                {research.runs.map((run) => (
                  <ResearchCard key={run.id} run={run} thought={research.thoughts[run.id]} onDismiss={() => research.dismiss(run.id)} />
                ))}
                {timers.map((timer) => (
                  <TimerCard key={timer.id} timer={timer} />
                ))}
              </div>
            )}

          </div>
        </div>

      </div>

      <footer className="home-dock">
        <LiveStage snapshot={activity.snapshot} />
        <CommandBar />
      </footer>


      {brainOpen && <BrainMap onClose={() => setBrainOpen(false)} />}

      {state === 'confirm' && confirmation && (
        <ConfirmDialog toolName={confirmation.toolName} question={confirmation.spokenQuestion} />
      )}
    </div>
  )
}
