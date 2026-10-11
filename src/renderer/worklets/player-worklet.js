/**
 * Lückenlose Wiedergabe der Modell-Audio-Chunks.
 *
 * Der übliche Fehler ist, jeden ankommenden Chunk als eigenen
 * AudioBufferSourceNode zu planen. Zwischen zwei Quellen entsteht dann fast
 * immer ein Sample-Loch oder eine Überlappung — man hört Knacken und der
 * Sprachfluss wirkt abgehackt. Stattdessen: ein durchgehender Ringpuffer,
 * aus dem der Audio-Thread kontinuierlich liest.
 *
 * Der Kontext läuft mit 24 kHz, also exakt der Ausgaberate der Live API.
 * Damit entfällt jedes Resampling auf der Ausgabeseite.
 *
 * Drei Dinge entscheiden hier über "klingt wie ein Telefonat aus dem Keller"
 * und "klingt wie jemand im Raum":
 *
 * 1. **Der Puffer muss die ganze Antwort fassen.** Die Live API schickt nicht
 *    im Sprechtempo, sondern so schnell die Leitung hergibt — eine Antwort von
 *    zwanzig Sekunden liegt in zwei Sekunden vollständig hier. Ein Ring von
 *    drei Sekunden lief dabei über, warf beim Überlauf die ältesten Daten weg,
 *    und das waren die, die gerade gesprochen werden sollten. Ergebnis: Wörter
 *    fehlen mitten im Satz. Das war der eigentliche Aussetzer.
 *
 * 2. **Nach einem Loch muss neu angefüttert werden.** Lief der Puffer leer und
 *    trudelt der nächste 20-ms-Happen ein, darf die Wiedergabe nicht sofort
 *    wieder loslaufen — sie hungert nach 20 ms erneut. Aus einer Netzdelle
 *    wird sonst ein Stakkato aus zwanzig kleinen Aussetzern.
 *
 * 3. **Kein Sprung im Signal.** Von einem Abtastwert direkt auf null zu gehen
 *    ist eine Sprungstelle, und eine Sprungstelle hört man als Klicken. Jeder
 *    Übergang läuft deshalb über eine kurze Rampe.
 */

/**
 * Ring-Kapazität. Eine Minute bei 24 kHz sind 5,8 MB — verglichen mit dem,
 * was ein Chromium ohnehin belegt, nichts, und lange genug für jede Antwort,
 * die ein Mensch am Stück anhören würde.
 */
const RING_SECONDS = 60

/** So lange bleibt "spricht" stehen, obwohl der Puffer leer ist. */
const DRAIN_HOLD_MS = 320

/** Rampe an jedem Übergang. Kurz genug, um nicht zu bremsen, lang genug gegen das Klicken. */
const GLIDE_MS = 4

/**
 * Wie viel nach einem Loch wieder dasein muss, bevor es weitergeht.
 *
 * Nicht der volle Jitterpuffer: Der ist für den Anlauf gedacht, wo Latenz
 * niemandem auffällt. Mitten im Satz zählt jede Zehntelsekunde, deshalb die
 * kleinere von beiden Größen.
 */
const REFILL_MS = 90

class PlayerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()

    const opts = options?.processorOptions ?? {}
    this.jitterSamples = Math.round(((opts.jitterBufferMs ?? 100) / 1000) * sampleRate)
    this.fadeSamples = Math.max(1, Math.round(((opts.fadeMs ?? 40) / 1000) * sampleRate))
    this.holdSamples = Math.round((DRAIN_HOLD_MS / 1000) * sampleRate)
    this.glideSamples = Math.max(1, Math.round((GLIDE_MS / 1000) * sampleRate))
    this.refillSamples = Math.round((REFILL_MS / 1000) * sampleRate)

    this.ring = new Float32Array(Math.ceil(RING_SECONDS * sampleRate))
    this.readIdx = 0
    this.writeIdx = 0
    this.available = 0

    // Erst anlaufen, wenn genug gepuffert ist — sonst stottert der erste Satz.
    this.priming = true
    this.playing = false
    /** Puffer lief mitten im Satz leer; es wird neu angefüttert. */
    this.rebuffering = false
    /** Zähler der ausgegebenen Stille-Samples, seit der Puffer leer lief. */
    this.starving = 0

    /**
     * Lautstärke-Hüllkurve, 0 bis 1. Jeder Übergang — Anlauf, Loch, Rückkehr,
     * Barge-in — bewegt nur ihr Ziel; die Rampe selbst läuft in `process`.
     */
    this.env = 0
    this.envTarget = 0
    this.envStep = 1 / this.glideSamples

    this.pendingClear = false
    /** Beim Barge-in: so viele Samples werden nach dem Ausblenden verworfen. */
    this.dropPending = 0

    this.rmsAccum = 0
    this.rmsCount = 0

    this.port.onmessage = (event) => {
      const msg = event.data
      if (!msg) return

      if (msg.type === 'push') {
        this.write(msg.pcm)
      } else if (msg.type === 'flush') {
        this.beginFlush()
      } else if (msg.type === 'config') {
        if (typeof msg.jitterBufferMs === 'number') {
          this.jitterSamples = Math.round((msg.jitterBufferMs / 1000) * sampleRate)
        }
      }
    }
  }

  /**
   * Barge-in: ausblenden statt hart abschneiden.
   *
   * Verworfen wird genau das, was jetzt im Puffer liegt — nicht alles. Der
   * Unterschied zählt: Während der 40 ms Ausblendung trifft oft schon der
   * Anfang der nächsten Antwort ein, und ein pauschales Leeren hätte den
   * mitgenommen. Der Satz danach begann dann mitten im Wort.
   */
  beginFlush() {
    if (this.playing && this.available > 0) {
      this.dropPending = this.available
      this.pendingClear = true
      this.envTarget = 0
      this.envStep = 1 / Math.max(1, Math.min(this.fadeSamples, this.available))
    } else {
      this.clear()
    }
  }

  clear() {
    this.readIdx = 0
    this.writeIdx = 0
    this.available = 0
    this.priming = true
    this.playing = false
    this.rebuffering = false
    this.starving = 0
    this.env = 0
    this.envTarget = 0
    this.envStep = 1 / this.glideSamples
    this.pendingClear = false
    this.dropPending = 0
    this.port.postMessage({ type: 'cleared' })
  }

  /** Nach dem Ausblenden: das Verworfene überspringen, Neues stehen lassen. */
  finishFlush() {
    const len = this.ring.length
    const drop = Math.min(this.dropPending, this.available)
    this.readIdx = (this.readIdx + drop) % len
    this.available -= drop
    this.dropPending = 0
    this.pendingClear = false

    this.starving = 0
    this.env = 0
    this.envStep = 1 / this.glideSamples

    // Was jetzt noch dasteht, gehört schon zur nächsten Antwort. Die läuft
    // wie ein Neuanfang an, also über den Jitterpuffer statt sofort.
    this.playing = false
    this.priming = true
    this.rebuffering = false
    this.envTarget = 0
    this.port.postMessage({ type: 'cleared' })

    if (this.available >= this.jitterSamples) this.startPlaying()
  }

  startPlaying() {
    this.priming = false
    this.playing = true
    this.rebuffering = false
    this.starving = 0
    this.envTarget = 1
    this.envStep = 1 / this.glideSamples
    this.port.postMessage({ type: 'started' })
  }

  /** Int16 → Float32, in den Ring geschrieben. */
  write(pcm) {
    const ring = this.ring
    const len = ring.length
    const n = pcm.length

    // Sollte bei einer Minute Kapazität nicht mehr vorkommen. Wenn doch, ist
    // die Verzögerung ohnehin nicht mehr zu retten — dann lieber das Älteste
    // opfern als unbegrenzt nachhängen.
    if (this.available + n > len) {
      const drop = this.available + n - len
      this.readIdx = (this.readIdx + drop) % len
      this.available -= drop
      this.dropPending = Math.max(0, this.dropPending - drop)
    }

    for (let i = 0; i < n; i++) {
      const s = pcm[i]
      ring[this.writeIdx] = s < 0 ? s / 0x8000 : s / 0x7fff
      this.writeIdx = (this.writeIdx + 1) % len
    }
    this.available += n

    if (this.playing) {
      // Nach einem Loch nicht beim ersten Happen weiterlaufen, sondern erst
      // wenn wieder ein Polster dasteht. Ohne das wird aus einer Netzdelle
      // ein Stottern über den halben Satz.
      if (this.rebuffering && this.available >= Math.min(this.refillSamples, this.jitterSamples)) {
        this.rebuffering = false
        this.starving = 0
        this.envTarget = 1
      }
      return
    }

    if (this.priming && !this.pendingClear && this.available >= this.jitterSamples) {
      this.startPlaying()
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0]
    if (!output || output.length === 0) return true

    const frames = output[0].length
    const ring = this.ring
    const len = ring.length

    for (let i = 0; i < frames; i++) {
      // ── Hüllkurve einen Schritt weiter ─────────────────────
      if (this.env < this.envTarget) {
        this.env = Math.min(this.envTarget, this.env + this.envStep)
      } else if (this.env > this.envTarget) {
        this.env = Math.max(this.envTarget, this.env - this.envStep)
      }

      let sample = 0
      const draining = this.playing && !this.rebuffering

      if (draining && this.available > 0) {
        sample = ring[this.readIdx]
        this.readIdx = (this.readIdx + 1) % len
        this.available--
        this.starving = 0
        if (this.dropPending > 0) this.dropPending--
      } else if (this.playing) {
        // Unterlauf. Ausblenden statt springen, und erst wenn der Nachschub
        // wirklich ausbleibt, gilt der Satz als beendet.
        if (!this.rebuffering && !this.pendingClear) {
          this.rebuffering = true
          this.envTarget = 0
          this.envStep = 1 / this.glideSamples
        }
        this.starving++
        if (this.starving >= this.holdSamples) {
          this.playing = false
          this.rebuffering = false
          this.priming = true
          this.starving = 0
          this.env = 0
          this.envTarget = 0
          this.port.postMessage({ type: 'drained' })
        }
      }

      sample *= this.env

      // Das Ende einer Barge-in-Ausblendung: erst jetzt wird verworfen.
      if (this.pendingClear && this.env === 0 && this.envTarget === 0) {
        this.finishFlush()
      }

      // Mono auf alle Kanäle.
      for (let c = 0; c < output.length; c++) output[c][i] = sample

      this.rmsAccum += sample * sample
      this.rmsCount++
    }

    if (this.rmsCount >= sampleRate / 32) {
      this.port.postMessage({
        type: 'level',
        rms: Math.sqrt(this.rmsAccum / this.rmsCount),
        bufferedMs: (this.available / sampleRate) * 1000
      })
      this.rmsAccum = 0
      this.rmsCount = 0
    }

    return true
  }
}

registerProcessor('player-processor', PlayerProcessor)
