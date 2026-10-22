import { useEffect, useRef, useState, type JSX } from 'react'
import type { Settings } from '@shared/types'
import { assistantRoles, assistantRoleInfo } from '@shared/assistantRole'
import './assistant-role.css'

type Role = Settings['assistantRole']
type Patch = (value: Partial<Settings>) => Promise<Settings>

function RoleChoices({ value, onChange, disabled }: { value: Role; onChange: (role: Role) => void; disabled: boolean }): JSX.Element {
  return <fieldset className="assistant-role-choices" disabled={disabled}>
    <legend>Schwerpunkt auswählen</legend>
    {assistantRoles.map(role => <label className="assistant-role-option" key={role.id} data-selected={value === role.id}>
      <input type="radio" name="assistant-role" value={role.id} checked={value === role.id} onChange={() => onChange(role.id)} />
      <span><strong>{role.label}</strong><small>{role.description}</small></span>
    </label>)}
  </fieldset>
}

export function AssistantRoleStep({ settings, patch, onNext, onBack }: { settings: Settings; patch: Patch; onNext: () => void; onBack: () => void }): JSX.Element {
  const [selected, setSelected] = useState<Role>(assistantRoleInfo(settings.assistantRole).id)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const locked = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const save = async (): Promise<void> => {
    if (locked.current) return
    locked.current = true; setSaving(true); setError('')
    try {
      await patch({ assistantRole: selected })
      if (alive.current) onNext()
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : 'Der Schwerpunkt konnte nicht gespeichert werden.')
    } finally {
      locked.current = false
      if (alive.current) setSaving(false)
    }
  }
  return <>
    <h1>Wofür soll James da sein?</h1>
    <p className="setup-lede">Wähle, wobei er dir vor allem helfen soll. Du kannst den Schwerpunkt später ändern – alle anderen Funktionen bleiben erreichbar.</p>
    <RoleChoices value={selected} onChange={setSelected} disabled={saving} />
    <p className="assistant-role-hint">Die Auswahl verbindet keinen Kalender und erteilt keine Zugriffsrechte. Konten und Berechtigungen richtest du separat ein; Termine werden nicht automatisch abgerufen.</p>
    {error && <p className="setup-note err" role="alert">{error}</p>}
    <div className="setup-actions">
      <button type="button" disabled={saving} onClick={onBack}>Zurück</button>
      <button type="button" className="primary setup-go" disabled={saving} onClick={() => void save()}>{saving ? 'Wird gespeichert …' : 'Speichern und weiter'}</button>
    </div>
  </>
}

export function AssistantRoleSettings({ settings, patch }: { settings: Settings; patch: Patch }): JSX.Element {
  const current = assistantRoleInfo(settings.assistantRole).id
  const [selected, setSelected] = useState<Role>(current)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const locked = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { setSelected(current) }, [current])
  const save = async (): Promise<void> => {
    if (locked.current || selected === current) return
    locked.current = true; setSaving(true); setError(''); setNotice('')
    try {
      await patch({ assistantRole: selected })
      if (alive.current) setNotice(`Schwerpunkt gespeichert: ${assistantRoleInfo(selected).label}.`)
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : 'Der Schwerpunkt konnte nicht gespeichert werden.')
    } finally {
      locked.current = false
      if (alive.current) setSaving(false)
    }
  }
  return <section className="assistant-role-settings" aria-label="Aufgabe und Schwerpunkt">
    <h3>Aufgabe &amp; Schwerpunkt</h3>
    <p className="hint">Wobei soll James dir vor allem helfen? Der Schwerpunkt ändert seine Prioritäten, nicht deine Freigaben oder verfügbaren Funktionen.</p>
    <RoleChoices value={selected} onChange={role => { setSelected(role); setNotice(''); setError('') }} disabled={saving} />
    <p className="assistant-role-hint">Kein automatischer Kalenderzugriff. Kalender und andere Konten verbindest du weiterhin separat.</p>
    <button type="button" disabled={saving || selected === current} onClick={() => void save()}>{saving ? 'Wird gespeichert …' : 'Schwerpunkt speichern'}</button>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>
}
