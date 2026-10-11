import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { getSecret } from '../secrets/keystore'
import { getSettings } from '../store/settings'
import { accept, type WsSocket } from '../companion/websocket'
import { LiveCall } from './liveCall'

/**
 * Der Endpunkt, den Twilio anruft, damit aus einer Ansage ein Gespräch wird.
 *
 * Ein ausgehender Anruf mit fester Nachricht braucht nichts davon: Das TwiML
 * geht als Parameter mit, Twilio spricht es ab und legt auf. Ein Gespräch
 * dagegen verlangt, dass Twilio uns erreichen kann — es holt sich beim
 * Abheben die Anweisung ab und öffnet danach einen WebSocket, über den die
 * Leitung in beide Richtungen läuft (Media Streams).
 *
 * Erreichbar heißt hier: aus dem offenen Netz, mit gültigem Zertifikat.
 * Twilios Server sitzen nicht im Heimnetz und nicht im Tailnet. Deshalb
 * hört dieser Server nur auf 127.0.0.1 und bekommt sein TLS von einem
 * Tunnel davor — Tailscale Funnel, cloudflared, ngrok, was der Nutzer
 * einrichtet. Das ist keine Bequemlichkeit, sondern der Punkt: So gibt es
 * keinen Port, der im Router aufgeht, und keinen Dienst, der ohne Tunnel
 * von außen sichtbar wäre.
 *
 * Was hier trotzdem an Absicherung nötig ist:
 *
 *   - Die Anweisung wird nur ausgeliefert, wenn Twilios Unterschrift stimmt.
 *     Ohne diese Prüfung könnte jeder, der die öffentliche Adresse kennt, die
 *     Leitung öffnen und auf Kosten des Kontos telefonieren.
 *   - Der WebSocket trägt ein Einmal-Merkmal im Pfad. Media Streams werden
 *     nicht unterschrieben, also ist das die einzige Stelle, an der sich
 *     "gehört zu diesem Anruf" überhaupt festmachen lässt.
 *   - Beides läuft über einen zeitkonstanten Vergleich.
 */

const HOST = '127.0.0.1'

/** Wie lange ein ausgestelltes Merkmal gilt, bevor es verfällt. */
const TICKET_TTL_MS = 5 * 60 * 1000

interface Ticket {
  token: string
  issuedAt: number
  /** Was James sagt, sobald abgehoben wurde. */
  opening: string
  /** Für das Protokoll: an wen der Anruf ging — oder von wem er kam. */
  to: string
  /** Auf `true`, sobald der Medienstrom steht — ein Merkmal, ein Gespräch. */
  used: boolean
  /** Bei einem eingehenden Anruf: wer am anderen Ende ist, laut Adressbuch. */
  callerName?: string
  /**
   * Ob am anderen Ende der Nutzer selbst ist.
   *
   * Entscheidet über die zweite Werkzeugliste in `phoneTools.ts`. Am Merkmal
   * und nicht erst beim Medienstrom, weil dort die Nummer nicht mehr vorliegt:
   * Twilios `start`-Nachricht trägt die Stream-Kennung, nicht den Anrufer.
   */
  owner: boolean
  /**
   * Hat der Anrufer die PIN richtig eingetippt?
   *
   * Erst dann gibt es am Telefon den vollen Werkzeugkasten. Die Nummer allein
   * lässt sich fälschen — und wer damit durchkäme, hätte sonst Maus,
   * Tastatur und Postfach in der Hand.
   */
  pinVerified: boolean
}

const tickets = new Map<string, Ticket>()

let server: Server | null = null
let boundPort = 0

/**
 * Die Adresse, unter der der Tunnel diesen Server im offenen Netz zeigt.
 *
 * Eine Modulvariable und kein Parameter der Serverschleife, weil sie sich
 * ändern kann, während der Server läuft: Ein cloudflared-Quick-Tunnel bekommt
 * bei jedem Start eine neue Adresse. Stünde hier noch die alte, schlüge die
 * Unterschriftsprüfung fehl — Twilio bildet sie über die Adresse, die es
 * tatsächlich aufgerufen hat.
 */
let publicBase = ''

const activeCalls = new Set<LiveCall>()

/**
 * Die hochgestuften Verbindungen, mitgeführt zum Zumachen.
 *
 * `server.close()` hört auf, neue anzunehmen, und wartet auf die bestehenden.
 * Eine Telefonleitung besteht aber, bis jemand auflegt — ohne diese Liste
 * kehrt das Herunterfahren also nie zurück, und weil der Tunnel erst danach
 * geschlossen wird, bliebe er nach dem Beenden der App offen. Genau das, was
 * er nicht soll.
 */
const openSockets = new Set<Duplex>()

export interface CallServerEvents {
  onTranscript?: (role: 'caller' | 'jarvis', text: string) => void
  onCallEnded?: (reason: string) => void
}

let events: CallServerEvents = {}

export function setCallServerEvents(next: CallServerEvents): void {
  events = next
}

/** Ein Merkmal für genau einen Anruf. */
export function issueTicket(
  to: string,
  opening: string,
  callerName?: string,
  owner = false,
  pinVerified = false
): string {
  purgeTickets()
  const token = randomBytes(24).toString('base64url')
  tickets.set(token, { token, issuedAt: Date.now(), opening, to, used: false, callerName, owner, pinVerified })
  return token
}

function purgeTickets(): void {
  const now = Date.now()
  for (const [token, ticket] of tickets) {
    if (now - ticket.issuedAt > TICKET_TTL_MS) tickets.delete(token)
  }
}

function ticketFrom(url: URL): Ticket | null {
  const token = url.searchParams.get('t')
  if (!token) return null
  purgeTickets()
  // Der Treffer in der Map ist der Vergleich: Ein Merkmal gilt genau dann,
  // wenn es unter diesem Schlüssel ausgestellt wurde und noch nicht
  // abgelaufen ist. Mehr braucht es nicht — ein zusätzlicher
  // Zeichen-für-Zeichen-Vergleich vergliche den Schlüssel mit sich selbst.
  return tickets.get(token) ?? null
}

/**
 * Twilios Unterschrift prüfen.
 *
 * Twilio bildet HMAC-SHA1 über die vollständige Adresse plus alle
 * POST-Felder, alphabetisch aneinandergehängt, mit dem Auth Token als
 * Schlüssel. Die Adresse muss dabei die sein, die Twilio aufgerufen hat —
 * also die öffentliche des Tunnels, nicht die lokale, auf der dieser Server
 * tatsächlich lauscht.
 */
export function twilioSignature(
  authToken: string,
  publicUrl: string,
  params: Record<string, string>
): string {
  let payload = publicUrl
  for (const key of Object.keys(params).sort()) payload += key + params[key]
  return createHmac('sha1', authToken).update(Buffer.from(payload, 'utf-8')).digest('base64')
}

export function validateTwilioSignature(
  publicUrl: string,
  params: Record<string, string>,
  signature: string | undefined
): boolean {
  const authToken = getSecret('twilioAuthToken')
  if (!authToken || !signature) return false

  const expected = twilioSignature(authToken, publicUrl, params)
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function readBody(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    // Ein Formular von Twilio ist ein paar hundert Byte groß. Alles jenseits
    // davon ist kein Formular, sondern ein Versuch, den Speicher zu füllen.
    if (size > 64 * 1024) throw new Error('Anfrage zu groß.')
    chunks.push(chunk as Buffer)
  }
  const parsed = new URLSearchParams(Buffer.concat(chunks).toString('utf-8'))
  return Object.fromEntries(parsed.entries())
}

/**
 * Die Anweisung, die Twilio beim Abheben abholt.
 *
 * `<Connect><Stream>` hält die Leitung offen und schickt den Ton beidseitig
 * über den WebSocket — im Gegensatz zu `<Start><Stream>`, das nur mithört.
 */
function twiml(publicBase: string, token: string): string {
  const wss = publicBase.replace(/^https:/, 'wss:').replace(/\/+$/, '')
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
    `<Connect><Stream url="${wss}/twilio/media?t=${encodeURIComponent(token)}" /></Connect>` +
    '</Response>'
  )
}

/**
 * Darf diese Nummer anrufen?
 *
 * Die Antwort steht im Adressbuch, und nur dort. Ein eingehender Anruf öffnet
 * eine Live-Sitzung mit Zugriff auf Kalender, Mail und Dateien — wer da
 * durchkommt, muss vorher eingetragen worden sein. Twilio-Nummern werden von
 * Wählautomaten gefunden, und die rufen zuerst und fragen nie.
 *
 * Der Vergleich läuft über E.164 auf beiden Seiten: Twilio liefert `+43664…`,
 * im Adressbuch steht vielleicht `0664 123 45 67`. Erst nach dem Umsetzen sind
 * das dieselben Ziffern.
 *
 * Die beiden Module kommen bewusst erst hier herein und nicht oben: `providers/twilio`
 * holt sich `prepareConversation` aus `telephony/index`, das wiederum diese
 * Datei braucht. Ein Import am Dateikopf schlösse den Kreis, und CommonJS
 * gäbe einem der drei ein halb gefülltes Modul.
 */
async function knownCaller(from: string): Promise<{ name: string; owner: boolean } | null> {
  if (!from) return null
  const { normalizePhone, isOwnerPhone } = await import('../providers/twilio')
  const { listContacts } = await import('../db')

  const caller = normalizePhone(from)
  if (!caller) return null

  for (const contact of listContacts()) {
    if (!contact.phone) continue
    // Im Adressbuch zu stehen entscheidet, ob durchgestellt wird. Ob es der
    // Nutzer selbst ist, entscheidet etwas anderes: was James dann vorlesen
    // darf. Der Installateur steht auch im Adressbuch.
    if (normalizePhone(contact.phone) === caller) {
      // `strict`: Hier entscheidet die Zuordnung über Rechte, nicht über
      // Bequemlichkeit. Wer die Werkzeuge des Nutzers bekommen soll, muss im
      // Adressbuch ausdrücklich als solcher markiert sein — "der einzige
      // Eintrag mit Nummer wird schon der Nutzer sein" ist beim ausgehenden
      // Anruf eine gute Vermutung und beim eingehenden eine offene Tür.
      return { name: contact.name, owner: isOwnerPhone(caller, true) }
    }
  }
  return null
}

/** Auflegen, ohne die Leitung aufzubauen — ein abgewiesener Anruf kostet nichts. */
function reject(res: ServerResponse): void {
  res
    .writeHead(200, { 'Content-Type': 'text/xml' })
    .end('<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="rejected" /></Response>')
}

/**
 * Ein Anruf von außen.
 *
 * Anders als beim ausgehenden gibt es hier kein Merkmal, das vorher
 * ausgestellt wurde — der Anruf ist ja nicht angekündigt. An seine Stelle
 * treten zwei Prüfungen: Twilios Unterschrift beweist, dass die Anfrage
 * wirklich von Twilio kommt, und das Adressbuch entscheidet, ob mit diesem
 * Anrufer gesprochen wird. Erst danach entsteht ein Merkmal für den
 * Medienstrom, und zwar für genau dieses Gespräch.
 */
async function handleIncoming(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const settings = getSettings().telephony
  if (!settings?.incoming) {
    reject(res)
    return
  }

  let params: Record<string, string> = {}
  if (req.method === 'POST') {
    try {
      params = await readBody(req)
    } catch (err) {
      console.warn('[telefonie] Eingehende Anfrage war unlesbar:', String(err).slice(0, 160))
      res.writeHead(413).end()
      return
    }
  }

  const calledUrl = `${publicBase.replace(/\/+$/, '')}/twilio/incoming`
  const signature = req.headers['x-twilio-signature']
  if (!validateTwilioSignature(calledUrl, params, typeof signature === 'string' ? signature : undefined)) {
    console.warn('[telefonie] Eingehender Anruf ohne gültige Twilio-Unterschrift abgewiesen.')
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Unterschrift stimmt nicht.')
    return
  }

  const from = params.From ?? ''
  const caller = await knownCaller(from)
  if (!caller) {
    // Die Nummer bleibt im Protokoll, damit sich ein erwarteter Anrufer
    // nachtragen lässt. Der Anrufer selbst erfährt nichts — wer hier landet,
    // soll nicht lernen, dass es eine Liste gibt.
    console.info(`[telefonie] Anruf von ${from || 'unbekannt'} abgewiesen — steht nicht im Adressbuch.`)
    reject(res)
    return
  }

  // Die Nummer sagt nur, wer es sein will. Ist eine PIN hinterlegt, muss der
  // Besitzer sie eintippen, bevor James ihm Persönliches vorliest.
  if (caller.owner && getSecret('phonePin')) {
    if (pinLockedOut()) {
      console.warn('[telefonie] Besitzer-Anruf abgewiesen — PIN nach zu vielen Fehlversuchen gesperrt.')
      reject(res)
      return
    }
    const challenge = issuePinChallenge(from, caller.name)
    console.info(`[telefonie] Anruf von ${caller.name} — PIN wird abgefragt.`)
    res.writeHead(200, { 'Content-Type': 'text/xml' }).end(pinPrompt(publicBase, challenge, false))
    return
  }

  console.info(
    `[telefonie] Anruf von ${caller.name} angenommen${caller.owner ? ' (Nutzer selbst).' : '.'}`
  )
  const token = issueTicket(from, settings.incomingGreeting, caller.name, caller.owner)
  res.writeHead(200, { 'Content-Type': 'text/xml' }).end(twiml(publicBase, token))
}

// ─────────────────────────────────────────────────────────────
// PIN für den Besitzer
// ─────────────────────────────────────────────────────────────

/**
 * Eine offene PIN-Abfrage, eine je Anruf.
 *
 * Das Merkmal steckt in der `action`-Adresse des `<Gather>`; Twilio schickt
 * die Ziffern dorthin zurück, unterschrieben wie jede andere Anfrage.
 */
interface PinChallenge {
  token: string
  issuedAt: number
  from: string
  callerName: string
  attempts: number
}

const pinChallenges = new Map<string, PinChallenge>()

/** Zwei Versuche je Anruf — ein Vertipper soll nicht gleich auflegen. */
const PIN_ATTEMPTS_PER_CALL = 2

/**
 * Fehlversuche über alle Anrufe hinweg, nicht je Nummer.
 *
 * Je Nummer zu zählen hülfe nichts: Wer die Nummer fälscht, fälscht immer
 * dieselbe, und wer rät, ruft einfach wieder an. Nach fünf Fehlern in einer
 * Stunde nimmt James vom Besitzer gar keinen Anruf mehr an, bis die Stunde
 * um ist — bei vier Ziffern bleiben einem Angreifer so rund 120 Versuche am
 * Tag, jeder davon ein bezahlter Anruf.
 */
const PIN_MAX_FAILURES = 5
const PIN_FAILURE_WINDOW_MS = 60 * 60 * 1000
let pinFailures: number[] = []

function pinLockedOut(): boolean {
  const now = Date.now()
  pinFailures = pinFailures.filter((at) => now - at < PIN_FAILURE_WINDOW_MS)
  return pinFailures.length >= PIN_MAX_FAILURES
}

function issuePinChallenge(from: string, callerName: string): string {
  const now = Date.now()
  for (const [key, c] of pinChallenges) {
    if (now - c.issuedAt > TICKET_TTL_MS) pinChallenges.delete(key)
  }
  const token = randomBytes(24).toString('base64url')
  pinChallenges.set(token, { token, issuedAt: now, from, callerName, attempts: 0 })
  return token
}

/** Zeitkonstant, und über den Hash — so verrät auch die Länge nichts. */
export function pinMatches(entered: string, expected: string): boolean {
  const a = createHmac('sha256', 'pin').update(entered).digest()
  const b = createHmac('sha256', 'pin').update(expected).digest()
  return timingSafeEqual(a, b)
}

function pinPrompt(publicBase: string, challenge: string, retry: boolean): string {
  const action = `${publicBase.replace(/\/+$/, '')}/twilio/pin?t=${encodeURIComponent(challenge)}`
  const ask = retry ? 'Die PIN stimmt nicht. Bitte noch einmal.' : 'Bitte gib deine PIN ein.'
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
    `<Gather input="dtmf" finishOnKey="#" timeout="10" action="${escapeXml(action)}" method="POST">` +
    `<Say language="de-DE">${ask}</Say>` +
    '</Gather>' +
    '<Say language="de-DE">Keine Eingabe. Auf Wiederhören.</Say><Hangup/>' +
    '</Response>'
  )
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function hangUpWith(res: ServerResponse, text: string): void {
  res
    .writeHead(200, { 'Content-Type': 'text/xml' })
    .end(
      '<?xml version="1.0" encoding="UTF-8"?><Response>' +
        `<Say language="de-DE">${text}</Say><Hangup/></Response>`
    )
}

async function handlePin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const token = url.searchParams.get('t') ?? ''
  const challenge = pinChallenges.get(token)
  if (!challenge || Date.now() - challenge.issuedAt > TICKET_TTL_MS) {
    pinChallenges.delete(token)
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Unbekannter oder abgelaufener Anruf.')
    return
  }

  let params: Record<string, string> = {}
  try {
    params = await readBody(req)
  } catch {
    res.writeHead(413).end()
    return
  }

  const calledUrl = `${publicBase.replace(/\/+$/, '')}/twilio/pin?t=${encodeURIComponent(token)}`
  const signature = req.headers['x-twilio-signature']
  if (!validateTwilioSignature(calledUrl, params, typeof signature === 'string' ? signature : undefined)) {
    console.warn('[telefonie] PIN-Antwort ohne gültige Twilio-Unterschrift abgelehnt.')
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Unterschrift stimmt nicht.')
    return
  }

  const expected = getSecret('phonePin')
  const entered = (params.Digits ?? '').replace(/\D/g, '')

  if (expected && !pinLockedOut() && pinMatches(entered, expected)) {
    pinChallenges.delete(token)
    console.info(`[telefonie] PIN stimmt — Anruf von ${challenge.callerName} als Besitzer angenommen.`)
    const greeting = getSettings().telephony?.incomingGreeting ?? ''
    const ticket = issueTicket(challenge.from, greeting, challenge.callerName, true, true)
    res.writeHead(200, { 'Content-Type': 'text/xml' }).end(twiml(publicBase, ticket))
    return
  }

  challenge.attempts += 1
  pinFailures.push(Date.now())
  console.warn(
    `[telefonie] Falsche PIN von ${challenge.from} (Versuch ${challenge.attempts} von ${PIN_ATTEMPTS_PER_CALL}).`
  )

  if (challenge.attempts < PIN_ATTEMPTS_PER_CALL && !pinLockedOut()) {
    res.writeHead(200, { 'Content-Type': 'text/xml' }).end(pinPrompt(publicBase, token, true))
    return
  }
  pinChallenges.delete(token)
  hangUpWith(res, 'Die PIN stimmt nicht. Auf Wiederhören.')
}

async function handleVoice(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const ticket = ticketFrom(url)
  if (!ticket) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Unbekannter oder abgelaufener Anruf.')
    return
  }

  let params: Record<string, string> = {}
  if (req.method === 'POST') {
    try {
      params = await readBody(req)
    } catch (err) {
      console.warn('[telefonie] Anweisungsanfrage war unlesbar:', String(err).slice(0, 160))
      res.writeHead(413).end()
      return
    }
  }

  // Die Adresse, über die Twilio gekommen ist — mit Merkmal, denn die geht in
  // die Unterschrift mit ein.
  const calledUrl = `${publicBase.replace(/\/+$/, '')}/twilio/voice?t=${encodeURIComponent(ticket.token)}`
  const signature = req.headers['x-twilio-signature']
  if (!validateTwilioSignature(calledUrl, params, typeof signature === 'string' ? signature : undefined)) {
    console.warn('[telefonie] Anweisung ohne gültige Twilio-Unterschrift abgelehnt.')
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Unterschrift stimmt nicht.')
    return
  }

  res.writeHead(200, { 'Content-Type': 'text/xml' }).end(twiml(publicBase, ticket.token))
}

/**
 * Der Medienstrom.
 *
 * Twilio schickt JSON-Nachrichten: `start` mit den Kenndaten, dann `media` mit
 * je zwanzig Millisekunden µ-law in base64, am Ende `stop`. In dieselbe
 * Richtung geht die Ausgabe zurück, dazu `clear` als Aufforderung, den
 * eigenen Puffer zu verwerfen — das ist die Twilio-Seite des Barge-in.
 */
function handleMedia(ws: WsSocket, ticket: Ticket): void {
  let streamSid: string | null = null
  let call: LiveCall | null = null

  const closeAll = (reason: string): void => {
    // Erst aus der globalen Liste und aus diesem Socket lösen, dann stoppen.
    // `stop()` ruft synchron `onClosed` auf und landet dadurch erneut hier.
    // Mit der alten Reihenfolge war `call` beim rekursiven Aufruf noch gesetzt,
    // anschließend aber vor `onClose` null — der Eintrag blieb für immer in
    // `activeCalls` und hielt das gesamte beendete Gespräch im Speicher.
    const current = call
    call = null
    if (current) {
      activeCalls.delete(current)
      current.stop(reason)
    }
    if (ws.open) ws.close(1000, 'Ende')
  }

  ws.onText = (raw): void => {
    let msg: { event?: string; start?: { streamSid?: string }; media?: { payload?: string } }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    switch (msg.event) {
      case 'start': {
        // Pro WebSocket genau ein Gespräch. Ein zweites `start` wäre kein
        // Wiederverbinden, sondern eine zweite kostenpflichtige Live-Sitzung
        // auf derselben Leitung.
        if (call || !msg.start?.streamSid) {
          closeAll('Ungültiger Start des Medienstroms.')
          break
        }
        streamSid = msg.start?.streamSid ?? null
        call = new LiveCall(
          {
            onAudio: (frame) => {
              if (!ws.open || !streamSid) return
              ws.sendText(
                JSON.stringify({
                  event: 'media',
                  streamSid,
                  media: { payload: frame.toString('base64') }
                })
              )
            },
            onClear: () => {
              if (!ws.open || !streamSid) return
              ws.sendText(JSON.stringify({ event: 'clear', streamSid }))
            },
            onTranscript: (role, text) => events.onTranscript?.(role, text),
            onClosed: (reason) => {
              events.onCallEnded?.(reason)
              closeAll(reason)
            }
          },
          ticket.opening,
          ticket.callerName,
          ticket.owner,
          ticket.owner && ticket.pinVerified
        )
        activeCalls.add(call)
        call.start().catch((err) => {
          console.error('[telefonie] Live-Sitzung ließ sich nicht aufbauen:', err)
          closeAll('Die Live-Sitzung ließ sich nicht aufbauen.')
        })
        break
      }

      case 'media': {
        const payload = msg.media?.payload
        const audio = payload ? decodeTwilioMedia(payload) : null
        // Twilio schickt `start` immer vor dem ersten `media`. Was während des
        // Aufbaus der Live-Sitzung hereinkommt, puffert `LiveCall` selbst.
        if (audio && call) call.pushCallerAudio(audio)
        break
      }

      case 'stop':
        closeAll('Der Anrufer hat aufgelegt.')
        break
    }
  }

  ws.onClose = (): void => {
    const current = call
    call = null
    if (!current) return
    activeCalls.delete(current)
    current.stop('Die Leitung wurde getrennt.')
  }
}

/**
 * Twilios Audiopaket streng lesen. `Buffer.from(..., 'base64')` akzeptiert
 * auch fast beliebigen Text und sehr große Felder; auf dem öffentlichen
 * Telefon-Endpunkt würde daraus unnötige Speicher- und Rechenarbeit.
 */
export function decodeTwilioMedia(payload: string): Buffer | null {
  if (payload.length === 0 || payload.length > 1024 || payload.length % 4 !== 0) return null
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return null
  const audio = Buffer.from(payload, 'base64')
  // Twilio sendet 160 Byte je 20 ms. Etwas Spielraum für gebündelte Pakete,
  // aber keine beliebig große Nutzlast an die Live-API durchreichen.
  return audio.length > 0 && audio.length <= 640 ? audio : null
}

/**
 * Fremde Pfade auf demselben Server.
 *
 * ── Warum das sein muss ──
 *
 * Weil es nur *einen* Weg von außen herein gibt. Tailscale Funnel bildet genau
 * einen lokalen Port auf die öffentliche 443 ab — ein zweiter Aufruf ersetzt
 * den ersten, er kommt nicht dazu. Und ein laufender cloudflared-Quick-Tunnel
 * wird wiederverwendet, zeigt also weiter auf den Port, für den er einmal
 * aufgemacht wurde.
 *
 * Solange nur die Telefonie von außen erreichbar war, fiel das nicht auf. Mit
 * der Alexa-Skill kam ein zweiter Dienst dazu, der dasselbe braucht — und
 * beide meldeten „läuft" samt plausibler Adresse, während in Wirklichkeit
 * einer von beiden den Verkehr des anderen bekam: Twilio hätte Alexa-JSON
 * gesehen, Amazon eine TwiML-Antwort. Wer zuletzt startet, gewinnt, und
 * gemerkt hätte man es beim ersten echten Anruf.
 *
 * Deshalb gibt es hier genau einen Server hinter genau einem Tunnel, und wer
 * von außen erreichbar sein will, hängt sich mit einem Pfad daran. Dieser
 * Server heißt aus historischen Gründen nach dem Telefon; er ist inzwischen
 * der öffentliche Eingang überhaupt.
 */
export type PublicRoute = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

const routes = new Map<string, PublicRoute>()

export function registerPublicRoute(path: string, handler: PublicRoute): void {
  routes.set(path, handler)
}

export function unregisterPublicRoute(path: string): void {
  routes.delete(path)
}

/** Alle Pfade abhängen — beim Beenden der App. */
export function clearPublicRoutes(): void {
  routes.clear()
}

/** Ob außer der Telefonie noch jemand an diesem Server hängt. */
export function hasPublicRoutes(): boolean {
  return routes.size > 0
}

/**
 * Die öffentliche Adresse nachreichen.
 *
 * Getrennt vom Starten, weil die Reihenfolge es verlangt: Erst muss der Server
 * einen Port haben, dann kann der Tunnel für *diesen* Port gebaut werden, und
 * erst danach steht die Adresse fest. Sie wird für das TwiML und für die
 * Unterschriftsprüfung gebraucht — beides muss dieselbe Adresse meinen, die
 * Twilio aufgerufen hat.
 */
export function setPublicBase(base: string): void {
  publicBase = base
}

/**
 * Wie viele Ports durchprobiert werden, wenn der gewünschte belegt ist.
 *
 * Fünf, und der Grund ist ein Zusammenstoß in der eigenen App: Die
 * Fernbedienung fürs Telefon belegt drei Ports am Stück — den eingestellten,
 * plus eins für den Kristall, plus zwei für die Zertifikatsstelle. Bei der
 * Vorgabe 8788 sind das 8788, 8789 und 8790 — und 8790 ist zugleich die
 * Vorgabe für die Telefonie.
 *
 * Den Standardwert zu ändern behebt das nur für Neuinstallationen: Gespeicherte
 * Einstellungen gewinnen beim Zusammenführen, wer die App schon hat, behielte
 * seinen 8790. Deshalb wird ausgewichen statt umbenannt.
 */
const PORT_ATTEMPTS = 5

/** Ein Start, der gerade läuft — siehe `startCallServer`. */
let starting: Promise<number> | null = null

/**
 * Startet den Server und liefert den Port, den er wirklich bekommen hat.
 *
 * Der Rückgabewert ist nicht kosmetisch: Der Tunnel muss auf genau diesen Port
 * zeigen. Wer stattdessen den gewünschten nimmt, baut nach einem Ausweichen
 * eine öffentliche Adresse, die ins Leere führt — und sie sieht dabei
 * vollkommen richtig aus.
 */
export async function startCallServer(port: number): Promise<number> {
  if (server) return boundPort
  // Telefonie und Alexa starten beim Hochfahren gleichzeitig. Ohne diesen
  // gemeinsamen Anlauf sahen beide `server === null`, der zweite wich wegen
  // EADDRINUSE auf den nächsten Port aus, und der erste Server lief danach
  // unerreichbar und ungeschlossen weiter.
  starting ??= openCallServer(port).finally(() => {
    starting = null
  })
  return starting
}

async function openCallServer(port: number): Promise<number> {
  const instance = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${HOST}`)

    // Angemeldete Pfade zuerst — siehe `registerPublicRoute`.
    const mounted = routes.get(url.pathname)
    if (mounted) {
      void Promise.resolve(mounted(req, res)).catch((err) => {
        console.error(`[eingang] Öffentlicher Pfad ${url.pathname} ist fehlgeschlagen:`, err)
        if (!res.headersSent) res.writeHead(500).end()
      })
      return
    }

    if (url.pathname === '/twilio/voice') {
      void handleVoice(req, res, url).catch((err) => {
        console.error('[telefonie] Anweisungsanfrage ist fehlgeschlagen:', err)
        if (!res.headersSent) res.writeHead(500).end()
      })
      return
    }
    if (url.pathname === '/twilio/pin') {
      void handlePin(req, res, url).catch((err) => {
        console.error('[telefonie] PIN-Abfrage ist fehlgeschlagen:', err)
        if (!res.headersSent) res.writeHead(500).end()
      })
      return
    }
    if (url.pathname === '/twilio/incoming') {
      void handleIncoming(req, res).catch((err) => {
        console.error('[telefonie] Eingehender Anruf ist fehlgeschlagen:', err)
        if (!res.headersSent) res.writeHead(500).end()
      })
      return
    }
    // Alles andere gibt es hier nicht — und sagt auch nicht, was es sonst
    // geben könnte.
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Nicht vorhanden.')
  })

  instance.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${HOST}`)
    if (url.pathname !== '/twilio/media') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
      return
    }
    const ticket = ticketFrom(url)
    if (!ticket || ticket.used) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    // Verbraucht. Ein zweiter Strom auf dasselbe Merkmal wäre ein zweites
    // Gespräch, das niemand bestellt hat.
    ticket.used = true

    const ws = accept(req, socket, head)
    if (!ws) return
    openSockets.add(socket)
    socket.once('close', () => openSockets.delete(socket))
    handleMedia(ws, ticket)
  })

  /*
   * Den gewünschten Port zuerst, dann die nächsten.
   *
   * Nur bei EADDRINUSE ausweichen. Ein anderer Fehler — fehlendes Recht, eine
   * Adresse, die es nicht gibt — verschwindet nicht dadurch, dass man ihn auf
   * dem nächsten Port wiederholt; er gehört durchgereicht, sonst sucht der
   * Nutzer fünfmal so lange nach derselben Ursache.
   */
  let lastError: NodeJS.ErrnoException | null = null

  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
    const candidate = port + attempt
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException): void => reject(err)
        instance.once('error', onError)
        instance.listen(candidate, HOST, () => {
          instance.removeListener('error', onError)
          resolve()
        })
      })

      server = instance
      boundPort = (instance.address() as { port: number }).port
      if (boundPort !== port) {
        console.info(
          `[eingang] Port ${port} war belegt, der öffentliche Eingang läuft auf ${boundPort}.`
        )
      }
      return boundPort
    } catch (err) {
      lastError = err as NodeJS.ErrnoException
      if (lastError.code !== 'EADDRINUSE') break
    }
  }

  throw new Error(
    lastError?.code === 'EADDRINUSE'
      ? `Die Ports ${port} bis ${port + PORT_ATTEMPTS - 1} sind alle belegt. Stell in den ` +
        'Einstellungen unter Telefon einen anderen ein.'
      : `Der öffentliche Eingang ließ sich nicht öffnen: ${lastError?.message ?? 'unbekannt'}`
  )
}

export function callServerRunning(): boolean {
  return server !== null
}

/**
 * Nur die Gespräche beenden, den Server stehen lassen.
 *
 * Gebraucht, seit die Alexa-Skill als Pfad an demselben Server hängt: „Telefonie
 * aus" soll auflegen, aber nicht den öffentlichen Eingang zumachen, durch den
 * gleich der nächste Echo-Befehl kommt.
 */
export function hangUpAll(): void {
  for (const call of activeCalls) call.stop('Der Telefondienst wurde beendet.')
  activeCalls.clear()
  // Die Merkmale bleiben bewusst stehen: Ein ausgestelltes, aber noch nicht
  // genutztes Merkmal — etwa für einen ausgehenden Anruf, der gerade gewählt
  // wird — überlebt das Auflegen der anderen. Abgelaufenes räumt `purgeTickets`
  // beim nächsten Zugriff weg. Erst `stopCallServer` macht wirklich zu und
  // verwirft sie mit.
}

export async function stopCallServer(): Promise<void> {
  hangUpAll()
  tickets.clear()
  pinChallenges.clear()
  if (!server) return
  const instance = server
  server = null
  boundPort = 0
  publicBase = ''

  // Erst die Leitungen kappen, dann schließen. Andersherum wartet `close`
  // auf ein Gespräch, das niemand mehr führt.
  for (const socket of openSockets) socket.destroy()
  openSockets.clear()
  instance.closeAllConnections()

  await new Promise<void>((resolve) => instance.close(() => resolve()))
}
