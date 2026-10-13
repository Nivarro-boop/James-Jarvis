import { useEffect, useState } from 'react'
import type { SkillProposal } from '@shared/skillProposal'

export function SkillProposalPanel() {
  const [proposals, setProposals] = useState<SkillProposal[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let alive = true
    let updated = false
    const off = window.jarvis.on('skills:proposed', list => { updated = true; if (alive) setProposals(list) })
    void window.jarvis.invoke('skills:proposals').then(list => { if (alive && !updated) setProposals(list) }).catch(() => { if (alive) setError('Lernvorschläge konnten nicht geladen werden.') })
    return () => { alive = false; off() }
  }, [])
  async function decide(p: SkillProposal, accept: boolean) {
    setBusy(p.id); setError(''); setNotice('')
    try {
      await window.jarvis.invoke('skills:decide', { id: p.id, accept })
      setNotice(accept ? `Fertigkeit „${p.name}“ übernommen.` : 'Vorschlag verworfen.')
    } catch (e) { setError(e instanceof Error ? e.message : 'Änderung fehlgeschlagen.') }
    finally { setBusy(null) }
  }
  return <div className="skill-proposals" aria-label="Lernvorschläge">
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {proposals.map(p => <section className="home-card skill-proposal" key={p.id}>
      <div className="home-card-head"><span className="home-card-tag">Selbstverbesserung vorgeschlagen</span><span>{p.previous === null ? 'Neue Fertigkeit' : 'Fertigkeit verbessern'}</span></div>
      <h2>{p.name}</h2><p>{p.description}</p>
      <p>Ich schlage vor, diese Anleitung fürs nächste Mal zu {p.previous === null ? 'lernen' : 'verbessern'}. Mit „Übernehmen“ speichere ich sie.</p>
      <details><summary>Vorschau ansehen</summary>{p.previous !== null && <><h3>Bisher</h3><pre>{p.previous}</pre></>}<h3>Vorschlag</h3><pre>{p.steps}</pre></details>
      <div className="answer-actions"><button disabled={busy !== null} onClick={() => void decide(p, true)}>{busy === p.id ? 'Wird verarbeitet…' : 'Übernehmen'}</button><button disabled={busy !== null} onClick={() => void decide(p, false)}>Verwerfen</button></div>
    </section>)}
  </div>
}
