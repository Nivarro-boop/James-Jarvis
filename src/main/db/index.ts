import { app } from 'electron'
import { Database } from 'node-sqlite3-wasm'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { LockTolerantDatabase, STARTUP_RETRY_MS, STEADY_RETRY_MS } from './lock'
import type {
  AuditEntry,
  Contact,
  MemoryEntry,
  PriceWatch,
  ResearchRun,
  SavingKind,
  ScheduleEntry,
  TimerEntry,
  ReminderEntry
} from '@shared/types'

/**
 * SQLite als WebAssembly statt als natives Modul.
 *
 * Der naheliegende Weg wäre better-sqlite3. Das muss aber für jede Kombination
 * aus Plattform und Electron-Version neu kompiliert werden, und genau daran
 * scheitert die Installation auf diesem Rechner: den Visual-Studio-Buildtools
 * fehlt das ClangCL-Toolset. Die WASM-Variante braucht überhaupt keinen
 * Compiler und verhält sich sonst gleich — dieselbe Datei, dieselbe Syntax.
 *
 * Gearbeitet wird durchgängig mit `run`/`get`/`all` statt mit vorbereiteten
 * Anweisungen: die müsste man hier von Hand freigeben, und ein vergessenes
 * `finalize()` ist ein echtes Speicherleck.
 */

let db: Database | null = null

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  text        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'fact',
  embedding   BLOB,
  created_at  INTEGER NOT NULL,
  last_used   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);

CREATE TABLE IF NOT EXISTS conversations (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  ts    INTEGER NOT NULL,
  role  TEXT NOT NULL,
  text  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_ts ON conversations(ts DESC);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  repeat TEXT NOT NULL DEFAULT 'none',
  state TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  last_notified_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(state, due_at);

CREATE TABLE IF NOT EXISTS actions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  tool            TEXT NOT NULL,
  args            TEXT NOT NULL,
  ok              INTEGER NOT NULL,
  result          TEXT,
  error           TEXT,
  duration_ms     INTEGER NOT NULL,
  confirmed       INTEGER,
  screenshot_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_actions_ts ON actions(ts DESC);

CREATE TABLE IF NOT EXISTS schedules (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  cron      TEXT NOT NULL,
  prompt    TEXT NOT NULL,
  label     TEXT NOT NULL DEFAULT '',
  active    INTEGER NOT NULL DEFAULT 1,
  last_run  INTEGER,
  next_run  INTEGER
);

CREATE TABLE IF NOT EXISTS price_watches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  url          TEXT NOT NULL,
  product_name TEXT NOT NULL,
  target_price REAL NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'EUR',
  last_price   REAL,
  last_check   INTEGER,
  notified     INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS price_history (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id INTEGER NOT NULL REFERENCES price_watches(id) ON DELETE CASCADE,
  ts       INTEGER NOT NULL,
  price    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS research_runs (
  id           TEXT PRIMARY KEY,
  query        TEXT NOT NULL,
  status       TEXT NOT NULL,
  agent        TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  last_thought TEXT,
  report       TEXT,
  sources      TEXT
);

CREATE TABLE IF NOT EXISTS costs (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  kind   TEXT NOT NULL,
  usd    REAL NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_costs_ts ON costs(ts DESC);

CREATE TABLE IF NOT EXISTS timers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  label      TEXT NOT NULL DEFAULT '',
  due_at     INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  fired      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_timers_due ON timers(due_at);

-- Die Adresse ist eindeutig, der Name nicht: zwei Annas sind ein
-- gewöhnlicher Fall, dieselbe Adresse zweimal einzutragen ist immer ein
-- Versehen. Gespeichert wird sie klein geschrieben — Mailadressen werden
-- ohnehin ohne Rücksicht auf Groß- und Kleinschreibung zugestellt, und so
-- reicht ein gewöhnlicher UNIQUE-Schlüssel statt eines Ausdrucksindex.
CREATE TABLE IF NOT EXISTS contacts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  email      TEXT UNIQUE,
  phone      TEXT UNIQUE,
  note       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS token_savings (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  kind   TEXT NOT NULL,
  tokens INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_savings_ts ON token_savings(ts DESC);

-- Störungen und was dagegen unternommen wurde.
--
-- Getrennt von der Tabelle actions: Dort steht, was James auf Zuruf getan
-- hat, hier steht, was ihm zugestoßen ist. Beides in einer Tabelle hieße,
-- dass eine Frage wie "warum ging die Stimme gestern nicht" zwischen
-- dreihundert geglückten Werkzeugaufrufen suchen müsste.
--
-- fingerprint fasst gleichartige Störungen zusammen — Bereich plus
-- Kennung, ohne die wechselnden Teile der Meldung. Daran hängt alles
-- Weitere: ob etwas zum dritten Mal passiert, ob ein Gegenmittel wirkt, und
-- ob es sich lohnt, den Nutzer überhaupt damit zu behelligen.
CREATE TABLE IF NOT EXISTS incidents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  area        TEXT NOT NULL,
  code        TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  message     TEXT NOT NULL,
  context     TEXT,
  -- Welches Gegenmittel angewandt wurde, null wenn keines passte.
  remedy      TEXT,
  -- 1 geheilt, 0 versucht und gescheitert, null nichts versucht.
  healed      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_incidents_ts ON incidents(ts DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_fp ON incidents(fingerprint, ts DESC);
`

/**
 * node-sqlite3-wasm sperrt über ein Verzeichnis `<datei>.lock`. Stürzt die
 * App ab, bleibt es liegen, und jeder weitere Start scheiterte mit „database
 * is locked“ — ohne Fenster, ohne Meldung. Die App läuft nur einmal (siehe
 * `requestSingleInstanceLock`), eine Sperre beim Start ist also immer Rest.
 *
 * Wirft nie: Unter Windows hält ein Virenscanner oder der Indexdienst ein
 * Verzeichnis mitunter für Augenblicke fest. Dann bleibt die Sperre stehen, und
 * der nächste Versuch beim Öffnen räumt sie erneut.
 */
function clearStaleLock(file: string): void {
  try {
    rmSync(`${file}.lock`, { recursive: true, force: true })
  } catch (err) {
    console.warn('[db] Alte Sperre ließ sich nicht entfernen:', err)
  }
}

/**
 * Öffnet die Datei und legt das Schema an.
 *
 * Das Handle wird erst von `initDb` ins Modul übernommen, wenn alles geklappt
 * hat. Früher stand es schon nach dem Öffnen in `db`: Scheiterte danach das
 * Schema (gesperrt, beschädigte Datei), blieb ein halbfertiges Handle liegen,
 * und jeder spätere Zugriff bekam es zurück statt eines neuen Versuchs — mit
 * „no such table“ als Folge.
 */
function openDatabase(file: string): LockTolerantDatabase {
  const handle = new LockTolerantDatabase(file)
  try {
    // Beim Start wird länger gewartet und jedes Mal die Sperre neu geräumt.
    handle.lockRetryDelays = STARTUP_RETRY_MS
    handle.lockBusyHook = () => clearStaleLock(file)
    handle.exec(SCHEMA)
    migrateContactsForPhone(handle)
    handle.lockRetryDelays = STEADY_RETRY_MS
    handle.lockBusyHook = undefined
    return handle
  } catch (err) {
    try {
      handle.close()
    } catch {
      // Schon zu oder nie richtig offen — dann gibt es nichts freizugeben.
    }
    throw err
  }
}

export function initDb(): Database {
  if (db) return db
  const dir = join(app.getPath('userData'), 'data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = join(dir, 'jarvis.db')
  clearStaleLock(file)
  db = openDatabase(file)
  return db
}

/** SQLite creates a consistent snapshot while the live database remains open. */
export function snapshotDb(file: string): void {
  conn().run('VACUUM INTO ?', [file])
}

/** Macht bestehende Mail-Kontakte mit telefonnummernlosen Kontakten kompatibel. */
function migrateContactsForPhone(database: Database): void {
  const columns = database.all(`PRAGMA table_info(contacts)`) as Row[]
  const hasPhone = columns.some((column) => column.name === 'phone')
  const emailRequired = columns.find((column) => column.name === 'email')?.notnull === 1
  if (hasPhone && !emailRequired) return

  try {
    database.exec(`
      BEGIN;
      ALTER TABLE contacts RENAME TO contacts_legacy;
      CREATE TABLE contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE,
        phone TEXT UNIQUE, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
        CHECK (email IS NOT NULL OR phone IS NOT NULL)
      );
      INSERT INTO contacts (id, name, email, note, created_at)
        SELECT id, name, email, COALESCE(note, ''), created_at FROM contacts_legacy;
      DROP TABLE contacts_legacy;
      COMMIT;
    `)
  } catch (err) {
    // `exec` bricht beim ersten Fehler ab und lässt das BEGIN offen stehen.
    // Ohne ROLLBACK liefe jeder spätere Schreibzugriff in diese nie
    // abgeschlossene Transaktion und wäre beim Beenden verloren.
    try {
      database.exec('ROLLBACK')
    } catch {
      // Keine Transaktion mehr offen — dann gibt es nichts zurückzurollen.
    }
    console.error('[db] Kontakte ließen sich nicht umstellen, es bleibt beim alten Aufbau:', err)
  }
}

function conn(): Database {
  return db ?? initDb()
}

export function closeDb(): void {
  // Ohne explizites Schließen bleibt der WASM-Speicher belegt.
  //
  // Erst vergessen, dann schließen, und ohne zu werfen: Der Aufrufer beim
  // Beenden ruft danach `app.exit` — ein Fehler hier ließe die App weder
  // schließen noch die Datenbank freigeben.
  const handle = db
  db = null
  try {
    handle?.close()
  } catch (err) {
    console.error('[db] Schließen fehlgeschlagen:', err)
  }
}

/** lastInsertRowid kann bei sehr großen Tabellen BigInt sein. */
function toNumber(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value
}

type Row = Record<string, unknown>

// ─────────────────────────────────────────────────────────────
// Aktionslog
// ─────────────────────────────────────────────────────────────

export function logAction(entry: {
  tool: string
  args: unknown
  ok: boolean
  result?: unknown
  error?: string
  durationMs: number
  confirmed?: boolean | null
  screenshotPath?: string | null
}): void {
  // Ergebnisse können sehr groß werden (Berichte, ganze Seiteninhalte).
  // Fürs Log reicht der Anfang.
  const trim = (v: unknown): string | null => {
    if (v === undefined || v === null) return null
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    return s.length > 4000 ? `${s.slice(0, 4000)}…` : s
  }

  conn().run(
    `INSERT INTO actions (ts, tool, args, ok, result, error, duration_ms, confirmed, screenshot_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Date.now(),
      entry.tool,
      trim(entry.args) ?? '{}',
      entry.ok ? 1 : 0,
      trim(entry.result),
      entry.error ?? null,
      entry.durationMs,
      entry.confirmed === undefined || entry.confirmed === null ? null : entry.confirmed ? 1 : 0,
      entry.screenshotPath ?? null
    ]
  )
}

export function listActions(limit = 200): AuditEntry[] {
  // Zweiter Schlüssel gegen Gleichstand: Ein Stapel Werkzeugaufrufe läuft
  // parallel und trägt reihenweise dieselbe Millisekunde. Ohne die Nummer
  // sprang die Anzeige bei jedem Aufruf anders herum.
  const rows = conn().all(`SELECT * FROM actions ORDER BY ts DESC, id DESC LIMIT ?`, [
    limit
  ]) as Row[]
  return rows.map((r) => ({
    id: r.id as number,
    ts: r.ts as number,
    tool: r.tool as string,
    args: r.args as string,
    ok: Boolean(r.ok),
    result: (r.result as string) ?? null,
    error: (r.error as string) ?? null,
    durationMs: r.duration_ms as number,
    confirmed: r.confirmed === null ? null : Boolean(r.confirmed),
    screenshotPath: (r.screenshot_path as string) ?? null
  }))
}

export function clearActions(): void {
  conn().run(`DELETE FROM actions`)
}

// ─────────────────────────────────────────────────────────────
// Gedächtnis
// ─────────────────────────────────────────────────────────────

export function insertMemory(text: string, kind: string, embedding: Float32Array | null): number {
  const blob = embedding
    ? new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength)
    : null
  const info = conn().run(
    `INSERT INTO memories (text, kind, embedding, created_at) VALUES (?, ?, ?, ?)`,
    [text, kind, blob, Date.now()]
  )
  return toNumber(info.lastInsertRowid)
}

/**
 * Blob aus SQLite in einen Vektor.
 *
 * Kopiert statt eine Sicht anzulegen. Der naheliegende Weg wäre
 * `new Float32Array(blob.buffer, blob.byteOffset, …)` — der wirft aber eine
 * RangeError, sobald `byteOffset` kein Vielfaches von vier ist, und wo im
 * WASM-Speicher der Blob landet, bestimmen wir nicht. Ein einziger ungünstig
 * liegender Eintrag hätte das gesamte Gedächtnis lahmgelegt: `recall` und
 * `remember` lesen beide über diese Stelle.
 */
function toVector(blob: Uint8Array | null): Float32Array | null {
  if (!blob || blob.byteLength < 4) return null
  const usable = blob.byteLength - (blob.byteLength % 4)
  // `slice` gibt einen eigenen, an null ausgerichteten Puffer.
  return new Float32Array(blob.slice(0, usable).buffer)
}

export function allMemoriesWithEmbeddings(): {
  id: number
  text: string
  kind: string
  embedding: Float32Array | null
}[] {
  const rows = conn().all(`SELECT id, text, kind, embedding FROM memories`) as Row[]
  return rows.map((r) => ({
    id: r.id as number,
    text: r.text as string,
    kind: r.kind as string,
    embedding: toVector(r.embedding as Uint8Array | null)
  }))
}

/**
 * Nur die Texte der zuletzt angelegten Erinnerungen.
 *
 * Eigene Abfrage, weil der System-Prompt bei jedem Verbindungsaufbau neu
 * entsteht — also alle fünfzehn Minuten und nach jeder Trennung wegen Stille.
 * Über `allMemoriesWithEmbeddings` zu gehen hätte dafür jedes Mal sämtliche
 * Vektoren aus der Datenbank geholt: bei tausend Erinnerungen drei Megabyte,
 * um zwölf Sätze anzuzeigen.
 */
export function recentMemoryTexts(limit = 12): string[] {
  const rows = conn().all(`SELECT text FROM memories ORDER BY id DESC LIMIT ?`, [limit]) as Row[]
  return rows.map((r) => r.text as string).reverse()
}

export function listMemories(limit = 200): MemoryEntry[] {
  const rows = conn().all(
    `SELECT id, text, kind, created_at, last_used FROM memories ORDER BY created_at DESC LIMIT ?`,
    [limit]
  ) as Row[]
  return rows.map((r) => ({
    id: r.id as number,
    text: r.text as string,
    kind: r.kind as MemoryEntry['kind'],
    createdAt: r.created_at as number,
    lastUsed: (r.last_used as number) ?? null
  }))
}

export function touchMemories(ids: number[]): void {
  if (ids.length === 0) return
  const now = Date.now()
  const database = conn()
  try {
    database.exec('BEGIN TRANSACTION')
    for (const id of ids) {
      database.run(`UPDATE memories SET last_used = ? WHERE id = ?`, [now, id])
    }
    database.exec('COMMIT')
  } catch (err) {
    if (database.inTransaction) database.exec('ROLLBACK')
    console.error('[db] touchMemories fehlgeschlagen:', err)
  }
}

/**
 * Wortlaut und Vektor einer bestehenden Erinnerung austauschen.
 *
 * Beides in einer einzigen Anweisung, und das ist der Sinn dieser Funktion.
 * Ein Weg, der nur den Text setzt, wäre die naheliegendere und die falsche
 * Bauart: Der alte Vektor bliebe stehen, und `recall` sucht über die Vektoren.
 * Die berichtigte Erinnerung wäre danach weiter unter dem alten Wortlaut zu
 * finden und unter dem neuen nicht — ein Fehler, den niemand sieht, weil in der
 * Liste ja der richtige Satz steht. Wer hier ändert, ändert beides.
 *
 * `null` als Vektor löscht den alten ausdrücklich, statt ihn zu behalten. Der
 * Aufrufer entscheidet das nicht aus Bequemlichkeit, sondern weil eine
 * Erinnerung ganz ohne Vektor über die Wortsuche in `recall` erreichbar bleibt,
 * eine mit dem Vektor eines fremden Satzes dagegen nicht.
 *
 * Der Rückgabewert sagt, ob es die Zeile überhaupt gab: SQLite hält ein UPDATE
 * ohne Treffer für einen ordentlichen Erfolg. Ohne diese Auskunft liefe eine
 * Berichtigung an einer inzwischen gelöschten Erinnerung still ins Leere, und
 * die Oberfläche meldete „gespeichert".
 */
export function updateMemory(id: number, text: string, embedding: Float32Array | null): boolean {
  const blob = embedding
    ? new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength)
    : null
  const info = conn().run(`UPDATE memories SET text = ?, embedding = ? WHERE id = ?`, [
    text,
    blob,
    id
  ])
  return info.changes > 0
}

export function deleteMemory(id: number): void {
  conn().run(`DELETE FROM memories WHERE id = ?`, [id])
}

// ─────────────────────────────────────────────────────────────
// Zeitplan
// ─────────────────────────────────────────────────────────────

export function listSchedules(): ScheduleEntry[] {
  const rows = conn().all(`SELECT * FROM schedules ORDER BY id`) as Row[]
  return rows.map((r) => ({
    id: r.id as number,
    cron: r.cron as string,
    prompt: r.prompt as string,
    label: r.label as string,
    active: Boolean(r.active),
    lastRun: (r.last_run as number) ?? null,
    nextRun: (r.next_run as number) ?? null
  }))
}

export function upsertSchedule(
  entry: Partial<ScheduleEntry> & { cron: string; prompt: string }
): ScheduleEntry {
  if (entry.id) {
    conn().run(`UPDATE schedules SET cron = ?, prompt = ?, label = ?, active = ? WHERE id = ?`, [
      entry.cron,
      entry.prompt,
      entry.label ?? '',
      entry.active === false ? 0 : 1,
      entry.id
    ])
    return listSchedules().find((s) => s.id === entry.id)!
  }
  const info = conn().run(`INSERT INTO schedules (cron, prompt, label, active) VALUES (?, ?, ?, ?)`, [
    entry.cron,
    entry.prompt,
    entry.label ?? '',
    entry.active === false ? 0 : 1
  ])
  const id = toNumber(info.lastInsertRowid)
  return listSchedules().find((s) => s.id === id)!
}

export function deleteSchedule(id: number): void {
  conn().run(`DELETE FROM schedules WHERE id = ?`, [id])
}

export function markScheduleRun(id: number): void {
  conn().run(`UPDATE schedules SET last_run = ? WHERE id = ?`, [Date.now(), id])
}

// ─────────────────────────────────────────────────────────────
// Preiswächter
// ─────────────────────────────────────────────────────────────

export function listWatches(activeOnly = false): PriceWatch[] {
  const sql = activeOnly
    ? `SELECT * FROM price_watches WHERE active = 1 ORDER BY id`
    : `SELECT * FROM price_watches ORDER BY id`
  const rows = conn().all(sql) as Row[]
  return rows.map((r) => ({
    id: r.id as number,
    url: r.url as string,
    productName: r.product_name as string,
    targetPrice: r.target_price as number,
    currency: r.currency as string,
    lastPrice: (r.last_price as number) ?? null,
    lastCheck: (r.last_check as number) ?? null,
    notified: Boolean(r.notified),
    active: Boolean(r.active)
  }))
}

export function insertWatch(w: {
  url: string
  productName: string
  targetPrice: number
  currency?: string
}): number {
  const info = conn().run(
    `INSERT INTO price_watches (url, product_name, target_price, currency) VALUES (?, ?, ?, ?)`,
    [w.url, w.productName, w.targetPrice, w.currency ?? 'EUR']
  )
  return toNumber(info.lastInsertRowid)
}

export function recordWatchPrice(id: number, price: number, notified: boolean): void {
  conn().run(`UPDATE price_watches SET last_price = ?, last_check = ?, notified = ? WHERE id = ?`, [
    price,
    Date.now(),
    notified ? 1 : 0,
    id
  ])
  conn().run(`INSERT INTO price_history (watch_id, ts, price) VALUES (?, ?, ?)`, [
    id,
    Date.now(),
    price
  ])
}

export function deleteWatch(id: number): void {
  conn().run(`DELETE FROM price_watches WHERE id = ?`, [id])
}

// ─────────────────────────────────────────────────────────────
// Recherche
// ─────────────────────────────────────────────────────────────

export function upsertResearch(run: ResearchRun): void {
  conn().run(
    `INSERT INTO research_runs (id, query, status, agent, started_at, finished_at, last_thought, report, sources)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       finished_at = excluded.finished_at,
       last_thought = excluded.last_thought,
       report = excluded.report,
       sources = excluded.sources`,
    [
      run.id,
      run.query,
      run.status,
      run.agent,
      run.startedAt,
      run.finishedAt,
      run.lastThought,
      run.report,
      run.sources ? JSON.stringify(run.sources) : null
    ]
  )
}

/**
 * Die Quellenliste steht als JSON in einer Spalte.
 *
 * Geschrieben hat sie diese App, gelesen wird sie hier — trotzdem nicht ohne
 * Fang: Eine einzige beschädigte Zelle würde sonst nicht diesen einen Lauf
 * verlieren, sondern `listResearch` als Ganzes zum Werfen bringen. Der Nutzer
 * sähe dann keine Recherche mehr, auch nicht die achtundvierzig heilen.
 */
function parseSources(raw: unknown): string[] | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? (value as string[]) : null
  } catch {
    return null
  }
}

function mapResearch(r: Row): ResearchRun {
  return {
    id: r.id as string,
    query: r.query as string,
    status: r.status as ResearchRun['status'],
    agent: r.agent as ResearchRun['agent'],
    startedAt: r.started_at as number,
    finishedAt: (r.finished_at as number) ?? null,
    lastThought: (r.last_thought as string) ?? null,
    report: (r.report as string) ?? null,
    sources: parseSources(r.sources)
  }
}

export function listResearch(limit = 50): ResearchRun[] {
  const rows = conn().all(`SELECT * FROM research_runs ORDER BY started_at DESC LIMIT ?`, [
    limit
  ]) as Row[]
  return rows.map(mapResearch)
}

export function getResearch(id: string): ResearchRun | null {
  const row = conn().get(`SELECT * FROM research_runs WHERE id = ?`, [id]) as Row | undefined
  return row ? mapResearch(row) : null
}

// ─────────────────────────────────────────────────────────────
// Kosten
// ─────────────────────────────────────────────────────────────

export function recordCost(kind: string, usd: number, detail?: string): void {
  conn().run(`INSERT INTO costs (ts, kind, usd, detail) VALUES (?, ?, ?, ?)`, [
    Date.now(),
    kind,
    usd,
    detail ?? null
  ])
}

export function costSince(sinceMs: number): number {
  const row = conn().get(`SELECT COALESCE(SUM(usd), 0) AS total FROM costs WHERE ts >= ?`, [
    sinceMs
  ]) as { total: number }
  return row.total
}

export function countSince(kind: string, sinceMs: number): number {
  const row = conn().get(`SELECT COUNT(*) AS n FROM costs WHERE kind = ? AND ts >= ?`, [
    kind,
    sinceMs
  ]) as { n: number }
  return row.n
}

// ─────────────────────────────────────────────────────────────
// Timer
// ─────────────────────────────────────────────────────────────

export function insertTimer(label: string, dueAt: number): TimerEntry {
  const info = conn().run(`INSERT INTO timers (label, due_at, created_at) VALUES (?, ?, ?)`, [
    label,
    dueAt,
    Date.now()
  ])
  const id = toNumber(info.lastInsertRowid)
  return { id, label, dueAt, createdAt: Date.now(), fired: false }
}

export function listTimers(includeFired = false): TimerEntry[] {
  const sql = includeFired
    ? `SELECT * FROM timers ORDER BY due_at`
    : `SELECT * FROM timers WHERE fired = 0 ORDER BY due_at`
  return (conn().all(sql) as Row[]).map((r) => ({
    id: r.id as number,
    label: r.label as string,
    dueAt: r.due_at as number,
    createdAt: r.created_at as number,
    fired: Boolean(r.fired)
  }))
}

export function markTimerFired(id: number): void {
  conn().run(`UPDATE timers SET fired = 1 WHERE id = ?`, [id])
}

export function listReminders(includeDone = false): ReminderEntry[] {
  return (conn().all(`SELECT * FROM reminders ${includeDone ? '' : "WHERE state != 'done'"} ORDER BY due_at`) as Row[])
    .map(toReminder)
}

function toReminder(r: Row): ReminderEntry {
  return { id: r.id as number, text: r.text as string, dueAt: r.due_at as number,
      repeat: r.repeat as ReminderEntry['repeat'], state: r.state as ReminderEntry['state'],
      createdAt: r.created_at as number, lastNotifiedAt: (r.last_notified_at as number) ?? null }
}

/** Der vorhandene Index liest nur fällige Termine statt jede Sekunde die ganze Liste. */
export function listDueReminders(now: number): ReminderEntry[] {
  return (conn().all("SELECT * FROM reminders WHERE state = 'pending' AND due_at <= ? ORDER BY due_at", [now]) as Row[])
    .map(toReminder)
}

export function insertReminder(text: string, dueAt: number, repeat: ReminderEntry['repeat']): ReminderEntry {
  const result = conn().run('INSERT INTO reminders (text, due_at, repeat, created_at) VALUES (?, ?, ?, ?)',
    [text, dueAt, repeat, Date.now()])
  return listReminders().find(r => r.id === toNumber(result.lastInsertRowid))!
}

export function updateReminder(id: number, patch: { dueAt?: number; text?: string; repeat?: ReminderEntry['repeat']; state?: ReminderEntry['state']; lastNotifiedAt?: number }): void {
  const existing = listReminders().find(r => r.id === id)
  if (!existing) throw new Error('Diese aktive Erinnerung existiert nicht.')
  conn().run("UPDATE reminders SET due_at = ?, text = ?, repeat = ?, state = ?, last_notified_at = ? WHERE id = ? AND state != 'done'",
    [patch.dueAt ?? existing.dueAt, patch.text ?? existing.text, patch.repeat ?? existing.repeat,
      patch.state ?? existing.state, patch.lastNotifiedAt ?? existing.lastNotifiedAt, id])
}

export function deleteTimer(id: number): void {
  conn().run(`DELETE FROM timers WHERE id = ?`, [id])
}

/** Abgelaufene Timer aufräumen, damit die Tabelle nicht ewig wächst. */
export function pruneTimers(olderThanMs: number): void {
  conn().run(`DELETE FROM timers WHERE fired = 1 AND due_at < ?`, [Date.now() - olderThanMs])
}

// ─────────────────────────────────────────────────────────────
// Sparmodus
// ─────────────────────────────────────────────────────────────

export function recordSaving(kind: SavingKind, tokens: number): void {
  if (tokens <= 0) return
  conn().run(`INSERT INTO token_savings (ts, kind, tokens) VALUES (?, ?, ?)`, [
    Date.now(),
    kind,
    Math.round(tokens)
  ])
}

export function savingsSince(sinceMs: number): number {
  const row = conn().get(
    `SELECT COALESCE(SUM(tokens), 0) AS total FROM token_savings WHERE ts >= ?`,
    [sinceMs]
  ) as { total: number }
  return row.total
}

export function savingsTotal(): number {
  const row = conn().get(`SELECT COALESCE(SUM(tokens), 0) AS total FROM token_savings`) as {
    total: number
  }
  return row.total
}

export function savingsByKind(sinceMs: number): { kind: SavingKind; tokens: number }[] {
  const rows = conn().all(
    `SELECT kind, SUM(tokens) AS tokens FROM token_savings WHERE ts >= ? GROUP BY kind ORDER BY tokens DESC`,
    [sinceMs]
  ) as Row[]
  return rows.map((r) => ({ kind: r.kind as SavingKind, tokens: r.tokens as number }))
}

export function clearSavings(): void {
  conn().run(`DELETE FROM token_savings`)
}

// ─────────────────────────────────────────────────────────────
// Adressbuch
// ─────────────────────────────────────────────────────────────

function mapContact(r: Row): Contact {
  return {
    id: r.id as number,
    name: r.name as string,
    email: (r.email as string) ?? '',
    phone: (r.phone as string) ?? '',
    note: (r.note as string) ?? '',
    createdAt: r.created_at as number
  }
}

export function listContacts(): Contact[] {
  const rows = conn().all(`SELECT * FROM contacts ORDER BY name COLLATE NOCASE`) as Row[]
  return rows.map(mapContact)
}

/**
 * Sucht nach einem gesprochenen Namen.
 *
 * Bewusst über LIKE auf beiden Seiten und ohne Beachtung der Groß- und
 * Kleinschreibung: Gesprochen kommt "max" an, im Buch steht "Max Muster".
 * Die Adresse ist mit durchsuchbar, damit "schreib an max at example" auch
 * dann trifft, wenn der Name anders lautet.
 */
export function findContacts(query: string): Contact[] {
  // Prozent und Unterstrich sind in LIKE Platzhalter. Eine Suche nach
  // "max_m" traf damit auch "maxXm", und ein einzelnes "%" hätte das
  // ganze Buch geliefert — inklusive Adressen, nach denen niemand gefragt hat.
  const needle = `%${query.trim().toLowerCase().replace(/[\\%_]/g, '\\$&')}%`
  const rows = conn().all(
    `SELECT * FROM contacts
      WHERE lower(name) LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\'
      ORDER BY length(name), name COLLATE NOCASE
      LIMIT 10`,
    [needle, needle, needle]
  ) as Row[]
  return rows.map(mapContact)
}

export function getContact(id: number): Contact | null {
  const row = conn().get(`SELECT * FROM contacts WHERE id = ?`, [id]) as Row | undefined
  return row ? mapContact(row) : null
}

/**
 * Anlegen oder ändern.
 *
 * Ein zweiter Eintrag zu einer schon bekannten Adresse ändert den bestehenden,
 * statt einen Doppelgänger anzulegen — sonst stünde nach einem versehentlich
 * doppelt diktierten Kontakt zweimal dasselbe im Buch, und die Rückfrage vor
 * dem Versand müsste zwischen zwei identischen Einträgen auswählen lassen.
 */
export function upsertContact(entry: {
  id?: number
  name: string
  email?: string
  phone?: string
  note?: string
}): Contact {
  const email = entry.email?.trim().toLowerCase() || null
  const phone = entry.phone?.trim() || null
  const name = entry.name.trim()
  const note = entry.note?.trim() ?? ''

  if (!name) throw new Error('Ein Kontakt braucht einen Namen.')
  if (!email && !phone) throw new Error('Ein Kontakt braucht eine Mailadresse oder Telefonnummer.')

  const update = (id: number): Contact => {
    guardContactConflict(() =>
      conn().run(`UPDATE contacts SET name = ?, email = ?, phone = ?, note = ? WHERE id = ?`, [
        name,
        email,
        phone,
        note,
        id
      ])
    )
    const contact = getContact(id)
    if (!contact) throw new Error('Diesen Kontakt gibt es nicht mehr.')
    return contact
  }

  if (entry.id) return update(entry.id)

  // Erst über die Adresse, dann über die Nummer: Ein Kontakt, der bisher nur
  // mit Telefonnummer im Buch stand, bekommt so seine Mailadresse dazu, statt
  // an der eindeutigen Nummer zu scheitern.
  const existing =
    (email
      ? (conn().get(`SELECT id FROM contacts WHERE email = ?`, [email]) as Row | undefined)
      : undefined) ??
    (phone
      ? (conn().get(`SELECT id FROM contacts WHERE phone = ?`, [phone]) as Row | undefined)
      : undefined)
  if (existing) return update(existing.id as number)

  const info = guardContactConflict(() =>
    conn().run(`INSERT INTO contacts (name, email, phone, note, created_at) VALUES (?, ?, ?, ?, ?)`, [
      name,
      email,
      phone,
      note,
      Date.now()
    ])
  )
  const contact = getContact(toNumber(info.lastInsertRowid))
  if (!contact) throw new Error('Der Kontakt ließ sich nicht speichern.')
  return contact
}

/**
 * SQLites „UNIQUE constraint failed" in einen Satz für den Nutzer übersetzen.
 *
 * Die Meldung landet sonst wörtlich und auf Englisch im Einstellungsfenster
 * oder in James' Antwort, sobald eine Adresse oder Nummer schon einem anderen
 * Kontakt gehört.
 */
function guardContactConflict<T>(write: () => T): T {
  try {
    return write()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/UNIQUE constraint failed: contacts\.email/i.test(message)) {
      throw new Error('Diese Mailadresse gehört schon zu einem anderen Kontakt.')
    }
    if (/UNIQUE constraint failed: contacts\.phone/i.test(message)) {
      throw new Error('Diese Telefonnummer gehört schon zu einem anderen Kontakt.')
    }
    throw err
  }
}

export function deleteContact(id: number): void {
  conn().run(`DELETE FROM contacts WHERE id = ?`, [id])
}

// ─────────────────────────────────────────────────────────────
// Gesprächsverlauf
// ─────────────────────────────────────────────────────────────

export function appendTranscript(role: 'user' | 'assistant', text: string): void {
  if (!text.trim()) return
  conn().run(`INSERT INTO conversations (ts, role, text) VALUES (?, ?, ?)`, [
    Date.now(),
    role,
    text
  ])
  conn().run('DELETE FROM conversations WHERE id NOT IN (SELECT id FROM conversations ORDER BY id DESC LIMIT 1000)')
}

/**
 * Die letzten Züge, in der Reihenfolge, in der sie gefallen sind.
 *
 * Sortiert wird über `id`, nicht über `ts`. Frage und Antwort landen im
 * Gespräch regelmäßig in derselben Millisekunde, und für gleiche Werte gibt
 * SQLite keine Reihenfolge zu — es kam also vor, dass die Antwort vor der
 * Frage stand. Das Modell bekam damit einen Verlauf zu lesen, in dem es sich
 * selbst zuvorkam. Die laufende Nummer ist die Einfügereihenfolge und kann das
 * nicht.
 */
export function recentTranscript(limit = 40): { role: string; text: string }[] {
  const rows = conn().all(`SELECT role, text FROM conversations ORDER BY id DESC LIMIT ?`, [
    limit
  ]) as { role: string; text: string }[]
  return rows.reverse()
}

export function searchTranscript(query: string, limit = 10): { id: number; ts: number; role: string; text: string }[] {
  const terms = query.trim().split(/\s+/).filter(Boolean).slice(0, 8)
  if (!terms.length) throw new Error('Suchbegriff fehlt.')
  const parameters = terms.map(term => `%${term.replace(/[\\%_]/g, '\\$&')}%`)
  return (conn().all(`SELECT id, ts, role, text FROM conversations WHERE ${terms.map(() => "text LIKE ? ESCAPE '\\'").join(' AND ')} ORDER BY id DESC LIMIT ?`,
    [...parameters, Math.max(1, Math.min(50, Math.floor(limit)))]) as { id: number; ts: number; role: string; text: string }[])
    .map(row => ({ ...row, text: row.text.slice(0, 4000) }))
}

// ─────────────────────────────────────────────────────────────
// Störungen
// ─────────────────────────────────────────────────────────────

export function insertIncident(entry: {
  area: string
  code: string
  fingerprint: string
  message: string
  context: string | null
  remedy: string | null
  healed: boolean | null
}): number {
  const info = conn().run(
    `INSERT INTO incidents (ts, area, code, fingerprint, message, context, remedy, healed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Date.now(),
      entry.area,
      entry.code,
      entry.fingerprint,
      entry.message.slice(0, 1000),
      entry.context,
      entry.remedy,
      entry.healed === null ? null : entry.healed ? 1 : 0
    ]
  )
  return toNumber(info.lastInsertRowid)
}

export function updateIncidentOutcome(id: number, remedy: string, healed: boolean): void {
  conn().run(`UPDATE incidents SET remedy = ?, healed = ? WHERE id = ?`, [remedy, healed ? 1 : 0, id])
}

export interface IncidentRow {
  id: number
  ts: number
  area: string
  code: string
  fingerprint: string
  message: string
  context: string | null
  remedy: string | null
  healed: boolean | null
}

function toIncident(r: Row): IncidentRow {
  return {
    id: r.id as number,
    ts: r.ts as number,
    area: r.area as string,
    code: r.code as string,
    fingerprint: r.fingerprint as string,
    message: r.message as string,
    context: (r.context as string | null) ?? null,
    remedy: (r.remedy as string | null) ?? null,
    healed: r.healed === null || r.healed === undefined ? null : Boolean(r.healed)
  }
}

export function listIncidents(limit = 100): IncidentRow[] {
  return (conn().all(`SELECT * FROM incidents ORDER BY ts DESC LIMIT ?`, [limit]) as Row[]).map(toIncident)
}

/** Wie oft dieselbe Störung seit einem Zeitpunkt auftrat. */
export function countIncidents(fingerprint: string, sinceMs: number): number {
  const row = conn().get(`SELECT COUNT(*) AS n FROM incidents WHERE fingerprint = ? AND ts >= ?`, [
    fingerprint,
    sinceMs
  ]) as { n: number }
  return row.n
}

/**
 * Die Störungen, die zuletzt offen blieben — nach Art zusammengefasst.
 *
 * Zusammengefasst und nicht einzeln, weil dieselbe Störung in einer schlechten
 * Stunde vierzigmal auftritt. Vierzig Zeilen sind keine bessere Auskunft als
 * eine mit der Zahl daneben.
 */
export function openIncidents(sinceMs: number): (IncidentRow & { count: number })[] {
  const rows = conn().all(
    `SELECT latest.*, grouped.n
       FROM incidents AS latest
       JOIN (
         SELECT fingerprint, MAX(id) AS latest_id, COUNT(*) AS n
           FROM incidents
          WHERE ts >= ?
          GROUP BY fingerprint
       ) AS grouped ON grouped.latest_id = latest.id
      WHERE latest.healed IS NULL OR latest.healed = 0
      ORDER BY latest.ts DESC`,
    [sinceMs]
  ) as Row[]
  return rows.map((r) => ({ ...toIncident(r), count: r.n as number }))
}

export function clearIncidents(): void {
  conn().run(`DELETE FROM incidents`)
}

/** Local desktop history is written only by the owner window. Expire prompt recall after 12 h. */
export function recentDesktopTranscript(limit: number, since: number): { role: string; text: string }[] {
  return (conn().all('SELECT role, text FROM conversations WHERE ts >= ? ORDER BY id DESC LIMIT ?', [since, limit]) as { role: string; text: string }[]).reverse()
}
export function clearTranscript(): void { conn().run('DELETE FROM conversations') }
