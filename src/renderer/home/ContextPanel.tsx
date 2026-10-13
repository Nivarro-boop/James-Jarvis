import { useEffect, useState } from 'react'
import type { WorkingContext } from '@shared/workingContext'
import { useCrystal } from '../store/crystalStore'

export function ContextPanel() {
  const [context, setContext] = useState<WorkingContext | null>(null)
  const [error, setError] = useState('')
  const [clearing, setClearing] = useState(false)
  const state = useCrystal(s => s.state)
  const busy = ['thinking', 'speaking', 'tool', 'research', 'confirm', 'connecting'].includes(state)
  useEffect(() => {
    let alive = true
    let updated = false
    const off = window.jarvis.on('context:changed', c => { updated = true; if (alive) setContext(c) })
    void window.jarvis.invoke('context:get').then(c => { if (alive && !updated) setContext(c) }).catch(() => { if (alive) setError('Arbeitsstand konnte nicht geladen werden.') })
    return () => { alive = false; off() }
  }, [])
  async function clear() {
    setClearing(true); setError('')
    try { await window.jarvis.invoke('context:clear'); useCrystal.getState().clearCaptions() }
    catch (e) { setError(e instanceof Error ? e.message : 'Zurücksetzen fehlgeschlagen.') }
    finally { setClearing(false) }
  }
  if (!context) return error ? <p role="alert">{error}</p> : null
  if (!context.goal) return <details className="context-manage"><summary>Gesprächskontext verwalten</summary><p>Letzte Gesprächsbeiträge werden lokal für den Anschluss an das Gespräch gespeichert. Noch kein Arbeitsplan vorhanden.</p>{error && <p role="alert">{error}</p>}<button disabled={busy || clearing} onClick={() => void clear()}>{clearing ? 'Wird zurückgesetzt…' : 'Kontext und Verlauf löschen'}</button></details>
  const next = context?.next ?? []
  return <section className="home-card context-panel" aria-label="Arbeitsgedächtnis">
    {error && <p role="alert">{error}</p>}
    {context?.goal && <>
      <div className="home-card-head"><span className="home-card-tag">Arbeitsgedächtnis</span><span>{context.status === 'done' ? 'Abgeschlossen' : context.status === 'paused' ? 'Zum Wiederaufnehmen' : 'Aktuelle Aufgabe'}</span></div>
      <h2>{context.goal}</h2>
      <div className="context-progress">{context.completed.length} erledigt · {next.length} nächste Schritte</div>
      {next.length > 0 && <p><strong>Als Nächstes:</strong> {next[0]}</p>}
      {context.blockers.length > 0 && <p className="context-blocker"><strong>Blockiert:</strong> {context.blockers.join(' · ')}</p>}
      <details><summary>Gespeicherten Kontext ansehen</summary>
        {[['Entscheidungen', context.decisions], ['Erledigt', context.completed], ['Nächste Schritte', next], ['Blockaden', context.blockers]].map(([label, list]) => <div key={String(label)}><h3>{String(label)}</h3><ul>{(list as string[]).map((text, i) => <li key={i}>{text}</li>)}</ul></div>)}
        <small>Lokal gespeichert. Notizen ersetzen keine Prüfung. Aktualisiert: {new Date(context.updatedAt).toLocaleString('de-DE')}</small>
      </details>
      <div className="answer-actions">
        {context.status !== 'done' && <button disabled={busy || clearing} onClick={() => window.dispatchEvent(new CustomEvent('jarvis:text', { detail: `Setze meine Aufgabe „${context.goal}“ anhand des gespeicherten Arbeitsstands fort. Prüfe zuerst den aktuellen Zustand und beachte meine bisherigen Einschränkungen.` }))}>Aufgabe fortsetzen</button>}
        <details><summary>Zurücksetzen</summary><p>Entfernt Arbeitsstand und lokal gespeicherten Gesprächsverlauf. Gelernte Fertigkeiten und Erinnerungen bleiben erhalten.</p><button disabled={busy || clearing} onClick={() => void clear()}>{clearing ? 'Wird zurückgesetzt…' : 'Kontext und Verlauf löschen'}</button></details>
      </div>
    </>}
  </section>
}
