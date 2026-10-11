/**
 * Mikrofon → 16-kHz-PCM, im Audio-Thread.
 *
 * Dieselbe Aufgabe wie `src/renderer/worklets/capture-worklet.js`, aber eigene
 * Datei: Der Renderer bündelt seine Worklets über Vite, diese hier wird roh
 * über den Companion-Server ausgeliefert und darf deshalb weder importieren
 * noch gebündelt werden.
 *
 * Heruntergerechnet wird linear. Ein ordentlicher Filter wäre sauberer, aber
 * das Gegenüber ist ein Spracherkenner, kein Mastering-Studio, und alles, was
 * hier an Rechenzeit hängen bleibt, geht auf einem Telefon direkt auf den Akku.
 */

const TARGET_RATE = 16000
/** 20 ms bei 16 kHz — dieselbe Blockgröße wie am Rechner. */
const FRAME = 320

class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(FRAME)
    this.filled = 0
    /** Bruchteil-Position im Eingang, damit zwischen den Blöcken nichts springt. */
    this.position = 0
    this.enabled = false

    this.port.onmessage = (event) => {
      if (event.data?.type === 'enable') {
        this.enabled = Boolean(event.data.value)
        if (!this.enabled) {
          this.filled = 0
          this.position = 0
        }
      }
    }
  }

  process(inputs) {
    const input = inputs[0]?.[0]
    if (!input || !this.enabled) return true

    const ratio = sampleRate / TARGET_RATE

    // Vom Ausgang her rechnen, nicht vom Eingang: So entsteht pro Block genau
    // die Zahl an Werten, die 16 kHz verlangt, und der Rest wandert über
    // `position` in den nächsten Aufruf.
    let pos = this.position
    while (pos < input.length) {
      const index = Math.floor(pos)
      const frac = pos - index
      const a = input[index]
      const b = index + 1 < input.length ? input[index + 1] : a
      this.buffer[this.filled++] = a + (b - a) * frac

      if (this.filled === FRAME) {
        const pcm = new Int16Array(FRAME)
        for (let i = 0; i < FRAME; i++) {
          const s = Math.max(-1, Math.min(1, this.buffer[i]))
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
        }
        this.port.postMessage(pcm, [pcm.buffer])
        this.filled = 0
      }
      pos += ratio
    }
    this.position = pos - input.length

    return true
  }
}

registerProcessor('mic-processor', MicProcessor)
