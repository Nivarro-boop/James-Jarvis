import { useEffect, useState } from 'react'
import { useCrystal } from '../store/crystalStore'

export function SkillsPanel() {
  const [open, setOpen] = useState(false)
  const [skills, setSkills] = useState<{ name: string; description: string; uses: number; steps: string }[]>([])
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const state = useCrystal(s => s.state)
  const busy = ['thinking', 'tool', 'confirm', 'speaking', 'connecting', 'research'].includes(state)
  useEffect(() => {
    const toggle = () => setOpen(value => !value)
    window.addEventListener('jarvis:skills', toggle)
    return () => window.removeEventListener('jarvis:skills', toggle)
  }, [])
  useEffect(() => {
    if (!open) return
    let alive = true
    const load = () => { void window.jarvis.invoke('skills:list').then(list => { if (alive) { setSkills(list); setError('') } }).catch(() => { if (alive) setError('Fertigkeiten konnten nicht geladen werden.') }) }
    load()
    const off = window.jarvis.on('skills:proposed', load)
    return () => { alive = false; off() }
  }, [open])
  if (!open) return null
  const filtered = skills.filter(s => `${s.name} ${s.description}`.toLocaleLowerCase('de').includes(query.toLocaleLowerCase('de')))
  return <section className="home-card skills-panel" aria-label="Fertigkeiten-Bibliothek">
    <div className="home-card-head"><span className="home-card-tag">Fertigkeiten · {skills.length}</span><button className="home-card-x" aria-label="Fertigkeiten schließen" onClick={() => setOpen(false)}>×</button></div>
    <h2>Was James gelernt hat</h2><p>Gespeicherte Abläufe ansehen und gezielt anwenden.</p>
    <input aria-label="Fertigkeiten suchen" placeholder="Fertigkeit suchen…" value={query} onChange={e => setQuery(e.target.value)} />
    {error && <p role="alert">{error}</p>}
    {!error && filtered.length === 0 && <p>{skills.length ? 'Keine passende Fertigkeit gefunden.' : 'Noch keine Fertigkeiten gespeichert. Neue Lernvorschläge erscheinen nach wiederkehrenden Aufgaben.'}</p>}
    {filtered.map(s => <details key={s.name}><summary>{s.name}<small> · {s.uses}× gelesen</small></summary><p>{s.description}</p><pre>{s.steps}</pre><div className="answer-actions"><button disabled={busy} onClick={() => { window.dispatchEvent(new CustomEvent('jarvis:text', { detail: `Wende die gespeicherte Fertigkeit ${JSON.stringify(s.name)} an. Lies zuerst die Anleitung, prüfe Voraussetzungen und beachte meine Freigaben.` })); setOpen(false) }}>Fertigkeit anwenden</button></div></details>)}
  </section>
}
