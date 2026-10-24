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
  settings: document.getElementById('settings')
}

let config = loadConfig()
let socket = null
let reconnectTimer = null
let reconnectDelay = 1000
let wakeTarget = null
let paused = false
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
      localStorage.setItem(STORE_KEY, JSON.stringify(fresh))
      history.replaceState(null, '', location.pathname)
      return fresh
    }
  }
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || 'null')
  } catch {
    return null
  }
}

function saveConfig(next) {
  config = next
  localStorage.setItem(STORE_KEY, JSON.stringify(next))
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
  /** Einmal gemeckert reicht — sonst überschreibt der Hinweis jede Notiz. */
  complained: false,

  async ensure() {
    if (this.context) {
      await this.wake()
      return
    }
    // iOS gibt die gewünschte Rate nicht immer — deshalb wird unten
    // umgerechnet, statt sich darauf zu verlassen.
    this.context = new AudioContext({ sampleRate: VOICE_RATE, latencyHint: 'interactive' })
    /**
     * Safari kennt einen dritten Zustand: `interrupted`. Ein Anruf, ein Wecker,
     * eine andere App, die den Ton an sich reißt — danach steht der Kontext still
     * und kommt von allein nicht zurück. Der Wechsel wird gemeldet, also wird er
     * auch beantwortet, statt darauf zu warten, dass jemand auf den Schirm tippt.
     */
    this.context.addEventListener('statechange', () => {
      if (this.context && this.context.state !== 'running') void this.wake()
    })
    await this.wake()
  },

  /**
   * Zurückholen, was der Browser schlafen gelegt hat.
   *
   * Der Zeitplan wird dabei verworfen. `nextTime` ist ein Zeitpunkt auf der Uhr
   * des Kontexts, und die steht still, solange er ruht: Nach einer Minute im
   * Hintergrund liegt der gemerkte Zeitpunkt weit vor der Uhr, und alles, was
   * dann geplant wird, liefe auf einen Schlag los.
   */
  async wake() {
    if (!this.context || this.context.state === 'running') return
    try {
      await this.context.resume()
      this.nextTime = 0
      // Der Hinweis darf wieder erscheinen, falls es später erneut klemmt.
      this.complained = false
    } catch {
      // Ohne Geste des Nutzers geht es nicht. Der nächste Tipp holt es nach.
    }
  },

  push(pcm) {
    if (!this.context) {
      // Der Ton war nie freigegeben: Wer die App vom Startbildschirm öffnet,
      // hat nichts angetippt, und ohne Antippen gibt iOS keinen Lautsprecher
      // heraus. Ohne diesen Hinweis wirkt das wie eine kaputte Verbindung —
      // der Kristall bewegt sich, es kommt nur nichts.
      if (!this.complained) {
        this.complained = true
        ui.note.textContent = 'Tipp einmal auf den Schirm, dann darf ich sprechen.'
      }
      return
    }
    if (this.context.state !== 'running') {
      // Schlafend oder unterbrochen. Aufwecken und diesen Block fallen lassen:
      // Ihn zu planen hieße, ihn auf einen Zeitpunkt zu legen, den die stehende
      // Uhr nie erreicht.
      void this.wake()
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
    setStatus('getrennt', 'offline')
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

  if (msg.t === 'state') {
    paused = msg.paused
    ui.pause.textContent = paused ? 'Aufwecken' : 'Stilllegen'
    setStatus(labelFor(msg.state, msg.paused), msg.paused ? 'paused' : msg.state)
    // Neue Runde: Was noch in der Warteschlange lag, gehört zur alten Antwort.
    if (msg.state === 'listening') playback.flush()
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

function send(msg) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg))
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
      offline: 'offline'
    }[state] ?? state
  )
}

function setStatus(text, state) {
  ui.status.textContent = text
  ui.dot.dataset.state = state
  ui.crystal.dataset.state = state
}

function showPairing(message) {
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
  const host = ui.host.value.trim().replace(/^https?:\/\//, '').replace(/\/$/, '')
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
  await playback.ensure()
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
ui.talk.addEventListener('pointerdown', async (event) => {
  ui.talk.setPointerCapture(event.pointerId)
  ui.talk.classList.add('active')
  await playback.ensure()
  try {
    await mic.start()
    send({ t: 'mic', on: true })
  } catch (err) {
    ui.note.textContent = `Kein Zugriff aufs Mikrofon: ${err}`
    ui.talk.classList.remove('active')
  }
})

const endTalk = () => {
  if (!ui.talk.classList.contains('active')) return
  ui.talk.classList.remove('active')
  mic.stop()
  send({ t: 'mic', on: false })
}
ui.talk.addEventListener('pointerup', endTalk)
ui.talk.addEventListener('pointercancel', endTalk)

ui.crystal.addEventListener('click', () => send({ t: 'press' }))
ui.pause.addEventListener('click', () => send({ t: 'pause', paused: !paused }))
ui.wake.addEventListener('click', wakeComputer)
ui.settings.addEventListener('click', () => showPairing(''))

ui.sayForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const text = ui.say.value.trim()
  if (!text) return
  send({ t: 'text', text })
  ui.say.value = ''
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
document.addEventListener('pointerdown', () => void playback.ensure(), { capture: true })

// Zurück aus dem Hintergrund, aus dem Funkloch, aus dem Netzwechsel.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    ensureConnected()
    return
  }
  // Wer die App weglegt, während er spricht, soll nicht weitersenden. Ohne das
  // bliebe das Mikrofon offen, bis die Verbindung von selbst zusammenbricht.
  endTalk()
})
window.addEventListener('pageshow', ensureConnected)
window.addEventListener('focus', ensureConnected)
window.addEventListener('online', ensureConnected)

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
