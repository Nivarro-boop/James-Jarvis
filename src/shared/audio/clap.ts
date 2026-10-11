/**
 * Zweimal Klatschen als Weckruf — ohne Modell, ohne Netz.
 *
 * Ein Klatschen ist ein kurzer, harter Knall: Der Pegel springt binnen weniger
 * Millisekunden weit über das Grundrauschen und ist nach gut 100 ms wieder
 * unten. Sprache steigt langsamer an und bleibt länger laut; deshalb zählt nur,
 * was steil kommt und schnell vergeht. Erst zwei solche Knalle im Abstand von
 * 120 bis 800 ms wecken James — ein einzelner Schlag auf den Tisch nicht.
 */

const FRAME = 160 // 10 ms bei 16 kHz
const MIN_PEAK = 0.12
const ONSET_RATIO = 4
const MAX_CLAP_MS = 140
const MIN_GAP_MS = 120
const MAX_GAP_MS = 800
const COOLDOWN_MS = 2000

export class ClapDetector {
  private floor = 0.003
  private pending: number[] = []
  private time = 0
  private clapStart = -1
  private lastClap = -Infinity
  private cooldownUntil = 0
  private sustained = false

  constructor(private readonly onDoubleClap: () => void) {}

  /** 16-kHz-Int16-Blöcke beliebiger Größe. */
  feed(pcm: Int16Array): void {
    for (let i = 0; i < pcm.length; i++) this.pending.push(pcm[i])
    let consumed = 0
    while (this.pending.length - consumed >= FRAME) {
      const frame = this.pending.slice(consumed, consumed + FRAME)
      consumed += FRAME
      this.frame(frame)
      this.time += 10
    }
    if (consumed) this.pending.splice(0, consumed)
  }

  reset(): void {
    this.pending.length = 0
    this.clapStart = -1
    this.lastClap = -Infinity
    this.floor = 0.003
    this.time = 0
    this.cooldownUntil = 0
    this.sustained = false
  }

  private frame(samples: number[]): void {
    let peak = 0
    let sum = 0
    for (const s of samples) {
      const v = Math.abs(s) / 0x8000
      if (v > peak) peak = v
      sum += v * v
    }
    const rms = Math.sqrt(sum / samples.length)
    if (this.sustained) {
      if (rms < this.floor * 3) this.sustained = false
      return
    }

    if (this.clapStart < 0) {
      if (peak >= MIN_PEAK && rms > this.floor * ONSET_RATIO) {
        this.clapStart = this.time
        return
      }
      // Grundrauschen nur außerhalb eines Knalls nachführen, langsam.
      this.floor = Math.max(0.002, this.floor * 0.98 + rms * 0.02)
      return
    }

    const length = this.time - this.clapStart
    if (rms < this.floor * 3) {
      this.clapStart = -1
      this.clap(this.time - length)
    } else if (length > MAX_CLAP_MS) {
      // Zu lang für ein Klatschen: Sprache, Musik, ein Stuhl.
      this.clapStart = -1
      this.lastClap = -Infinity
      this.sustained = true
    }
  }

  private clap(at: number): void {
    if (at < this.cooldownUntil) return
    const gap = at - this.lastClap
    if (gap >= MIN_GAP_MS && gap <= MAX_GAP_MS) {
      this.lastClap = -Infinity
      this.cooldownUntil = at + COOLDOWN_MS
      this.onDoubleClap()
      return
    }
    this.lastClap = at
  }
}
