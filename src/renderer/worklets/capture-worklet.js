/**
 * Mikrofon-Aufnahme mit sauberem Resampling auf 16 kHz.
 *
 * Warum das aufwendiger ist als "jedes dritte Sample nehmen":
 * Der Audiograph läuft meist mit 48 kHz. Nimmt man einfach jedes dritte
 * Sample, faltet sich alles oberhalb von 8 kHz als Aliasing zurück ins
 * Sprachband — Zischlaute werden zu Rauschen, und die Erkennung bricht
 * hörbar ein. Deshalb erst tiefpassfiltern, dann dezimieren.
 *
 * Umgesetzt als windowed-sinc mit fraktionalem Leseoffset, damit auch
 * krumme Verhältnisse (44,1 kHz → 16 kHz) sauber laufen. Die Kernel-Tabelle
 * wird einmal beim Start berechnet; im Audio-Thread wird nur noch
 * multipliziert und addiert — dort darf nichts allokiert werden.
 */

const TARGET_RATE = 16000
const CHUNK_SAMPLES = 320 // 20 ms bei 16 kHz
const FILTER_HALF = 16 // 32 Taps insgesamt
const TABLE_RES = 128 // Stützstellen pro Eingangs-Sample

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()

    this.inRate = sampleRate
    this.ratio = TARGET_RATE / this.inRate

    // Grenzfrequenz auf die niedrigere der beiden Nyquist-Frequenzen.
    // Beim Hochtakten (selten) darf der Filter voll offen bleiben.
    this.cutoff = Math.min(1, this.ratio)

    this.kernel = this.buildKernel()

    // Historie: großzügig dimensioniert, damit auch bei Blockgrößen-Schwankungen
    // nie über den Rand gelesen wird.
    this.history = new Float32Array(4096)
    this.historyWrite = 0
    this.historyCount = 0

    // Leseposition in Eingangs-Samples, relativ zum ältesten Sample in `history`.
    this.readPos = FILTER_HALF

    this.outBuffer = new Int16Array(CHUNK_SAMPLES)
    this.outCount = 0

    this.rmsAccum = 0
    this.rmsCount = 0
    this.muted = false

    this.port.onmessage = (event) => {
      if (event.data?.type === 'mute') this.muted = Boolean(event.data.value)
    }
  }

  /** Blackman-gefensterte sinc-Kernel-Tabelle, symmetrisch um 0. */
  buildKernel() {
    const size = FILTER_HALF * TABLE_RES + 1
    const table = new Float32Array(size)
    for (let i = 0; i < size; i++) {
      const t = i / TABLE_RES // Abstand in Eingangs-Samples
      const x = this.cutoff * t
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
      // Blackman über [-FILTER_HALF, FILTER_HALF]
      const w = t / FILTER_HALF
      const window =
        w >= 1 ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * w) + 0.08 * Math.cos(2 * Math.PI * w)
      table[i] = this.cutoff * sinc * window
    }
    return table
  }

  /** Kernel-Wert bei beliebigem Abstand, linear zwischen Stützstellen interpoliert. */
  kernelAt(t) {
    const a = Math.abs(t) * TABLE_RES
    const i = a | 0
    if (i >= this.kernel.length - 1) return 0
    const frac = a - i
    return this.kernel[i] + (this.kernel[i + 1] - this.kernel[i]) * frac
  }

  pushInput(samples) {
    const h = this.history
    const len = h.length
    for (let i = 0; i < samples.length; i++) {
      h[this.historyWrite] = samples[i]
      this.historyWrite = (this.historyWrite + 1) % len
    }
    this.historyCount += samples.length
  }

  /** Absoluter Sample-Index → Position im Ringpuffer. */
  historyAt(absoluteIndex) {
    const len = this.history.length
    const oldest = this.historyCount - len
    if (absoluteIndex < oldest || absoluteIndex >= this.historyCount) return 0
    return this.history[((absoluteIndex % len) + len) % len]
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true

    // Nur der erste Kanal — die Live API will Mono.
    const channel = input[0]
    if (!channel) return true

    this.pushInput(channel)

    // Absolute Position des ersten Samples, das wir lesen dürfen.
    const step = this.inRate / TARGET_RATE
    const available = this.historyCount - FILTER_HALF

    while (this.readPos + FILTER_HALF < available) {
      const center = this.readPos
      const base = Math.floor(center)

      let sum = 0
      for (let k = -FILTER_HALF + 1; k <= FILTER_HALF; k++) {
        const idx = base + k
        const w = this.kernelAt(center - idx)
        if (w !== 0) sum += this.historyAt(idx) * w
      }

      // Clamping vor der Int16-Wandlung, sonst wrappt ein Übersteuerer
      // ins Negative und erzeugt ein lautes Knacken.
      const clamped = sum > 1 ? 1 : sum < -1 ? -1 : sum
      this.outBuffer[this.outCount++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff

      this.rmsAccum += clamped * clamped
      this.rmsCount++

      if (this.outCount === CHUNK_SAMPLES) {
        if (!this.muted) {
          // Kopie übertragen — der Puffer wird sofort weiterbeschrieben.
          const copy = new Int16Array(this.outBuffer)
          this.port.postMessage({ type: 'audio', pcm: copy }, [copy.buffer])
        }
        this.outCount = 0
      }

      this.readPos += step
    }

    // Pegel für den Kristall, ca. alle 30 ms.
    if (this.rmsCount >= TARGET_RATE / 32) {
      const rms = Math.sqrt(this.rmsAccum / this.rmsCount)
      this.port.postMessage({ type: 'level', rms })
      this.rmsAccum = 0
      this.rmsCount = 0
    }

    // readPos wächst sonst unbegrenzt und verliert irgendwann an Präzision.
    // Der Abzug muss ein Vielfaches der Puffergröße sein, sonst stimmt die
    // Modulo-Zuordnung in historyAt() nicht mehr und wir lesen Müll.
    if (this.historyCount > 1e9) {
      const len = this.history.length
      const drop = Math.floor((this.historyCount - len * 2) / len) * len
      if (drop > 0) {
        this.historyCount -= drop
        this.readPos -= drop
      }
    }

    return true
  }
}

registerProcessor('capture-processor', CaptureProcessor)
