import playerWorkletUrl from '../worklets/player-worklet.js?url'
import type { AudioSettings } from '@shared/types'
import { AUDIO_CONSTANTS } from '@shared/config/defaults'
import { describeError } from '@shared/errorText'
import { amplitude } from '../store/crystalStore'

/**
 * Wiedergabe der Modell-Audio-Chunks.
 *
 * Der Kontext läuft mit 24 kHz — exakt der Ausgaberate der Live API. Damit
 * entfällt jedes Resampling; das Betriebssystem hebt intern auf die Rate der
 * Soundkarte an, und zwar mit einem besseren Filter als wir hier von Hand
 * bauen würden.
 *
 * Hinter dem Ringpuffer hängt eine kleine Klangkette: Hochpass, eine Senke in
 * den unteren Mitten, eine Präsenzglocke, eine Spur Luft, ein sanfter
 * Kompressor — und ganz am Ende eine Bremse, die sich nicht abschalten lässt.
 * Das ist kein Effekt um des Effekts willen: Auf Laptop- und
 * Schreibtischlautsprechern hebt es die Verständlichkeit spürbar, weil
 * Konsonanten sonst im Grundton untergehen, und die Bremse verhindert das
 * Zerren, das man sonst für einen Aussetzer hält.
 */

export interface PlayerHandle {
  push(pcm: Int16Array): void
  /** Barge-in: blendet in 40 ms aus und verwirft den Rest. */
  flush(): void
  setSettings(settings: AudioSettings): void
  isSpeaking(): boolean
  destroy(): Promise<void>
  onSpeakingChange?: (speaking: boolean) => void
}

export async function createPlayer(settings: AudioSettings): Promise<PlayerHandle> {
  const context = new AudioContext({
    sampleRate: AUDIO_CONSTANTS.OUTPUT_SAMPLE_RATE,
    latencyHint: 'interactive'
  })
  try {
  await context.audioWorklet.addModule(playerWorkletUrl)

  const node = new AudioWorkletNode(context, 'player-processor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {
      jitterBufferMs: settings.jitterBufferMs,
      fadeMs: AUDIO_CONSTANTS.BARGE_IN_FADE_MS
    }
  })

  // ── Klangkette ────────────────────────────────────────────
  // Leichter Hochpass gegen Rumpeln, das bei Sprache nur Headroom frisst.
  const highpass = context.createBiquadFilter()
  highpass.type = 'highpass'
  highpass.frequency.value = 85

  /**
   * Eine flache Senke in den unteren Mitten.
   *
   * Um 300 Hz herum sitzt bei fast jeder synthetischen Stimme zu viel
   * Energie — es klingt nach Pappkarton und deckt genau die Frequenzen zu, die
   * darüber die Silben tragen. Zwei, drei Dezibel weniger machen die Stimme
   * nicht dünner, sondern hörbar aufgeräumter.
   */
  const lowMid = context.createBiquadFilter()
  lowMid.type = 'peaking'
  lowMid.frequency.value = 320
  lowMid.Q.value = 0.9

  /**
   * Präsenz — und zwar als Glocke, nicht als Shelf.
   *
   * Hier sitzen die Konsonanten, die Verständlichkeit tragen. Ein Shelf ab
   * 3,2 kHz hob alles darüber gleichmäßig an, also auch das Zischen der
   * S-Laute und das Rauschen der Kompression. Eine Glocke um 2,9 kHz nimmt
   * die Silben mit und lässt den Rest, wo er war.
   */
  const presence = context.createBiquadFilter()
  presence.type = 'peaking'
  presence.frequency.value = 2900
  presence.Q.value = 0.85

  /** Eine Spur Luft ganz oben. Nimmt der Stimme das Dumpfe der 24 kHz. */
  const air = context.createBiquadFilter()
  air.type = 'highshelf'
  air.frequency.value = 9000

  // Sanfte Kompression — nur Spitzen abfangen, nicht plattbügeln.
  const compressor = context.createDynamicsCompressor()
  compressor.knee.value = 22
  compressor.attack.value = 0.004
  compressor.release.value = 0.18

  const gain = context.createGain()
  gain.gain.value = settings.outputGain

  /**
   * Die Bremse ganz am Ende, und sie ist nicht abschaltbar.
   *
   * Präsenzanhebung und Lautstärkeregler multiplizieren sich: Steht der Regler
   * auf Anschlag und die Anhebung bei sechs Dezibel, verlässt das Signal die
   * Kette weit über eins. Was darüber liegt, kappt die Soundkarte hart — und
   * hartes Kappen klingt nach kaputter Verbindung, nicht nach zu laut. Genau
   * dieses Zerren wird gern für einen Aussetzer gehalten.
   */
  const limiter = context.createDynamicsCompressor()
  limiter.threshold.value = -1.5
  limiter.knee.value = 0
  limiter.ratio.value = 20
  limiter.attack.value = 0.001
  limiter.release.value = 0.1

  /**
   * Der Kompressor hängt fest in der Kette und wird über seine Parameter
   * stillgelegt statt umgesteckt. Ein Umbau des Graphen im laufenden Betrieb
   * erzeugt genau an der Stelle ein Knacken, an der man ihn braucht.
   */
  const applyCompressor = (enabled: boolean): void => {
    compressor.threshold.value = enabled ? -20 : 0
    compressor.ratio.value = enabled ? 3 : 1
  }
  applyCompressor(settings.outputCompressorEnabled)

  /** Dieselbe Begründung: die Entzerrung wird flachgelegt, nicht ausgehängt. */
  const applyEq = (enabled: boolean, presenceDb: number): void => {
    presence.gain.value = enabled ? presenceDb : 0
    lowMid.gain.value = enabled ? -2.5 : 0
    air.gain.value = enabled ? 1.5 : 0
  }
  applyEq(settings.outputEqEnabled, settings.outputHighShelfGainDb)

  node.connect(highpass)
  highpass.connect(lowMid)
  lowMid.connect(presence)
  presence.connect(air)
  air.connect(compressor)
  compressor.connect(gain)
  gain.connect(limiter)
  limiter.connect(context.destination)

  // Ausgabegerät, falls eines gewählt wurde. Ältere Chromium-Stände kennen
  // setSinkId am Kontext noch nicht — dann bleibt es beim Systemstandard.
  const applySink = (deviceId: string | null): void => {
    const sinkable = context as AudioContext & { setSinkId?: (id: string) => Promise<void> }
    if (typeof sinkable.setSinkId !== 'function') return
    void sinkable.setSinkId(deviceId ?? '').catch((err) => {
      // Als Text: ein DOMException-Objekt landet im Protokoll als „[object DOMException]“.
      console.warn('[player] Ausgabegerät nicht setzbar:', describeError(err))
    })
  }
  applySink(settings.outputDeviceId)

  let speaking = false
  let destroyed = false
  let currentSink = settings.outputDeviceId

  const handle: PlayerHandle = {
    push(pcm) {
      if (destroyed) return
      const copy = new Int16Array(pcm)
      node.port.postMessage({ type: 'push', pcm: copy }, [copy.buffer])
    },
    flush() {
      if (destroyed) return
      node.port.postMessage({ type: 'flush' })
    },
    setSettings(next) {
      if (destroyed) return
      applyEq(next.outputEqEnabled, next.outputHighShelfGainDb)
      gain.gain.value = next.outputGain
      applyCompressor(next.outputCompressorEnabled)
      node.port.postMessage({ type: 'config', jitterBufferMs: next.jitterBufferMs })
      if (next.outputDeviceId !== currentSink) {
        currentSink = next.outputDeviceId
        applySink(currentSink)
      }
    },
    isSpeaking() {
      return speaking
    },
    async destroy() {
      if (destroyed) return
      destroyed = true
      node.port.onmessage = null
      try {
        node.disconnect()
        gain.disconnect()
      } catch {
        // Kann bereits abgebaut sein.
      }
      await context.close()
      amplitude.output = 0
    }
  }

  node.port.onmessage = (event: MessageEvent): void => {
    const msg = event.data
    if (!msg) return

    if (msg.type === 'level') {
      amplitude.output = Math.min(1, Math.sqrt(msg.rms as number) * 2.4)
      return
    }

    const wasSpeaking = speaking
    if (msg.type === 'started') speaking = true
    if (msg.type === 'drained' || msg.type === 'cleared') {
      speaking = false
      amplitude.output = 0
    }
    if (wasSpeaking !== speaking) handle.onSpeakingChange?.(speaking)
  }

  if (context.state === 'suspended') await context.resume()
  return handle
  } catch (error) {
    await context.close().catch(() => {})
    throw error
  }
}
