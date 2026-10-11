import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'

const KINDS = ['incident', 'capability-gap']
// Fähigkeitslücken liegen unter eigenem Präfix; Fehlerberichte behalten das alte Schlüsselformat.
const GAP_PREFIX = 'gap/'
const GAP_WINDOW = 200
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NO_GAP_TOKEN = 'Fähigkeitslücken brauchen JARVIS_REPORT_TOKEN auf dem Server.'

// Der Zeitanteil im Schlüssel ist umgekehrt: aufsteigend sortiert kommt der neueste Bericht zuerst.
const stamp = () => String(9999999999999 - Date.now()).padStart(13, '0')
const age = key => key.startsWith(GAP_PREFIX) ? key.slice(GAP_PREFIX.length) : key
const byAge = (a, b) => { const x = age(a), y = age(b); return x < y ? -1 : x > y ? 1 : 0 }
const keyFingerprint = key => /^gap\/\d{13}-([0-9a-f]{16})-/.exec(key)?.[1]

async function newestKeys(store, { prefix, keep = () => true, limit }) {
  const keys = []
  for await (const page of store.list(prefix ? { paginate: true, prefix } : { paginate: true })) {
    keys.push(...page.blobs.map(blob => blob.key).filter(key => (!prefix || key.startsWith(prefix)) && keep(key)))
    keys.sort(byAge)
    keys.splice(limit)
  }
  return keys
}

async function readAll(store, keys) {
  const reports = []
  for (let i = 0; i < keys.length; i += 10) reports.push(...await Promise.all(keys.slice(i, i + 10).map(key => store.get(key, { type: 'json' }))))
  return reports.filter(Boolean)
}

// Wie gapFingerprint in der App: sortierte Wörter der Anfrage plus gescheiterte Werkzeuge.
function gapInfo(details, message) {
  let gap = null
  try { const value = JSON.parse(details); if (value && typeof value === 'object' && !Array.isArray(value)) gap = value } catch {}
  const words = (typeof gap?.request === 'string' ? gap.request : '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 3).sort().slice(0, 12).join(' ')
  const tools = Array.isArray(gap?.tools) ? [...new Set(gap.tools.filter(t => t && typeof t.tool === 'string' && typeof t.kind === 'string').map(t => `${t.kind}:${t.tool}`))].sort().join(',') : ''
  const basis = words || tools ? `${words}|${tools}` : `message:${message.toLowerCase().replace(/\s+/g, ' ')}`
  return { fingerprint: createHash('sha256').update(basis).digest('hex').slice(0, 16), appVersion: typeof gap?.appVersion === 'string' ? gap.appVersion.slice(0, 40) : '' }
}

function newerVersion(a, b) {
  const x = /^(\d+)\.(\d+)\.(\d+)/.exec(a || ''), y = /^(\d+)\.(\d+)\.(\d+)/.exec(b || '')
  if (!x || !y) return false
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i])
  return false
}

async function readJson(request, maxBytes) {
  if (!request.headers.get('content-type')?.includes('application/json')) return { status: 415, error: 'JSON erforderlich.' }
  const raw = await request.text()
  if (Buffer.byteLength(raw) > maxBytes) return { status: 413, error: 'Bericht zu groß.' }
  try { return { body: JSON.parse(raw) } } catch { return { status: 400, error: 'Ungültiges JSON.' } }
}

export function createHandler(getStore, env = process.env) {
  return async request => {
    const origin = request.headers.get('origin')
    const allowed = new Set([new URL(request.url).origin, 'https://resonant-shortbread-6be4b2.netlify.app', ...(env.JARVIS_ALLOWED_ORIGINS || '').split(',').filter(Boolean)])
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin', 'X-Content-Type-Options': 'nosniff' }
    if (origin && allowed.has(origin)) headers['Access-Control-Allow-Origin'] = origin
    headers['Access-Control-Allow-Methods'] = 'GET, POST, PATCH, OPTIONS'
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, x-jarvis-token'
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers })
    if (origin && !allowed.has(origin)) return json({ error: 'Origin nicht erlaubt.' }, 403)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (!['GET', 'POST', 'PATCH'].includes(request.method)) return json({ error: 'Methode nicht erlaubt.' }, 405)
    const expected = env.JARVIS_REPORT_TOKEN
    const supplied = request.headers.get('authorization')?.replace(/^Bearer /i, '') || request.headers.get('x-jarvis-token') || ''
    if (expected && (Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)))) return json({ error: 'Zugangstoken erforderlich.' }, 401)
    // Lücken enthalten Gesprächstext: ohne Token auf dem Server weder annehmen noch zeigen noch ändern.
    if (request.method === 'PATCH' && !expected) return json({ error: NO_GAP_TOKEN }, 403)
    try {
      const store = getStore()
      if (request.method === 'POST') {
        const { body, status, error } = await readJson(request, 16384)
        if (error) return json({ error }, status)
        if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 2000 || !['error', 'warning', 'warn', 'info'].includes(body.level)) return json({ error: 'level und message sind ungültig.' }, 400)
        if ((body.source !== undefined && (typeof body.source !== 'string' || body.source.length > 100)) || (body.details !== undefined && (typeof body.details !== 'string' || body.details.length > 10000))) return json({ error: 'source oder details ist ungültig.' }, 400)
        if (body.kind !== undefined && !KINDS.includes(body.kind)) return json({ error: 'kind muss incident oder capability-gap sein.' }, 400)
        const kind = body.kind || 'incident'
        if (kind === 'capability-gap' && !expected) return json({ error: NO_GAP_TOKEN }, 403)
        const report = { id: randomUUID(), kind, timestamp: new Date().toISOString(), level: body.level === 'warn' ? 'warning' : body.level, message: body.message.trim(), source: body.source || 'JARVIS', details: body.details || '' }
        if (kind === 'incident') {
          const key = `${stamp()}-${report.id}`
          await store.setJSON(key, report)
          return json({ ok: true, id: report.id }, 201)
        }
        // Gleiche Lücke unter den letzten 200: nur zählen. Lesen–Ändern–Schreiben ohne Sperre;
        // treffen zwei gleiche Meldungen zeitgleich ein, entsteht höchstens ein zweiter Eintrag
        // oder ein Zähler geht verloren. Für eine Häufigkeit reicht das.
        const { fingerprint, appVersion } = gapInfo(report.details, report.message)
        const match = (await newestKeys(store, { prefix: GAP_PREFIX, limit: GAP_WINDOW })).find(key => keyFingerprint(key) === fingerprint)
        const existing = match && await store.get(match, { type: 'json' })
        if (existing) {
          existing.count = (Number.isInteger(existing.count) && existing.count > 0 ? existing.count : 1) + 1
          existing.lastSeen = report.timestamp
          if (appVersion) existing.lastAppVersion = appVersion
          // Erledigt, aber in einer neueren Version wieder aufgetreten: Lösung hat nicht gereicht.
          if (existing.status === 'done' && newerVersion(appVersion, existing.doneVersion)) {
            existing.status = 'open'
            existing.reopenedAt = report.timestamp
            delete existing.doneAt
            delete existing.doneVersion
          }
          await store.setJSON(match, existing)
          return json({ ok: true, id: existing.id, duplicate: true, count: existing.count })
        }
        Object.assign(report, { status: 'open', count: 1, lastSeen: report.timestamp, fingerprint })
        await store.setJSON(`${GAP_PREFIX}${stamp()}-${fingerprint}-${report.id}`, report)
        return json({ ok: true, id: report.id }, 201)
      }
      if (request.method === 'PATCH') {
        const { body, status, error } = await readJson(request, 2048)
        if (error) return json({ error }, status)
        if (!body || typeof body !== 'object' || typeof body.id !== 'string' || !UUID.test(body.id) || !['open', 'done'].includes(body.status)) return json({ error: 'id und status (open oder done) sind ungültig.' }, 400)
        let match
        for await (const page of store.list({ paginate: true, prefix: GAP_PREFIX })) {
          match = page.blobs.map(blob => blob.key).find(key => key.startsWith(GAP_PREFIX) && key.endsWith(`-${body.id}`))
          if (match) break
        }
        const record = match && await store.get(match, { type: 'json' })
        if (!record) return json({ error: 'Fähigkeitslücke nicht gefunden.' }, 404)
        if ((record.status || 'open') !== body.status) {
          record.status = body.status
          if (body.status === 'done') {
            record.doneAt = new Date().toISOString()
            record.doneVersion = record.lastAppVersion || gapInfo(record.details || '', record.message || '').appVersion || undefined
          } else {
            delete record.doneAt
            delete record.doneVersion
          }
          await store.setJSON(match, record)
        }
        return json({ ok: true, id: record.id, status: record.status })
      }
      const params = new URL(request.url).searchParams
      const kind = params.get('kind')
      if (kind !== null && !KINDS.includes(kind)) return json({ error: 'kind muss incident oder capability-gap sein.' }, 400)
      if (kind === 'capability-gap' && !expected) return json({ error: NO_GAP_TOKEN }, 403)
      const rawLimit = params.get('limit')
      const limit = rawLimit === null ? 200 : Number(rawLimit)
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) return json({ error: 'limit muss 1–200 sein.' }, 400)
      // Ohne kind kommen beide Arten, damit ältere Dashboards weiter funktionieren; ohne Token
      // bleiben gespeicherte Lücken trotzdem verborgen, etwa wenn die Variable entfernt wurde.
      const keys = kind === 'capability-gap'
        ? await newestKeys(store, { prefix: GAP_PREFIX, limit })
        : await newestKeys(store, { keep: key => !key.startsWith(GAP_PREFIX) || (kind === null && !!expected), limit })
      const reports = await readAll(store, keys)
      return json({ reports: reports.sort((a, b) => String(b.lastSeen || b.timestamp).localeCompare(String(a.lastSeen || a.timestamp))) })
    } catch { return json({ error: 'Berichtsspeicher nicht verfügbar. Netlify-Function und Blobs-Konfiguration prüfen.' }, 503) }
  }
}
