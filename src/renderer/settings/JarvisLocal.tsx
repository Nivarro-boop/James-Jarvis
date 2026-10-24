import { useEffect, useState, type JSX } from 'react'
import type { HubFiles, HubModel, HubProgress, JarvisLocalStatus, Settings } from '@shared/types'

/**
 * Eigene lokale Modelle: suchen auf Hugging Face, laden, auswählen.
 *
 * Gerechnet wird mit llama.cpp auf diesem Rechner. Die Suche zeigt nur
 * GGUF-Modelle, denn nur die kann llama.cpp direkt öffnen.
 */

const fmtBytes = (n: number): string =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`
const fmtCount = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)} Mio.` : n >= 1e3 ? `${Math.round(n / 1e3)} Tsd.` : String(n)
const clean = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

interface Props {
  settings: Settings
  patch: (p: Partial<Settings>) => void
}

/** Geprüfte Modelle mit Apache-2.0-Lizenz – auch für eine verkaufte App unbedenklich. */
const QUICK_MODELS = [
  { repo: 'bartowski/Qwen2.5-7B-Instruct-GGUF', title: 'Empfohlen: Qwen 2.5 · 7B', note: 'Gute Antworten auf Deutsch. ca. 4,7 GB, ideal mit Grafikkarte ab 6 GB.' },
  { repo: 'bartowski/Qwen2.5-1.5B-Instruct-GGUF', title: 'Klein & schnell: Qwen 2.5 · 1,5B', note: 'Läuft auf jedem Rechner. ca. 1 GB, einfachere Antworten.' },
  { repo: 'bartowski/Mistral-7B-Instruct-v0.3-GGUF', title: 'Alternative: Mistral · 7B', note: 'Solides Allround-Modell. ca. 4,4 GB.' }
]

/**
 * Lokales Modell mit einem Klick: llama.cpp holen, empfohlene Variante laden,
 * auswählen und als Modell für Textaufgaben einstellen.
 */
export function LocalQuickStart({ settings, patch }: Props): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<HubProgress | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [installed, setInstalled] = useState<string[]>([])
  useEffect(() => window.jarvis.on('hub:progress', setProgress), [])
  useEffect(() => {
    void window.jarvis.invoke('jarvisLocal:status').then(s => setInstalled(s.models.map(m => m.path))).catch(() => undefined)
  }, [busy])

  const get = async (repo: string): Promise<void> => {
    setBusy(repo); setNote(null)
    try {
      const status = await window.jarvis.invoke('jarvisLocal:status')
      if (!status.runtime) await window.jarvis.invoke('hub:runtime')
      const files = await window.jarvis.invoke('hub:files', { repo })
      const model = await window.jarvis.invoke('hub:install', { repo, file: files.recommended })
      patch({ jarvisLocal: { model: model.path }, brainProvider: 'jarvis' })
      setNote({ ok: true, text: `${model.name} ist geladen und aktiv. James nutzt es ab jetzt für Textaufgaben.` })
    } catch (e) {
      setNote({ ok: false, text: clean(e) })
    } finally { setBusy(null); setProgress(null) }
  }

  const pct = progress && progress.total ? Math.round((progress.received / progress.total) * 100) : null
  const active = settings.brainProvider === 'jarvis' && settings.jarvisLocal?.model
  return (
    <div className="field local-quick">
      <label>Lokales Modell mit einem Klick</label>
      <div className="settings-tiles">
        {QUICK_MODELS.map(m => {
          const have = installed.some(p => p.toLowerCase().includes(m.repo.split('/')[1].replace('-GGUF', '').toLowerCase()))
          return (
            <button key={m.repo} className="settings-tile" disabled={busy !== null} onClick={() => void get(m.repo)}>
              <strong>{m.title}</strong><p>{m.note}</p>
              <span>{busy === m.repo ? (pct !== null ? `Lädt … ${pct} %` : 'Lädt …') : have ? 'Geladen · erneut wählen ↗' : 'Herunterladen ↗'}</span>
            </button>
          )
        })}
      </div>
      {busy && progress && <progress max={100} value={pct ?? undefined} style={{ width: '100%', marginTop: 8 }} />}
      {busy && <button type="button" onClick={() => void window.jarvis.invoke('hub:cancel')}>Abbrechen</button>}
      {note && <p role="status" className={note.ok ? 'hint ok' : 'hint err'}>{note.text}</p>}
      <div className="hint">{active ? 'Lokales Modell ist aktiv. ' : ''}Läuft komplett auf deinem Rechner, kostet nichts, sendet nichts ins Netz.</div>
    </div>
  )
}

export function JarvisLocalSetup({ settings, patch }: Props): JSX.Element {
  const chosen = settings.jarvisLocal?.model ?? ''
  const [status, setStatus] = useState<JarvisLocalStatus | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('downloads')
  const [results, setResults] = useState<HubModel[]>([])
  const [open, setOpen] = useState<HubFiles | null>(null)
  const [file, setFile] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<HubProgress | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = (): void => {
    void window.jarvis.invoke('jarvisLocal:status').then(setStatus).catch(() => undefined)
  }
  useEffect(refresh, [])
  useEffect(() => window.jarvis.on('hub:progress', setProgress), [])

  const search = async (): Promise<void> => {
    setError('')
    setOpen(null)
    setNote('Suche …')
    try {
      const list = await window.jarvis.invoke('hub:search', { query, sort })
      setResults(list)
      setNote(list.length ? `${list.length} Treffer` : 'Keine GGUF-Modelle gefunden.')
    } catch (e) {
      setNote('')
      setError(clean(e))
    }
  }

  const openRepo = async (repo: string): Promise<void> => {
    if (open?.repo === repo) return setOpen(null)
    setError('')
    try {
      const info = await window.jarvis.invoke('hub:files', { repo })
      setOpen(info)
      setFile(info.recommended)
    } catch (e) {
      setError(clean(e))
    }
  }

  const install = async (): Promise<void> => {
    if (!open || !file || busy) return
    setBusy(true)
    setError('')
    try {
      if (!status?.runtime) {
        setNote('llama.cpp wird geladen …')
        setStatus(await window.jarvis.invoke('hub:runtime'))
      }
      const model = await window.jarvis.invoke('hub:install', { repo: open.repo, file })
      patch({ jarvisLocal: { model: model.path } })
      setNote(`${model.name} ist geladen und ausgewählt.`)
      refresh()
    } catch (e) {
      setError(clean(e))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const remove = async (path: string): Promise<void> => {
    if (!window.confirm('Modelldatei endgültig löschen?')) return
    try {
      setStatus(await window.jarvis.invoke('hub:remove', { path }))
      if (path === chosen) patch({ jarvisLocal: { model: '' } })
    } catch (e) {
      setError(clean(e))
    }
  }

  const pct = progress && progress.total ? Math.round((progress.received / progress.total) * 100) : null

  return (
    <div className="jarvis-local">
      <label>Eigenes Modell</label>
      {status && status.models.length > 0 ? (
        <div className="jl-models" role="radiogroup" aria-label="Lokales Modell">
          {status.models.map((m) => (
            <div key={m.path} className={`jl-model${m.path === chosen ? ' active' : ''}`}>
              <button type="button" role="radio" aria-checked={m.path === chosen}
                onClick={() => patch({ jarvisLocal: { model: m.path } })}>
                <strong>{m.name}</strong>
                <small>{[m.source, fmtBytes(m.size), status.running === m.path ? 'läuft' : ''].filter(Boolean).join(' · ')}</small>
              </button>
              <button type="button" className="jl-remove" aria-label={`${m.name} löschen`} onClick={() => void remove(m.path)}>Löschen</button>
            </div>
          ))}
        </div>
      ) : (
        <div className="hint">Noch kein Modell geladen. Unten auf Hugging Face suchen.</div>
      )}
      {status && !status.runtime && (
        <div className="hint">llama.cpp fehlt noch und wird beim ersten Download mitgeladen (CPU-Fassung, ca. 30 MB).</div>
      )}

      <label style={{ marginTop: 14 }}>Von Hugging Face laden</label>
      <div className="jl-search">
        <input type="search" value={query} placeholder="z. B. qwen, gemma, llama, mistral, deutsch" aria-label="Modelle suchen"
          onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void search() }} />
        <select value={sort} aria-label="Sortierung" onChange={(e) => setSort(e.target.value)}>
          <option value="downloads">Meiste Downloads</option>
          <option value="trendingScore">Im Trend</option>
          <option value="likes">Meiste Likes</option>
          <option value="lastModified">Neueste</option>
        </select>
        <button type="button" onClick={() => void search()}>Suchen</button>
      </div>
      {note && <div className="hint" aria-live="polite">{note}</div>}
      {error && <div className="hint err">{error}</div>}

      <div className="jl-results">
        {results.map((m) => (
          <div key={m.id} className="jl-result">
            <button type="button" className="jl-name" aria-expanded={open?.repo === m.id} onClick={() => void openRepo(m.id)}>
              {m.id}
            </button>
            <small>
              {[`↓ ${fmtCount(m.downloads)}`, `♥ ${fmtCount(m.likes)}`, m.license && `Lizenz: ${m.license}`, m.gated && 'gesperrt']
                .filter(Boolean).join(' · ')}
            </small>
            {open?.repo === m.id && (
              <div className="jl-files">
                <select value={file} aria-label="Variante" onChange={(e) => setFile(e.target.value)}>
                  {open.files.map((f) => (
                    <option key={f.path} value={f.path} disabled={f.split}>
                      {`${f.quant || f.path} · ${fmtBytes(f.size)}${f.split ? ' · geteilt, nicht unterstützt' : ''}${f.path === open.recommended ? ' · empfohlen' : ''}`}
                    </option>
                  ))}
                </select>
                {busy
                  ? <button type="button" onClick={() => void window.jarvis.invoke('hub:cancel')}>Abbrechen</button>
                  : <button type="button" className="primary" disabled={!file} onClick={() => void install()}>Herunterladen</button>}
                {busy && progress && (
                  <div className="jl-progress">
                    <progress max={100} value={pct ?? undefined} />
                    <small>{progress.label}: {fmtBytes(progress.received)}{progress.total ? ` von ${fmtBytes(progress.total)}` : ''}</small>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="hint" style={{ marginTop: 8 }}>
        Läuft komplett auf diesem Rechner, kostet nichts. Modelle liegen unter {status?.modelsPath ?? '~/JamesJarvis/modelle'}.
        Lizenz des Modells vor der Nutzung prüfen. Gilt für Textaufgaben; das Gespräch selbst denkt weiter über den gewählten Sprachweg.
      </div>
    </div>
  )
}

/** Eigene Seite „Lokale KI": drei Modelle mit einem Klick, darunter die freie Suche. */
export function LocalSection({ settings, patch }: Props): JSX.Element {
  return (
    <>
      <h2>Lokale KI</h2>
      <p className="lede">Ein Modell auf deinem Rechner: kostenlos, offline, privat. Ein Klick genügt.</p>
      <LocalQuickStart settings={settings} patch={patch} />
      <hr className="section-divider" />
      <h3 className="settings-step">Andere Modelle suchen</h3>
      <JarvisLocalSetup settings={settings} patch={patch} />
    </>
  )
}
