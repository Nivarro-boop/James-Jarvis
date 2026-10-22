// Bewusst der reine WASM-Zweig und nicht das Sammelbündel: gebraucht wird
// hier nur der WASM-Ausführungspfad, die WebGPU-Fassung bringt eine doppelt
// so große Binärdatei mit (26,8 statt 13,5 MB) und nutzt hier nichts.
//
// Und bewusst nur als Typ: Die Laufzeit wird weiter unten per `import()`
// nachgeladen. Statisch eingebunden landete onnxruntime im selben Bündel wie
// der Kristall und wurde damit geparst, bevor das erste Bild stand — für eine
// Erkennung, die erst Sekunden später gebraucht wird und ohne die die App
// vollständig benutzbar bleibt. Der Kristall soll sofort da sein.
import type * as OrtNS from 'onnxruntime-web/wasm'
import type { IpcInvokeMap } from '@shared/ipc'
// Der Pfad zur Binärdatei muss von Hand gesetzt werden. Sonst sucht
// onnxruntime sie neben dem eigenen Bündel — und das liegt im
// Entwicklungsmodus in Vites Zwischenlager für Abhängigkeiten, wo keine
// .wasm-Datei steht. Ergebnis wäre "no available backend found", also gar
// keine Erkennung. Über `?url` nimmt Vite die Datei in beide Welten mit:
// Dev-Server wie fertiges Paket. Das ist nur die Adresse, nicht der Inhalt —
// die 13,5 MB werden erst geholt, wenn das Backend startet.

/** Mitgelieferte Weckwort-Modelle. Herkunft: scripts/wakeword-training/README.md. */
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import { asBytes, createOnce, errorText, hasBytes, loadError, modelSource, pageIsLocalFile } from './assets'

/**
 * Wake-Word-Erkennung "Hey James" — komplett offline.
 *
 * openWakeWord arbeitet dreistufig, und zwar aus gutem Grund: die ersten
 * beiden Stufen sind für alle Wake-Words identisch und teuer, die dritte ist
 * winzig und wortspezifisch. Deshalb laufen sie getrennt.
 *
 *   Audio (16 kHz)  →  melspectrogram  →  embedding  →  Klassifikator  →  Score
 *
 * Alle drei Modelle holt `npm run wakeword` nach `src/renderer/public/wakeword/`,
 * von wo aus sie unter `/wakeword/…` ausgeliefert werden. Fehlen sie, bleibt
 * die App voll benutzbar — nur eben über Hotkey und Klick statt per Zuruf.
 */

// Fenstergrößen aus dem openWakeWord-Referenzmodell. Nicht frei wählbar,
// die Modelle sind auf genau diese Formen trainiert.
const CHUNK_SAMPLES = 1280 // 80 ms bei 16 kHz
const MEL_FRAMES_PER_CHUNK = 8
const MEL_BINS = 32
const MEL_WINDOW = 76 // Frames, die das Embedding-Modell erwartet
const EMBED_DIM = 96
const EMBED_WINDOW = 16 // Embeddings, die der Klassifikator erwartet
/** So viele Blöcke am Stück dürfen scheitern, bevor die Erkennung aufgibt. */
const MAX_FAILURES = 5

export interface WakeWordHandle {
  /** 16-kHz-Int16-Blöcke; Größe egal, wird intern gepuffert. */
  feed(pcm: Int16Array): void
  setEnabled(enabled: boolean): void
  setThreshold(value: number): void
  readonly available: boolean
  destroy(): void
}

export interface WakeWordOptions {
  threshold: number
  /**
   * Der Klassifikator aus `./wakeword/`. Jede Datei erkennt ihr eigenes Wort;
   * die Mel- und Embedding-Vorstufen sind für alle gleich. Fehlt die Datei,
   * bleibt die Erkennung aus — die App läuft dann über Hotkey und Klick weiter.
   */
  modelName?: string
  /**
   * Ist das Weckwort eingeschaltet? Ist es aus, fehlt niemandem etwas, wenn
   * das Modell fehlt — das steht dann nur im Info-Protokoll und löst keine
   * Störung aus. Ohne Angabe gilt es als eingeschaltet.
   */
  enabled?: boolean
  onDetected(score: number): void
}

/** Jede Meldung dieses Moduls höchstens einmal je Fensterstart. */
const tell = createOnce((level, ...args) => {
  if (level === 'error') console.error(...args)
  else if (level === 'warn') console.warn(...args)
  else console.info(...args)
})

class RollingBuffer {
  private data: Float32Array
  private filled = 0

  constructor(
    private rows: number,
    private cols: number
  ) {
    this.data = new Float32Array(rows * cols)
  }

  push(frame: Float32Array): void {
    // Nach vorn schieben und hinten anhängen. Bei 76×32 Floats ist das
    // billig genug, um es 12-mal pro Sekunde zu machen.
    this.data.copyWithin(0, this.cols)
    this.data.set(frame, (this.rows - 1) * this.cols)
    if (this.filled < this.rows) this.filled++
  }

  get ready(): boolean {
    return this.filled >= this.rows
  }

  get raw(): Float32Array {
    return this.data
  }

  reset(): void {
    this.data.fill(0)
    this.filled = 0
  }
}

export async function createWakeWord(opts: WakeWordOptions): Promise<WakeWordHandle> {
  const inactive: WakeWordHandle = { available: false, feed() {}, setEnabled() {}, setThreshold() {}, destroy() {} }
  let assets: IpcInvokeMap['wake:status']['res']
  try {
    assets = await window.jarvis.invoke('wake:status')
  } catch (err) {
    // Ohne Auskunft aus dem Hauptprozess kein Weckwort — aber der Aufrufer
    // (Mikrofon, Klatschen, Hotkey) darf daran nicht scheitern.
    tell('warn', '[wakeword] Modelle nicht geladen — Status nicht lesbar:', errorText(err))
    return inactive
  }
  if (!assets.installed) {
    const missing = assets.missing.join(', ')
    if (opts.enabled === false) tell('info', '[wakeword] Weckwort ist aus, Modelldateien fehlen:', missing)
    else tell('warn', '[wakeword] Modelldateien fehlen:', missing)
    return inactive
  }
  let ort: typeof OrtNS | null = null
  let melModel: OrtNS.InferenceSession | null = null
  let embedModel: OrtNS.InferenceSession | null = null
  let wakeModel: OrtNS.InferenceSession | null = null
  let available = false
  let modelsReleased = false
  async function releaseModels(): Promise<void> {
    if (modelsReleased) return
    modelsReleased = true
    await Promise.all([melModel, embedModel, wakeModel].map(async (model) => {
      if (!model) return
      try { await model.release() } catch { /* Ressourcenfreigabe darf den eigentlichen Fehler nicht verdecken. */ }
    }))
  }

  try {
    // Hier wird onnxruntime tatsächlich geholt — ein eigenes Bündel, das
    // parallel zum schon sichtbaren Kristall über die Leitung geht.
    ort = await import('onnxruntime-web/wasm')

    // WASM-Backend: läuft überall, braucht keine GPU und stört die 3D-Szene
    // nicht. Ein Thread reicht — das Netz ist winzig.
    ort.env.wasm.numThreads = 1
    ort.env.wasm.simd = true

    // Im Fenster von file:// (fertiges Paket) scheitert jedes fetch, auch das
    // von onnxruntime für die WASM-Datei und die Modelle. Dort kommen die
    // Bytes über den Hauptprozess; nur der Dev-Server liefert Adressen aus.
    const files = {
      fromFile: pageIsLocalFile(),
      read: (name: string): Promise<unknown> => window.jarvis.invoke('wake:asset', { name })
    }
    if (files.fromFile) {
      const wasm = await files.read('runtime').catch(() => null)
      if (!hasBytes(wasm)) throw loadError('onnxruntime', new Error('WASM-Datei im Programmordner nicht lesbar'))
      ort.env.wasm.wasmBinary = asBytes(wasm)
    } else {
      ort.env.wasm.wasmPaths = { wasm: wasmUrl }
    }

    const runtime = ort
    const base = './wakeword'
    const options = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' } as const
    const load = async (name: string): Promise<OrtNS.InferenceSession> => {
      try {
        const source = await modelSource(name, `${base}/${name}`, files)
        // Zwei Aufrufe, weil die Überladungen von create() keine Vereinigung annehmen.
        return typeof source === 'string'
          ? await runtime.InferenceSession.create(source, options)
          : await runtime.InferenceSession.create(source, options)
      } catch (err) {
        // Mit dem Dateinamen: Ein bloßes "Failed to fetch" sagte nicht, welche
        // der drei Dateien es war.
        throw loadError(name, err)
      }
    }

    const loaded = await Promise.allSettled([
      load('melspectrogram.onnx'),
      load('embedding_model.onnx'),
      // Models must be supplied locally; no third-party classifier is downloaded here.
      load(assets.model || opts.modelName || 'hey_james.onnx')
    ])
    const failed = loaded.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) {
      await Promise.all(loaded.map(async (result) => {
        if (result.status !== 'fulfilled') return
        try { await result.value.release() } catch { /* Den Ladefehler beibehalten. */ }
      }))
      throw failed.reason
    }
    ;[melModel, embedModel, wakeModel] = loaded.map((result) => (result as PromiseFulfilledResult<OrtNS.InferenceSession>).value)
    available = true
  } catch (err) {
    await releaseModels()
    available = false
    // Einmal und laut: So steht im Protokoll, *welche* Datei woran scheiterte —
    // und die Selbstheilung bekommt einen Anlass, nicht fünf. Bei
    // ausgeschaltetem Weckwort nur leise: Es fehlt dann niemandem.
    tell(
      opts.enabled === false ? 'info' : 'warn',
      '[wakeword] Modelle nicht geladen — Wake-Word ist aus, Hotkey und Klick funktionieren weiter.',
      errorText(err)
    )
  }

  const pending: number[] = []
  // The reference front-end prepends 480 samples from the previous block.
  // Without that context the STFT yields fewer than eight complete frames.
  let overlap = new Float32Array(480)
  const melBuffer = new RollingBuffer(MEL_WINDOW, MEL_BINS)
  const embedBuffer = new RollingBuffer(EMBED_WINDOW, EMBED_DIM)

  let enabled = true
  let threshold = opts.threshold
  let busy = false
  let destroyed = false
  let failures = 0
  // Nach einer Erkennung kurz sperren, sonst feuert dasselbe "Hey James"
  // mehrfach, während es noch im Fenster steht.
  let cooldownUntil = 0

  async function processChunk(chunk: Float32Array): Promise<void> {
    // In eine Konstante geholt, weil `ort` erst nach dem Nachladen belegt ist:
    // Über ein `await` hinweg hilft eine Prüfung auf die veränderliche
    // Variable dem Typprüfer nicht weiter.
    const runtime = ort
    if (!runtime || !melModel || !embedModel || !wakeModel) return

    // ── Stufe 1: Mel-Spektrogramm ──────────────────────────
    const audio = new Float32Array(overlap.length + chunk.length)
    audio.set(overlap)
    audio.set(chunk, overlap.length)
    overlap = chunk.slice(-480)
    const melOut = await melModel.run({
      [melModel.inputNames[0]]: new runtime.Tensor('float32', audio, [1, audio.length])
    })
    const melData = melOut[melModel.outputNames[0]].data as Float32Array
    if (melData.length < MEL_FRAMES_PER_CHUNK * MEL_BINS) throw new Error('Weckwort-Vorstufe lieferte zu wenige Mel-Frames.')

    // Die Normierung stammt aus der openWakeWord-Referenz. Ohne sie liegt der
    // Wertebereich falsch und der Klassifikator feuert nie.
    for (let f = 0; f < MEL_FRAMES_PER_CHUNK; f++) {
      const frame = new Float32Array(MEL_BINS)
      for (let b = 0; b < MEL_BINS; b++) {
        frame[b] = melData[f * MEL_BINS + b] / 10 + 2
      }
      melBuffer.push(frame)
    }

    if (!melBuffer.ready) return

    // ── Stufe 2: Embedding ─────────────────────────────────
    const embedOut = await embedModel.run({
      [embedModel.inputNames[0]]: new runtime.Tensor('float32', melBuffer.raw, [
        1,
        MEL_WINDOW,
        MEL_BINS,
        1
      ])
    })
    const embedding = embedOut[embedModel.outputNames[0]].data as Float32Array
    embedBuffer.push(new Float32Array(embedding.subarray(0, EMBED_DIM)))

    if (!embedBuffer.ready) return

    // ── Stufe 3: Klassifikator ─────────────────────────────
    const wakeOut = await wakeModel.run({
      [wakeModel.inputNames[0]]: new runtime.Tensor('float32', embedBuffer.raw, [
        1,
        EMBED_WINDOW,
        EMBED_DIM
      ])
    })
    const score = (wakeOut[wakeModel.outputNames[0]].data as Float32Array)[0]

    if (score >= threshold && Date.now() > cooldownUntil) {
      cooldownUntil = Date.now() + 2000
      // Fenster leeren, sonst löst der Nachhall gleich nochmal aus.
      melBuffer.reset()
      embedBuffer.reset()
      opts.onDetected(score)
    }
  }

  /**
   * Sequenziell abarbeiten. Parallele Läufe würden die Reihenfolge der
   * Rolling-Buffer zerstören und die Erkennung unbrauchbar machen.
   */
  async function drain(): Promise<void> {
    if (busy || destroyed) return
    busy = true
    try {
      while (pending.length >= CHUNK_SAMPLES && enabled && !destroyed) {
        const chunk = new Float32Array(CHUNK_SAMPLES)
        for (let i = 0; i < CHUNK_SAMPLES; i++) {
          // openWakeWord's mel model accepts Float32 in Int16 amplitude units.
          chunk[i] = pending[i]
        }
        pending.splice(0, CHUNK_SAMPLES)
        await processChunk(chunk)
        failures = 0
      }
    } catch (err) {
      // Einmal melden, nicht zwölfmal pro Sekunde: Dieselbe Ursache schlägt
      // bei jedem 80-ms-Block wieder zu. Nach ein paar Fehlern am Stück gibt
      // die Erkennung auf — Hotkey und Klick bleiben, und die Selbstheilung
      // stellt auf Klatschen um.
      tell('error', '[wakeword] Erkennung fehlgeschlagen:', errorText(err))
      if (++failures >= MAX_FAILURES) {
        available = false
        pending.length = 0
        void releaseModels()
      }
    } finally {
      busy = false
    }
  }

  return {
    // Lesend am Zustand: Gibt die Erkennung nach wiederholten Fehlern auf
    // (siehe `drain`), soll auch `available` das zeigen — der Controller liest
    // es später wieder, etwa beim Einschalten des Weckworts.
    get available() {
      return available
    },
    feed(pcm) {
      if (!available || !enabled || destroyed) return
      for (let i = 0; i < pcm.length; i++) pending.push(pcm[i])
      // Rückstau begrenzen, falls die Inferenz mal nicht hinterherkommt.
      if (pending.length > CHUNK_SAMPLES * 20) {
        pending.splice(0, pending.length - CHUNK_SAMPLES * 10)
      }
      void drain()
    },
    setEnabled(value) {
      enabled = value
      if (!value) {
        overlap.fill(0)
        pending.length = 0
        melBuffer.reset()
        embedBuffer.reset()
      }
    },
    setThreshold(value) {
      threshold = value
    },
    destroy() {
      destroyed = true
      pending.length = 0
      void releaseModels()
    }
  }
}
