import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import {
  FEATURE_PACK_PERMISSION,
  type FeaturePackIpcMap,
  type FeaturePackInstalled,
  type FeaturePackPreview,
  type FeaturePackWidgetView
} from '@shared/featurePacks'
import './feature-packs.css'

const SAMPLE_JSON = `{
  "format": "jarvis-feature-pack",
  "schemaVersion": 1,
  "id": "beispiel-alltag",
  "name": "Alltag – Beispiel",
  "version": "1.0.0",
  "permissions": ["local-widget-state"],
  "widgets": [
    { "id": "kurznotiz", "type": "note", "title": "Kleine Erinnerung", "text": "Ein Feature-Pack enthält ausschließlich lokale, deklarative Widgets." },
    { "id": "start-checkliste", "type": "checklist", "title": "Tagesstart", "items": [
      { "id": "wasser", "text": "Ein Glas Wasser trinken" },
      { "id": "plan", "text": "Die drei wichtigsten Aufgaben notieren" }
    ] }
  ]
}`
type Channel = keyof FeaturePackIpcMap
const invoke = window.jarvis.invoke as unknown as (channel: Channel, req?: unknown) => Promise<unknown>
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Der Vorgang ist fehlgeschlagen.'
}
function emitChanged(): void { window.dispatchEvent(new Event('jarvis:packs-changed')) }

/** Import and lifecycle controls. This component is optional; widgets are separately embeddable. */
export function FeaturePacksPanel(): JSX.Element {
  const mounted = useRef(false)
  const [json, setJson] = useState('')
  const [preview, setPreview] = useState<FeaturePackPreview | null>(null)
  const [packs, setPacks] = useState<FeaturePackInstalled[]>([])
  const [trustAccepted, setTrustAccepted] = useState(false)
  const [permissionAccepted, setPermissionAccepted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const load = useCallback(async (isMounted: () => boolean = () => mounted.current): Promise<void> => {
    try {
      const result = await invoke('packs:list') as FeaturePackInstalled[]
      if (isMounted()) { setPacks(result); setLoading(false) }
    } catch (cause) { if (isMounted()) { setError(errorMessage(cause)); setLoading(false) } }
  }, [])
  useEffect(() => {
    mounted.current = true
    const refresh = (): void => { void load(() => mounted.current) }
    refresh()
    window.addEventListener('jarvis:packs-changed', refresh)
    return () => { mounted.current = false; window.removeEventListener('jarvis:packs-changed', refresh) }
  }, [load])
  const runPreview = async (): Promise<void> => {
    setBusy(true); setError(''); setNotice(''); setPreview(null); setTrustAccepted(false); setPermissionAccepted(false)
    try {
      const result = await invoke('packs:preview', { json }) as FeaturePackPreview
      if (mounted.current) setPreview(result)
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const install = async (): Promise<void> => {
    if (!preview || !trustAccepted || (preview.manifest.permissions.includes(FEATURE_PACK_PERMISSION) && !permissionAccepted)) return
    setBusy(true); setError(''); setNotice('')
    try {
      await invoke('packs:install', {
        json, sha256: preview.sha256, acceptTrust: trustAccepted,
        acceptedPermissions: permissionAccepted ? [FEATURE_PACK_PERMISSION] : []
      })
      if (mounted.current) { setPreview(null); setNotice('Feature-Pack wurde lokal installiert bzw. aktualisiert.'); emitChanged() }
      await load()
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const enablePack = async (pack: FeaturePackInstalled, enabled: boolean): Promise<void> => {
    if (!enabled && !window.confirm(`Feature-Pack „${pack.name}“ deaktivieren? Seine Widgets werden ausgeblendet.`)) return
    setBusy(true); setError('')
    try { await invoke('packs:setEnabled', { id: pack.id, enabled }); if (mounted.current) emitChanged(); await load() }
    catch (cause) { if (mounted.current) setError(errorMessage(cause)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const removePack = async (pack: FeaturePackInstalled): Promise<void> => {
    if (!window.confirm(`Feature-Pack „${pack.name}“ wirklich vollständig entfernen?`)) return
    setBusy(true); setError('')
    try { await invoke('packs:remove', { id: pack.id }); if (mounted.current) emitChanged(); await load() }
    catch (cause) { if (mounted.current) setError(errorMessage(cause)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const needsPermission = !!preview?.manifest.permissions.includes(FEATURE_PACK_PERMISSION)
  return <section className="feature-packs-panel" aria-labelledby="feature-packs-heading">
    <header className="feature-packs-header"><div><h2 id="feature-packs-heading">Deklarative Feature-Packs</h2><p>Nur lokale Notizen und Checklisten – keine Skripte, HTML/CSS, URLs oder ausführbaren Plugins.</p></div></header>
    <div className="feature-packs-import">
      <label htmlFor="feature-pack-json">Manifest-JSON</label>
      <textarea id="feature-pack-json" value={json} onChange={(event) => { setJson(event.target.value); setPreview(null); setError('') }} maxLength={65536} spellCheck={false} placeholder="JSON-Manifest einfügen" />
      <div className="feature-packs-actions">
        <button type="button" disabled={busy} onClick={() => { setJson(SAMPLE_JSON); setPreview(null); setError(''); setNotice('Beispiel geladen. Prüfe es vor der Installation.') }}>Beispiel laden</button>
        <button type="button" disabled={busy || !json.trim()} onClick={() => void runPreview()}>{busy ? 'Bitte warten …' : 'Prüfen und Vorschau'}</button>
      </div>
      {preview && <div className="feature-pack-preview" aria-live="polite">
        <h3>Vorschau: {preview.manifest.name}</h3>
        <p><strong>ID:</strong> {preview.manifest.id} · <strong>Version:</strong> {preview.manifest.version}{preview.installedVersion ? ` (installiert: ${preview.installedVersion})` : ''}</p>
        <p><strong>Widgets:</strong> {preview.manifest.widgets.map((widget) => `${widget.title} (${widget.type === 'note' ? 'Notiz' : 'Checkliste'})`).join(', ')}</p>
        <p><strong>Berechtigungen:</strong> {preview.manifest.permissions.length ? preview.manifest.permissions.join(', ') : 'Keine'}</p>
        <p><strong>SHA-256 der exakt geprüften JSON-Bytes:</strong> <code>{preview.sha256}</code></p>
        <p className="feature-pack-warning">Installiere nur JSON, dem du vertraust. Es werden keine Skripte ausgeführt; nur angezeigte lokale Checkzustände können gespeichert werden.</p>
        <label className="feature-pack-consent"><input type="checkbox" checked={trustAccepted} onChange={(event) => setTrustAccepted(event.target.checked)} /> Ich vertraue diesem Manifest und bestätige diese Installation/Aktualisierung ausdrücklich.</label>
        {needsPermission && <label className="feature-pack-consent"><input type="checkbox" checked={permissionAccepted} onChange={(event) => setPermissionAccepted(event.target.checked)} /> Ich erlaube <code>local-widget-state</code>: ausschließlich eigene Checkzustände dieses Packs lokal zu speichern.</label>}
        <button type="button" disabled={busy || !trustAccepted || (needsPermission && !permissionAccepted)} onClick={() => void install()}>{preview.update ? 'Ausdrücklich aktualisieren' : 'Ausdrücklich installieren'}</button>
      </div>}
    </div>
    <div className="feature-packs-installed">
      <h3>Installierte Packs</h3>
      {loading ? <p role="status">Lade lokale Packs …</p> : packs.length === 0 ? <p>Noch keine Feature-Packs installiert.</p> : packs.map((pack) => <article className="feature-pack-row" key={pack.id}>
        <div><strong>{pack.name}</strong><small>{pack.id} · v{pack.version} · {pack.widgets.length} Widgets · {pack.permissions.length ? pack.permissions.join(', ') : 'keine Berechtigungen'}</small></div>
        <label><input type="checkbox" checked={pack.enabled} disabled={busy} onChange={(event) => void enablePack(pack, event.target.checked)} /> Aktiv</label>
        <button type="button" disabled={busy} onClick={() => void removePack(pack)}>Entfernen</button>
      </article>)}
    </div>
    {error && <p className="feature-pack-error" role="alert">{error}</p>}{notice && <p className="feature-pack-notice" role="status">{notice}</p>}
  </section>
}

/** Safe data-only widget renderer; optional props make it directly embeddable in Board. */
export function FeaturePackWidgets(_props: { className?: string } = {}): JSX.Element {
  const mounted = useRef(false)
  const [widgets, setWidgets] = useState<FeaturePackWidgetView[]>([])
  const [error, setError] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  useEffect(() => {
    mounted.current = true
    const load = (): void => { void invoke('packs:widgets').then((items) => { if (mounted.current) { setWidgets(items as FeaturePackWidgetView[]); setError('') } }).catch((cause) => { if (mounted.current) setError(errorMessage(cause)) }) }
    load(); window.addEventListener('jarvis:packs-changed', load)
    return () => { mounted.current = false; window.removeEventListener('jarvis:packs-changed', load) }
  }, [])
  const toggle = async (view: FeaturePackWidgetView, itemId: string, checked: boolean): Promise<void> => {
    const key = `${view.packId}/${view.widget.id}/${itemId}`; setPending(key); setError('')
    try { const result = await invoke('packs:toggle', { packId: view.packId, widgetId: view.widget.id, itemId, checked }) as FeaturePackWidgetView[]; if (mounted.current) setWidgets(result) }
    catch (cause) { if (mounted.current) setError(errorMessage(cause)) }
    finally { if (mounted.current) setPending(null) }
  }
  return <div className={['feature-pack-widgets', _props.className].filter(Boolean).join(' ')}>
    {widgets.map((view) => <section className="feature-pack-widget" key={`${view.packId}/${view.widget.id}`}>
      <h3>{view.widget.title}</h3>
      {view.widget.type === 'note' ? <p>{view.widget.text}</p> : <ul>{view.widget.items.map((item) => {
        const key = `${view.packId}/${view.widget.id}/${item.id}`
        return <li key={item.id}><label><input type="checkbox" checked={!!view.checked?.[item.id]} disabled={pending !== null} onChange={(event) => void toggle(view, item.id, event.target.checked)} /> <span>{item.text}</span></label></li>
      })}</ul>}
      <small>{view.packName}</small>
    </section>)}
    {error && <p className="feature-pack-error" role="alert">{error}</p>}
  </div>
}
