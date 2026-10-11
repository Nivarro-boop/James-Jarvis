import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { randomBytes, randomUUID } from 'node:crypto'
import { authorization, parseChallenges } from './digest'
import {
  addressOf,
  buildRequest,
  buildResponse,
  header,
  headers,
  param,
  SipStreamParser,
  uriOf,
  type SipMessage
} from './message'
import { localCandidates, newIceCredentials } from './ice'
import { buildSdp, parseRemoteMedia, publicAddress, RtpSession, SDP_PROBLEM_TEXT } from './rtp'

/**
 * Ein SIP-Telefon für genau einen Zweck: James bei einem SIP-Anbieter wie
 * sip.linphone.org anmelden, damit der Nutzer ihn aus der Linphone-App
 * anrufen kann — und James ihn.
 *
 * Bewusst klein: eine TLS-Verbindung zum Anbieter, über die alles läuft
 * (auch eingehende Anrufe — der Anbieter schickt sie über dieselbe
 * Verbindung zurück, deshalb muss kein Port am Router offen sein), ein Anruf
 * zur Zeit, nur G.711 µ-law. Mehr braucht ein Gespräch zwischen zwei
 * Beteiligten nicht.
 */

export interface SipConfig {
  username: string
  password: string
  domain: string
  /** Server, falls er vom Domainnamen abweicht. */
  proxy?: string
  port?: number
}

export interface SipCallHandle {
  readonly remote: string
  /** µ-law senden; der Takt liegt in der RTP-Sitzung. */
  sendAudio(muLaw: Buffer): void
  clearAudio(): void
  hangup(): void
  onAudio: (muLaw: Buffer) => void
  onEnded: (reason: string) => void
}

interface Dialog {
  callId: string
  localTag: string
  remoteTag: string
  localUri: string
  remoteUri: string
  remoteTarget: string
  routes: string[]
  cseq: number
}

interface Pending {
  method: string
  onResponse(msg: SipMessage): void
}

const REGISTER_EXPIRES = 600
const KEEPALIVE_MS = 25_000

/**
 * SIP-Verkehr ins Protokoll, ohne Anmeldung und Keep-alives.
 *
 * Ohne diese Zeilen stand bei einem gescheiterten Anruf nur „Niemand hat
 * abgenommen" im Protokoll — ob das Telefon geklingelt hat, ob Linphone es
 * überhaupt erreichen konnte oder ob es den Anruf abgewiesen hat, ließ sich
 * nicht mehr sagen.
 */
function trace(text: string): void {
  const first = text.slice(0, text.indexOf('\r\n')).trim()
  const cseq = /^CSeq:\s*\d+\s+(\S+)/im.exec(text)?.[1] ?? ''
  if (!first || cseq === 'REGISTER' || first.startsWith('REGISTER')) return
  const label = first.startsWith('SIP/2.0') ? `${first.slice(8)} (${cseq})` : first.replace(/ SIP\/2\.0$/, '')
  console.info(`[sip] → ${label}`)
}

/** Was ein Zwischenstand beim Anrufen bedeutet, für die Meldung nach Ablauf der Frist. */
function progressText(status: number): string {
  if (status === 180 || status === 183) return 'Es hat geklingelt, aber niemand hat abgenommen.'
  if (status === 110) {
    return (
      'Linphone hat dein iPhone per Push geweckt, aber die App hat sich nicht gemeldet. Öffne Linphone auf dem ' +
      'iPhone und prüf, ob dein Konto grün (verbunden) ist, Mitteilungen erlaubt sind und in den ' +
      'Kontoeinstellungen Push-Benachrichtigungen an sind. Zum Gegentest Linphone offen lassen und nochmal anrufen.'
    )
  }
  return 'Dein Telefon war für Linphone nicht erreichbar. Ist die Linphone-App mit deinem Konto angemeldet und darf sie Mitteilungen senden?'
}

export class SipPhone {
  private socket: TLSSocket | null = null
  private parser = new SipStreamParser((msg) => this.dispatch(msg))
  private pending = new Map<string, Pending>()
  private readonly host = `${randomBytes(6).toString('hex')}.invalid`
  private readonly instance = `<urn:uuid:${randomUUID()}>`
  private readonly regCallId = randomUUID()
  private regCseq = 1
  private registerTimer: NodeJS.Timeout | null = null
  private keepalive: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private stopped = false
  private active: { dialog: Dialog; rtp: RtpSession; handle: SipCallHandle; byeSent: boolean; sdp: string } | null = null
  /** Eingehender Anruf zwischen INVITE und Antwort des Nutzers. */
  private ringing: { invite: SipMessage; cancelled: boolean } | null = null
  registered = false
  lastError = ''
  /** Wie der letzte Anruf ausging, für die Einstellungsseite. */
  lastCall = ''

  constructor(
    private readonly config: SipConfig,
    private readonly events: {
      /** Ein Anruf kommt. Zurückgeben, ob er angenommen wird. */
      onIncoming(from: string): boolean
      onAnswered(call: SipCallHandle, incoming: boolean): void
      onRegistration(ok: boolean, detail: string): void
    }
  ) {}

  get aor(): string {
    return `sip:${this.config.username}@${this.config.domain}`
  }

  get busy(): boolean {
    return this.active !== null || this.ringing !== null || this.dialing
  }

  /** James ruft gerade an und wartet aufs Abnehmen. */
  private dialing = false

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.active?.handle.hangup()
    if (this.registerTimer) clearTimeout(this.registerTimer)
    if (this.keepalive) clearInterval(this.keepalive)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    // Abmelden ist höflich, aber nicht nötig — die Anmeldung läuft ohnehin ab.
    if (this.socket && this.registered) {
      try {
        this.register(0)
      } catch {
        // egal
      }
    }
    setTimeout(() => this.socket?.destroy(), 300)
    this.registered = false
  }

  // ─────────────────────────────────────────────────────────────
  // Verbindung und Anmeldung
  // ─────────────────────────────────────────────────────────────

  private connect(): void {
    const host = this.config.proxy || this.config.domain
    const socket = tlsConnect({ host, port: this.config.port ?? 5061, servername: host })
    this.socket = socket
    socket.on('secureConnect', () => {
      this.register(REGISTER_EXPIRES)
      if (this.keepalive) clearInterval(this.keepalive)
      // Doppeltes CRLF hält die Verbindung (und damit eingehende Anrufe) offen.
      this.keepalive = setInterval(() => socket.write('\r\n\r\n'), KEEPALIVE_MS)
    })
    socket.on('data', (chunk: Buffer) => this.parser.push(chunk))
    socket.on('error', (err) => {
      this.lastError = err.message
      console.warn('[sip] Verbindung:', err.message)
    })
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      this.registered = false
      if (this.keepalive) clearInterval(this.keepalive)
      this.events.onRegistration(false, this.lastError || 'Verbindung getrennt.')
      if (!this.stopped) this.reconnectTimer = setTimeout(() => this.connect(), 10_000)
    })
  }

  private write(text: string): void {
    trace(text)
    this.socket?.write(text)
  }

  /**
   * Port, öffentliche Adresse und ICE-Kandidaten für einen Anruf.
   *
   * Mit ICE findet das Telefon selbst einen Weg, der durch beide Router geht,
   * notfalls über seinen TURN-Server bei Linphone. Ohne ICE hing es an der
   * Adresse aus der c-Zeile, und die stimmt hinter einem Router selten.
   */
  private async prepareMedia(onAudio: (audio: Buffer) => void): Promise<{ rtp: RtpSession; sdp: string }> {
    const rtp = await RtpSession.open(onAudio)
    const mapped = await publicAddress(rtp.udp)
    const credentials = newIceCredentials()
    rtp.setIce(credentials)
    const candidates = localCandidates(rtp.port, mapped)
    const host = candidates.find((c) => c.type === 'host')
    const preferred = mapped ?? (host ? { address: host.address, port: host.port } : null)
    if (!mapped) console.warn('[sip] STUN ohne Antwort — die öffentliche Adresse ist unbekannt, Ton von außen kommt womöglich nicht an.')
    const sdp = buildSdp(preferred?.address ?? '0.0.0.0', preferred?.port ?? rtp.port, {
      credentials,
      candidates,
      base: host ? { address: host.address, port: host.port } : undefined
    })
    return { rtp, sdp }
  }

  private register(expires: number, auth?: string): void {
    const branch = this.branch()
    const cseq = this.regCseq++
    const hdrs: [string, string][] = [
      ['Via', `SIP/2.0/TLS ${this.host};branch=${branch};rport`],
      ['Max-Forwards', '70'],
      ['From', `<${this.aor}>;tag=${this.regCallId.slice(0, 8)}`],
      ['To', `<${this.aor}>`],
      ['Call-ID', this.regCallId],
      ['CSeq', `${cseq} REGISTER`],
      ['Contact', `${this.contact()};+sip.instance="${this.instance}";reg-id=1;expires=${expires}`],
      ['Supported', 'outbound, path'],
      ['User-Agent', 'VoidJames'],
      ['Expires', String(expires)]
    ]
    if (auth) hdrs.push(['Authorization', auth])
    this.pending.set(branch, {
      method: 'REGISTER',
      onResponse: (res) => {
        if (res.status === 401 || res.status === 407) {
          if (auth) return this.registrationFailed('Benutzername oder Passwort stimmt nicht.')
          const challenge = parseChallenges(headers(res, res.status === 401 ? 'www-authenticate' : 'proxy-authenticate'))[0]
          if (!challenge) return this.registrationFailed('Der Anbieter verlangt eine unbekannte Anmeldung.')
          const uri = `sip:${this.config.domain}`
          return this.register(expires, authorization(challenge, 'REGISTER', uri, this.config.username, this.config.password))
        }
        if (res.status >= 200 && res.status < 300) {
          if (expires === 0) return
          this.registered = true
          this.lastError = ''
          this.events.onRegistration(true, `Angemeldet als ${this.config.username}@${this.config.domain}.`)
          const granted = Number(param(header(res, 'contact'), 'expires') ?? header(res, 'expires') ?? expires)
          if (this.registerTimer) clearTimeout(this.registerTimer)
          this.registerTimer = setTimeout(() => this.register(REGISTER_EXPIRES), Math.max(60, granted * 0.8) * 1000)
          return
        }
        if (res.status === 403 || res.status === 404) {
          return this.registrationFailed('Linphone kennt dieses Konto nicht oder das Passwort stimmt nicht.')
        }
        if (res.status >= 300) this.registrationFailed(`Anmeldung abgelehnt: ${res.status} ${res.reason}`)
      }
    })
    this.write(buildRequest('REGISTER', `sip:${this.config.domain}`, hdrs))
  }

  private registrationFailed(detail: string): void {
    this.registered = false
    this.lastError = detail
    this.events.onRegistration(false, detail)
    if (this.registerTimer) clearTimeout(this.registerTimer)
    // Falsches Passwort wiederholt man nicht im Minutentakt.
    if (!this.stopped) this.registerTimer = setTimeout(() => this.register(REGISTER_EXPIRES), 5 * 60_000)
  }

  // ─────────────────────────────────────────────────────────────
  // Ausgehender Anruf
  // ─────────────────────────────────────────────────────────────

  /**
   * Anrufen. Löst auf, sobald abgenommen wurde; wirft bei Ablehnung,
   * Besetzt oder wenn nach `timeoutMs` niemand rangeht.
   */
  async call(target: string, timeoutMs = 45_000): Promise<SipCallHandle> {
    if (!this.socket || !this.registered) throw new Error('James ist bei Linphone nicht angemeldet.')
    if (this.busy) throw new Error('Es läuft schon ein Anruf.')
    this.dialing = true
    try {
      return await this.dial(target, timeoutMs)
    } finally {
      this.dialing = false
    }
  }

  private async dial(target: string, timeoutMs: number): Promise<SipCallHandle> {
    const { rtp, sdp } = await this.prepareMedia((audio) => handle?.onAudio(audio))
    console.info(`[sip] Rufe ${target} an`)
    const dialog: Dialog = {
      callId: randomUUID(),
      localTag: randomBytes(6).toString('hex'),
      remoteTag: '',
      localUri: this.aor,
      remoteUri: target,
      remoteTarget: target,
      routes: [],
      cseq: 1
    }
    let handle: SipCallHandle | null = null

    return new Promise<SipCallHandle>((resolve, reject) => {
      let settled = false
      let currentBranch = ''
      /** Der beste Zwischenstand bisher: 100, 110 (Push), 180 (klingelt) … */
      let progress = 0
      const fail = (reason: string, keepPending = false): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // Nach einem CANCEL kommt noch ein 487, und das will bestätigt sein.
        if (!keepPending) this.pending.delete(currentBranch)
        rtp.close()
        this.lastCall = reason
        console.warn(`[sip] Anruf an ${target} gescheitert: ${reason}`)
        reject(new Error(reason))
      }
      const timer = setTimeout(() => {
        // Niemand geht ran: Anruf zurückziehen.
        this.write(this.inviteRequest('CANCEL', dialog, currentBranch, ''))
        fail(progressText(progress), true)
      }, timeoutMs)

      const send = (auth?: [string, string]): void => {
        currentBranch = this.branch()
        const branch = currentBranch
        this.pending.set(branch, {
          method: 'INVITE',
          onResponse: (res) => {
            if (res.status < 200) {
              if (res.status > progress) progress = res.status
              return
            }
            this.pending.delete(branch)
            if (settled && res.status >= 300) {
              // Antwort auf das eigene CANCEL — nur noch bestätigen.
              this.ackError(dialog, branch, res)
              return
            }
            if (res.status === 401 || res.status === 407) {
              this.ackError(dialog, branch, res)
              if (auth) return fail('Linphone hat die Anmeldung für den Anruf abgelehnt.')
              const name = res.status === 401 ? 'www-authenticate' : 'proxy-authenticate'
              const challenge = parseChallenges(headers(res, name))[0]
              if (!challenge) return fail('Unbekannte Anmeldung verlangt.')
              dialog.cseq++
              const value = authorization(challenge, 'INVITE', target, this.config.username, this.config.password)
              return send([res.status === 401 ? 'Authorization' : 'Proxy-Authorization', value])
            }
            if (res.status >= 300) {
              this.ackError(dialog, branch, res)
              return fail(
                res.status === 486 || res.status === 600
                  ? 'Besetzt.'
                  : res.status === 603 || res.status === 487
                    ? 'Abgelehnt.'
                    : res.status === 480 || res.status === 404 || res.status === 408
                      ? 'Linphone auf dem Telefon ist gerade nicht erreichbar. Ist die App mit deinem Konto angemeldet?'
                      : res.status === 488 || res.status === 415
                        ? 'Das Telefon hat den Ton abgelehnt. In Linphone die Medienverschlüsselung auf „Keine" stellen und PCMU einschalten.'
                        : `Anruf gescheitert: ${res.status} ${res.reason}`
              )
            }
            // 200 OK — abgenommen.
            if (settled) {
              // Kam nach dem Zeitlimit doch noch an: sofort wieder auflegen.
              this.adoptDialog(dialog, res, true)
              this.sendAck(dialog)
              this.write(this.inDialog('BYE', dialog))
              return
            }
            settled = true
            clearTimeout(timer)
            this.adoptDialog(dialog, res, true)
            this.sendAck(dialog)
            const remote = parseRemoteMedia(res.body)
            if ('problem' in remote) {
              this.write(this.inDialog('BYE', dialog))
              rtp.close()
              this.lastCall = SDP_PROBLEM_TEXT[remote.problem]
              console.warn(`[sip] Abgenommen, aber kein Ton möglich: ${this.lastCall}`)
              return reject(new Error(this.lastCall))
            }
            rtp.connect(remote.targets)
            console.info(`[sip] Abgenommen, Ton an ${rtp.destination}`)
            this.lastCall = 'Abgenommen.'
            handle = this.activate(dialog, rtp, target, sdp)
            resolve(handle)
            this.events.onAnswered(handle, false)
          }
        })
        this.write(this.inviteRequest('INVITE', dialog, branch, sdp, auth))
      }
      send()
    })
  }

  private inviteRequest(method: 'INVITE' | 'CANCEL', d: Dialog, branch: string, sdp: string, auth?: [string, string]): string {
    const hdrs: [string, string][] = [
      ['Via', `SIP/2.0/TLS ${this.host};branch=${branch};rport`],
      ['Max-Forwards', '70'],
      ['From', `<${d.localUri}>;tag=${d.localTag}`],
      ['To', `<${d.remoteUri}>`],
      ['Call-ID', d.callId],
      ['CSeq', `${d.cseq} ${method}`],
      ['User-Agent', 'VoidJames']
    ]
    if (method === 'INVITE') {
      hdrs.push(['Contact', this.contact()], ['Allow', 'INVITE, ACK, CANCEL, BYE, OPTIONS'], ['Content-Type', 'application/sdp'])
      if (auth) hdrs.push(auth)
    }
    return buildRequest(method, d.remoteUri, hdrs, method === 'INVITE' ? sdp : '')
  }

  /** ACK auf eine Ablehnung gehört zur selben Transaktion (selber Branch). */
  private ackError(d: Dialog, branch: string, res: SipMessage): void {
    this.write(
      buildRequest('ACK', d.remoteUri, [
        ['Via', `SIP/2.0/TLS ${this.host};branch=${branch};rport`],
        ['Max-Forwards', '70'],
        ['From', `<${d.localUri}>;tag=${d.localTag}`],
        ['To', header(res, 'to') ?? `<${d.remoteUri}>`],
        ['Call-ID', d.callId],
        ['CSeq', `${d.cseq} ACK`]
      ])
    )
  }

  private adoptDialog(d: Dialog, msg: SipMessage, asCaller: boolean): void {
    d.remoteTag = param(header(msg, asCaller ? 'to' : 'from'), 'tag') ?? ''
    d.remoteTarget = uriOf(header(msg, 'contact')) ?? d.remoteUri
    const rr = headers(msg, 'record-route')
    d.routes = asCaller ? rr.reverse() : rr
  }

  private sendAck(d: Dialog): void {
    this.write(
      buildRequest('ACK', d.remoteTarget, [
        ['Via', `SIP/2.0/TLS ${this.host};branch=${this.branch()};rport`],
        ...d.routes.map((r): [string, string] => ['Route', r]),
        ['Max-Forwards', '70'],
        ['From', `<${d.localUri}>;tag=${d.localTag}`],
        ['To', `<${d.remoteUri}>;tag=${d.remoteTag}`],
        ['Call-ID', d.callId],
        ['CSeq', `${d.cseq} ACK`]
      ])
    )
  }

  private inDialog(method: string, d: Dialog): string {
    d.cseq++
    return buildRequest(method, d.remoteTarget, [
      ['Via', `SIP/2.0/TLS ${this.host};branch=${this.branch()};rport`],
      ...d.routes.map((r): [string, string] => ['Route', r]),
      ['Max-Forwards', '70'],
      ['From', `<${d.localUri}>;tag=${d.localTag}`],
      ['To', `<${d.remoteUri}>;tag=${d.remoteTag}`],
      ['Call-ID', d.callId],
      ['CSeq', `${d.cseq} ${method}`]
    ])
  }

  // ─────────────────────────────────────────────────────────────
  // Eingehende Nachrichten
  // ─────────────────────────────────────────────────────────────

  private dispatch(msg: SipMessage): void {
    const cseq = header(msg, 'cseq') ?? ''
    if (!/REGISTER/i.test(cseq)) {
      console.info(`[sip] ← ${msg.method ? `${msg.method} ${msg.uri}` : `${msg.status} ${msg.reason} (${cseq.split(/\s+/)[1] ?? ''})`}`)
    }
    if (!msg.method) {
      const branch = param(header(msg, 'via'), 'branch')
      const pending = branch ? this.pending.get(branch) : undefined
      // CANCEL teilt sich den Branch mit dem INVITE, das es abbricht. Ohne den
      // Blick auf CSeq hielt das INVITE das „200 OK" des CANCEL für ein spätes
      // Abnehmen und schickte ACK und BYE hinterher (482 Loop Detected).
      const method = cseq.split(/\s+/)[1]?.toUpperCase()
      if (pending && (!method || pending.method === method)) pending.onResponse(msg)
      return
    }
    switch (msg.method) {
      case 'INVITE':
        return void this.onInvite(msg)
      case 'ACK':
        return
      case 'BYE':
        this.reply(msg, 200, 'OK')
        if (this.active && header(msg, 'call-id') === this.active.dialog.callId) this.end('Aufgelegt.', false)
        return
      case 'CANCEL':
        this.reply(msg, 200, 'OK')
        if (this.ringing && header(this.ringing.invite, 'call-id') === header(msg, 'call-id')) {
          this.ringing.cancelled = true
          this.reply(this.ringing.invite, 487, 'Request Terminated')
          this.ringing = null
        }
        return
      case 'OPTIONS':
        return this.reply(msg, 200, 'OK', [['Allow', 'INVITE, ACK, CANCEL, BYE, OPTIONS']])
      default:
        return this.reply(msg, 405, 'Method Not Allowed')
    }
  }

  private async onInvite(invite: SipMessage): Promise<void> {
    const callId = header(invite, 'call-id')
    // Erneutes INVITE im laufenden Gespräch — Halten, oder Linphone meldet
    // nach ICE den gewählten Weg. Den übernehmen und bestätigen.
    if (this.active && callId === this.active.dialog.callId) {
      const updated = invite.body ? parseRemoteMedia(invite.body) : null
      if (updated && 'targets' in updated) this.active.rtp.connect(updated.targets)
      return this.reply(invite, 200, 'OK', [['Contact', this.contact()], ['Content-Type', 'application/sdp']], this.active.sdp)
    }
    if (this.busy) return this.reply(invite, 486, 'Busy Here')

    const from = uriOf(header(invite, 'from')) ?? ''
    // Erst fragen, wer anruft, dann prüfen, ob es technisch geht: So steht ein
    // Anruf auch dann im Protokoll, wenn er am Ton scheitert. Früher wurde er
    // vorher still mit 488 abgewiesen.
    if (!this.events.onIncoming(from)) return this.reply(invite, 603, 'Decline')
    const remote = parseRemoteMedia(invite.body)
    if ('problem' in remote) {
      this.lastCall = SDP_PROBLEM_TEXT[remote.problem]
      console.warn(`[sip] Anruf von ${from} abgewiesen: ${this.lastCall}`)
      return this.reply(invite, 488, 'Not Acceptable Here', [['Warning', `399 james "${remote.problem}"`]])
    }

    this.ringing = { invite, cancelled: false }
    const localTag = randomBytes(6).toString('hex')
    this.reply(invite, 180, 'Ringing', [], '', localTag)

    let handle: SipCallHandle | null = null
    const { rtp, sdp } = await this.prepareMedia((audio) => handle?.onAudio(audio))
    if (!this.ringing || this.ringing.cancelled) {
      rtp.close()
      return
    }
    this.ringing = null

    const dialog: Dialog = {
      callId: callId ?? randomUUID(),
      localTag,
      remoteTag: '',
      localUri: uriOf(header(invite, 'to')) ?? this.aor,
      remoteUri: from,
      remoteTarget: from,
      routes: [],
      cseq: 1
    }
    this.adoptDialog(dialog, invite, false)
    this.reply(invite, 200, 'OK', [['Contact', this.contact()], ['Content-Type', 'application/sdp']], sdp, localTag)
    rtp.connect(remote.targets)
    console.info(`[sip] Angenommen, Ton an ${rtp.destination}`)
    this.lastCall = 'Angenommen.'
    handle = this.activate(dialog, rtp, from, sdp)
    this.events.onAnswered(handle, true)
  }

  private activate(dialog: Dialog, rtp: RtpSession, remote: string, sdp: string): SipCallHandle {
    const handle: SipCallHandle = {
      remote,
      sendAudio: (muLaw) => rtp.send(muLaw),
      clearAudio: () => rtp.clear(),
      hangup: () => this.end('James hat aufgelegt.', true),
      onAudio: () => undefined,
      onEnded: () => undefined
    }
    this.active = { dialog, rtp, handle, byeSent: false, sdp }
    return handle
  }

  private end(reason: string, sendBye: boolean): void {
    const active = this.active
    if (!active) return
    this.active = null
    if (sendBye && !active.byeSent) {
      active.byeSent = true
      this.write(this.inDialog('BYE', active.dialog))
    }
    active.rtp.close()
    const { sent, received } = active.rtp
    console.info(`[sip] Ton: ${sent} Pakete gesendet, ${received} empfangen`)
    if (sent > 100 && received === 0) {
      this.lastCall = 'Das Gespräch stand, aber vom Telefon kam kein Ton an — vermutlich lässt ein Router ihn nicht durch.'
      console.warn(`[sip] ${this.lastCall}`)
    }
    active.handle.onEnded(reason)
  }

  private reply(
    req: SipMessage,
    status: number,
    reason: string,
    extra: [string, string][] = [],
    body = '',
    toTag?: string
  ): void {
    let to = header(req, 'to') ?? ''
    if (toTag && !param(to, 'tag')) to += `;tag=${toTag}`
    const hdrs: [string, string][] = [
      ...headers(req, 'via').map((v): [string, string] => ['Via', v]),
      ...headers(req, 'record-route').map((v): [string, string] => ['Record-Route', v]),
      ['From', header(req, 'from') ?? ''],
      ['To', to],
      ['Call-ID', header(req, 'call-id') ?? ''],
      ['CSeq', header(req, 'cseq') ?? ''],
      ['User-Agent', 'VoidJames'],
      ...extra
    ]
    this.write(buildResponse(status, reason, hdrs, body))
  }

  private contact(): string {
    return `<sip:${this.config.username}@${this.host};transport=tls;ob>`
  }

  private branch(): string {
    return `z9hG4bK${randomBytes(8).toString('hex')}`
  }
}

/** Vergleicht zwei SIP-Adressen ohne Parameter und Groß-/Kleinschreibung. */
export function sameAddress(a: string, b: string): boolean {
  const left = addressOf(a.startsWith('sip') ? a : `sip:${a}`)
  const right = addressOf(b.startsWith('sip') ? b : `sip:${b}`)
  return left !== '' && left === right
}
