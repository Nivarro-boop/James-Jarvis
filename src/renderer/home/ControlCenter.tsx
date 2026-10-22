import { useCallback, useEffect, useRef, useState, type JSX, type FormEvent, type KeyboardEvent } from 'react'
import './control-center.css'
import type { IpcInvokeMap } from '@shared/ipc'
import { workflowPresets } from './workflowPresets'

type ControlStatus = IpcInvokeMap['control:status']['res']
type Tab = 'phone' | 'computer' | 'everyday'
const tabs: Tab[] = ['phone', 'computer', 'everyday']

function requestJames(text: string, result: (sent: boolean) => void): void {
  window.dispatchEvent(new CustomEvent('jarvis:text', { detail: { text, onResult: result } }))
}

export function ControlCenter({ onClose }: { onClose: () => void }): JSX.Element {
  const [tab, setTab] = useState<Tab>('phone')
  const [status, setStatus] = useState<ControlStatus | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [loading, setLoading] = useState(false)
  const [target, setTarget] = useState('')
  const [brief, setBrief] = useState('')
  const [review, setReview] = useState(false)
  const [computerTask, setComputerTask] = useState('')
  const [windowTitle, setWindowTitle] = useState('')
  const [selectedPreset, setSelectedPreset] = useState('')
  const [workflowDraft, setWorkflowDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const busyRef = useRef(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const priorFocus = useRef<HTMLElement | null>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const statusSeq = useRef(0)
  const alive = useRef(true)
  const resultTimer = useRef<number | null>(null)
  const phoneReady = status?.phoneConfigured === true && status.conversationEnabled === true

  const loadStatus = useCallback(async () => {
    const seq = ++statusSeq.current
    setLoading(true); setLoadError(false)
    try {
      const next = await window.jarvis.invoke('control:status')
      if (alive.current && seq === statusSeq.current) setStatus(next)
    } catch { if (alive.current && seq === statusSeq.current) setLoadError(true) } finally { if (alive.current && seq === statusSeq.current) setLoading(false) }
  }, [])

  useEffect(() => {
    alive.current = true
    priorFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    void loadStatus()
    const keydown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); return }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]')]
      if (!focusable.length) return
      const first = focusable[0], last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      alive.current = false
      statusSeq.current++
      if (resultTimer.current !== null) window.clearTimeout(resultTimer.current)
      resultTimer.current = null
      busyRef.current = false
      document.removeEventListener('keydown', keydown)
      priorFocus.current?.focus()
    }
  }, [loadStatus])

  const send = (text: string): void => {
    if (busyRef.current || !text.trim()) return
    busyRef.current = true; setBusy(true); setMessage('Auftrag wird übergeben …')
    let answered = false
    const finish = (sent: boolean): void => {
      if (answered || !alive.current) return
      answered = true
      if (resultTimer.current !== null) window.clearTimeout(resultTimer.current)
      resultTimer.current = null
      busyRef.current = false; setBusy(false)
      if (sent) setReview(false)
      setMessage(sent ? 'Auftrag an James übergeben' : 'Auftrag konnte nicht übergeben werden. Bitte erneut versuchen.')
    }
    resultTimer.current = window.setTimeout(() => {
      if (!answered && alive.current) {
        answered = true; resultTimer.current = null; busyRef.current = false; setBusy(false)
        setMessage('Keine Übergabebestätigung erhalten. Es wurde nicht automatisch erneut gesendet.')
      }
    }, 20000)
    requestJames(text.trim(), finish)
  }

  const submitPhone = (event: FormEvent): void => {
    event.preventDefault()
    if (!phoneReady || busy || !target.trim() || !brief.trim()) return
    if (!review) { setReview(true); setMessage('Bitte prüfe Ziel und Gesprächsauftrag.'); return }
    send(`Rufe ${target.trim()} an und ${brief.trim()}`)
  }
  const computerRequest = (task: string): void => {
    if (!task.trim()) return
    setComputerTask(task); send(task)
  }
  const switchTab = (next: Tab): void => {
    setTab(next)
    if (!busyRef.current) setMessage('')
    setReview(false)
  }
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const index = tabs.indexOf(tab)
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    switchTab(tabs[nextIndex]); tabRefs.current[nextIndex]?.focus()
  }
  const choosePreset = (id: string): void => {
    const preset = workflowPresets.find((item) => item.id === id)
    if (!preset) return
    setSelectedPreset(id); setWorkflowDraft(preset.prompt); setMessage('')
  }

  return <div className="cc-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
    <div className="cc-dialog" role="dialog" aria-modal="true" aria-labelledby="cc-title" ref={dialogRef}>
      <header className="cc-header"><div><span className="cc-eyebrow">JAMES · STEUERZENTRALE</span><h2 id="cc-title">Was soll ich für dich tun?</h2><p>Prüfe den Status und übergib einen klaren Auftrag.</p></div><button ref={closeRef} className="cc-close" onClick={onClose} aria-label="Steuerzentrale schließen">×</button></header>
      <div className="cc-tabs" role="tablist" aria-label="Steuerzentrale Bereiche">
        <button ref={(el) => { tabRefs.current[0] = el }} id="cc-tab-phone" role="tab" aria-selected={tab === 'phone'} aria-controls="cc-panel-phone" tabIndex={tab === 'phone' ? 0 : -1} onClick={() => switchTab('phone')} onKeyDown={onTabKey}>Telefon</button>
        <button ref={(el) => { tabRefs.current[1] = el }} id="cc-tab-computer" role="tab" aria-selected={tab === 'computer'} aria-controls="cc-panel-computer" tabIndex={tab === 'computer' ? 0 : -1} onClick={() => switchTab('computer')} onKeyDown={onTabKey}>Computer</button>
        <button ref={(el) => { tabRefs.current[2] = el }} id="cc-tab-everyday" role="tab" aria-selected={tab === 'everyday'} aria-controls="cc-panel-everyday" tabIndex={tab === 'everyday' ? 0 : -1} onClick={() => switchTab('everyday')} onKeyDown={onTabKey}>Alltag</button>
      </div>
      {loadError ? <div className="cc-error" role="alert"><strong>Status konnte nicht geladen werden.</strong><span>Es wurde kein Dienst gestartet.</span><button onClick={() => void loadStatus()} disabled={loading}>{loading ? 'Wird aktualisiert …' : 'Erneut versuchen'}</button></div> : <>
        <div className="cc-status" aria-live="polite">
          <span className={`cc-status-dot ${status?.telephony.running ? 'is-on' : ''}`} />
          <span><b>{loading && !status ? 'Status wird geladen …' : status?.telephony.running ? 'Telefonie erreichbar' : status ? 'Telefonie nicht aktiv' : 'Status ausstehend'}</b><small>{status ? `${status.telephony.hint || (status.telephony.publicUrl ? `Verbindung: ${status.telephony.source ?? 'eingerichtet'}` : 'Nur Statusabfrage · keine Dienste gestartet')} · Gespräche ${status.conversationEnabled ? 'bereit' : 'aus'} · Eingehend ${status.incomingEnabled ? 'an' : 'aus'}` : 'Passive Statusabfrage'}</small></span>
          <button className="cc-refresh" onClick={() => void loadStatus()} disabled={loading} aria-label="Status aktualisieren">{loading ? '…' : 'Aktualisieren'}</button>
        </div>
        {tab === 'phone' ? <section id="cc-panel-phone" role="tabpanel" aria-labelledby="cc-tab-phone" className="cc-panel">
          {status && !status.conversationEnabled && <div className="cc-notice cc-notice-info"><b>Zweiweg-Gespräche sind ausgeschaltet</b><span>Telefonaufträge können so nicht ausgeführt werden. James aktiviert den Dienst nicht automatisch.</span></div>}
          {status && !status.phoneConfigured && <div className="cc-notice"><b>Telefonzugänge fehlen</b><span>Richte deine Zugänge ein, bevor ein Anruf beauftragt werden kann.</span><button onClick={() => void window.jarvis.invoke('app:openSettings', { section: 'keys' })}>Zugänge öffnen</button></div>}
          <form onSubmit={submitPhone}>
            <label htmlFor="cc-target">Ziel <span>Telefonnummer oder Kontaktname</span></label><input id="cc-target" value={target} onChange={(e) => { setTarget(e.target.value); setReview(false) }} maxLength={120} placeholder="z. B. +49 30 123456 oder Alex" required />
            <label htmlFor="cc-brief">Gesprächsauftrag</label><textarea id="cc-brief" value={brief} onChange={(e) => { setBrief(e.target.value); setReview(false) }} maxLength={500} rows={3} placeholder="Was soll James im Gespräch sagen oder klären?" required />
            <p className="cc-cost">Ein Anruf kann Telefonkosten verursachen. Der Auftrag wird erst nach deiner Bestätigung übergeben.</p>
            {review && <div className="cc-review" aria-live="polite"><b>Bitte genau prüfen</b><p><span>Ziel</span>{target.trim()}</p><p><span>Gesprächsauftrag</span>{brief.trim()}</p></div>}
            <button className="cc-primary" type="submit" disabled={!phoneReady || busy || !target.trim() || !brief.trim()}>{busy ? 'Wird übergeben …' : review ? 'Anruf beauftragen' : 'Auftrag prüfen'}</button>
          </form>
        </section> : tab === 'computer' ? <section id="cc-panel-computer" role="tabpanel" aria-labelledby="cc-tab-computer" className="cc-panel">
          <div className="cc-computer"><span className={`cc-status-dot ${status && !status.computer.grund && status.computer.name !== 'nicht verfügbar' ? 'is-on' : ''}`}/><div><b>{status?.computer.name || 'Computer'}</b><small>{status?.computer.grund || 'Aktionen werden über James angefragt und unterliegen den üblichen Freigaben.'}</small></div></div>
          <label htmlFor="cc-computer-task">Auftrag an James</label><textarea id="cc-computer-task" value={computerTask} onChange={(e) => setComputerTask(e.target.value)} maxLength={1000} rows={3} placeholder="Beschreibe, was James am Computer tun soll …" />
          <button className="cc-primary" onClick={() => computerRequest(computerTask)} disabled={busy || !computerTask.trim()}>Auftrag übergeben</button>
          <div className="cc-actions-label">Schnellaktionen</div><div className="cc-quick-actions">
            <button disabled={busy} onClick={() => computerRequest('Prüfe den Systemstatus und berichte mir, was du findest.')}>Systemstatus</button>
            <button disabled={busy} onClick={() => computerRequest('Sieh dir den aktuellen Bildschirm an und beschreibe mir, was du siehst.')}>Bildschirm ansehen</button>
            <button disabled={busy} onClick={() => { if (windowTitle.trim()) computerRequest(`Ordne das Fenster „${windowTitle.trim()}" sinnvoll an.`) }}>Fenster anordnen</button>
            <input aria-label="Fenstertitel für Fenster anordnen" value={windowTitle} onChange={(e) => setWindowTitle(e.target.value)} maxLength={150} placeholder="Fenstertitel" />
            <button disabled={busy} onClick={() => computerRequest('Öffne den Browser und hilf mir mit meinem Anliegen.')}>Browser öffnen</button>
          </div>
          <p className="cc-permissions">Vor jeder Aktion gelten weiterhin die normalen Rechte und Freigaben.</p>
        </section> : <section id="cc-panel-everyday" role="tabpanel" aria-labelledby="cc-tab-everyday" className="cc-panel cc-workflows">
          <p className="cc-workflow-intro">Wähle eine Vorlage als Startpunkt und passe den Entwurf an deine Situation an.</p>
          <div className="cc-presets" aria-label="Alltagsvorlagen">
            {workflowPresets.map((preset) => <button key={preset.id} type="button" className="cc-preset" aria-pressed={selectedPreset === preset.id} onClick={() => choosePreset(preset.id)}>
              <b>{preset.title}</b><span>{preset.description}</span>
            </button>)}
          </div>
          <label htmlFor="cc-workflow-draft">Editierbarer Auftragsentwurf</label>
          <textarea id="cc-workflow-draft" value={workflowDraft} onChange={(e) => setWorkflowDraft(e.target.value)} maxLength={2000} rows={6} placeholder="Wähle eine Vorlage oder formuliere deinen Auftrag …" />
          <div className="cc-notice cc-notice-info"><b>Du behältst die Kontrolle</b><span>Vorlagen starten nichts automatisch. Inhalte können verbundene Zugänge erfordern. Erst mit „Entwurf an James übergeben“ wird dieser Text übergeben; Versand, Änderungen und weitere Aktionen unterliegen den üblichen Freigaben.</span></div>
          <button className="cc-primary" type="button" onClick={() => send(workflowDraft)} disabled={busy || !workflowDraft.trim()}>{busy ? 'Wird übergeben …' : 'Entwurf an James übergeben'}</button>
        </section>}
      </>}
      {message && <div className="cc-message" role="status">{message}</div>}
      <footer className="cc-footer"><span>Aufträge werden an James übergeben – nicht als ausgeführt bestätigt.</span><button onClick={onClose}>Schließen</button></footer>
    </div>
  </div>
}
