/**
 * Audio zwischen Telefonnetz und Live-API umrechnen.
 *
 * Die beiden Seiten sprechen nicht dieselbe Sprache, und zwar in drei
 * Punkten gleichzeitig:
 *
 *   Twilio Media Streams   G.711 µ-law, 8000 Hz, 8 bit, mono
 *   Live-API Eingang       PCM, 16000 Hz, 16 bit little-endian, mono
 *   Live-API Ausgang       PCM, 24000 Hz, 16 bit little-endian, mono
 *
 * µ-law ist eine logarithmische Kennlinie aus den Sechzigern: acht Bit, die
 * den Dynamikumfang von rund vierzehn abdecken, weil das Ohr leise Stellen
 * feiner auflöst als laute. Die Umrechnung ist deshalb keine Skalierung
 * sondern eine Tabelle — und weil sie pro Anruf fünfzigmal in der Sekunde
 * läuft, steht sie hier als vorberechnetes Feld statt als Formel.
 */

/** 20-ms-Rahmen bei 8 kHz — die Paketgröße, in der Twilio sendet und erwartet. */
export const TWILIO_FRAME_BYTES = 160

const MU_LAW_BIAS = 0x84
const MU_LAW_CLIP = 32635

/**
 * µ-law → linear, als Tabelle über alle 256 möglichen Bytes.
 *
 * Der Dekodierschritt ist billig genug, um ihn zu rechnen; die Tabelle spart
 * trotzdem bei jedem einzelnen Abtastwert eine Handvoll Verzweigungen, und
 * davon gibt es bei einem Zehnminutengespräch knapp fünf Millionen.
 */
const MU_LAW_TO_PCM = new Int16Array(256)
for (let i = 0; i < 256; i++) {
  const inverted = ~i & 0xff
  const sign = inverted & 0x80
  const exponent = (inverted >> 4) & 0x07
  const mantissa = inverted & 0x0f
  let sample = ((mantissa << 3) + MU_LAW_BIAS) << exponent
  sample -= MU_LAW_BIAS
  MU_LAW_TO_PCM[i] = sign ? -sample : sample
}

/**
 * linear → µ-law.
 *
 * Andersherum lohnt keine Tabelle über 65536 Einträge; der Exponent lässt
 * sich in ein paar Schritten finden.
 */
function pcmToMuLaw(sample: number): number {
  let value = sample
  const sign = value < 0 ? 0x80 : 0x00
  if (value < 0) value = -value
  if (value > MU_LAW_CLIP) value = MU_LAW_CLIP
  value += MU_LAW_BIAS

  let exponent = 7
  for (let mask = 0x4000; (value & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {
    // Höchstes gesetztes Bit suchen — das ist der Exponent.
  }

  const mantissa = (value >> (exponent + 3)) & 0x0f
  return ~(sign | (exponent << 4) | mantissa) & 0xff
}

/** Ein µ-law-Paket vom Telefon in lineare 8-kHz-Abtastwerte. */
export function muLawToPcm8k(muLaw: Buffer): Int16Array {
  const out = new Int16Array(muLaw.length)
  for (let i = 0; i < muLaw.length; i++) out[i] = MU_LAW_TO_PCM[muLaw[i]]
  return out
}

/** Lineare 8-kHz-Abtastwerte zurück ins Telefonformat. */
export function pcm8kToMuLaw(pcm: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(pcm.length)
  for (let i = 0; i < pcm.length; i++) out[i] = pcmToMuLaw(pcm[i])
  return out
}

/**
 * 8 kHz → 16 kHz, für den Weg zur Live-API.
 *
 * Verdoppeln heißt: zwischen je zwei Werten einen dritten einsetzen. Linear
 * interpoliert statt schlicht wiederholt — Wiederholen erzeugt eine
 * Treppenkurve, deren Kanten als Rauschen oberhalb von 4 kHz landen, also
 * genau dort, wo vorher nichts war und wo das Modell sonst nichts erwartet.
 *
 * Der letzte Wert des vorigen Pakets wird mitgegeben, damit an der Naht
 * zwischen zwei Paketen nicht alle zwanzig Millisekunden ein Knacken sitzt.
 */
export function upsample8kTo16k(pcm: Int16Array, previousLast = 0): { out: Int16Array; last: number } {
  const out = new Int16Array(pcm.length * 2)
  let prev = previousLast
  for (let i = 0; i < pcm.length; i++) {
    const current = pcm[i]
    out[i * 2] = (prev + current) >> 1
    out[i * 2 + 1] = current
    prev = current
  }
  return { out, last: prev }
}

/**
 * 24 kHz → 8 kHz, für den Weg zum Telefon.
 *
 * Jeder dritte Wert allein wäre falsch: alles zwischen 4 und 12 kHz — bei
 * einer Stimme ist da reichlich — klappt beim Unterabtasten in den hörbaren
 * Bereich zurück und klingt als metallisches Zischeln. Deshalb erst mitteln,
 * dann ausdünnen. Der gleitende Dreier-Mittelwert ist ein grober Tiefpass,
 * aber für eine Telefonleitung, die ohnehin bei 3,4 kHz endet, genügt er.
 */
const DOWNSAMPLE_TAPS = 15

/**
 * Tiefpass für Telefonbandbreite, per Fenster-Sinc erzeugt.
 * 3,4 kHz bleiben erhalten; Frequenzen darüber werden vor dem Ausdünnen
 * gedämpft, damit Zischlaute nicht metallisch in den Hörbereich zurückfalten.
 */
const DOWNSAMPLE_FILTER = (() => {
  const coefficients = new Float64Array(DOWNSAMPLE_TAPS)
  const middle = (DOWNSAMPLE_TAPS - 1) / 2
  const cutoff = 3400 / 24000
  let sum = 0
  for (let i = 0; i < DOWNSAMPLE_TAPS; i++) {
    const x = i - middle
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x)
    const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (DOWNSAMPLE_TAPS - 1))
    coefficients[i] = sinc * hamming
    sum += coefficients[i]
  }
  for (let i = 0; i < coefficients.length; i++) coefficients[i] /= sum
  return coefficients
})()

/** Zustandsbehafteter 24→8-kHz-Abtaster, der Paketgrenzen verlustfrei überbrückt. */
export class Downsampler24kTo8k {
  private history = new Float64Array(DOWNSAMPLE_TAPS)
  private position = 0
  private phase = 0

  push(pcm: Int16Array): Int16Array {
    if (pcm.length === 0) return new Int16Array(0)
    const result: number[] = []

    for (let i = 0; i < pcm.length; i++) {
      this.history[this.position] = pcm[i]
      this.position = (this.position + 1) % DOWNSAMPLE_TAPS
      this.phase++
      if (this.phase < 3) continue
      this.phase = 0

      let value = 0
      let index = this.position
      for (let tap = 0; tap < DOWNSAMPLE_TAPS; tap++) {
        index = (index - 1 + DOWNSAMPLE_TAPS) % DOWNSAMPLE_TAPS
        value += this.history[index] * DOWNSAMPLE_FILTER[tap]
      }
      result.push(Math.max(-32768, Math.min(32767, Math.round(value))))
    }

    return Int16Array.from(result)
  }

  reset(): void {
    this.history.fill(0)
    this.position = 0
    this.phase = 0
  }
}

/** Ein einzelner vollständiger Block; für fortlaufende Streams die Klasse verwenden. */
export function downsample24kTo8k(pcm: Int16Array): Int16Array {
  return new Downsampler24kTo8k().push(pcm)
}

/** Rohe Bytes als 16-bit little-endian lesen — so liefert die Live-API. */
export function bytesToPcm(buffer: Buffer): Int16Array {
  const count = buffer.length >> 1
  const out = new Int16Array(count)
  for (let i = 0; i < count; i++) out[i] = buffer.readInt16LE(i * 2)
  return out
}

/** Und zurück, für den Weg zur Live-API. */
export function pcmToBytes(pcm: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(pcm.length * 2)
  for (let i = 0; i < pcm.length; i++) out.writeInt16LE(pcm[i], i * 2)
  return out
}

/**
 * Ausgabepuffer mit Taktgeber.
 *
 * Die Live-API schickt eine Antwort viel schneller, als sie gesprochen wird —
 * ein Satz von fünf Sekunden kommt in einem knappen Schwung an. Twilio nimmt
 * das zwar entgegen, aber ein Barge-in wäre damit wirkungslos: Was einmal
 * abgeschickt ist, lässt sich nicht zurückholen, und James redete noch
 * Sekunden weiter, nachdem der Angerufene ihn unterbrochen hat.
 *
 * Deshalb wird hier gestaut und in 20-ms-Rahmen ausgegeben, im Takt der
 * Uhr. `clear()` wirft weg, was noch nicht draußen ist — das ist das
 * Barge-in.
 */
export class OutboundPacer {
  private queue: Int16Array[] = []
  private headOffset = 0
  private queuedSamples = 0
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly send: (frame: Buffer) => void) {}

  /** Lineare 8-kHz-Abtastwerte einreihen. */
  push(pcm: Int16Array): void {
    if (pcm.length === 0) return
    this.queue.push(pcm.slice())
    this.queuedSamples += pcm.length
    this.start()
  }

  private start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), 20)
  }

  private tick(): void {
    if (this.queuedSamples === 0) {
      // Nichts mehr da: Takt anhalten, statt alle zwanzig Millisekunden
      // Stille zu verschicken. Twilio braucht keinen Trägerstrom.
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      return
    }
    const take = Math.min(TWILIO_FRAME_BYTES, this.queuedSamples)
    const chunk = new Int16Array(TWILIO_FRAME_BYTES)
    let written = 0
    while (written < take && this.queue.length > 0) {
      const head = this.queue[0]
      const available = head.length - this.headOffset
      const amount = Math.min(available, take - written)
      chunk.set(head.subarray(this.headOffset, this.headOffset + amount), written)
      written += amount
      this.headOffset += amount
      if (this.headOffset >= head.length) {
        this.queue.shift()
        this.headOffset = 0
      }
    }
    // Ein angebrochener Rahmen wird mit Stille aufgefüllt, nicht verkürzt —
    // Twilio erwartet gleich lange Pakete.
    this.queuedSamples -= written
    this.send(pcm8kToMuLaw(chunk))
  }

  /** Barge-in: alles wegwerfen, was noch nicht auf der Leitung ist. */
  clear(): void {
    this.queue = []
    this.headOffset = 0
    this.queuedSamples = 0
  }

  /** Wie viele Millisekunden noch im Puffer stehen. */
  pendingMs(): number {
    return (this.queuedSamples / 8000) * 1000
  }

  stop(): void {
    this.clear()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
