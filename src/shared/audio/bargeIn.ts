/** Holds the user's first syllables while the speaker upload gate is closed. Input is 16 kHz. */
export class BargeInDetector {
  private frames: Int16Array[] = []
  private loudMs = 0
  reset(): void { this.frames = []; this.loudMs = 0 }
  feed(pcm: Int16Array, level: number, threshold: number): Int16Array[] | null {
    this.frames.push(pcm)
    if (this.frames.length > 15) this.frames.shift()
    this.loudMs = level >= threshold ? this.loudMs + pcm.length / 16 : 0
    if (this.loudMs < 160) return null
    const speech = this.frames
    this.reset()
    return speech
  }
}
