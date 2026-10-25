import { app } from 'electron'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, normalize, resolve, sep } from 'node:path'
import type { CrystalState } from '@shared/types'
import {
  AUDIO_TAG,
  isPhoneMessage,
  isCaptionMessage,
  COMPANION_DEFAULT_PORT,
  COMPANION_PATH,
  type CompanionStatus,
  type HostCommand,
  type HostMessage,
  type PhoneMessage,
  type ServerMessage
} from '@shared/companion'
import { resourceFile } from '../resources'
import { accept, guardSocket, type WsSocket } from './websocket'
import { localWakeTarget } from './wol'
import { parseHealthSnapshot } from '@shared/health'
import { saveHealth } from '../health/store'

/**
 * Der Server, an dem das Telefon hängt.
 *
 * Er tut absichtlich wenig: Dateien ausliefern, Marken prüfen, Rahmen
 * weiterreichen. Kein Ton wird hier angefasst, kein Zustand hier entschieden —
 * beides gehört in den Renderer, wo Mikrofon und Live-Sitzung sitzen. Was hier
 * steht, ist eine Vermittlung, und je dümmer sie ist, desto weniger kann sie
 * kaputtgehen.
 *
 * Zur Sicherheit, denn hier wird ein Port geöffnet: Dahinter sitzt etwas, das
 * Mails verschickt und Warenkörbe füllt. Ohne gültige Marke kommt niemand an
 * den WebSocket, die Marke wird in gleichbleibender Zeit verglichen, und nach
 * genug Fehlversuchen von derselben Adresse ist für eine Weile Schluss.
 *
 * Verschlüsselt wird über ein Zertifikat von Tailscale (siehe `tailscale.ts`).
 * Das ist nicht bloß Sorgfalt, sondern Voraussetzung: `getUserMedia` verlangt
 * auf iOS einen sicheren Kontext, und ohne den bleibt die Sprechtaste tot —
 * die Fernbedienung wäre eine Anzeige. Fehlt Tailscale, läuft der Server
 * trotzdem, nur eben ohne Mikrofon; das ist wenig, aber mehr als nichts, und
 * die Einstellungsseite sagt genau das.
 *
 * Eine Portweiterleitung im Router bleibt trotzdem falsch. Der Weg von
 * unterwegs führt über das Tailnet, dann bleibt dieser Server dort, wo er
 * hingehört, nämlich hinter dem Router.
 */

// ─────────────────────────────────────────────────────────────
// Die Marke
// ─────────────────────────────────────────────────────────────

/**
 * Sie liegt im Klartext in den App-Daten.
 *
 * Das ist Absicht und keine Nachlässigkeit: Sie muss im Einstellungsfenster
 * anzeigbar sein, damit man sie ins Telefon tippen oder als QR-Code abfotografieren
 * kann. Eine Marke, die man nicht mehr lesen kann, wäre für ihren einzigen
 * Zweck untauglich. Wer Zugriff auf die App-Daten hat, hat ohnehin schon
 * genug, um sich anders zu bedienen.
 */
function tokenFile(): string {
  return join(app.getPath('userData'), 'companion-token.txt')
}

function loadToken(): string {
  const file = tokenFile()
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf-8').trim()
    if (existing.length >= 20) return existing
  }
  // 20 Byte base64url — lang genug, dass Raten aussichtslos ist, kurz genug,
  // dass man sie zur Not abtippen kann.
  const fresh = randomBytes(20).toString('base64url')
  writeFileSync(file, fresh, 'utf-8')
  return fresh
}

export function rotateToken(): string {
  const fresh = randomBytes(20).toString('base64url')
  writeFileSync(tokenFile(), fresh, 'utf-8')
  token = fresh
  // Alle bestehenden Telefone verlieren damit ihr Recht — das ist der Zweck
  // eines Wechsels und darf nicht erst beim nächsten Neustart wirken.
  for (const phone of phones) phone.socket.close(1008, 'Marke gewechselt')
  return fresh
}

let token: string | null = null

function tokenValid(candidate: string): boolean {
  if (!token) return false
  const a = Buffer.from(candidate)
  const b = Buffer.from(token)
  // `timingSafeEqual` wirft bei ungleicher Länge — die Länge selbst ist kein
  // Geheimnis, aber der Vergleich muss sie vorher abfangen.
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Der Schlüssel für den inneren Zuhörer.
 *
 * „Nur 127.0.0.1" hält fremde Rechner fern, aber nicht fremde Webseiten: Ein
 * Browser baut WebSockets zu jeder Adresse auf, auch zu Loopback, und fragt
 * dabei niemanden. Ohne Schlüssel konnte jede geöffnete Seite sich als
 * Kristall anmelden, den echten verdrängen und bekam dann, was das Telefon
 * schickt — getippte Befehle und den Ton aus seinem Mikrofon.
 *
 * Er gilt für einen Programmlauf und verlässt den Rechner nie: Der Kristall
 * holt ihn über IPC, das nur die eigenen Fenster erreicht.
 */
const hostKey = randomBytes(24).toString('base64url')

export function companionHostKey(): string {
  return hostKey
}

function hostKeyValid(candidate: string): boolean {
  const a = Buffer.from(candidate)
  const b = Buffer.from(hostKey)
  return a.length === b.length && timingSafeEqual(a, b)
}

// ─────────────────────────────────────────────────────────────
// Fehlversuche
// ─────────────────────────────────────────────────────────────

const attempts = new Map<string, { count: number; until: number }>()
const MAX_ATTEMPTS = 8
const LOCKOUT_MS = 5 * 60_000

function lockedOut(address: string): boolean {
  const entry = attempts.get(address)
  if (!entry) return false
  if (Date.now() > entry.until) {
    attempts.delete(address)
    return false
  }
  return entry.count >= MAX_ATTEMPTS
}

function noteFailure(address: string): void {
  const entry = attempts.get(address) ?? { count: 0, until: 0 }
  entry.count += 1
  entry.until = Date.now() + LOCKOUT_MS
  attempts.set(address, entry)
  if (entry.count >= MAX_ATTEMPTS) {
    console.warn(`[companion] ${address} für fünf Minuten gesperrt (${entry.count} Fehlversuche)`)
  }
}

// ─────────────────────────────────────────────────────────────
// Verbindungen
// ─────────────────────────────────────────────────────────────

interface Phone {
  socket: WsSocket
  name: string
}

/**
 * Zwei Zuhörer, und das ist der Kern des Aufbaus.
 *
 * Sobald TLS im Spiel ist, kann der Kristall nicht mehr über `wss://127.0.0.1`
 * mitreden: Das Zertifikat lautet auf den Tailnet-Namen, und auf eine
 * Loopback-Adresse passt es nicht — Chromium lehnt ab, ohne dass sich daran
 * etwas einstellen ließe. Also bekommt der Kristall seinen eigenen Zuhörer,
 * unverschlüsselt und ausschließlich auf 127.0.0.1 gebunden.
 *
 * Das ist obendrein die bessere Trennung. Vorher hingen beide Pfade am selben
 * Zuhörer, und dass der Kristallpfad nur von innen erreichbar war, hing an
 * einer Prüfung der Gegenadresse — also an einer Zeile, die man vergessen kann.
 * Jetzt hängt es daran, dass der Sockel nach außen gar nicht erst gebunden ist.
 * Umgekehrt gibt es den Telefonpfad auf dem inneren Zuhörer nicht.
 */
let publicServer: Server | null = null
let bridgeServer: Server | null = null
let caServer: Server | null = null
let host: WsSocket | null = null
let phones: Phone[] = []
let port = COMPANION_DEFAULT_PORT
let publicOrigin: string | null = null

/**
 * Der Port für den Kristall. Immer der öffentliche plus eins, damit er nicht
 * als zweite Einstellung geführt werden muss, die jemand verstellen kann,
 * ohne dass der Renderer davon erfährt.
 */
export function bridgePort(desiredPort: number): number {
  return desiredPort + 1
}

/**
 * Der Port, über den die Stelle abgeholt wird. Öffentlicher plus zwei, aus
 * demselben Grund wie oben — und nur solange sie noch nicht auf dem Telefon ist.
 */
export function caPort(desiredPort: number): number {
  return desiredPort + 2
}

/** Der zuletzt gemeldete Zustand — ein neu verbundenes Telefon soll ihn sofort sehen. */
let lastState: { state: CrystalState; paused: boolean; until: number | null } = {
  state: 'idle',
  paused: false,
  until: null
}

export function isRunning(): boolean {
  return publicServer !== null
}

/**
 * Woher das Zertifikat kommt, ist dem Server gleich — er will nur eines.
 *
 * Tailscale liefert ein PEM-Paar, die eigene Stelle eine PFX-Datei. Der
 * Unterschied ist keine Laune: Aus dem Windows-Zertifikatsspeicher kommt der
 * private Schlüssel nur als PFX heraus, und ihn unterwegs nach PEM zu wandeln
 * hieße, ihn selbst anzufassen. Node liest beides von sich aus.
 */
export interface TlsMaterial {
  /** Der Name oder die Adresse, auf die es lautet. */
  hostname: string
  pem?: { certFile: string; keyFile: string }
  pfx?: { file: string; passphrase: string }
  /**
   * Die eigene Stelle im DER-Format. Steht sie hier, macht der Server einen
   * dritten Zuhörer auf, über den das Telefon sie abholen kann — im Klartext,
   * denn genau dieses Vertrauen wird ja gerade erst hergestellt.
   */
  caFile?: string
}

export async function startCompanion(
  desiredPort = COMPANION_DEFAULT_PORT,
  tls: TlsMaterial | null = null
): Promise<void> {
  if (publicServer) return
  token = loadToken()
  port = desiredPort

  // ── Der öffentliche Zuhörer: Dateien und Telefone ───────
  const handler = (req: IncomingMessage, res: ServerResponse): void => void serveStatic(req, res)
  const outward = tls?.pem
    ? createSecureServer(
        { cert: readFileSync(tls.pem.certFile), key: readFileSync(tls.pem.keyFile) },
        handler
      )
    : tls?.pfx
      ? createSecureServer(
          { pfx: readFileSync(tls.pfx.file), passphrase: tls.pfx.passphrase },
          handler
        )
      : createServer(handler)

  outward.on('clientError', (_error, socket) => socket.destroy())
  outward.on('upgrade', (req, socket, head) => {
    guardSocket(socket)
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const address = req.socket.remoteAddress ?? 'unbekannt'

    if (url.pathname !== COMPANION_PATH.phone) {
      // Der Kristallpfad existiert hier nicht. Nicht "verboten" — es gibt ihn
      // an dieser Stelle schlicht nicht.
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
      return
    }
    if (lockedOut(address)) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n')
      return
    }
    if (!tokenValid(url.searchParams.get('token') ?? '')) {
      noteFailure(address)
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return
    }
    attempts.delete(address)
    const ws = accept(req, socket, head)
    if (ws) attachPhone(ws)
  })

  await listen(outward, port, '0.0.0.0')

  // ── Der innere Zuhörer: nur der Kristall ────────────────
  const inward = createServer((_req, res) => res.writeHead(404).end())
  inward.on('clientError', (_error, socket) => socket.destroy())
  inward.on('upgrade', (req, socket, head) => {
    guardSocket(socket)
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== COMPANION_PATH.host) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
      return
    }
    if (!hostKeyValid(url.searchParams.get('key') ?? '')) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return
    }
    const ws = accept(req, socket, head)
    if (ws) attachHost(ws)
  })

  try {
    await listen(inward, bridgePort(port), '127.0.0.1')
  } catch (err) {
    // Der äußere steht schon — ohne den inneren wäre er nutzlos und bliebe
    // trotzdem offen. Also zurückrollen und den Fehler weiterreichen.
    await new Promise<void>((resolve) => outward.close(() => resolve()))
    throw err
  }

  // ── Der Zuhörer für die Stelle: eine Datei, im Klartext ──
  //
  // Hier beißt sich sonst die Katze in den Schwanz: Das Telefon soll die Stelle
  // holen, damit es dem Zertifikat traut — über eine Verbindung, die mit genau
  // diesem Zertifikat gesichert wäre. Also ein eigener Zuhörer ohne TLS, der
  // nichts anderes kennt als diese eine öffentliche Datei. Ein Geheimnis wird
  // dabei nicht preisgegeben: Der private Teil der Stelle bleibt hier.
  let caListener: Server | null = null
  if (tls?.caFile) {
    caListener = createServer((req, res) => serveCa(req, res, tls.caFile as string))
    try {
      await listen(caListener, caPort(port), '0.0.0.0')
    } catch (err) {
      // Kein Grund, den ganzen Server hinzuwerfen: Ein Telefon, das die Stelle
      // schon kennt, braucht diesen Zuhörer nicht mehr.
      console.warn(`[companion] Port ${caPort(port)} für die Stelle belegt:`, err)
      caListener = null
    }
  }

  publicServer = outward
  bridgeServer = inward
  caServer = caListener
  publicOrigin = tls ? `https://${tls.hostname}:${port}/` : null

  console.info(
    `[companion] öffentlich auf ${port}${tls ? ` (TLS für ${tls.hostname})` : ' (ohne TLS)'}, ` +
      `Kristall auf ${bridgePort(port)}${caListener ? `, Stelle auf ${caPort(port)}` : ''}`
  )
}

/**
 * Die Stelle zum Abholen — und dazu eine Seite, die sagt, was danach kommt.
 *
 * Die zweite Hälfte ist der wichtigere Teil. Ein Profil zu installieren reicht
 * unter iOS nicht: Es liegt danach da, ohne zu wirken, und der Schalter, der es
 * scharf macht, sitzt drei Menüs weiter unter einem Namen, den niemand sucht.
 * Wer nur die Datei ausliefert, liefert einen halben Vorgang aus.
 */
function serveCa(req: IncomingMessage, res: ServerResponse, caFile: string): void {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname

  if (path === '/ca.cer' || path === '/ca.crt') {
    try {
      res.writeHead(200, {
        // Dieser Typ ist es, der iOS die Datei als Profil annehmen lässt statt
        // sie herunterzuladen.
        'content-type': 'application/x-x509-ca-cert',
        'content-disposition': 'attachment; filename="void-jarvis.cer"',
        'cache-control': 'no-store'
      })
      res.end(readFileSync(caFile))
    } catch {
      res.writeHead(500).end('Zertifikat nicht lesbar')
    }
    return
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(`<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>James vertrauen</title>
<style>
  body { font: 17px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 32px 24px;
         background: #14121a; color: #e8e4f0; }
  h1 { font-size: 24px; margin: 0 0 8px; }
  p { color: #a49dba; }
  ol { padding-left: 22px; }
  li { margin: 14px 0; }
  b { color: #e8e4f0; }
  a.btn { display: block; text-align: center; background: #7c5cff; color: #fff;
          text-decoration: none; padding: 16px; border-radius: 12px; font-weight: 600;
          margin: 24px 0; }
</style></head><body>
<h1>James vertrauen</h1>
<p>Zwei Schritte. Der zweite wird gern vergessen — ohne ihn liegt das Profil nur herum.</p>
<a class="btn" href="/ca.cer">1 · Profil laden</a>
<ol start="2">
  <li><b>Einstellungen → Profil geladen → Installieren</b> (oben rechts). Code eingeben, zweimal bestätigen.</li>
  <li><b>Einstellungen → Allgemein → Info → Zertifikatsvertrauenseinstellungen</b> — dort den Schalter
      für <b>James-Jarvis</b> umlegen. Erst jetzt gilt es.</li>
</ol>
<p>Danach zurück zum Rechner und den zweiten Code abfotografieren.</p>
</body></html>`)
}

function listen(server: Server, at: number, address: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(at, address, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}

export async function stopCompanion(): Promise<void> {
  if (!publicServer && !bridgeServer && !caServer) return
  for (const phone of phones) phone.socket.close(1001, 'James beendet')
  host?.close(1001, 'James beendet')
  phones = []
  host = null

  for (const server of [publicServer, bridgeServer, caServer]) {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  publicServer = null
  bridgeServer = null
  caServer = null
  publicOrigin = null
  console.info('[companion] beendet')
}

// ─────────────────────────────────────────────────────────────
// Kristall
// ─────────────────────────────────────────────────────────────

function attachHost(ws: WsSocket): void {
  // Nur ein Kristall. Öffnet der Nutzer das Fenster neu, ist der alte Sockel
  // vielleicht noch nicht abgeräumt — der neue gewinnt.
  host?.close(1000, 'Ersetzt')
  host = ws
  broadcastToPhones({ t: 'availability', ready: true })

  ws.onText = (raw) => {
    if (host !== ws) return
    const msg = parse<HostMessage>(raw)
    if (!msg) return
    if (msg.t === 'state') {
      lastState = { state: msg.state, paused: msg.paused, until: msg.until }
      broadcastToPhones(msg)
    } else if (msg.t === 'note' && typeof msg.text === 'string') {
      broadcastToPhones(msg)
    } else if (msg.t === 'text-result' && typeof msg.requestId === 'string' && msg.requestId.length <= 80 && typeof msg.ok === 'boolean') {
      broadcastToPhones(msg)
    } else if (isCaptionMessage(msg)) {
      broadcastToPhones(msg)
    }
  }

  // Stimme vom Kristall an alle Telefone. Hier wird nichts umgerechnet und
  // nichts zwischengespeichert — der Rahmen geht durch, wie er kam.
  ws.onBinary = (data) => {
    if (host !== ws || data.length < 3 || data.length % 2 !== 1 || data[0] !== AUDIO_TAG.voice) return
    for (const phone of phones) phone.socket.sendBinary(data)
  }

  ws.onClose = () => {
    if (host === ws) {
      host = null
      broadcastToPhones({ t: 'availability', ready: false })
      broadcastToPhones({ t: 'state', state: 'offline', paused: false, until: null })
    }
  }

  ws.sendText(JSON.stringify({ t: 'phones', count: phones.length } satisfies HostCommand))
}

/** Vom Hauptprozess, wenn James von sich aus etwas sagt. */
export function notifyPhones(text: string): void {
  broadcastToPhones({ t: 'note', text })
}

// ─────────────────────────────────────────────────────────────
// Telefon
// ─────────────────────────────────────────────────────────────

function attachPhone(ws: WsSocket): void {
  const phone: Phone = { socket: ws, name: 'Telefon' }
  phones.push(phone)
  console.info(`[companion] Telefon verbunden (${ws.remote}), jetzt ${phones.length}`)

  const target = localWakeTarget()
  if (target) {
    send(ws, {
      t: 'wake',
      mac: target.mac,
      broadcast: target.broadcast,
      address: target.address,
      port
    })
  }
  send(ws, host ? { t: 'state', ...lastState } : { t: 'state', state: 'offline', paused: false, until: null })
  send(ws, { t: 'availability', ready: host !== null })

  ws.onText = (raw) => {
    const msg = parse<PhoneMessage>(raw)
    if (!isPhoneMessage(msg)) {
      send(ws, { t: 'error', message: 'Ungültige Nachricht. Texte dürfen höchstens 8000 Zeichen enthalten.' })
      return
    }

    if (msg.t === 'hello') {
      phone.name = String(msg.name ?? 'Telefon').slice(0, 40)
      return
    }
    // Vor der Kristallprüfung, und das ist der Sinn der Sache: Ob ein Fenster
    // offen ist, hat mit der Frage „steht die Leitung noch" nichts zu tun. Ginge
    // die Antwort über den Kristall, hielte das Telefon einen geschlossenen
    // Kristall für ein abgerissenes Netz und verbände sich im Kreis neu.
    if (msg.t === 'ping') {
      send(ws, { t: 'pong' })
      return
    }
    // Wie der Ping: hat mit dem Kristallfenster nichts zu tun.
    if (msg.t === 'health') {
      const snapshot = parseHealthSnapshot(msg.data)
      // Still bei Erfolg: Die Notizzeile der Seite trägt wichtigere Hinweise.
      if (snapshot) saveHealth(snapshot)
      else send(ws, { t: 'note', text: 'Apple-Health-Werte waren unvollständig und wurden nicht übernommen.' })
      return
    }
    if (!host) {
      if (msg.t === 'text' && msg.requestId) send(ws, { t: 'text-result', requestId: msg.requestId, ok: false })
      send(ws, { t: 'error', message: 'Das James-Fenster am Rechner ist gerade nicht offen.' })
      return
    }
    // Alles Weitere ist ein Wunsch an den Kristall und wird dort entschieden.
    // Der Server prüft nur, dass es eine der bekannten Formen ist.
    if (msg.t === 'press' || msg.t === 'mic' || msg.t === 'text' || msg.t === 'pause') {
      host.sendText(JSON.stringify(msg satisfies HostCommand))
    }
  }

  ws.onBinary = (data) => {
    if (data.length < 3 || data.length % 2 !== 1 || data[0] !== AUDIO_TAG.mic) return
    host?.sendBinary(data)
  }

  ws.onClose = () => {
    phones = phones.filter((p) => p !== phone)
    console.info(`[companion] Telefon getrennt, noch ${phones.length}`)
    host?.sendText(JSON.stringify({ t: 'phones', count: phones.length } satisfies HostCommand))
  }

  host?.sendText(JSON.stringify({ t: 'phones', count: phones.length } satisfies HostCommand))
}

function broadcastToPhones(msg: ServerMessage): void {
  const raw = JSON.stringify(msg)
  for (const phone of phones) {
    if (phone.socket.open) phone.socket.sendText(raw)
  }
}

function send(ws: WsSocket, msg: ServerMessage): void {
  ws.sendText(JSON.stringify(msg))
}

function parse<T>(raw: string): T | null {
  try {
    const value = JSON.parse(raw) as T
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// Dateien
// ─────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')

  // `decodeURIComponent` wirft bei einem einzelnen Prozentzeichen. Der Aufrufer
  // wartet nicht auf diese Zusage, ein Fehler hier landete also als unbehandelte
  // Ablehnung im Hauptprozess — wegen einer Adresse, die jeder tippen kann.
  let wanted: string
  try {
    wanted = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)
  } catch {
    res.writeHead(400).end('Kaputte Adresse')
    return
  }

  /**
   * Beide Seiten durch `resolve`, und zwar bevor verglichen wird.
   *
   * Der erste Anlauf verglich das Ergebnis von `join` mit dem rohen Rückgabewert
   * von `resourceFile`. Kommt der mit Schrägstrichen herein — und das tut er,
   * sobald irgendwo ein Pfad aus einer Konfiguration stammt —, dann steht auf
   * der einen Seite `C:/…/companion` und auf der anderen `C:\…\companion\x`,
   * und `startsWith` ist falsch. Das fiel nicht als Loch auf, sondern als
   * Mauer: Der Server hat auf *jede* Anfrage mit 403 geantwortet, auch auf die
   * eigene Startseite. Und weil damit auch jeder Ausbruchsversuch abgewiesen
   * wurde, sah die Prüfung von außen genau richtig aus.
   */
  const root = resolve(resourceFile('companion'))
  const target = resolve(join(root, normalize(wanted)))

  // Erst nach dem Auflösen ist der Vergleich belastbar: "/../../secrets.bin"
  // wird zu einem Pfad außerhalb, und genau das fängt die Bedingung ab.
  if (target !== root && !target.startsWith(root + sep)) {
    res.writeHead(403).end('Verboten')
    return
  }

  try {
    const body = await readFile(target)
    const dot = target.lastIndexOf('.')
    const type = MIME[target.slice(dot).toLowerCase()] ?? 'application/octet-stream'
    res.writeHead(200, {
      'content-type': type,
      // Die Seite darf sich nichts von außerhalb holen und niemand darf sie
      // einrahmen. Sie besteht ohnehin nur aus eigenen Dateien.
      'content-security-policy':
        "default-src 'self'; connect-src 'self' ws://* wss://*; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-cache'
    })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Nicht gefunden')
  }
}

// ─────────────────────────────────────────────────────────────
// Für die Einstellungsseite
// ─────────────────────────────────────────────────────────────

export function companionStatus(): CompanionStatus {
  const target = localWakeTarget()

  /**
   * Die Tailnet-Adresse steht zuerst, und das ist keine Sortierfrage.
   *
   * Nur sie ist ein sicherer Kontext, und nur dort lässt iOS das Mikrofon zu.
   * Die Adresse im Heimnetz kommt trotzdem mit — für den Fall, dass jemand vom
   * Rechner aus nachsehen will oder Tailscale gerade nicht läuft —, aber der
   * QR-Code nimmt immer die erste.
   */
  const urls: string[] = []
  if (publicServer) {
    if (publicOrigin) urls.push(publicOrigin)
    if (target) urls.push(`http://${target.address}:${port}/`)
  }

  return {
    running: publicServer !== null,
    secure: publicOrigin !== null,
    port,
    urls,
    phones: phones.length,
    token: publicServer ? token : null,
    // Die Adresse für den ersten Code. Sie steht nur, solange der Zuhörer dafür
    // läuft — ist er weg, weil der Port belegt war, soll die Seite keinen Code
    // zeigen, den niemand einlösen kann.
    caUrl: caServer && target ? `http://${target.address}:${caPort(port)}/` : null,
    wake: target ? { mac: target.mac, broadcast: target.broadcast } : null
  }
}
