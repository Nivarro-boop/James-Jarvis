import { useEffect, useRef, useState, type JSX } from 'react'
import type { McpServerConfig, McpServerStatus, Settings } from '@shared/types'
import { ENV_NAME, MCP_PRESETS, parseMcpConfig, uniqueServerId, exportMcpConfig, validateMcpUrl, splitMcpArgs, type McpPreset, type ParsedMcpServer } from '@shared/mcp'
import './connectors.css'

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
export function McpSection({ settings, patch, onNavigate }: { settings: Settings; patch: Patch; onNavigate?: (section: 'keys' | 'connections' | 'smarthome' | 'music' | 'alexa' | 'companion') => void }): JSX.Element {
  const [draft, setDraft] = useState({ name: '', command: '', args: '' })
  const [json, setJson] = useState('')
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [reloading, setReloading] = useState(false)
  const [status, setStatus] = useState<Record<string, McpServerStatus> | null>(null)
  const [search, setSearch] = useState('')
  const [preview, setPreview] = useState<ParsedMcpServer[] | null>(null)
  const [remote, setRemote] = useState({ name: '', url: '' })
  const [exported, setExported] = useState('')
  const adding = useRef(false)

  useEffect(() => {
    let alive = true
    const load = (): void => { void window.jarvis.invoke('mcp:status').then(next => { if (alive) setStatus(next) }).catch(() => undefined) }
    load()
    const timer = window.setInterval(load, 5000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [])

  const reload = async (): Promise<void> => {
    setReloading(true)
    setNote(null)
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
    } catch (err) {
      return err instanceof Error ? err.message : 'Die Anmeldung hat nicht geklappt.'
    } finally {
      setReloading(false)
    }
  }

  const logout = async (id: string): Promise<void> => {
    setReloading(true)
    try {
      await window.jarvis.invoke('mcp:logout', { id })
      setStatus(await window.jarvis.invoke('mcp:status'))
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : 'Das Abmelden ging nicht.' })
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
      headers?: Record<string, string>
    }[]
  ): Promise<void> => {
    if (adding.current) throw new Error('Ein Konnektor wird bereits eingerichtet. Bitte kurz warten.')
    adding.current = true
    setReloading(true)
    try {
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
        ...(entry.url ? { url: entry.url } : {}),
        ...(entry.headers ? { headers: entry.headers } : {})
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
    } finally { adding.current = false; setReloading(false) }
  }

  const addPreset = async (preset: McpPreset): Promise<void> => {
    setNote(null)
    try {
      await addServers([
        {
          name: preset.name,
          command: preset.command,
          args: preset.args,
          url: preset.url,
          headers: preset.headers,
          secrets: Object.fromEntries((preset.secretEnv ?? []).map((n) => [n, '']))
        }
      ])
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : `${preset.name} ließ sich nicht eintragen.` })
      return
    }
    setNote({
      ok: true,
      text: preset.secretEnv?.length
        ? `${preset.name} ist eingetragen. Trage den Schlüssel unten in der Karte ein.`
        : preset.url
        ? `${preset.name} ist eingetragen. Jetzt unten am Server auf „Anmelden" klicken.`
        : `${preset.name} ist eingetragen. Den Verbindungsstatus siehst du unten.`
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
    try {
      await addServers(parsed)
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : 'Die Übernahme ging nicht.' })
      return
    }
    setJson('')
    setPreview(null)
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
    try {
      await addServers([{ name, command, args: splitMcpArgs(draft.args) }])
      setDraft({ name: '', command: '', args: '' })
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : 'Der Server ließ sich nicht eintragen.' })
    }
  }

  const update = async (id: string, change: Partial<McpServerConfig>): Promise<void> => {
      await patch({ mcpServers: settings.mcpServers.map((x) => (x.id === id ? { ...x, ...change } : x)) })
  }

  const remove = async (id: string): Promise<void> => {
    try {
      await patch({ mcpServers: settings.mcpServers.filter((x) => x.id !== id) })
      await window.jarvis.invoke('mcp:clearSecrets', { id })
      await reload()
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : 'Das Entfernen ging nicht.' })
    }
  }

  // Am Paket erkannt, nicht an der ganzen Zeile — ein eingefügter Block
  // schreibt Playwright mal mit, mal ohne `-y`.
  const isInstalled = (preset: McpPreset): boolean => {
    if (preset.url) return settings.mcpServers.some((s) => s.url === preset.url)
    const pkg = preset.args.find((a) => !a.startsWith('-')) ?? ''
    return settings.mcpServers.some((s) => s.args.some(arg => arg.replace(/@latest$/, '') === pkg.replace(/@latest$/, '')))
  }
  const matches = (text: string): boolean => search.toLocaleLowerCase('de').trim().split(/\s+/).every(word => text.toLocaleLowerCase('de').includes(word))
  const presets = MCP_PRESETS.filter(p => matches(`${p.name} ${p.description} ${p.category ?? ''}`))
  const builtins = [
    { name: 'Google Kalender', description: 'Termine lesen, anlegen und verschieben.', section: 'keys' },
    { name: 'Gmail & Yahoo', description: 'E-Mails lesen und mit eingerichteter Schnittstelle bearbeiten.', section: 'connections' },
    { name: 'Home Assistant', description: 'Licht, Steckdosen und Smart-Home-Geräte steuern.', section: 'smarthome' },
    { name: 'Spotify & Apple Music', description: 'Musik suchen, Wiedergabe und Ausgabegeräte steuern.', section: 'music' },
    { name: 'WhatsApp & Webkonten', description: 'Vorhandene Browser-Verbindungen verwalten.', section: 'connections' },
    { name: 'Alexa', description: 'James mit deinem Echo verbinden.', section: 'alexa' },
    { name: 'Telefon & Handy', description: 'Telefonfunktionen und Mobilgerät einrichten.', section: 'companion' }
  ] as const
  const builtInMatches = builtins.filter(p => matches(`${p.name} ${p.description}`))
  const reportError = (error: unknown): void => setNote({ ok: false, text: error instanceof Error ? error.message : 'Die Aktion ist fehlgeschlagen.' })
  const addRemote = async (): Promise<void> => {
    try {
      const url = validateMcpUrl(remote.url).toString()
      if (settings.mcpServers.some(server => server.url === url)) throw new Error('Diese Serveradresse ist bereits eingetragen.')
      await addServers([{ name: remote.name.trim() || new URL(url).hostname, command: '', args: [], url }])
      setRemote({ name: '', url: '' })
      setNote({ ok: true, text: 'Konnektor eingetragen. Den Status und die Anmeldung findest du unten.' })
    } catch (error) { reportError(error) }
  }

  return (
    <>
      <h2>Erweiterungen</h2>
      <p className="lede">
        Erweiterungen geben James neue Fähigkeiten: Kalender, Smart Home, Notizen, Arbeit.
        Oben stehen die eingebauten, darunter welche zum Hinzufügen mit einem Klick.
      </p>
      <div className="connector-summary" aria-label="Status der Erweiterungen"><strong>{settings.mcpServers.length} eingetragen</strong><span>{Object.values(status ?? {}).filter(s => s.state === 'ok').length} verbunden</span><span>{Object.values(status ?? {}).reduce((sum, s) => sum + (s.state === 'ok' ? s.tools : 0), 0)} zusätzliche Werkzeuge</span></div>
      <label className="connector-search">Erweiterung finden<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Kalender, Smart Home, GitHub…" /></label>
      {note && <p role={note.ok ? 'status' : 'alert'} className={note.ok ? 'hint ok' : 'hint err'}>{note.text}</p>}
      {onNavigate && builtInMatches.length > 0 && <section className="connector-builtins" aria-label="In James enthalten"><h3>In James enthalten</h3><div className="mcp-presets">{builtInMatches.map(item => <button type="button" className="mcp-preset" key={item.name} onClick={() => onNavigate(item.section)}><strong>{item.name} <span aria-hidden="true">↗</span></strong><small>{item.description}</small><small>Einrichtung öffnen</small></button>)}</div></section>}
      {!presets.length && !builtInMatches.length && <p role="status">Kein Treffer. Eigene Erweiterungen kannst du ganz unten hinzufügen.</p>}

      <div className="field">
        <h3>Mit einem Klick hinzufügen</h3>
        <div className="mcp-presets">
          {presets.map((preset) => {
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
                  ) : preset.secretEnv?.length ? (
                    <span className="badge missing">Schlüssel</span>
                  ) : preset.url ? (
                    <span className="badge missing">Anmeldung</span>
                  ) : preset.secretEnv?.length ? (
                    <span className="badge missing">braucht Key</span>
                  ) : null}
                </strong>
                <small>{preset.description}</small>
                <small>{preset.category}</small>
              </button>
            )
          })}
        </div>
      </div>

      <hr className="section-divider" />
      <h3>Eigene Erweiterung hinzufügen</h3>
      <p className="hint">Für Fortgeschrittene: Erweiterungen nach dem MCP-Standard per Adresse, per kopierter Konfiguration oder von Hand.</p>
      <div className="field"><label className="connector-subhead">Per Adresse</label><label>Name<input value={remote.name} onChange={event => setRemote({ ...remote, name: event.target.value })} placeholder="Mein Dienst" /></label><label>Serveradresse<input type="url" value={remote.url} onChange={event => setRemote({ ...remote, url: event.target.value })} placeholder="https://mein-dienst.example/mcp" /></label><button className="primary" disabled={reloading || !remote.url.trim()} onClick={() => void addRemote()}>Konnektor hinzufügen</button><p className="hint">Für eine Anmeldung per Token nutze den Konfigurationsimport mit einem Authorization-Header. Der Token wird verschlüsselt abgelegt.</p></div>

      <div className="field">
        <label>Per kopierter Konfiguration</label>
        <textarea
          aria-label="Konnektor-Konfiguration"
          rows={6}
          spellCheck={false}
          placeholder={
            '{\n  "mcpServers": {\n    "playwright": {\n      "command": "npx",\n      "args": ["@playwright/mcp@latest"]\n    }\n  }\n}'
          }
          value={json}
          onChange={(e) => {
            setJson(e.target.value)
            setNote(null)
            setPreview(null)
          }}
          style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}
        />
        <div className="row" style={{ marginTop: 8 }}>
          <button disabled={!json.trim() || reloading} onClick={() => { try { setPreview(parseMcpConfig(json)); setNote(null) } catch (error) { reportError(error); setPreview(null) } }}>Konfiguration prüfen</button>
          {preview && <button className="primary" disabled={reloading} onClick={() => void importJson()}>{reloading ? 'Wird eingerichtet…' : `${preview.length} Konnektor${preview.length === 1 ? '' : 'en'} übernehmen`}</button>}
        </div>
        {preview && <div className="connector-preview" role="region" aria-label="Import-Vorschau"><strong>Wird hinzugefügt</strong><ul>{preview.map((entry, i) => <li key={i}>{entry.name} · {entry.url ? 'Remote' : 'Lokaler Prozess'} · {Object.keys(entry.secrets).length} geschützte Felder</li>)}</ul><p>Ein lokaler Prozess wird beim Übernehmen mit deinen Benutzerrechten gestartet.</p></div>}
        <div className="hint">
          Der Block, den fast jede MCP-Anleitung zum Kopieren anbietet — für Claude Desktop, Cursor
          oder VS Code. Steht darin ein API-Key, landet er verschlüsselt im Keystore und nicht in den
          Einstellungen.
        </div>
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
              onLogout={() => void logout(s.id).catch(reportError)}
              onToggle={async (enabled) => { try {
                await update(s.id, { enabled })
                await reload()
              } catch (error) { reportError(error) } }}
              onSecretEnv={(secretEnv) => update(s.id, { secretEnv })}
              onRemove={() => void remove(s.id)}
              onKeysChanged={() => void reload().catch(reportError)}
            />
          ))}
          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={() => void reload().catch(reportError)} disabled={reloading}>
              {reloading ? 'Lädt neu…' : 'Alle neu laden'}
            </button>
            <button disabled={reloading} onClick={() => { try { setExported(exportMcpConfig(settings.mcpServers)) } catch (error) { reportError(error) } }}>Vorlage ohne Schlüssel exportieren</button>
          </div>
          {exported && <label className="connector-export">Vorlage ohne Schlüssel<textarea rows={7} readOnly value={exported} onFocus={event => event.target.select()} /></label>}
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
            aria-label="Name des Werkzeugs"
            type="text"
            placeholder="Name, z. B. Spotify"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            style={{ marginBottom: 8 }}
          />
          <input
            aria-label="Befehl zum Starten"
            type="text"
            placeholder="Befehl, z. B. npx"
            value={draft.command}
            onChange={(e) => setDraft({ ...draft, command: e.target.value })}
            style={{ marginBottom: 8 }}
          />
          <input
            aria-label="Argumente für den Befehl"
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
  const headerAuth = Object.keys(server.headers ?? {}).length > 0
  const preset = MCP_PRESETS.find(p => p.url ? p.url === server.url : p.args.some(arg => arg.startsWith('@') && server.args.includes(arg)))
  const [status, setStatus] = useState<Record<string, boolean>>({})
  const [values, setValues] = useState<Record<string, string>>({})
  const [newName, setNewName] = useState('')
  const [error, setError] = useState('')

  const namesKey = names.join(',')
  useEffect(() => {
    if (!namesKey) return
    void window.jarvis
      .invoke('mcp:secretStatus', { id: server.id })
      .then(setStatus)
      .catch(() => { setError('Der Zustand der Schlüssel ließ sich nicht aufnehmen.') })
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
    setError('')
    try {
      setStatus(await window.jarvis.invoke('mcp:setSecret', { id: server.id, name, value: '' }))
      onKeysChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Das Entfernen ging nicht.')
    }
  }

  const addName = async (): Promise<void> => {
    const name = newName.trim().toUpperCase()
    if (!ENV_NAME.test(name)) {
      setError('Der Name darf nur Buchstaben, Ziffern und _ enthalten, z. B. BRAVE_API_KEY.')
      return
    }
    setError('')
    try {
      if (!names.includes(name)) await onSecretEnv([...names, name])
      setNewName('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Das Feld ließ sich nicht anlegen.')
    }
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
        {server.url && !headerAuth && server.enabled && serverStatus?.state !== 'ok' && (
          <button className="primary" disabled={reloading} onClick={() => void signIn()}>
            Anmelden
          </button>
        )}
        {server.url && !headerAuth && serverStatus?.state === 'ok' && (
          <button disabled={reloading} onClick={onLogout}>
            Abmelden
          </button>
        )}
        <label style={{ fontWeight: 400, whiteSpace: 'nowrap', margin: 0 }}>
          <input
            type="checkbox"
            checked={server.enabled}
            disabled={reloading}
            style={{ width: 'auto', marginRight: 6 }}
            onChange={(e) => void onToggle(e.target.checked)}
          />
          aktiv
        </label>
        <button disabled={reloading} onClick={onRemove}>Löschen</button>
      </div>

      {names.map((name) => (
        <div className="row" key={name} style={{ marginTop: 10 }}>
          <code style={{ minWidth: 170 }}>{name}</code>
          <input
            type="password"
            aria-label={`${server.name} ${name}`}
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
          ) : !Object.values(server.headers ?? {}).some(value => value.includes('${' + name + '}')) ? (
            <button onClick={() => void onSecretEnv(names.filter((n) => n !== name)).catch(error => setError(String(error)))}>Entfernen</button>
          ) : null}
        </div>
      ))}
      {preset?.keyUrl && <p className="hint"><a href={preset.keyUrl} target="_blank" rel="noreferrer">Schlüssel bei {preset.name} erstellen ↗</a></p>}
      {preset?.docsUrl && <p className="hint"><a href={preset.docsUrl} target="_blank" rel="noreferrer">Anleitung von {preset.name} ↗</a></p>}

      {/* Ferne Server melden sich im Browser an — Umgebungsvariablen gibt es dort nicht. */}
      {!server.url && (
      <details style={{ marginTop: 8 }}>
        <summary className="hint" style={{ cursor: 'pointer' }}>
          API-Key hinzufügen
        </summary>
        <div className="row" style={{ marginTop: 6 }}>
          <input
            aria-label="Name der Umgebungsvariable"
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

