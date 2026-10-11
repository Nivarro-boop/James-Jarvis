/** Kurze lineare Überblendung zwischen unabhängig erzeugten PCM-Blöcken. */
export function smoothPcmBoundary(
  pcm: Int16Array,
  previousLast: number,
  samples = 72
): { pcm: Int16Array; last: number } {
  if (pcm.length === 0) return { pcm, last: previousLast }
  const out = pcm.slice()
  const count = Math.min(samples, out.length)
  for (let i = 0; i < count; i++) {
    const mix = (i + 1) / count
    out[i] = Math.round(previousLast * (1 - mix) + out[i] * mix)
  }
  return { pcm: out, last: out[out.length - 1] }
}
