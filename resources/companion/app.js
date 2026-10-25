/**
 * James auf dem Telefon.
 *
 * Kein Bündler, keine Abhängigkeiten, eine Datei. Das ist keine Sparsamkeit um
 * ihrer selbst willen: Die Seite wird vom Hauptprozess roh ausgeliefert, und
 * jeder Bauschritt dazwischen wäre eine Stelle, an der die App im fertigen
 * Installer anders aussieht als in der Entwicklung.
 *
 * Was hier NICHT passiert: Es gibt kein Weckwort. iOS lässt keine Seite und
 * keine App dauerhaft im Hintergrund mithören, und ein Weckwort, das nur
 * funktioniert, solange man auf den Bildschirm schaut, wäre eine Attrappe.
 * Stattdessen die Sprechtaste — gedrückt halten, reden, loslassen.
 */

// ── Muss mit src/shared/companion.ts übereinstimmen ──────────
const TAG_MIC = 0x01
const TAG_VOICE = 0x02
const VOICE_RATE = 24000
const PATH_PHONE = '/ws/phone'
const PING_EVERY_MS = 15000
const SILENCE_LIMIT_MS = 45000

const STORE_KEY = 'jarvis.companion'

// ─────────────────────────────────────────────────────────────
// Zustand
// ─────────────────────────────────────────────────────────────

const ui = {
  pairing: document.getElementById('pairing'),
  main: document.getElementById('main'),
  host: document.getElementById('host'),
  token: document.getElementById('token'),
  pair: document.getElementById('pair'),
  pairBack: document.getElementById('pair-back'),
  pairError: document.getElementById('pair-error'),
  dot: document.getElementById('dot'),
  status: document.getElementById('status'),
  note: document.getElementById('note'),
  crystal: document.getElementById('crystal'),
  talk: document.getElementById('talk'),
  say: document.getElementById('say'),
  sayForm: document.getElementById('say-form'),
  wake: document.getElementById('wake'),
  pause: document.getElementById('pause'),
  settings: document.getElementById('settings'),
  audioStatus: document.getElementById('audio-status'),
  audioTest: document.getElementById('audio-test'),
  messages: document.getElementById('messages'),
  clearChat: document.getElementById('clear-chat'),
  reconnect: document.getElementById('reconnect')
}

let config = loadConfig()
let socket = null
let reconnectTimer = null
let reconnectDelay = 1000
let wakeTarget = null
let paused = false
let hostReady = true
let pendingText = null
let textTimer = null
let heartbeatTimer = null
/** Wann zuletzt irgendetwas vom Rechner kam — Antwort, Zustand oder Ton. */
let lastHeard = Date.now()

// ─────────────────────────────────────────────────────────────
// Einstellungen
// ─────────────────────────────────────────────────────────────

function loadConfig() {
  // Aus dem QR-Code: #host=…&token=… . Direkt danach aus der Adresszeile
  // löschen, sonst steht die Marke dauerhaft im Verlauf des Browsers.
  if (location.hash.length > 1) {
    const params = new URLSearchParams(location.hash.slice(1))
    const host = params.get('host')
    const token = params.get('token')
    if (host && token) {
      const fresh = { host, token }
      try { localStorage.setItem(STORE_KEY, JSON.stringify(fresh)) } catch { /* Private Browser: Sitzung bleibt nutzbar. */ }
      history.replaceState(null, '', location.pathname)
      return fresh
    }
  }
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null')
    return saved && typeof saved.host === 'string' && typeof saved.token === 'string' ? saved : null
  } catch {
    return null
  }
}

function saveConfig(next) {
  config = next
  try { localStorage.setItem(STORE_KEY, JSON.stringify(next)) } catch { /* Nur für diese Sitzung merken. */ }
}

// ─────────────────────────────────────────────────────────────
// Wiedergabe
// ─────────────────────────────────────────────────────────────

/**
 * Ausgabe über nacheinander geplante Puffer.
 *
 * Ein Ringpuffer im Worklet wäre feiner, aber hier reicht das Planen: Jeder
 * ankommende Block bekommt seinen Startzeitpunkt direkt hinter dem
 * vorhergehenden. Wichtig ist nur der kleine Vorlauf — ohne ihn liegt der
 * erste Startzeitpunkt in der Vergangenheit, sobald das Netz einmal zuckt,
 * und dann knackt es.
 */
const playback = {
  context: null,
  nextTime: 0,
  sources: new Set(),
  pending: [],
  pendingSamples: 0,
  resuming: null,

  async ensure() {
    if (this.context) {
      await this.wake()
      return
    }
    // iOS gibt die gewünschte Rate nicht immer — deshalb wird unten
    // umgerechnet, statt sich darauf zu verlassen.
    setAudioMode('playback')
    this.context = new AudioContext({ latencyHint: 'interactive' })
    /**
     * Safari kennt einen dritten Zustand: `interrupted`. Ein Anruf, ein Wecker,
     * eine andere App, die den Ton an sich reißt — danach steht der Kontext still
     * und kommt von allein nicht zurück. Der Wechsel wird gemeldet, also wird er
     * auch beantwortet, statt darauf zu warten, dass jemand auf den Schirm tippt.
     */
    this.context.addEventListener('statechange', () => {
      this.updateStatus()
      if (this.context?.state === 'running') this.drain()
    })
    await this.wake()
  },

  /**
   * Zurückholen, was der Browser schlafen gelegt hat.
   *
   * Während der Unterbrechung eingehende Blöcke werden begrenzt aufgehoben.
   * Beim Seitenwechsel wird die alte Antwort dagegen vollständig verworfen.
   */
  async wake() {
    if (!this.context) return
    if (this.context.state !== 'running') {
      if (!this.resuming) {
        this.resuming = this.context.resume().catch(() => {}).finally(() => { this.resuming = null })
      }
      await this.resuming
    }
    this.updateStatus()
    if (this.context.state === 'running') this.drain()
  },

  updateStatus() {
    const running = this.context?.state === 'running'
    ui.audioStatus.textContent = running ? 'Ausgabe bereit · Lautstärke am iPhone regeln' : 'Ton gesperrt oder unterbrochen · Ton prüfen antippen'
    ui.audioTest.textContent = running ? 'Ton prüfen' : 'Ton aktivieren'
  },

  drain() {
    const queued = this.pending
    this.pending = []
    this.pendingSamples = 0
    for (const pcm of queued) this.push(pcm)
  },

  push(pcm) {
    if (!pcm.length) return
    if (!this.context || this.context.state !== 'running') {
      // Höchstens acht Sekunden halten, damit die erste Antwort nicht verloren geht.
      this.pending.push(pcm)
      this.pendingSamples += pcm.length
      while (this.pendingSamples > VOICE_RATE * 8) this.pendingSamples -= this.pending.shift().length
      this.updateStatus()
      if (this.context) void this.wake()
      return
    }
    const rate = this.context.sampleRate
    const samples = rate === VOICE_RATE ? pcm.length : Math.round((pcm.length * rate) / VOICE_RATE)
    const buffer = this.context.createBuffer(1, samples, rate)
    const channel = buffer.getChannelData(0)

    if (rate === VOICE_RATE) {
      for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x8000
    } else {
      const ratio = VOICE_RATE / rate
      for (let i = 0; i < samples; i++) {
        const pos = i * ratio
        const index = Math.floor(pos)
        const a = pcm[index] ?? 0
        const b = pcm[index + 1] ?? a
        channel[i] = (a + (b - a) * (pos - index)) / 0x8000
      }
    }

    const source = this.context.createBufferSource()
    source.buffer = buffer
    source.connect(this.context.destination)

    const now = this.context.currentTime
    if (this.nextTime < now + 0.06) this.nextTime = now + 0.06
    source.start(this.nextTime)
    this.nextTime += buffer.duration

    this.sources.add(source)
    source.onended = () => this.sources.delete(source)
  },

  /** Barge-in: Was noch geplant ist, wird verworfen. */
  flush() {
    for (const source of this.sources) {
      try {
        source.stop()
      } catch {
        // War schon durch.
      }
    }
    this.sources.clear()
    this.pending = []
    this.pendingSamples = 0
    this.nextTime = 0
  }
}

// ─────────────────────────────────────────────────────────────
// Mikrofon
// ─────────────────────────────────────────────────────────────

const mic = {
  context: null,
  stream: null,
  node: null,
  active: false,

  /** Ob die Aufnahme noch steht — oder nur so aussieht. */
  alive() {
    if (!this.node || !this.stream || !this.context) return false
    if (this.context.state === 'closed') return false
    // Nach einem Anruf oder einer Weile im Hintergrund beendet iOS die Spur.
    // Das Objekt bleibt liegen, es kommt nur nie wieder etwas heraus — die
    // Sprechtaste sähe gedrückt aus und übertrüge Stille.
    return this.stream.getAudioTracks().some((track) => track.readyState === 'live')
  },

  async ensure() {
    if (this.alive()) {
      // Steht alles, kann der Kontext trotzdem schlafen. Ohne das Aufwecken
      // liefert das Worklet keinen einzigen Block, und zwar wortlos.
      if (this.context.state !== 'running') await this.context.resume()
      return
    }
    await this.teardown()
    /**
     * Ohne sicheren Kontext gibt es `navigator.mediaDevices` gar nicht.
     *
     * iOS macht genau eine Ausnahme, und die heißt `localhost` — eine Adresse
     * im Heimnetz über einfaches HTTP fällt durch. Der Fehler, den man ohne
     * diese Prüfung bekäme, lautet "Cannot read properties of undefined", und
     * damit kommt niemand auf die Ursache. Deshalb hier der ganze Satz.
     */
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        location.protocol === 'https:'
          ? 'Dieser Browser gibt das Mikrofon nicht frei.'
          : 'Über eine unverschlüsselte Adresse lässt iOS das Mikrofon nicht zu. Öffne die App ' +
            'über die Tailscale-Adresse — sie steht am Rechner unter Einstellungen, Telefon.'
      )
    }
    setAudioMode('play-and-record')
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      },
      video: false
    })
    this.context = new AudioContext({ latencyHint: 'interactive' })
    if (this.context.state === 'suspended') await this.context.resume()
    await this.context.audioWorklet.addModule('mic-worklet.js')

    const source = this.context.createMediaStreamSource(this.stream)
    this.node = new AudioWorkletNode(this.context, 'mic-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit'
    })
    this.node.port.onmessage = (event) => {
      const pcm = event.data
      if (!this.active || !socket || socket.readyState !== WebSocket.OPEN) return
      // Ein Byte Kennung davor, dann die Rohdaten. Ein neuer Puffer pro Block
      // ist billiger als er aussieht und spart das Zusammenkleben am anderen Ende.
      const frame = new Uint8Array(1 + pcm.byteLength)
      frame[0] = TAG_MIC
      frame.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 1)
      socket.send(frame)
    }
    source.connect(this.node)
  },

  async start() {
    await this.ensure()
    this.active = true
    this.node.port.postMessage({ type: 'enable', value: true })
  },

  stop() {
    this.active = false
    this.node?.port.postMessage({ type: 'enable', value: false })
  },

  /**
   * Alles abräumen, damit `ensure` von vorn anfangen kann.
   *
   * Die Spuren einzeln zu stoppen ist nicht bloß Ordnungsliebe: Solange eine
   * lebt, zeigt iOS den roten Balken und hält die Aufnahme-Betriebsart, in der
   * der Lautsprecher leiser klingt. Wer nur den Knoten wegwirft, lässt beides
   * stehen.
   */
  async teardown() {
    this.active = false
    try {
      this.node?.disconnect()
    } catch {
      // Kann schon abgebaut sein.
    }
    if (this.node) this.node.port.onmessage = null
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    if (this.context && this.context.state !== 'closed') {
      try {
        await this.context.close()
      } catch {
        // Auch das ist kein Grund, hier stehenzubleiben.
      }
    }
    this.node = null
    this.stream = null
    this.context = null
    setAudioMode('playback')
    void playback.wake()
  }
}

// ─────────────────────────────────────────────────────────────
// Verbindung
// ─────────────────────────────────────────────────────────────

/**
 * Den alten Sockel aus der Kennung nehmen, bevor ein neuer hineinkommt.
 *
 * Ohne das gehört `socket` beim sofortigen Neuaufbau kurz zwei Verbindungen
 * gleichzeitig: Der geschlossene meldet sich einen Wimpernschlag später mit
 * `onclose`, setzt die Kennung auf `null` — obwohl längst eine frische, gesunde
 * Verbindung dahintersteht — und danach ginge jeder Tastendruck ins Leere,
 * während die Anzeige weiter „verbunden" sagt.
 */
function discard() {
  const dying = socket
  socket = null
  stopHeartbeat()
  endTalk()
  playback.flush()
  if (!dying) return
  try {
    dying.close()
  } catch {
    // Er war schon durch.
  }
}

function connect() {
  if (!config) return
  clearTimeout(reconnectTimer)
  reconnectTimer = null
  discard()

  // Das Schema folgt der Seite, nicht der Einstellung: Eine über https
  // ausgelieferte Seite darf keinen ws://-Sockel aufmachen, der Browser wertet
  // das als gemischten Inhalt und blockt ihn wortlos.
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${scheme}//${config.host}${PATH_PHONE}?token=${encodeURIComponent(config.token)}`
  setStatus('verbinde…', 'connecting')

  let ws
  try {
    ws = new WebSocket(url)
  } catch {
    scheduleReconnect()
    return
  }
  socket = ws
  ws.binaryType = 'arraybuffer'
  // Schon jetzt, nicht erst beim `onopen`: Solange der Aufbau läuft, ist noch
  // nichts angekommen — und eine Wache, die „seit ewig nichts gehört" mit
  // „tot" verwechselt, risse jede Verbindung ab, bevor sie steht.
  lastHeard = Date.now()

  /** Gilt dieser Rückruf noch? Nach `discard` gehört die Kennung einem anderen. */
  const mine = () => socket === ws

  ws.onopen = () => {
    if (!mine()) return
    reconnectDelay = 1000
    lastHeard = Date.now()
    ws.send(JSON.stringify({ t: 'hello', name: deviceName() }))
    setStatus('verbunden', 'idle')
    startHeartbeat()
    flushHealth()
  }

  ws.onmessage = (event) => {
    if (!mine()) return
    lastHeard = Date.now()
    if (typeof event.data === 'string') {
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        // Ein kaputter Satz darf die Verbindung nicht mitnehmen.
        return
      }
      handleMessage(msg)
      return
    }
    const bytes = new Uint8Array(event.data)
    if (bytes[0] !== TAG_VOICE) return
    // Die Nutzlast liegt hinter dem Kennungsbyte und ist damit ungerade
    // ausgerichtet — Int16Array verlangt aber ein Vielfaches von zwei.
    // Deshalb umkopieren statt eine Sicht darüberzulegen.
    const pcm = new Int16Array(bytes.byteLength - 1 >> 1)
    new Uint8Array(pcm.buffer).set(bytes.subarray(1, 1 + pcm.byteLength))
    playback.push(pcm)
  }

  ws.onclose = (event) => {
    if (!mine()) return
    socket = null
    stopHeartbeat()
    // Beim Trennen mitten im Reden bliebe die Taste sonst optisch gedrückt.
    endTalk()
    if (event.code === 1008 || event.code === 1002) {
      // Marke abgelehnt oder gewechselt — erneutes Verbinden hilft nicht.
      showPairing('Der Rechner hat die Marke abgelehnt. Hol dir eine neue.')
      return
    }
    playback.flush()
    setStatus('getrennt · erneuter Versuch läuft', 'offline')
    scheduleReconnect()
  }

  ws.onerror = () => {
    // Das eigentliche Aufräumen macht onclose, das immer folgt.
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(connect, reconnectDelay)
  // Langsam aufgeben, aber nie ganz: Der Rechner darf ruhig eine Weile
  // schlafen, und wenn er zurückkommt, soll das Telefon von selbst wieder da sein.
  reconnectDelay = Math.min(20000, reconnectDelay * 1.6)
}

// ─────────────────────────────────────────────────────────────
// Totmannschaltung
// ─────────────────────────────────────────────────────────────

/**
 * Der Browser sagt nicht, wenn eine Verbindung tot ist.
 *
 * `readyState` steht auf OPEN, bis ein Schreibversuch scheitert oder das
 * Betriebssystem den Sockel abräumt — beim Wechsel von WLAN auf Mobilfunk kann
 * das Minuten dauern, und in dieser Zeit sieht die App gesund aus, während
 * nichts mehr durchgeht. Also wird gefragt: alle fünfzehn Sekunden ein `ping`,
 * und wenn dreimal hintereinander keine Antwort kommt, wird neu aufgebaut.
 *
 * Die Pings des Protokolls, die der Rechner schickt, helfen hier nicht: Der
 * Browser beantwortet sie selbst und sagt der Seite nichts davon.
 */
function startHeartbeat() {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => {
    if (!socket) return
    if (socket.readyState !== WebSocket.OPEN) {
      reconnectNow()
      return
    }
    if (Date.now() - lastHeard > SILENCE_LIMIT_MS) {
      setStatus('Leitung tot — verbinde neu', 'connecting')
      reconnectNow()
      return
    }
    try {
      socket.send(JSON.stringify({ t: 'ping' }))
    } catch {
      reconnectNow()
    }
  }, PING_EVERY_MS)
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = null
}

/** Sofort neu aufbauen, ohne die Wartezeit des geregelten Rückzugs. */
function reconnectNow() {
  discard()
  reconnectDelay = 1000
  connect()
}

/**
 * Zurück aus dem Hintergrund, aus dem Sperrbildschirm, aus einem Netzwechsel.
 *
 * Zu fragen, ob `socket` leer ist, ist nur die eine Hälfte: iOS friert die Seite
 * ein, ohne den Sockel zu schließen, und beim Aufwachen steht dann eine
 * Verbindung da, die es nicht mehr gibt. Gefragt wird deshalb auch nach dem
 * letzten Lebenszeichen, nicht bloß nach dem Vorhandensein eines Objekts.
 */
function ensureConnected() {
  if (!config) return
  // Der Ton schläft im Hintergrund mit ein. Erst aufwecken, dann verbinden —
  // sonst kommt die Antwort auf einen Kontext, der stillsteht.
  void playback.wake()
  if (!socket || socket.readyState > WebSocket.OPEN) {
    reconnectDelay = 1000
    connect()
    return
  }
  if (Date.now() - lastHeard > SILENCE_LIMIT_MS) reconnectNow()
}

function handleMessage(msg) {
  // `pong` braucht keine Behandlung — dass es angekommen ist, hat der Aufrufer
  // schon vermerkt, und genau darin liegt sein ganzer Zweck.
  if (msg.t === 'pong') return

  if (msg.t === 'text-result' && pendingText?.requestId === msg.requestId) {
    const submitted = pendingText.text
    clearTimeout(textTimer)
    pendingText = null
    ui.sayForm.querySelector('button').disabled = !hostReady || Boolean(pendingText)
    if (msg.ok) {
      if (ui.say.value.trim() === submitted) { ui.say.value = ''; storeDraft() }
      ui.note.textContent = ''
    } else { ui.note.textContent = 'James konnte deine Nachricht nicht übernehmen. Sie bleibt zum erneuten Senden erhalten.' }
    return
  }
  if (msg.t === 'availability') {
    hostReady = msg.ready === true
    ui.talk.disabled = !hostReady
    ui.sayForm.querySelector('button').disabled = !hostReady || Boolean(pendingText)
    ui.note.textContent = hostReady ? '' : 'James ist am Rechner nicht bereit. Öffne dort das James-Fenster.'
    return
  }
  if (msg.t === 'state') {
    paused = msg.paused
    ui.pause.textContent = paused ? 'Fortsetzen' : 'Pausieren'
    setStatus(labelFor(msg.state, msg.paused), msg.paused ? 'paused' : msg.state)
    // Neue Runde: Was noch in der Warteschlange lag, gehört zur alten Antwort.
    if (msg.state === 'listening') playback.flush()
  } else if (msg.t === 'captions' && Array.isArray(msg.items)) {
    renderCaptions(msg.items)
  } else if (msg.t === 'wake') {
    wakeTarget = msg
    // Die App merkt sich das Ziel selbst: Schläft der Rechner, lädt diese
    // Seite gar nicht erst, und geweckt werden muss trotzdem.
    window.jarvisNative?.remember?.({ mac: msg.mac, broadcast: msg.broadcast, address: msg.address })
  } else if (msg.t === 'note') {
    ui.note.textContent = msg.text
  } else if (msg.t === 'error') {
    ui.note.textContent = msg.message
  } else if (msg.t === 'bye') {
    setStatus(msg.reason, 'offline')
  }
}

// Apple Health: Die James-App reicht die Tageswerte über `__jarvisHealth`
// herein. Sie gehen am Kristall vorbei direkt an den Rechner — dafür muss
// das James-Fenster nicht offen sein. Steht die Leitung noch nicht, wartet
// der letzte Stand bis zum nächsten Verbindungsaufbau.
let pendingHealth = null
function flushHealth() {
  if (!pendingHealth || socket?.readyState !== WebSocket.OPEN) return
  try { socket.send(JSON.stringify({ t: 'health', data: pendingHealth })); pendingHealth = null } catch { /* nächster Aufbau */ }
}
window.__jarvisHealth = (data) => {
  if (!data || typeof data !== 'object') return
  pendingHealth = data
  flushHealth()
}

function send(msg) {
  if (!hostReady && !['ping', 'hello'].includes(msg.t)) {
    ui.note.textContent = 'Öffne das James-Fenster am Rechner. Deine Eingabe bleibt erhalten.'
    return false
  }
  if (socket?.readyState !== WebSocket.OPEN) {
    ui.note.textContent = 'Keine Verbindung. Deine Nachricht bleibt im Eingabefeld.'
    ensureConnected()
    return false
  }
  try { socket.send(JSON.stringify(msg)); return true } catch {
    ui.note.textContent = 'Senden fehlgeschlagen. Bitte erneut versuchen.'
    return false
  }
}

// ─────────────────────────────────────────────────────────────
// Wecken
// ─────────────────────────────────────────────────────────────

/**
 * Ein Browser kann kein UDP. Deshalb wird hier nach einer nativen Brücke
 * gesucht, die die eingepackte Fassung mitbringt — und wenn es sie nicht gibt,
 * wird gesagt warum, statt einen Knopf anzubieten, der nichts tut.
 */
async function wakeComputer() {
  if (!wakeTarget) {
    ui.note.textContent =
      'Ich weiß noch nicht, welche Karte ich wecken soll — dafür muss die Verbindung einmal ' +
      'gestanden haben.'
    return
  }
  const native = window.jarvisNative
  if (!native?.wake) {
    ui.note.textContent =
      'Wecken geht nur in der installierten App: Eine Webseite darf keine Netzpakete dieser Art ' +
      'verschicken. In Safari bleibt nur, den Rechner selbst anzustupsen.'
    return
  }
  ui.note.textContent = 'Zauberpaket unterwegs…'
  try {
    await native.wake({ mac: wakeTarget.mac, broadcast: wakeTarget.broadcast, address: wakeTarget.address })
    ui.note.textContent = 'Geweckt. Er braucht einen Moment.'
    reconnectDelay = 1000
    scheduleReconnect()
  } catch (err) {
    ui.note.textContent = `Das Wecken hat nicht geklappt: ${err}`
  }
}

// ─────────────────────────────────────────────────────────────
// Oberfläche
// ─────────────────────────────────────────────────────────────

function labelFor(state, isPaused) {
  if (isPaused) return 'stillgelegt'
  return (
    {
      idle: 'bereit',
      connecting: 'verbindet',
      listening: 'hört zu',
      thinking: 'denkt nach',
      speaking: 'spricht',
      tool: 'arbeitet',
      research: 'recherchiert',
      offline: 'offline',
      confirm: 'wartet auf deine Antwort',
      error: 'Fehler · Hinweis beachten',
      paused: 'pausiert'
    }[state] ?? state
  )
}

function setStatus(text, state) {
  ui.status.textContent = text
  ui.dot.dataset.state = state
  ui.crystal.dataset.state = state
}

function showPairing(message) {
  endTalk()
  ui.pairBack.hidden = !config
  ui.pairError.hidden = !message
  ui.main.hidden = true
  ui.pairing.hidden = false
  if (message) {
    ui.pairError.textContent = message
    ui.pairError.hidden = false
  }
  if (config) {
    ui.host.value = config.host
    ui.token.value = config.token
  }
}

function showMain() {
  ui.pairing.hidden = true
  ui.main.hidden = false
}

function deviceName() {
  return /iphone|ipad/i.test(navigator.userAgent) ? 'iPhone' : 'Telefon'
}

// ─────────────────────────────────────────────────────────────
// Bedienung
// ─────────────────────────────────────────────────────────────

ui.pair.addEventListener('click', async () => {
  let host
  try {
    const entered = ui.host.value.trim()
    const address = new URL(entered.includes('://') ? entered : `${location.protocol}//${entered}`)
    if (!['https:', 'http:'].includes(address.protocol) || address.pathname !== '/' || address.search || address.hash || address.username || address.password) throw new Error('Adresse')
    host = address.host
  } catch {
    ui.pairError.textContent = 'Bitte nur die Rechneradresse mit Port eingeben, zum Beispiel 192.168.1.20:8788.'
    ui.pairError.hidden = false
    return
  }
  const token = ui.token.value.trim()
  if (!host || !token) {
    ui.pairError.textContent = 'Beides wird gebraucht.'
    ui.pairError.hidden = false
    return
  }
  saveConfig({ host, token })
  ui.pairError.hidden = true
  // Der Knopfdruck ist die Geste, die iOS für den Ton verlangt — hier und
  // nirgendwo sonst lässt sich der Kontext aufmachen.
  void playback.ensure().catch(showAudioError)
  showMain()
  connect()
})

/**
 * Die Sprechtaste.
 *
 * Pointer-Ereignisse statt touchstart: Damit funktioniert dieselbe Taste auf
 * dem Telefon und mit der Maus, wenn man die Seite am Rechner aufmacht.
 * `setPointerCapture` sorgt dafür, dass das Loslassen auch dann ankommt, wenn
 * der Finger dabei von der Taste gerutscht ist — sonst bliebe das Mikrofon an.
 */
let talkHeld = false
let talkStarting = false
let talkGeneration = 0

async function beginTalk() {
  if (talkHeld || talkStarting) return
  if (socket?.readyState !== WebSocket.OPEN) { send({ t: 'ping' }); return }
  const generation = ++talkGeneration
  talkHeld = true
  talkStarting = true
  ui.talk.classList.add('active')
  ui.talk.setAttribute('aria-pressed', 'true')
  void playback.ensure().catch(showAudioError)
  playback.flush()
  try {
    await mic.ensure()
    // Eine Freigabe kann erst nach dem Loslassen oder Seitenwechsel eintreffen.
    if (!talkHeld || generation !== talkGeneration) return
    if (!send({ t: 'mic', on: true })) return
    mic.active = true
    mic.node.port.postMessage({ type: 'enable', value: true })
  } catch (err) {
    ui.note.textContent = `Kein Zugriff aufs Mikrofon: ${err.message || err}`
    talkHeld = false
  } finally {
    if (!talkHeld || generation !== talkGeneration || !mic.active) {
      talkHeld = false
      ui.talk.classList.remove('active')
      ui.talk.setAttribute('aria-pressed', 'false')
      await mic.teardown()
    }
    talkStarting = false
  }
}

function endTalk() {
  if (!talkHeld) return
  talkHeld = false
  talkGeneration++
  ui.talk.classList.remove('active')
  ui.talk.setAttribute('aria-pressed', 'false')
  mic.stop()
  send({ t: 'mic', on: false })
  // Während der Freigabe räumt beginTalk auf. Sonst sofort die Spur freigeben.
  if (!talkStarting) {
    talkStarting = true
    void mic.teardown().finally(() => { talkStarting = false })
  }
}
ui.talk.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  ui.talk.setPointerCapture(event.pointerId)
  void beginTalk()
})
ui.talk.addEventListener('pointerup', endTalk)
ui.talk.addEventListener('pointercancel', endTalk)
ui.talk.addEventListener('lostpointercapture', endTalk)
ui.talk.addEventListener('keydown', (event) => {
  if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); void beginTalk() }
})
ui.talk.addEventListener('keyup', (event) => {
  if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); endTalk() }
})
ui.talk.addEventListener('blur', endTalk)
window.addEventListener('blur', endTalk)

ui.crystal.addEventListener('click', () => { playback.flush(); send({ t: 'press' }) })
ui.crystal.addEventListener('keydown', (event) => {
  if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); ui.crystal.click() }
})
ui.pause.addEventListener('click', () => send({ t: 'pause', paused: !paused }))
ui.wake.addEventListener('click', wakeComputer)
ui.settings.addEventListener('click', () => showPairing(''))
ui.pairBack.addEventListener('click', showMain)

ui.sayForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const text = ui.say.value.trim()
  if (!text || pendingText) return
  void playback.ensure().catch(showAudioError)
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  if (send({ t: 'text', text, requestId })) {
    pendingText = { requestId, text }
    ui.sayForm.querySelector('button').disabled = true
    ui.note.textContent = 'Nachricht wird an James übergeben …'
    textTimer = setTimeout(() => {
      if (pendingText?.requestId !== requestId) return
      pendingText = null
      ui.sayForm.querySelector('button').disabled = !hostReady
      ui.note.textContent = 'Keine Sendebestätigung erhalten. Deine Nachricht bleibt erhalten; prüfe vor erneutem Senden den Verlauf.'
    }, 30000)
  }
})

/**
 * Der Ton, den iOS nur nach einer Geste herausgibt.
 *
 * Bisher hing er allein am Kopplungsknopf und an der Sprechtaste. Wer die App
 * vom Startbildschirm öffnet, drückt aber weder das eine noch das andere — er
 * sieht den Kristall pulsieren und hört nichts, und das sieht nach einer
 * kaputten Verbindung aus. Jede Berührung irgendwo auf der Seite reicht jetzt.
 * In der Erfassungsphase, damit es auch dann greift, wenn ein anderer Handler
 * das Ereignis für sich behält.
 */
document.addEventListener('click', () => void playback.ensure().catch(showAudioError), { capture: true })

// Zurück aus dem Hintergrund, aus dem Funkloch, aus dem Netzwechsel.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    ensureConnected()
    return
  }
  // Wer die App weglegt, während er spricht, soll nicht weitersenden. Ohne das
  // bliebe das Mikrofon offen, bis die Verbindung von selbst zusammenbricht.
  endTalk()
  playback.flush()
})
window.addEventListener('pagehide', () => { endTalk(); playback.flush() })
window.addEventListener('pageshow', ensureConnected)
window.addEventListener('focus', ensureConnected)
window.addEventListener('online', ensureConnected)

function setAudioMode(type) {
  try { if (navigator.audioSession) navigator.audioSession.type = type } catch { /* Optional auf älteren iPhones. */ }
}
function showAudioError(err) {
  ui.audioStatus.textContent = `Audio nicht verfügbar: ${err.message || err}`
}
ui.audioTest.addEventListener('click', async () => {
  try {
    setAudioMode(mic.active ? 'play-and-record' : 'playback')
    await playback.ensure()
    if (playback.context.state !== 'running') return
    const ctx = playback.context
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()
    oscillator.frequency.value = 660
    gain.gain.setValueAtTime(0, ctx.currentTime)
    gain.gain.linearRampToValueAtTime(.15, ctx.currentTime + .03)
    gain.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + .4)
    oscillator.connect(gain).connect(ctx.destination)
    oscillator.start()
    oscillator.stop(ctx.currentTime + .45)
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect() }
    ui.note.textContent = 'Testton abgespielt. Falls du nichts hörst: Medienlautstärke erhöhen und Bluetooth-Ausgabe prüfen.'
  } catch (err) { showAudioError(err) }
})
ui.reconnect.addEventListener('click', reconnectNow)
function appendMessage(who, text) {
  ui.messages.querySelector('.empty-chat')?.remove()
  const row = document.createElement('article')
  row.className = 'message'
  row.dataset.who = who
  const label = document.createElement('strong')
  label.textContent = who === 'user' ? 'DU' : 'JAMES'
  const content = document.createElement('p')
  content.textContent = text
  row.append(label, content)
  ui.messages.append(row)
  ui.main.classList.add('has-messages')
  while (ui.messages.children.length > 30) ui.messages.firstElementChild.remove()
  ui.messages.scrollTop = ui.messages.scrollHeight
}
let hiddenCaptionId = -1
let latestCaptionId = -1
function renderCaptions(items) {
  const nearBottom = ui.messages.scrollHeight - ui.messages.scrollTop - ui.messages.clientHeight < 60
  const oldScroll = ui.messages.scrollTop
  ui.messages.replaceChildren()
  for (const item of items.slice(-30)) {
    if (typeof item.id !== 'number' || typeof item.text !== 'string' || !['user', 'james'].includes(item.who)) continue
    latestCaptionId = Math.max(latestCaptionId, item.id)
    if (item.id > hiddenCaptionId) appendMessage(item.who, item.text)
  }
  if (!nearBottom) ui.messages.scrollTop = oldScroll
}
ui.clearChat.addEventListener('click', () => { hiddenCaptionId = latestCaptionId; ui.messages.replaceChildren(); ui.main.classList.remove('has-messages') })
function storeDraft() {
  try { localStorage.setItem('jarvis.companion.draft', ui.say.value) } catch { /* Sitzung bleibt nutzbar. */ }
}
try { ui.say.value = localStorage.getItem('jarvis.companion.draft') || '' } catch { /* Kein Speicher. */ }
ui.say.addEventListener('input', storeDraft)

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {
    // Ohne Service Worker läuft alles bis auf das Symbol am Startbildschirm.
  })
}

if (config) {
  showMain()
  connect()
} else {
  showPairing('')
}
