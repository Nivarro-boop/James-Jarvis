import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import type { McpServerConfig, McpServerStatus, Settings } from '@shared/types'
import {
  ENV_NAME,
  MCP_PRESETS,
  parseMcpConfig,
  uniqueServerId,
  type McpPreset,
  type ParsedMcpServer
} from '@shared/mcp'
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
  { id: 'mcp', label: 'MCP-Server', group: 'Feintuning', advanced: true },
  { id: 'research', label: 'Recherchen', group: 'Feintuning', advanced: true },
  { id: 'memory', label: 'Gedächtnis', group: 'Feintuning', advanced: true },
  { id: 'audit', label: 'Aktionslog', group: 'Feintuning', advanced: true },
  { id: 'about', label: 'Über', group: '' }
] as const

type SectionId = (typeof SECTIONS)[number]['id']

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
  const [saveError, setSaveError] = useState('')
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

  useEffect(() => {
    void window.jarvis.invoke('settings:get').then(next => {
      savedSettings.current = next
      if (!pendingWrites.current) setSettings(next)
    })
    void window.jarvis
      .invoke('secrets:status')
      .then((s) => setHasKey(s.some((x) => x.key === 'gemini' && x.present)))
    const offNavigate = window.jarvis.onNavigate((target) => {
      if (isSectionId(target)) setSection(target)
    })
    const offSettings = window.jarvis.on('settings:changed', next => {
      savedSettings.current = next
      if (!pendingWrites.current) setSettings(next)
    })
    return () => { offNavigate(); offSettings() }
  }, [])

  const patch = useCallback(async (p: Partial<Settings>): Promise<Settings> => {
    const edit = ++revision.current
    pendingWrites.current++
    setSaveError('')
    setSettings((current) => (current ? { ...current, ...p } : current))
    try {
      const next = await writeQueue.current.enqueue(p)
      savedSettings.current = next
      if (edit === revision.current) setSettings(next)
      return next
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
      if (edit === revision.current) setSettings(savedSettings.current)
      throw error
    } finally { pendingWrites.current-- }
  }, [])

  const primaryIds = ['overview', 'voice', 'audio', 'listening', 'features', 'keys']
  const primary = SECTIONS.filter(s => primaryIds.includes(s.id))
  const extra = SECTIONS.filter(s => !primaryIds.includes(s.id))

  // Auf den Schlüsselstand wird mitgewartet: Sonst blitzt bei jedem Öffnen der
  // Assistent kurz auf, bevor die Antwort da ist und ihn wieder wegnimmt.
  if (!settings || hasKey === null) {
    return <div style={{ padding: 40, color: '#9b8fae' }}>Lädt…</div>
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

  // Ein Abschnitt, der gerade offen ist und beim Umschalten auf „einfach"
  // verschwindet, würde sonst eine leere Fläche hinterlassen.
  const active = section

  return (
    <div className="settings-shell">
      <nav className="settings-nav">
        <h1>
          Void <span>James</span>
        </h1>
        <p className="settings-nav-note">Alles an einem Ort.</p>
        {primary.map(s => <button key={s.id} className="nav-item" aria-current={active === s.id} onClick={() => setSection(s.id)}>{s.label}</button>)}
        <details className="settings-nav-more" open={!primaryIds.includes(active) || settings.showAdvanced}>
          <summary>Weitere Einstellungen</summary>
          {extra.map(s => <button key={s.id} className="nav-item" aria-current={active === s.id} onClick={() => setSection(s.id)}>{s.label}</button>)}
        </details>
      </nav>

      <main className="settings-main">
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
            ] as const).map(([id, number, title, description]) => <button className="settings-tile" key={id} onClick={() => setSection(id)}><span>{number} <i>↗</i></span><strong>{title}</strong><p>{description}</p></button>)}
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
            ] as const).map(([id, title, description]) => <button className="settings-tile" key={id} onClick={() => setSection(id)}><strong>{title}</strong><p>{description}</p><span>Öffnen ↗</span></button>)}
          </div>
        </>}
        {saveError && <p role="alert" className="hint err">Speichern fehlgeschlagen: {saveError}</p>}
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
        {active === 'mcp' && <McpSection settings={settings} patch={patch} />}
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

/**
 * Argumente wie in einer Kommandozeile trennen.
 *
 * An Leerzeichen allein zu trennen zerriss jeden Pfad mit Leerzeichen —
 * `"C:\Users\Max Muster\Dokumente"` kam als zwei Argumente beim Server an.
 * Anführungszeichen halten jetzt zusammen, was zusammengehört.
 */
function splitArgs(raw: string): string[] {
  // Ein Argument ist eine Folge aus Anführungsteilen und gewöhnlichen
  // Zeichen — so bleibt auch `--root="C:\Mein Ordner"` ein einziges.
  const tokens = raw.match(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g) ?? []
  return tokens.map((token) => token.replace(/"([^"]*)"|'([^']*)'/g, '$1$2'))
}

type Patch = (p: Partial<Settings>) => Promise<Settings> | void

/**
 * MCP-Server.
 *
 * Drei Wege hinein, vom einfachsten zum freiesten: eine Vorlage anklicken,
 * den JSON-Block aus einer Anleitung einfügen, oder Befehl und Argumente von
 * Hand. Danach wird sofort neu geladen — der frühere Extra-Klick auf „neu
 * laden" wurde regelmäßig vergessen, und James kannte die Werkzeuge nicht.
 *
 * Schlüssel stehen direkt am Server als Passwortfelder. Wer einen Server
 * anlegt, der einen braucht, sieht das Feld sofort und muss nicht wissen, was
 * eine Umgebungsvariable ist.
 */
function McpSection({ settings, patch }: { settings: Settings; patch: Patch }): JSX.Element {
  const [draft, setDraft] = useState({ name: '', command: '', args: '' })
  const [json, setJson] = useState('')
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [reloading, setReloading] = useState(false)
  const [status, setStatus] = useState<Record<string, McpServerStatus> | null>(null)

  useEffect(() => {
    void window.jarvis.invoke('mcp:status').then(setStatus)
  }, [])

  const reload = async (): Promise<void> => {
    setReloading(true)
    try {
      await window.jarvis.invoke('mcp:reload')
      setStatus(await window.jarvis.invoke('mcp:status'))
    } finally {
      setReloading(false)
    }
  }

  /** Anmeldung im Systembrowser; die Karte zeigt danach den neuen Zustand. */
  const login = async (id: string): Promise<string | null> => {
    setReloading(true)
    try {
      const result = await window.jarvis.invoke('mcp:login', { id })
      setStatus(await window.jarvis.invoke('mcp:status'))
      return result.ok ? null : (result.error ?? 'Die Anmeldung hat nicht geklappt.')
    } finally {
      setReloading(false)
    }
  }

  const logout = async (id: string): Promise<void> => {
    setReloading(true)
    try {
      await window.jarvis.invoke('mcp:logout', { id })
      setStatus(await window.jarvis.invoke('mcp:status'))
    } finally {
      setReloading(false)
    }
  }

  /** Server anlegen, Schlüssel ablegen, neu laden — in dieser Reihenfolge. */
  const addServers = async (
    entries: {
      name: string
      command: string
      args: string[]
      env?: Record<string, string>
      secrets?: Record<string, string>
      url?: string
    }[]
  ): Promise<void> => {
    const list = [...settings.mcpServers]
    const created: { id: string; secrets: Record<string, string> }[] = []
    for (const entry of entries) {
      const id = uniqueServerId(entry.name, list)
      const secretEnv = Object.keys(entry.secrets ?? {})
      list.push({
        id,
        name: entry.name,
        enabled: true,
        command: entry.command,
        args: entry.args,
        ...(entry.env && Object.keys(entry.env).length > 0 ? { env: entry.env } : {}),
        ...(secretEnv.length > 0 ? { secretEnv } : {}),
        ...(entry.url ? { url: entry.url } : {})
      })
      created.push({ id, secrets: entry.secrets ?? {} })
    }
    // Erst speichern: Der Hauptprozess nimmt Schlüssel nur für Server an,
    // die in den Einstellungen stehen.
    await patch({ mcpServers: list })
    for (const { id, secrets } of created) {
      for (const [name, value] of Object.entries(secrets)) {
        if (value) await window.jarvis.invoke('mcp:setSecret', { id, name, value })
      }
    }
    await reload()
  }

  const addPreset = async (preset: McpPreset): Promise<void> => {
    setNote(null)
    await addServers([
      {
        name: preset.name,
        command: preset.command,
        args: preset.args,
        url: preset.url,
        secrets: Object.fromEntries((preset.secretEnv ?? []).map((n) => [n, '']))
      }
    ])
    setNote({
      ok: true,
      text: preset.url
        ? `${preset.name} ist eingetragen. Jetzt unten am Server auf „Anmelden" klicken.`
        : preset.secretEnv?.length
          ? `${preset.name} ist eingetragen. Fehlt nur noch der Schlüssel unten am Server.`
          : `${preset.name} ist eingetragen und gestartet.`
    })
  }

  const importJson = async (): Promise<void> => {
    let parsed: ParsedMcpServer[]
    try {
      parsed = parseMcpConfig(json)
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : String(err) })
      return
    }
    await addServers(parsed)
    setJson('')
    const open = parsed.flatMap((p) =>
      Object.entries(p.secrets)
        .filter(([, v]) => !v)
        .map(([k]) => k)
    )
    setNote({
      ok: true,
      text:
        `Übernommen: ${parsed.map((p) => p.name).join(', ')}.` +
        (open.length > 0 ? ` Noch einzutragen: ${open.join(', ')}.` : '')
    })
  }

  const addManual = async (): Promise<void> => {
    const name = draft.name.trim()
    const command = draft.command.trim()
    if (!name || !command) return
    await addServers([{ name, command, args: splitArgs(draft.args) }])
    setDraft({ name: '', command: '', args: '' })
  }

  const update = async (id: string, change: Partial<McpServerConfig>): Promise<void> => {
    await patch({ mcpServers: settings.mcpServers.map((x) => (x.id === id ? { ...x, ...change } : x)) })
  }

  const remove = async (id: string): Promise<void> => {
    await patch({ mcpServers: settings.mcpServers.filter((x) => x.id !== id) })
    await window.jarvis.invoke('mcp:clearSecrets', { id })
    await reload()
  }

  // Am Paket erkannt, nicht an der ganzen Zeile — ein eingefügter Block
  // schreibt Playwright mal mit, mal ohne `-y`.
  const isInstalled = (preset: McpPreset): boolean => {
    if (preset.url) return settings.mcpServers.some((s) => s.url === preset.url)
    const pkg = preset.args.find((a) => !a.startsWith('-')) ?? ''
    return settings.mcpServers.some((s) => s.args.includes(pkg))
  }

  return (
    <>
      <h2>MCP-Server</h2>
      <p className="lede">
        James spricht das Model Context Protocol. Jeder Server bringt seine eigenen Werkzeuge mit —
        Browser, Dateisystem, GitHub, Smart Home. Code schreiben muss dafür niemand.
      </p>

      <div className="field">
        <label>Mit einem Klick</label>
        <div className="mcp-presets">
          {MCP_PRESETS.map((preset) => {
            const present = isInstalled(preset)
            return (
              <button
                key={preset.id}
                className="mcp-preset"
                disabled={present || reloading}
                onClick={() => void addPreset(preset)}
              >
                <strong>
                  {preset.name}{' '}
                  {present ? (
                    <span className="badge ok">eingetragen</span>
                  ) : preset.url ? (
                    <span className="badge missing">Anmeldung</span>
                  ) : preset.secretEnv?.length ? (
                    <span className="badge missing">braucht Key</span>
                  ) : null}
                </strong>
                <small>{preset.description}</small>
              </button>
            )
          })}
        </div>
      </div>

      <div className="field">
        <label>Konfiguration einfügen</label>
        <textarea
          rows={6}
          spellCheck={false}
          placeholder={
            '{\n  "mcpServers": {\n    "playwright": {\n      "command": "npx",\n      "args": ["@playwright/mcp@latest"]\n    }\n  }\n}'
          }
          value={json}
          onChange={(e) => {
            setJson(e.target.value)
            setNote(null)
          }}
          style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}
        />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="primary" disabled={!json.trim() || reloading} onClick={() => void importJson()}>
            {reloading ? 'Startet…' : 'Übernehmen'}
          </button>
        </div>
        <div className="hint">
          Der Block, den fast jede MCP-Anleitung zum Kopieren anbietet — für Claude Desktop, Cursor
          oder VS Code. Steht darin ein API-Key, landet er verschlüsselt im Keystore und nicht in den
          Einstellungen.
        </div>
        {note && <div className={note.ok ? 'hint ok' : 'hint err'}>{note.text}</div>}
      </div>

      {settings.mcpServers.length > 0 && (
        <div className="field">
          <label>Eingetragen</label>
          {settings.mcpServers.map((s) => (
            <McpServerCard
              key={s.id}
              server={s}
              status={status?.[s.id] ?? null}
              reloading={reloading}
              onLogin={() => login(s.id)}
              onLogout={() => void logout(s.id)}
              onToggle={async (enabled) => {
                await update(s.id, { enabled })
                await reload()
              }}
              onSecretEnv={(secretEnv) => update(s.id, { secretEnv })}
              onRemove={() => void remove(s.id)}
              onKeysChanged={() => void reload()}
            />
          ))}
          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={() => void reload()} disabled={reloading}>
              {reloading ? 'Lädt neu…' : 'Alle neu laden'}
            </button>
          </div>
          <div className="hint">
            Was nur liest, läuft ohne Rückfrage. Alles, was etwas tut, fragt nach — einzelne
            Werkzeuge lassen sich unter „Rechte" freigeben. Code ausführen und Dateien hochladen fragt
            immer. Beim ersten Start holt npx das Paket aus dem Netz, das kann eine Minute dauern.
          </div>
        </div>
      )}

      <details className="advanced-choice">
        <summary>Von Hand eintragen</summary>
        <div className="field" style={{ marginTop: 10 }}>
          <input
            type="text"
            placeholder="Name, z. B. Spotify"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            style={{ marginBottom: 8 }}
          />
          <input
            type="text"
            placeholder="Befehl, z. B. npx"
            value={draft.command}
            onChange={(e) => setDraft({ ...draft, command: e.target.value })}
            style={{ marginBottom: 8 }}
          />
          <input
            type="text"
            placeholder="Argumente, z. B. -y @modelcontextprotocol/server-filesystem C:\\Users"
            value={draft.args}
            onChange={(e) => setDraft({ ...draft, args: e.target.value })}
            style={{ marginBottom: 8 }}
          />
          <button className="primary" onClick={() => void addManual()} disabled={reloading}>
            Hinzufügen
          </button>
        </div>
      </details>
    </>
  )
}

/** Ein eingetragener Server: Zustand, Schalter und seine API-Keys. */
function McpServerCard({
  server,
  status: serverStatus,
  reloading,
  onLogin,
  onLogout,
  onToggle,
  onSecretEnv,
  onRemove,
  onKeysChanged
}: {
  server: McpServerConfig
  status: McpServerStatus | null
  reloading: boolean
  onLogin: () => Promise<string | null>
  onLogout: () => void
  onToggle: (enabled: boolean) => Promise<void>
  onSecretEnv: (names: string[]) => Promise<void>
  onRemove: () => void
  onKeysChanged: () => void
}): JSX.Element {
  const names = server.secretEnv ?? []
  const [status, setStatus] = useState<Record<string, boolean>>({})
  const [values, setValues] = useState<Record<string, string>>({})
  const [newName, setNewName] = useState('')
  const [error, setError] = useState('')

  const namesKey = names.join(',')
  useEffect(() => {
    if (!namesKey) return
    void window.jarvis.invoke('mcp:secretStatus', { id: server.id }).then(setStatus)
  }, [server.id, namesKey])

  const save = async (name: string): Promise<void> => {
    const value = values[name]
    if (!value) return
    setError('')
    try {
      setStatus(await window.jarvis.invoke('mcp:setSecret', { id: server.id, name, value }))
      setValues((v) => ({ ...v, [name]: '' }))
      onKeysChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const clear = async (name: string): Promise<void> => {
    setStatus(await window.jarvis.invoke('mcp:setSecret', { id: server.id, name, value: '' }))
    onKeysChanged()
  }

  const addName = async (): Promise<void> => {
    const name = newName.trim().toUpperCase()
    if (!ENV_NAME.test(name)) {
      setError('Der Name darf nur Buchstaben, Ziffern und _ enthalten, z. B. BRAVE_API_KEY.')
      return
    }
    setError('')
    if (!names.includes(name)) await onSecretEnv([...names, name])
    setNewName('')
  }

  const missing = names.filter((n) => !status[n])
  const state = !server.enabled
    ? { cls: 'missing', text: 'aus' }
    : reloading
      ? { cls: 'missing', text: 'lädt…' }
      : missing.length > 0 || serverStatus?.state === 'key'
        ? { cls: 'err', text: 'Key fehlt' }
        : serverStatus?.state === 'login'
          ? { cls: 'err', text: 'Anmeldung nötig' }
          : serverStatus?.state === 'ok'
            ? { cls: 'ok', text: `${serverStatus.tools} Werkzeuge` }
            : serverStatus?.state === 'error'
              ? { cls: 'err', text: 'nicht erreichbar' }
              : null

  const signIn = async (): Promise<void> => {
    setError('')
    const problem = await onLogin()
    if (problem) setError(problem)
  }

  return (
    <div className="mcp-card">
      <div className="mcp-card-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <strong>{server.name}</strong>{' '}
          {state && <span className={`badge ${state.cls}`}>{state.text}</span>}
          <div className="hint">
            <code>{server.url ?? `${server.command} ${server.args.join(' ')}`}</code>
          </div>
          {serverStatus?.state === 'error' && serverStatus.error && (
            <div className="hint err">{serverStatus.error}</div>
          )}
        </div>
        {server.url && server.enabled && serverStatus?.state !== 'ok' && (
          <button className="primary" disabled={reloading} onClick={() => void signIn()}>
            Anmelden
          </button>
        )}
        {server.url && serverStatus?.state === 'ok' && (
          <button disabled={reloading} onClick={onLogout}>
            Abmelden
          </button>
        )}
        <label style={{ fontWeight: 400, whiteSpace: 'nowrap', margin: 0 }}>
          <input
            type="checkbox"
            checked={server.enabled}
            style={{ width: 'auto', marginRight: 6 }}
            onChange={(e) => void onToggle(e.target.checked)}
          />
          aktiv
        </label>
        <button onClick={onRemove}>Löschen</button>
      </div>

      {names.map((name) => (
        <div className="row" key={name} style={{ marginTop: 10 }}>
          <code style={{ minWidth: 170 }}>{name}</code>
          <input
            type="password"
            style={{ flex: 1, minWidth: 160, width: 'auto' }}
            placeholder={status[name] ? '••••••••••••  (neu eingeben zum Ersetzen)' : 'API-Key einfügen…'}
            value={values[name] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save(name)
            }}
          />
          <button className="primary" disabled={!values[name]} onClick={() => void save(name)}>
            Speichern
          </button>
          {status[name] ? (
            <button onClick={() => void clear(name)}>Löschen</button>
          ) : (
            <button onClick={() => void onSecretEnv(names.filter((n) => n !== name))}>Entfernen</button>
          )}
        </div>
      ))}

      {/* Ferne Server melden sich im Browser an — Umgebungsvariablen gibt es dort nicht. */}
      {!server.url && (
      <details style={{ marginTop: 8 }}>
        <summary className="hint" style={{ cursor: 'pointer' }}>
          API-Key hinzufügen
        </summary>
        <div className="row" style={{ marginTop: 6 }}>
          <input
            type="text"
            style={{ flex: 1, width: 'auto' }}
            placeholder="Name der Variable, z. B. BRAVE_API_KEY"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addName()
            }}
          />
          <button onClick={() => void addName()}>Feld anlegen</button>
        </div>
      </details>
      )}
      {error && <div className="hint err">{error}</div>}
    </div>
  )
}

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
    void window.jarvis.invoke('diag:ping').then((r) => setVersion(r.version))
    void window.jarvis.invoke('cost:get').then(setCost)
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
        <input
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
          <button onClick={() => void window.jarvis.invoke('app:openGuide')}>
            Kurzanleitung öffnen
          </button>
          <button onClick={() => void window.jarvis.invoke('app:showLog')}>
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
