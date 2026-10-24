import { useId, type JSX } from 'react'

export interface Choice<T extends string> { value: T; label: string; hint?: string }

/**
 * Eine Auswahl als Karten statt als Liste: Titel, ein Satz darunter, ein Punkt
 * davor. Für alles mit wenigen, gut beschreibbaren Möglichkeiten.
 */
export function ChoiceCards<T extends string>({ title, intro, value, options, onChange, disabled }: {
  title: string
  intro?: string
  value: T | ''
  options: Choice<T>[]
  onChange: (value: T) => void
  disabled?: boolean
}): JSX.Element {
  const name = useId()
  return <fieldset className="choice-group" disabled={disabled}>
    <legend className="choice-title">{title}</legend>
    {intro && <p className="choice-intro">{intro}</p>}
    <div className="choice-cards" role="radiogroup" aria-label={title}>
      {options.map(o => <label key={o.value} className="choice-card" data-checked={o.value === value}>
        <input type="radio" name={name} value={o.value} checked={o.value === value} onChange={() => onChange(o.value)} />
        <span><strong>{o.label}</strong>{o.hint && <small>{o.hint}</small>}</span>
      </label>)}
    </div>
  </fieldset>
}
