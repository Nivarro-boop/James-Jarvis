import { useEffect, useState, type JSX } from 'react'
import type { Settings } from '@shared/types'
import { PersonalWakeTrainer } from './PersonalWake'

type Choice = 'personal.onnx' | 'jarvis.onnx' | 'hey_james.onnx' | 'clap' | 'none'

const OPTIONS: { id: Choice; title: string; say: string; note: string }[] = [
  { id: 'personal.onnx', title: 'Eigenes Wort', say: '🎙', note: 'Dreimal sagen, fertig. Z. B. „Hey James“.' },
  { id: 'jarvis.onnx', title: 'Hey Jarvis', say: '„Hey Jarvis“', note: 'Klassisch. Funktioniert sofort.' },
  { id: 'clap', title: 'Zweimal klatschen', say: '👏👏', note: 'Ganz ohne Wort.' },
  { id: 'none', title: 'Nur per Taste', say: '⌨', note: 'James hört nur, wenn du drückst.' }
]

/**
 * Einrichtung wie bei Siri: Wie soll James geweckt werden?
 *
 * Wählbar ist ein Weckwort, Klatschen oder nur der Knopf. Ein Weckwort, dessen
 * Modell nicht mitgeliefert ist, bleibt sichtbar, aber gesperrt, damit niemand
 * auf ein Wort wartet, das James gar nicht erkennen kann. Klatschen lässt sich
 * zu jedem Weckwort dazunehmen.
 */
export function WakeStep({ settings, patch, onNext }: {
  settings: Settings
  patch: (p: Partial<Settings>) => Promise<Settings>
  onNext: () => void
}): JSX.Element {
  const wake = settings.wake
  const [available, setAvailable] = useState<string[] | null>(null)
  const [training, setTraining] = useState(false)
  useEffect(() => {
    void window.jarvis.invoke('wake:status').then(s => setAvailable(s.available)).catch(() => setAvailable([]))
  }, [])

  const current: Choice = !wake.enabled ? (wake.clap ? 'clap' : 'none') : (wake.modelName as Choice)
  const choose = (id: Choice): void => {
    if (id === 'clap') void patch({ wake: { ...wake, enabled: false, clap: true } })
    else if (id === 'none') void patch({ wake: { ...wake, enabled: false, clap: false } })
    else if (id === 'personal.onnx') setTraining(true)
    else { setTraining(false); void patch({ wake: { ...wake, enabled: true, modelName: id } }) }
  }

  return (
    <div className="setup-card">
      <h1>Wie rufst du James?</h1>
      <p className="setup-lede">Wie bei Siri: Wähle, worauf James hört. Du kannst es später unter Zuhören ändern.</p>
      <div className="wake-options" role="radiogroup" aria-label="Weckwort">
        {OPTIONS.map(o => {
          const missing = o.id !== 'personal.onnx' && o.id.endsWith('.onnx') && available !== null && !available.includes(o.id)
          return (
            <button key={o.id} type="button" role="radio" aria-checked={current === o.id} disabled={missing}
              className={current === o.id || (training && o.id === 'personal.onnx') ? 'wake-option is-active' : 'wake-option'} onClick={() => choose(o.id)}>
              <span className="wake-say">{o.say}</span>
              <strong>{o.title}</strong>
              <small>{missing ? 'Kommt mit einem der nächsten Updates.' : o.note}</small>
            </button>
          )
        })}
      </div>
      {(training || current === 'personal.onnx') && <PersonalWakeTrainer settings={settings} patch={patch} />}
      {wake.enabled && (
        <label className="setup-note">
          <input type="checkbox" checked={wake.clap} onChange={e => void patch({ wake: { ...wake, clap: e.target.checked } })} />
          {' '}Zusätzlich auf zweimal Klatschen reagieren
        </label>
      )}
      <p className="setup-note">Die Erkennung läuft lokal auf deinem Rechner. Per Taste geht es immer: {wake.pushToTalkHotkey}.</p>
      <div className="setup-actions"><button className="primary" onClick={onNext}>Weiter</button></div>
    </div>
  )
}
