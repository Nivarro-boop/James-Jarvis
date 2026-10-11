import { createSentenceBuffer } from '@shared/speakable'
import { smoothPcmBoundary } from '@shared/pcm'
import type { VoiceServiceStatus } from '@shared/types'
import type { VoiceStream } from './elevenVoice'
import type { PiperVoiceOptions } from './piperVoice'

/** Der tatsächlich erreichbare lokale Sprachdienst. */
export interface VibeVoicePlan {
  port: number
  voice: string
  token: string
}

/**
 * Stellt sicher, dass der gewählte lokale Dienst wirklich bereitsteht.
 * Die Statusabfrage startet ihn bei Bedarf; ein Fehlschlag führt anschließend
 * kontrolliert zur Gemini-Stimme statt zu einer stummen Sitzung.
 */
export async function planVibeVoice(
  voice: string,
  note: (message: string) => void
): Promise<VibeVoicePlan | null> {
  let status: VoiceServiceStatus
  try {
    status = await window.jarvis.invoke('speech:status')
    if (!status.running) status = await window.jarvis.invoke('speech:status', { start: true })
  } catch (error) {
    console.warn('[vibevoice] Zustandsfrage fehlgeschlagen:', messageOf(error))
    note('Der lokale VibeVoice-Dienst antwortet nicht. Solange spreche ich mit Geminis Stimme.')
    return null
  }

  if (!status.running || status.port <= 0 || !status.sessionToken) {
    note(status.detail || 'VibeVoice steht nicht bereit. Solange spreche ich mit Geminis Stimme.')
    return null
  }

  const selected = status.voices.includes(voice) ? voice : (status.voices[0] ?? voice)
  return { port: status.port, voice: selected, token: status.sessionToken }
}

/**
 * Unabhängig erzeugte Satzblöcke beginnen selten exakt beim letzten Wert des
 * vorigen. Eine sehr kurze Überblendung entfernt den Sprung (Knackser), ohne
 * zwischen Sätzen künstliche Stille einzufügen.
 */
/**
 * VibeVoice spricht über den lokalen WebSocket des Python-Dienstes.
 * Binärrahmen sind 24-kHz-PCM und passen damit ohne Umrechnung in denselben
 * Player wie ElevenLabs und Gemini.
 */
export function createVibeVoiceStream(
  plan: VibeVoicePlan,
  options: PiperVoiceOptions
): VoiceStream {
  const sentences = createSentenceBuffer()
  const pending = new Set<string>()
  const waiting: { id: string; sentence: string }[] = []
  let socket: WebSocket | null = null
  let opening: Promise<WebSocket> | null = null
  let closed = false
  let failed = false
  let finished = false
  let nextJob = 1
  let activeJob: string | null = null
  let previousLast = 0

  const toPcm = (buffer: ArrayBuffer): Int16Array => {
    const usable = buffer.byteLength - (buffer.byteLength % 2)
    const view = new DataView(buffer, 0, usable)
    const pcm = new Int16Array(usable / 2)
    for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(i * 2, true)
    return pcm
  }

  const maybeIdle = (): void => {
    if (finished && pending.size === 0 && waiting.length === 0 && activeJob === null) {
      previousLast = 0
      options.onIdle?.()
    }
  }

  const fail = (reason: string): void => {
    if (closed || failed) return
    failed = true
    pending.clear()
    waiting.length = 0
    activeJob = null
    const dying = socket
    socket = null
    opening = null
    try {
      dying?.close()
    } catch {
      // Der Sockel kann noch im Handschlag stehen.
    }
    options.onError(reason, true)
  }

  let pump = (): void => {}

  const handleText = (raw: string): void => {
    let message: { type?: string; id?: string; message?: string }
    try {
      message = JSON.parse(raw) as typeof message
    } catch {
      return
    }

    if (message.type === 'done' && message.id) {
      pending.delete(message.id)
      if (activeJob === message.id) activeJob = null
      pump()
      maybeIdle()
      return
    }
    if (message.type === 'error') {
      if (message.id) pending.delete(message.id)
      if (activeJob === message.id) activeJob = null
      fail(message.message || 'VibeVoice konnte den Satz nicht sprechen.')
      maybeIdle()
    }
  }

  const connect = (): Promise<WebSocket> => {
    if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket)
    if (opening) return opening

    opening = new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${plan.port}`)
      ws.binaryType = 'arraybuffer'
      // Schon während des Handschlags merken. Sonst kann `close()` diesen
      // Sockel nicht erreichen und `onopen` belebt eine beendete Sitzung neu.
      socket = ws
      let settled = false

      ws.onopen = () => {
        if (closed || failed || socket !== ws) {
          try {
            ws.close()
          } catch {
            // Wurde parallel geschlossen.
          }
          if (!settled) {
            settled = true
            reject(new Error('Der VibeVoice-Sockel wurde vor dem Öffnen geschlossen.'))
          }
          return
        }
        settled = true
        socket = ws
        opening = null
        resolve(ws)
      }
      ws.onmessage = (event) => {
        if (closed || ws !== socket) return
        if (typeof event.data === 'string') handleText(event.data)
        else if (event.data instanceof ArrayBuffer) {
          const pcm = toPcm(event.data)
          if (pcm.length > 0) {
            const smoothed = smoothPcmBoundary(pcm, previousLast)
            previousLast = smoothed.last
            options.onAudio(smoothed.pcm)
          }
        }
      }
      ws.onerror = () => {
        if (settled) return
        settled = true
        if (socket === ws) socket = null
        opening = null
        reject(new Error('Der VibeVoice-Sockel ließ sich nicht öffnen.'))
      }
      ws.onclose = () => {
        if (socket === ws) socket = null
        if (!settled) {
          settled = true
          opening = null
          reject(new Error('Der VibeVoice-Sockel wurde vor dem Öffnen geschlossen.'))
        }
        if (closed || failed) return
        opening = null
        pending.clear()
        fail('Die Verbindung zum lokalen VibeVoice-Dienst ist abgerissen.')
      }
    })

    return opening
  }

  const say = (sentence: string): void => {
    const id = `vibe-${nextJob++}`
    pending.add(id)
    waiting.push({ id, sentence })
    pump()
  }

  // Immer nur einen Auftrag gleichzeitig an den Dienst geben. Der Dienst
  // zerlegt auch einen Satz intern in Abschnitte; mehrere gleichzeitige
  // Aufträge könnten diese Abschnitte sonst hörbar vertauschen.
  pump = (): void => {
    if (closed || failed || activeJob !== null) return
    const job = waiting.shift()
    if (!job) return
    activeJob = job.id
    void (async () => {
      try {
        const ws = await connect()
        if (closed || failed || !pending.has(job.id)) return
        ws.send(
          JSON.stringify({
            type: 'speak',
            id: job.id,
            text: job.sentence,
            voice: plan.voice,
            token: plan.token
          })
        )
      } catch (error) {
        pending.delete(job.id)
        if (activeJob === job.id) activeJob = null
        fail(messageOf(error))
        maybeIdle()
      }
    })()
  }

  const cancelPending = (): void => {
    const ws = socket
    // Nur der aktive Auftrag ist beim Dienst bekannt. Wartende Kennungen als
    // `cancel` zu schicken würde dort Einträge erzeugen, zu denen nie ein
    // Auftrag kommt und die deshalb nie wieder verschwinden.
    if (activeJob && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'cancel', id: activeJob, token: plan.token }))
    }
    pending.clear()
    waiting.length = 0
    activeJob = null
    previousLast = 0
  }

  return {
    prewarm() {
      if (closed || failed) return
      void connect().catch((error) => {
        fail(messageOf(error))
      })
    },
    speak(text) {
      if (closed || failed || !text) return
      finished = false
      for (const sentence of sentences.push(text)) say(sentence)
    },
    finish() {
      if (closed || failed) return
      for (const sentence of sentences.flush()) say(sentence)
      finished = true
      maybeIdle()
    },
    abort() {
      if (closed) return
      sentences.clear()
      finished = false
      cancelPending()
    },
    close() {
      if (closed) return
      closed = true
      sentences.clear()
      cancelPending()
      socket?.close()
      socket = null
      opening = null
    },
    spentChars() {
      return 0
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
