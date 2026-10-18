import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import type { Settings } from '@shared/types'
import { McpSection } from './settings/Connectors'
import { Setup } from './settings/Setup'
import { BackupPanel } from './settings/BackupPanel'
import { SettingsWriteQueue } from '@shared/settingsQueue'
import {
  AlexaSection,
  AudioSection,
  AuditSection,
  CompanionSection,
  ConnectionsSection,
  ContactsSection,
  EarsSection,
  KeysSection,
  ListeningSection,
  MemorySection,
  MusicSection,
  PermissionsSection,
  ResearchSection,
  SaverSection,
  SmartHomeSection,
  VoiceSection
} from './settings/sections'
import './styles.css'
import './settings/settings.css'

/**
 * Einstellungsfenster.
 *
 * Bewusst vom Kristall getrennt: die Hauptanwendung bleibt rein visuell und
 * sprachgesteuert. Hier steht alles, was man nicht diktieren kann.
 */

/**
 * Die Abschnitte, und wer sie braucht.
 *
 * `advanced` heißt nicht „gefährlich", sondern „setzt eine Frage voraus, die
 * die meisten nie stellen": auf welchem Port der Telefondienst horcht, welches
 * lokale Modell einspringt, welches Werkzeug vor der Ausführung nachfragt. Wer
 * die Frage hat, findet die Antwort über den Schalter unter „Über". Wer sie
 * nicht hat, sieht acht Menüpunkte statt achtzehn — und findet darin die
 * drei, um die es tatsächlich geht.
 *
 * Die Reihenfolge folgt der Gruppe: erst was James zum Laufen braucht, dann
 * womit er sich verbindet, dann das Feintuning. „Über" steht immer unten.
 */
const SECTIONS = [
  { id: 'overview', label: 'Übersicht', group: 'Für dich' },
  { id: 'features', label: 'Funktionen', group: 'Für dich' },
  { id: 'keys', label: 'Zugänge', group: 'Grundlagen' },
  // Die Stimme ist eine der beiden Hauptentscheidungen und darf nicht hinter
  // „Erweitert" verschwinden — dort würde der neue Umschalter niemandem helfen.
  { id: 'voice', label: 'Stimme', group: 'Grundlagen' },
  { id: 'audio', label: 'Audio', group: 'Grundlagen' },
  { id: 'listening', label: 'Zuhören', group: 'Grundlagen' },
  { id: 'connections', label: 'Verbindungen', group: 'Dienste' },
  // Nicht hinter „Erweitert": James schickt Leute ausdrücklich hierher, wenn
  // eine Adresse oder Nummer fehlt, und die Seite muss dann auch da sein.
  { id: 'contacts', label: 'Kontakte', group: 'Dienste' },
  { id: 'music', label: 'Musik', group: 'Dienste', advanced: true },
  { id: 'companion', label: 'Telefon', group: 'Dienste', advanced: true },
  { id: 'smarthome', label: 'Smart Home', group: 'Dienste', advanced: true },
  { id: 'alexa', label: 'Alexa', group: 'Dienste', advanced: true },
  { id: 'ears', label: 'Ohren', group: 'Feintuning', advanced: true },
  { id: 'saver', label: 'Sparmodus', group: 'Feintuning', advanced: true },
  { id: 'permissions', label: 'Rechte', group: 'Feintuning', advanced: true },
  { id: 'mcp', label: 'Konnektoren', group: 'Feintuning', advanced: true },
  { id: 'research', label: 'Recherchen', group: 'Feintuning', advanced: true },
  { id: 'memory', label: 'Gedächtnis', group: 'Feintuning', advanced: true },
  { id: 'audit', label: 'Aktionslog', group: 'Feintuning', advanced: true },
  { id: 'about', label: 'Über', group: '' }
] as const

type SectionId = (typeof SECTIONS)[number]['id']

const SECTION_KEYWORDS: Record<SectionId, string> = {
  overview: 'start hilfe einrichtung einrichten überblick',
  features: 'funktionen fähigkeiten aufgaben helfer',
  keys: 'zugang schlüssel api key standort ort wetter fehler diagnose',
  voice: 'stimme sprechen anbieter modell gemini openai chatgpt elevenlabs hermes',
  audio: 'mikrofon lautsprecher gerät test hören ton ausgabe eingabe',
  listening: 'zuhören stille weckwort hotkey taste sprache sprachsteuerung',
  connections: 'kalender email e-mail mail konto dienste verbinden',
  contacts: 'kontakte person adresse telefonnummer adressbuch',
  music: 'musik spotify youtube wiedergabe',
  companion: 'telefon mobilgerät handy anrufen companion twilio',
  smarthome: 'smart home zuhause lampen geräte home assistant',
  alexa: 'alexa amazon echo',
  ears: 'ohren klatschen weckwort erkennung empfindlichkeit',
  saver: 'sparen sparmodus verbrauch kosten tokens budget limit',
  permissions: 'rechte erlaubnis freigabe sicherheit werkzeuge bestätigung',
  mcp: 'mcp server werkzeuge erweiterungen plugins integration konnektoren connectors github notion linear kalender smart home',
  research: 'recherche suchen ergebnisse berichte',
  memory: 'gedächtnis erinnerung wissen sicherung backup wiederherstellen daten',
  audit: 'aktionslog verlauf protokoll aktivität aufgaben',
  about: 'über version autostart windows starten kosten limit einrichtung hilfe lernen erweitert'
}

function normalizeSearch(value: string): string {
  return value.toLocaleLowerCase('de').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').replace(/ae|oe|ue/g, pair => pair[0])
}

function isSectionId(value: string): value is SectionId {
  return SECTIONS.some((s) => s.id === value)
}

/** Der Abschnitt, mit dem das Fenster geöffnet wurde — steht als Anker in der Adresse. */
function initialSection(): SectionId {
  try {
    const wanted = decodeURIComponent(window.location.hash.slice(1))
    return isSectionId(wanted) ? wanted : 'overview'
  } catch {
    return 'overview'
  }
}

function App(): JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const loadRevision = useRef(0)
  const savedSettings = useRef<Settings | null>(null)
  const revision = useRef(0)
  const pendingWrites = useRef(0)
  const writeQueue = useRef(new SettingsWriteQueue(patch => window.jarvis.invoke('settings:set', patch)))
  const [section, setSection] = useState<SectionId>(initialSection)
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  /** Der Ausweg aus dem Assistenten, ohne ihn abzuschließen. */
  const [skippedSetup, setSkippedSetup] = useState(false)
  /**
   * Der Weg zurück hinein, von Hand aus „Über".
   *
   * Ein eigener Zustand und nicht `setupDone: false`: Der Merker steht bei
   * jeder Installation aus der Zeit vor dem Assistenten ebenfalls auf false,
   * und die soll er nicht erwischen. Was den Assistenten von selbst öffnet,
   * ist das Fehlen eines Schlüssels — was ihn auf Wunsch öffnet, ist dieser
   * Knopf.
   */
  const [forceSetup, setForceSetup] = useState(false)

  const navigate = useCallback((target: SectionId): void => {
    setSection(target)
    setQuery('')
    requestAnimationFrame(() => {
      mainRef.current?.scrollTo({ top: 0 })
      mainRef.current?.focus({ preventScroll: true })
    })
  }, [])

  const load = useCallback(async (): Promise<void> => {
    const request = ++loadRevision.current
    setLoadError('')
    try {
      const [next, secrets] = await Promise.all([
        window.jarvis.invoke('settings:get'),
        window.jarvis.invoke('secrets:status')
      ])
      if (request !== loadRevision.current) return
      savedSettings.current = next
      if (!pendingWrites.current) setSettings(next)
      setHasKey(secrets.some(x => x.key === 'gemini' && x.present))
    } catch (error) {
      if (request === loadRevision.current) {
        setLoadError(error instanceof Error ? error.message : String(error))
      }
    }
  }, [])

  useEffect(() => {
    void load()
    const offNavigate = window.jarvis.onNavigate((target) => {
      if (isSectionId(target)) navigate(target)
    })
    const offSettings = window.jarvis.on('settings:changed', next => {
      savedSettings.current = next
      if (!pendingWrites.current) setSettings(next)
    })
    return () => { loadRevision.current++; offNavigate(); offSettings() }
  }, [load, navigate])

  useEffect(() => {
    window.history.replaceState(null, '', `#${section}`)
    document.title = `${SECTIONS.find(s => s.id === section)?.label ?? 'Einstellungen'} · Void James`
  }, [section])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && searchRef.current) {
        event.preventDefault()
        searchRef.current.focus()
        searchRef.current.select()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (saveState !== 'saved') return
    const timeout = window.setTimeout(() => setSaveState('idle'), 3500)
    return () => window.clearTimeout(timeout)
  }, [saveState])

  const patch = useCallback(async (p: Partial<Settings>): Promise<Settings> => {
    const edit = ++revision.current
    pendingWrites.current++
    setSaveError('')
    setSaveState('saving')
    setSettings((current) => (current ? { ...current, ...p } : current))
    try {
      const next = await writeQueue.current.enqueue(p)
      savedSettings.current = next
      if (edit === revision.current) setSettings(next)
      return next
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
      if (edit === revision.current) setSettings(savedSettings.current)
      // Ohne den Wurf: Die vielen onChange-Aufrufe zeigen den Fehler schon
      // hier oben — eine Ablehnung je Eintrag wäre nur Rauschen in der
      // Konsole. Der Rückgabewert ist der Stand, der sicher auf der Platte
      // liegt; der optimistische Blick bleibt zurückgerollt.
      const saved = savedSettings.current
      if (!saved) throw error
      return saved
    } finally {
      pendingWrites.current--
      if (!pendingWrites.current) setSaveState('saved')
    }
  }, [])

  const primaryIds = ['overview', 'voice', 'audio', 'listening', 'features', 'mcp', 'keys']
  const primary = SECTIONS.filter(s => primaryIds.includes(s.id))
  const extra = SECTIONS.filter(s => !primaryIds.includes(s.id))
  const searchResults = useMemo(() => {
    const terms = normalizeSearch(query).trim().split(/\s+/).filter(Boolean)
    return SECTIONS.filter(s => {
      const text = normalizeSearch(`${s.label} ${s.group} ${SECTION_KEYWORDS[s.id]}`)
      return terms.every(term => text.includes(term))
    })
  }, [query])
  const searching = query.trim().length > 0

  // Auf den Schlüsselstand wird mitgewartet: Sonst blitzt bei jedem Öffnen der
  // Assistent kurz auf, bevor die Antwort da ist und ihn wieder wegnimmt.
  if (!settings || hasKey === null) {
    return <main className="settings-loading">
      <span className="settings-eyebrow">VOID JAMES</span>
      <h1>{loadError ? 'Einstellungen gerade nicht erreichbar.' : 'Einstellungen werden geladen…'}</h1>
      {loadError ? <>
        <p role="alert">{loadError}</p>
        <button className="primary" onClick={() => void load()}>Erneut versuchen</button>
      </> : <p role="status">Einen Moment. Dein persönlicher Bereich wird vorbereitet.</p>}
    </main>
  }

  /*
   * Der Assistent kommt beim ersten Mal von selbst — und ein hinterlegter
   * Schlüssel zählt als erledigt, auch wenn `setupDone` noch aus ist. Ohne
   * diese zweite Bedingung bekäme jede bestehende Installation nach dem
   * Update einmal eine Einrichtung vorgesetzt für etwas, das längst steht.
   */
  if (forceSetup || (!settings.setupDone && !hasKey && !skippedSetup)) {
    return (
      <Setup
        settings={settings}
        patch={patch}
        hasKey={hasKey}
        onSkip={() => {
          setForceSetup(false)
          setSkippedSetup(true)
        }}
      />
    )
  }

  const active = section
  const activeSection = SECTIONS.find(s => s.id === active)!

  return (
    <div className="settings-shell">
      <a className="settings-skip" href="#settings-content" onClick={event => {
        event.preventDefault()
        mainRef.current?.focus()
      }}>Zum Inhalt springen</a>
      <nav className="settings-nav" aria-label="Einstellungen">
        <h1>
          Void <span>James</span>
        </h1>
        <p className="settings-nav-note">Alles an einem Ort.</p>
        <div className="settings-search">
          <label htmlFor="settings-search">Einstellung finden <kbd>Strg K</kbd></label>
          <div className="settings-search-field">
            <input ref={searchRef} id="settings-search" type="search" placeholder="z. B. Mikrofon" value={query} autoComplete="off"
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Escape') { setQuery(''); event.preventDefault() }
                if (event.key === 'Enter' && searching && searchResults[0]) { navigate(searchResults[0].id); event.preventDefault() }
                if (event.key === 'ArrowDown' && searching) {
                  event.preventDefault()
                  document.querySelector<HTMLButtonElement>('.settings-search-results button')?.focus()
                }
              }} />
            {query && <button className="settings-search-clear" onClick={() => { setQuery(''); searchRef.current?.focus() }} aria-label="Suche leeren">×</button>}
          </div>
        </div>
        {searching ? <div className="settings-search-results">
          <p className="settings-search-count" role="status">{searchResults.length === 1 ? '1 Bereich gefunden' : `${searchResults.length} Bereiche gefunden`}</p>
          {searchResults.map(s => <button key={s.id} className="nav-item" aria-current={active === s.id} onClick={() => navigate(s.id)}><span>{s.label}</span><small>{s.group || 'Hilfe & App'}</small></button>)}
          {!searchResults.length && <p className="settings-search-empty">Versuch einen anderen Begriff, etwa „Stimme“, „Kosten“ oder „Backup“.</p>}
        </div> : <>
          <p className="nav-group">Dein Alltag</p>
          {primary.map(s => <button key={s.id} className="nav-item" aria-current={active === s.id} onClick={() => navigate(s.id)}>{s.label}</button>)}
          <details className="settings-nav-more" open={!primaryIds.includes(active) || settings.showAdvanced}>
            <summary>Weitere Einstellungen</summary>
            {extra.map(s => <button key={s.id} className="nav-item" aria-current={active === s.id} onClick={() => navigate(s.id)}>{s.label}</button>)}
          </details>
        </>}
      </nav>

      <main className="settings-main" id="settings-content" ref={mainRef} tabIndex={-1} aria-label={activeSection.label}>
        <div className="settings-page-meta">
          <span>{activeSection.group || 'Hilfe & App'} <i aria-hidden="true">/</i> {activeSection.label}</span>
          <span className={`settings-save-state ${saveError ? 'is-error' : ''}`} role="status" aria-live="polite">{saveError ? 'Nicht gespeichert' : saveState === 'saving' ? 'Wird gespeichert…' : saveState === 'saved' ? 'Änderungen gespeichert' : 'Automatisch speichern'}</span>
        </div>
        {saveError && <p role="alert" className="settings-save-error">Speichern fehlgeschlagen: {saveError}. Bitte ändere die Einstellung erneut.</p>}
        {active === 'overview' && <>
          <span className="settings-eyebrow">DEIN PERSÖNLICHER HELFER</span>
          <h2>Mach es dir einfach.</h2>
          <p className="lede">Du sagst, was du brauchst. James kümmert sich darum. Hier passt du die wichtigsten Dinge an.</p>
          <div className="settings-tiles">
            {([
              ['voice', '01', 'Mit James sprechen', 'Stimme wählen und deinen Anbieter verbinden.'],
              ['audio', '02', 'Mikrofon und Lautsprecher', 'Prüfen, ob James dich hört und du ihn hören kannst.'],
              ['features', '03', 'Was James für dich tun kann', 'Recherchen, Telefon, Kontakte und weitere Helfer.'],
              ['keys', '04', 'Standort und Fehlerberichte', 'Deinen Standardort und den optionalen Fehlerversand einstellen.']
            ] as const).map(([id, number, title, description]) => <button className="settings-tile" key={id} onClick={() => navigate(id)}><span>{number} <i>↗</i></span><strong>{title}</strong><p>{description}</p></button>)}
          </div>
          <div className="settings-help"><strong>Neu hier?</strong><p>Die geführte Einrichtung hilft dir Schritt für Schritt beim Start.</p><button className="primary" onClick={() => setForceSetup(true)}>Einrichtung öffnen</button></div>
        </>}
        {active === 'features' && <>
          <h2>Was brauchst du?</h2><p className="lede">Wähle einen Bereich. Du kannst James auch einfach sagen, was er für dich erledigen soll.</p>
          <div className="settings-tiles">
            {([
              ['research', 'Recherchen', 'Gesammelte Ergebnisse und fertige Berichte lesen.'],
              ['companion', 'Telefon', 'Telefonfunktionen und die Verbindung zum Mobilgerät einrichten.'],
              ['contacts', 'Kontakte', 'Personen und Telefonnummern verwalten.'],
              ['connections', 'Verbindungen', 'Kalender, E-Mail und weitere Dienste verbinden.'],
              ['music', 'Musik', 'Deine Musikdienste einrichten.'],
              ['memory', 'Gedächtnis', 'Gespeicherte Informationen und Sicherungen verwalten.'],
              ['audit', 'Aktionslog', 'Nachsehen, was James bereits erledigt hat.'],
              ['saver', 'Weniger Verbrauch', 'Kosten, Tokens und Sparoptionen einstellen.']
            ] as const).map(([id, title, description]) => <button className="settings-tile" key={id} onClick={() => navigate(id)}><strong>{title}</strong><p>{description}</p><span>Öffnen ↗</span></button>)}
          </div>
        </>}
        {active === 'connections' && <ConnectionsSection />}
        {active === 'smarthome' && <SmartHomeSection settings={settings} patch={patch} />}
        {active === 'music' && <MusicSection settings={settings} patch={patch} />}
        {active === 'alexa' && <AlexaSection settings={settings} patch={patch} />}
        {active === 'keys' && <KeysSection settings={settings} patch={patch} />}
        {active === 'contacts' && <ContactsSection />}
        {active === 'companion' && <CompanionSection settings={settings} patch={patch} />}
        {active === 'voice' && <VoiceSection settings={settings} patch={patch} />}
        {active === 'ears' && <EarsSection settings={settings} patch={patch} />}
        {active === 'audio' && <AudioSection settings={settings} patch={patch} />}
        {active === 'listening' && <ListeningSection settings={settings} patch={patch} />}
        {active === 'saver' && <SaverSection settings={settings} patch={patch} />}
        {active === 'permissions' && <PermissionsSection settings={settings} patch={patch} />}
        {active === 'mcp' && <McpSection settings={settings} patch={patch} onNavigate={navigate} />}
        {active === 'audit' && <AuditSection />}
        {active === 'research' && <ResearchSection />}
        {active === 'memory' && <><BackupPanel settings={settings} patch={patch} /><MemorySection /></>}
        {active === 'about' && (
          <AboutSection settings={settings} patch={patch} onRestartSetup={() => setForceSetup(true)} />
        )}
      </main>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────

type Patch = (p: Partial<Settings>) => Promise<Settings> | void

function AboutSection({
  settings,
  patch,
  onRestartSetup
}: {
  settings: Settings
  patch: (p: Partial<Settings>) => Promise<Settings>
  onRestartSetup: () => void
}): JSX.Element {
  const [version, setVersion] = useState('')
  const [cost, setCost] = useState({ todayUsd: 0, monthUsd: 0 })

  useEffect(() => {
    void window.jarvis.invoke('diag:ping').then((r) => setVersion(r.version)).catch(() => undefined)
    void window.jarvis.invoke('cost:get').then(setCost).catch(() => undefined)
  }, [])

  return (
    <>
      <h2>Über</h2>
      <p className="lede">Void James {version}</p>
      <BackupPanel settings={settings} patch={patch} />


      <hr className="section-divider" />

      <div className="field">
        <label>Kosten</label>
        <table>
          <tbody>
            <tr>
              <td>Heute</td>
              <td>{cost.todayUsd.toFixed(2)} $</td>
            </tr>
            <tr>
              <td>Diesen Monat</td>
              <td>{cost.monthUsd.toFixed(2)} $</td>
            </tr>
          </tbody>
        </table>
        <div className="hint">
          Erfasst werden die abschätzbaren Posten wie Recherchen. Live-Audio wird pro Sekunde
          abgerechnet und lässt sich lokal nicht exakt beziffern — der beste Hebel dagegen ist die
          Trennung nach Stille unter „Zuhören".
        </div>
      </div>

      <div className="field">
        <label>
          Tageslimit:{' '}
          {settings.dailyCostLimitUsd > 0 ? `${settings.dailyCostLimitUsd} $` : 'aus'}
        </label>
        <input aria-label="Tageslimit:"
          type="range"
          min={0}
          max={50}
          step={1}
          value={settings.dailyCostLimitUsd}
          onChange={(e) => patch({ dailyCostLimitUsd: Number(e.target.value) })}
        />
        <div className="hint">
          Greift bei dem, was ein bekanntes Preisschild hat — derzeit die tiefe Recherche. Ist die
          Grenze erreicht, lehnt James den nächsten Lauf ab und sagt warum, statt ihn stillschweigend
          zu starten. Auf null steht die Bremse aus.
        </div>
      </div>

      <div className="field">
        <label style={{ fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={settings.launchOnStartup}
            onChange={(e) => patch({ launchOnStartup: e.target.checked })}
            style={{ width: 'auto', marginRight: 8 }}
          />
          Mit Windows starten
        </label>
        <div className="hint" style={{ marginLeft: 24 }}>
          Startet ohne Fenster, nur mit dem Symbol im Infobereich der Taskleiste. Gilt erst für die
          installierte Fassung — im Entwicklungslauf wird nichts eingetragen.
        </div>
      </div>

      <div className="field">
        <label style={{ fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={settings.learnSkills ?? true}
            onChange={(e) => patch({ learnSkills: e.target.checked })}
            style={{ width: 'auto', marginRight: 8 }}
          />
          Aus Erfahrung lernen
        </label>
        <div className="hint" style={{ marginLeft: 24 }}>
          Nach Aufgaben mit mehreren Schritten prüft James im Hintergrund, ob sich daraus eine
          Anleitung fürs nächste Mal machen lässt, und legt sie als Fertigkeit ab. Kostet einen kurzen
          Textaufruf pro Aufgabe. „Zeig mir deine Fertigkeiten" öffnet den Ordner.
        </div>
      </div>

      <hr className="section-divider" />

      <div className="field">
        <label style={{ fontWeight: 400 }}>
          <input
            type="checkbox"
            checked={settings.showAdvanced}
            onChange={(e) => patch({ showAdvanced: e.target.checked })}
            style={{ width: 'auto', marginRight: 8 }}
          />
          Erweiterte Einstellungen zeigen
        </label>
        <div className="hint" style={{ marginLeft: 24 }}>
          Blendet die selten benötigten Bereiche in der Leiste ein. Sie sind nicht abgeschaltet —
          nur aus der normalen Ansicht entfernt, damit die wichtigen Einstellungen übersichtlich bleiben.
        </div>
      </div>

      <div className="field">
        <label>Einrichtung</label>
        <button onClick={onRestartSetup}>Einrichtung erneut durchgehen</button>
        <div className="hint">
          Zeigt den geführten Ablauf noch einmal — Zugang, Mikrofon, Bedienung. Gelöscht wird
          dabei nichts: Ein hinterlegter Schlüssel wird erkannt, und der Schritt lässt sich
          überspringen.
        </div>
      </div>

      <div className="field">
        <label>Wenn etwas nicht geht</label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => void window.jarvis.invoke('app:openGuide').catch(() => undefined)}>
            Kurzanleitung öffnen
          </button>
          <button onClick={() => void window.jarvis.invoke('app:showLog').catch(() => undefined)}>
            Protokoll zeigen
          </button>
        </div>
        <div className="hint">
          Die Kurzanleitung ist eine Seite zum Ausdrucken. Das Protokoll ist die Datei, in der
          steht, was zuletzt schiefging — sie öffnet im Explorer und lässt sich anhängen, wenn
          etwas gemeldet werden soll. Zugangsschlüssel werden beim Schreiben unkenntlich gemacht.
        </div>
      </div>

      <hr className="section-divider" />

      <div className="field">
        <label>Was James grundsätzlich nicht tut</label>
        <div className="hint" style={{ lineHeight: 1.75 }}>
          Er schließt keine Käufe ab und drückt keinen Bestellknopf. Er gibt keine Passwörter,
          Kartennummern oder anderen Zahlungsdaten ein und tippt sie auch nicht. In Banking-,
          Passwortmanager- und Bezahlfenstern übernimmt er die Bildschirmsteuerung nicht.
          Sicherheitsabfragen löst er nicht, sondern übergibt an dich. Mails löscht er nicht
          endgültig, sondern legt sie höchstens in den Papierkorb. Das gilt unabhängig von den
          Rechte-Einstellungen.
        </div>
      </div>

      <div className="field">
        <label>Wann er nachfragt</label>
        <div className="hint" style={{ lineHeight: 1.75 }}>
          Nur noch bei dem, was nach außen wirkt oder sich nicht zurücknehmen lässt: Mails
          verschicken und beantworten, Warenkorb ändern, Kasse öffnen, Dateien schreiben, Befehle
          ausführen, wiederkehrende Aufträge einrichten. Die Bildschirmsteuerung fragt
          <strong style={{ color: 'var(--text)' }}> nicht mehr</strong> jedes Mal — im Alltag hat
          das mehr genervt als geschützt. Wenn du sie zurück willst, stell unter „Rechte" das
          Werkzeug <code>computer_task</code> auf „fragt nach". Der Not-Aus bleibt: dreimal
          Escape bricht alles ab.
        </div>
      </div>
    </>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
