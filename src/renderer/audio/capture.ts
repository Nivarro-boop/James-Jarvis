import captureWorkletUrl from '../worklets/capture-worklet.js?url'
import type { AudioSettings } from '@shared/types'
import { amplitude } from '../store/crystalStore'

/**
 * Mikrofonaufnahme.
 *
 * Die drei Constraints unten sind der Unterschied zwischen "funktioniert" und
 * "unbenutzbar". Ohne `echoCancellation` nimmt das Mikrofon James' eigene
 * Ausgabe auf, das serverseitige VAD hält das für Sprache, und er unterbricht
 * sich in einer Endlosschleife.
 */

export interface CaptureHandle {
  stop(): Promise<void>
  setMuted(muted: boolean): void
  readonly context: AudioContext
  readonly stream: MediaStream
}

export interface CaptureOptions {
  settings: AudioSettings
  /** 20-ms-PCM-Blöcke bei 16 kHz. */
  onChunk(pcm: Int16Array): void
}

export async function startCapture(opts: CaptureOptions): Promise<CaptureHandle> {
  const { settings } = opts

  const constraints = (deviceId: string): MediaStreamConstraints => ({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl,
      channelCount: 1
    },
    video: false
  })

  /*
   * Geräte-Kennungen gelten nur für den Ursprung, der sie gesehen hat. Die
   * Entwicklerfassung (localhost) und die installierte (file://) teilen sich
   * die Einstellungen, aber nicht die Kennungen — die gespeicherte passte dann
   * auf kein Gerät, getUserMedia warf einen OverconstrainedError ohne Text,
   * und James blieb taub. Ebenso nach dem Abstecken eines Headsets. Dann das
   * Standardgerät nehmen statt gar keins.
   */
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints(settings.inputDeviceId ?? ''))
  } catch (err) {
    const name = (err as { name?: string })?.name ?? ''
    if (!settings.inputDeviceId || !['OverconstrainedError', 'NotFoundError'].includes(name)) {
      throw new Error(`${name || 'Fehler'}: ${(err as Error)?.message || 'kein Mikrofon'}`)
    }
    console.warn('[capture] Gewähltes Mikrofon nicht gefunden, nehme das Standardgerät.')
    stream = await navigator.mediaDevices.getUserMedia(constraints(''))
    // Die tote Kennung vergessen, sonst schlägt jeder Start erst einmal fehl
    // und die Einstellungen zeigen ein Gerät, das es nicht gibt.
    void window.jarvis.invoke('settings:set', { audio: { ...settings, inputDeviceId: null } })
  }

  // Kein erzwungener sampleRate: der Kontext übernimmt die native Rate des
  // Geräts. Erzwingt man 16 kHz, schaltet Chromium bei manchen Interfaces die
  // Echounterdrückung ab — genau das, was wir am dringendsten brauchen.
  let cleanupContext: AudioContext | null = null
  try {
  const context = new AudioContext({ latencyHint: 'interactive' })
  cleanupContext = context
  await context.audioWorklet.addModule(captureWorkletUrl)

  const source = context.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(context, 'capture-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
    channelCountMode: 'explicit'
  })

  node.port.onmessage = (event: MessageEvent): void => {
    const msg = event.data
    if (msg?.type === 'audio') {
      opts.onChunk(msg.pcm as Int16Array)
    } else if (msg?.type === 'level') {
      // Grob auf 0..1 skaliert: normale Sprachlautstärke liegt bei RMS ~0.05,
      // linear dargestellt bewegt sich der Kristall sonst kaum sichtbar.
      amplitude.input = Math.min(1, Math.sqrt(msg.rms as number) * 2.6)
    }
  }

  source.connect(node)

  // Manche Browser starten den Kontext suspendiert, wenn das Fenster beim
  // Erzeugen nicht fokussiert war.
  if (context.state === 'suspended') await context.resume()

  return {
    context,
    stream,
    setMuted(muted: boolean) {
      node.port.postMessage({ type: 'mute', value: muted })
    },
    async stop() {
      try {
        source.disconnect()
        node.port.onmessage = null
        node.disconnect()
      } catch {
        // Knoten kann bereits abgebaut sein — nicht kritisch.
      }
      for (const track of stream.getTracks()) track.stop()
      await context.close()
      amplitude.input = 0
    }
  }
  } catch (error) {
    for (const track of stream.getTracks()) track.stop()
    await cleanupContext?.close().catch(() => undefined)
    throw error
  }
}

/** Für die Geräteauswahl in den Einstellungen. */
export async function listAudioDevices(): Promise<{
  inputs: MediaDeviceInfo[]
  outputs: MediaDeviceInfo[]
}> {
  // Ohne vorherige Freigabe liefert enumerateDevices leere Labels.
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
    for (const track of probe.getTracks()) track.stop()
  } catch {
    // Keine Freigabe — wir liefern trotzdem, was sichtbar ist.
  }
  const devices = await navigator.mediaDevices.enumerateDevices()
  return {
    inputs: devices.filter((d) => d.kind === 'audioinput'),
    outputs: devices.filter((d) => d.kind === 'audiooutput')
  }
}
