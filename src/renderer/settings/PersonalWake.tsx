import { useRef, useState, type JSX } from 'react'
import type { Settings } from '@shared/types'
import { createWakeWord, PERSONAL_MODEL, sequenceSimilarity } from '../wake/wakeword'

const RATE = 16000
const CHUNK = 1280
const TAKES = 3
const TAKE_MS = 2000
/** Stille vor jeder Aufnahme, damit die Vorstufen ihr Fenster gefüllt haben. */
const PAD_CHUNKS = 18

/** Nimmt `ms` Millisekunden Mikrofon in 16 kHz auf, Werte in Int16-Einheiten. */
async function record(ms: number, deviceId?: string): Promise<Float32Array> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true, channelCount: 1 }
  })
  const ctx = new AudioContext({ sampleRate: RATE })
  const source = ctx.createMediaStreamSource(stream)
  const node = ctx.createScriptProcessor(4096, 1, 1)
  const parts: Float32Array[] = []
  node.onaudioprocess = e => parts.push(new Float32Array(e.inputBuffer.getChannelData(0)))
  source.connect(node)
  node.connect(ctx.destination)
  await new Promise(r => setTimeout(r, ms))
  node.disconnect(); source.disconnect()
  stream.getTracks().forEach(t => t.stop())
  await ctx.close()
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  for (let i = 0; i < out.length; i++) out[i] *= 32767
  return out
}

/** Erster und letzter Block mit Sprache, über die Lautstärke je 80 ms. */
function voicedSpan(pcm: Float32Array): { start: number; end: number } | null {
  const rms: number[] = []
  for (let c = 0; c + CHUNK <= pcm.length; c += CHUNK) {
    let s = 0
    for (let i = c; i < c + CHUNK; i++) s += pcm[i] * pcm[i]
    rms.push(Math.sqrt(s / CHUNK))
  }
  const sorted = [...rms].sort((a, b) => a - b)
  const floor = sorted[Math.floor(sorted.length * 0.2)] || 1
  const peak = sorted[sorted.length - 1] || 0
  if (peak < 600 || peak < floor * 3) return null
  const limit = Math.max(floor * 2.5, peak * 0.18)
  const start = rms.findIndex(v => v >= limit)
  let end = rms.length - 1
  while (end > start && rms[end] < limit) end--
  return start < 0 ? null : { start, end }
}

/**
 * Eigenes Weckwort in drei Aufnahmen einlernen, ganz lokal.
 */
export function PersonalWakeTrainer({ settings, patch, onDone }: {
  settings: Settings
  patch: (p: Partial<Settings>) => Promise<Settings>
  onDone?: () => void
}): JSX.Element {
  const [phrase, setPhrase] = useState('Hey James')
  const [takes, setTakes] = useState<Float32Array[]>([])
  const [state, setState] = useState<'idle' | 'recording' | 'learning' | 'testing'>('idle')
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const testStop = useRef<(() => void) | null>(null)

  const take = async (): Promise<void> => {
    setNote(null)
    setState('recording')
    try {
      const pcm = await record(TAKE_MS, settings.audio?.inputDeviceId || undefined)
      if (!voicedSpan(pcm)) {
        setNote({ ok: false, text: 'Nichts gehört. Etwas lauter und näher ans Mikrofon.' })
      } else {
        setTakes(t => [...t, pcm])
      }
    } catch {
      setNote({ ok: false, text: 'Mikrofon nicht verfügbar. Unter Mikrofon & Lautsprecher prüfen.' })
    } finally { setState('idle') }
  }

  const learn = async (): Promise<void> => {
    setState('learning')
    setNote(null)
    try {
      const seen: { n: number; v: Float32Array }[] = []
      const wake = await createWakeWord({ threshold: 0, captureOnly: true, onDetected() {}, onEmbedding: (v, n) => seen.push({ n, v }) })
      if (!wake.available) throw new Error('Die Weckwort-Vorstufen fehlen in dieser Fassung.')
      const spans = takes.map(voicedSpan)
      const words = spans.map(s => (s ? s.end - s.start + 1 : 0))
      const frames = Math.min(16, Math.max(6, Math.max(...words) + 2))
      const templates: number[][][] = []
      for (let i = 0; i < takes.length; i++) {
        const span = spans[i]
        if (!span) continue
        wake.setEnabled(false); wake.setEnabled(true)
        const before = seen.length ? seen[seen.length - 1].n : 0
        const padded = new Float32Array(PAD_CHUNKS * CHUNK + takes[i].length)
        padded.set(takes[i], PAD_CHUNKS * CHUNK)
        await wake.analyze(padded)
        const endChunk = before + PAD_CHUNKS + span.end + 1
        const rows = seen.filter(e => e.n > endChunk - frames && e.n <= endChunk).map(e => Array.from(e.v))
        if (rows.length === frames) templates.push(rows)
      }
      // Wie weit liegt Stille von den Mustern weg? Die Schwelle muss darüber liegen.
      wake.setEnabled(false); wake.setEnabled(true)
      const quietFrom = seen.length ? seen[seen.length - 1].n : 0
      await wake.analyze(new Float32Array((PAD_CHUNKS + frames) * CHUNK).map(() => (Math.random() - 0.5) * 60))
      const quiet = seen.filter(e => e.n > quietFrom).slice(-frames).map(e => Array.from(e.v))
      wake.destroy()
      if (templates.length < 2) throw new Error('Zu wenig Sprache erkannt. Bitte neu aufnehmen.')
      const pairs: number[] = []
      for (let a = 0; a < templates.length; a++) for (let b = a + 1; b < templates.length; b++) pairs.push(sequenceSimilarity(templates[a], templates[b]))
      const together = pairs.reduce((s, v) => s + v, 0) / pairs.length
      const silence = quiet.length ? Math.max(...templates.map(t => sequenceSimilarity(quiet, t))) : 0
      const threshold = Math.min(0.92, Math.max(0.55, together - 0.07, silence + 0.08))
      const saved = await window.jarvis.invoke('wake:personalSave', { phrase: phrase.trim() || 'Hey James', templates, threshold })
      if (!saved.ok) throw new Error(saved.error)
      await patch({ wake: { ...settings.wake, enabled: true, modelName: PERSONAL_MODEL } })
      setNote({ ok: true, text: `Gelernt. Sag jetzt „${phrase.trim()}“ zum Testen.` })
      setTakes([])
      void test()
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : 'Einlernen fehlgeschlagen.' })
      setState('idle')
    }
  }

  const test = async (): Promise<void> => {
    setState('testing')
    let detected = false
    const wake = await createWakeWord({ threshold: 0.5, onDetected: () => { detected = true; stop() } })
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } })
    const ctx = new AudioContext({ sampleRate: RATE })
    const source = ctx.createMediaStreamSource(stream)
    const node = ctx.createScriptProcessor(2048, 1, 1)
    node.onaudioprocess = e => {
      const f = e.inputBuffer.getChannelData(0)
      const pcm = new Int16Array(f.length)
      for (let i = 0; i < f.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, f[i] * 32767))
      wake.feed(pcm)
    }
    source.connect(node); node.connect(ctx.destination)
    const timer = window.setTimeout(() => stop(), 10000)
    function stop(): void {
      window.clearTimeout(timer)
      node.disconnect(); source.disconnect(); stream.getTracks().forEach(t => t.stop()); void ctx.close(); wake.destroy()
      testStop.current = null
      setState('idle')
      setNote(detected
        ? { ok: true, text: 'Erkannt ✓ James hört jetzt auf dein Wort.' }
        : { ok: false, text: 'Nicht erkannt. Nochmal testen oder neu einsprechen.' })
      if (detected) onDone?.()
    }
    testStop.current = stop
  }

  const busy = state !== 'idle'
  return (
    <div className="wake-trainer">
      <label className="setup-note">Dein Weckwort
        <input value={phrase} maxLength={40} disabled={busy} onChange={e => setPhrase(e.target.value)} placeholder="z. B. Hey James" />
      </label>
      <div className="wake-takes" aria-label="Aufnahmen">
        {Array.from({ length: TAKES }, (_, i) => <span key={i} className={i < takes.length ? 'is-done' : ''}>{i < takes.length ? '✓' : i + 1}</span>)}
      </div>
      {takes.length < TAKES ? (
        <button className="primary" disabled={busy} onClick={() => void take()}>
          {state === 'recording' ? 'Sprich jetzt …' : `„${phrase.trim() || 'Hey James'}“ sagen (${takes.length + 1}/${TAKES})`}
        </button>
      ) : (
        <button className="primary" disabled={busy} onClick={() => void learn()}>{state === 'learning' ? 'Lernt …' : 'Einlernen'}</button>
      )}
      {state === 'testing' && <p className="setup-note" role="status">Hört zu … sag „{phrase.trim()}“.</p>}
      {state === 'idle' && settings.wake.modelName === PERSONAL_MODEL && <button onClick={() => void test()}>Testen</button>}
      {takes.length > 0 && !busy && <button onClick={() => setTakes([])}>Neu beginnen</button>}
      {note && <p role="status" className={note.ok ? 'setup-note ok' : 'setup-note err'}>{note.text}</p>}
    </div>
  )
}
