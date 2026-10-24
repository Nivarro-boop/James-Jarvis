import {
  AUDIO_TAG,
  COMPANION_PATH,
  type HostCommand,
  type HostMessage
} from '@shared/companion'
import type { JarvisController } from './controller'
import { useCrystal } from '../store/crystalStore'

/**
 * Der Kristall als Client am eigenen Server.
 *
 * Ungewöhnlich, aber überlegt: Der Server muss im Hauptprozess sitzen, weil ein
 * Renderer keinen Port aufmachen kann — und Mikrofon, Live-Sitzung und
 * Wiedergabe sitzen hier. Irgendwo dazwischen muss der Ton also die
 * Prozessgrenze überqueren. Über IPC wäre der naheliegende Weg gewesen; dagegen
 * steht der erste Absatz von `shared/ipc.ts`, und er steht dort aus gutem
 * Grund. Ein WebSocket auf 127.0.0.1 kostet dasselbe an Kopieren, hält die
 * Zusage und bringt obendrein mit, was IPC nicht hat: Der Server merkt von
 * selbst, wenn das Kristallfenster geschlossen wird.
 *
 * Angeschlossen wird nur, wenn der Server auch läuft. Steht er nicht, versucht
 * es die Brücke in Ruhe weiter — der Nutzer darf ihn in den Einstellungen
 * jederzeit einschalten, ohne dafür das Fenster neu zu öffnen.
 */

export interface CompanionBridge {
  stop(): void
}

export function startCompanionBridge(
  controller: JarvisController,
  port: number
): CompanionBridge {
  let socket: WebSocket | null = null
  let retryTimer: number | null = null
  let stopped = false
  let delay = 1000
  let unsubscribe: (() => void) | null = null
  // Ohne diesen Schlüssel weist der innere Zuhörer ab — er ist das Einzige,
  // was den Kristall von einer beliebigen Webseite im Browser unterscheidet.
  let hostKey: string | null = null
  let lastCaptions: unknown = null
  let lastState = ''

  const open = (): void => {
    if (stopped) return
    if (hostKey === null) {
      window.jarvis.invoke('companion:hostKey').then(
        (key) => {
          hostKey = key
          open()
        },
        () => {
          if (!stopped) retryTimer = window.setTimeout(open, delay)
        }
      )
      return
    }
    // Der innere Zuhörer, nicht der öffentliche: Sobald dort TLS läuft, lautet
    // das Zertifikat auf den Tailnet-Namen und passt auf keine Loopback-Adresse.
    const ws = new WebSocket(
      `ws://127.0.0.1:${port + 1}${COMPANION_PATH.host}?key=${encodeURIComponent(hostKey)}`
    )
    socket = ws
    ws.binaryType = 'arraybuffer'

    /**
     * Gilt dieser Rückruf noch?
     *
     * Dieselbe Falle wie auf dem Telefon: Ein abgelöster Sockel meldet sein
     * `onclose` verspätet und setzte damit die Kennung der frischen Verbindung
     * auf `null` — danach ging die Stimme nirgendwo mehr hin.
     */
    const mine = (): boolean => socket === ws

    ws.onopen = () => {
      if (!mine()) return
      delay = 1000
      lastCaptions = null
      lastState = ''
      pushState()
    }

    ws.onmessage = (event) => {
      if (!mine()) return
      if (typeof event.data !== 'string') {
        handleAudio(new Uint8Array(event.data))
        return
      }
      let command: HostCommand
      try {
        command = JSON.parse(event.data) as HostCommand
      } catch {
        return
      }
      void handleCommand(command).catch((err) => {
        send({ t: 'note', text: `Auftrag fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` })
      })
    }

    ws.onclose = () => {
      if (!mine()) return
      socket = null
      // Reißt die Brücke, während am Telefon die Sprechtaste gehalten wird,
      // käme das Loslassen nie an — und das Mikrofon am Rechner bliebe
      // stumm geschaltet, weil der Controller die Ferne für zuständig hält.
      void controller.setRemoteMic(false)
      if (stopped) return
      retryTimer = window.setTimeout(open, delay)
      // Langsam zurücknehmen: Ist der Server aus, soll die Brücke nicht
      // sekündlich gegen eine geschlossene Tür laufen.
      delay = Math.min(15_000, delay * 1.8)
    }

    ws.onerror = () => {
      // `onclose` folgt immer und räumt auf.
    }
  }

  const handleAudio = (bytes: Uint8Array): void => {
    if (bytes.length < 3 || bytes[0] !== AUDIO_TAG.mic) return
    // Hinter dem Kennungsbyte liegt die Nutzlast ungerade — `Int16Array` will
    // aber eine gerade Adresse. Kopieren ist hier billiger als jede Alternative.
    const pcm = new Int16Array((bytes.byteLength - 1) >> 1)
    new Uint8Array(pcm.buffer).set(bytes.subarray(1, 1 + pcm.byteLength))
    controller.pushRemoteAudio(pcm)
  }

  const handleCommand = async (command: HostCommand): Promise<void> => {
    switch (command.t) {
      case 'press':
        await controller.pressCrystal()
        break
      case 'mic':
        await controller.setRemoteMic(command.on)
        break
      case 'text': {
        const ok = await controller.sendTyped(command.text)
        if (command.requestId) send({ t: 'text-result', requestId: command.requestId, ok })
        if (!ok) send({ t: 'note', text: 'Die Nachricht konnte nicht verarbeitet werden. Bitte erneut senden.' })
        break
      }
      case 'pause':
        await controller.setPaused(command.paused)
        break
      case 'phones':
        useCrystal.getState().setCompanions(command.count)
        // Das letzte Telefon ist gegangen. Hielt es beim Verschwinden die
        // Sprechtaste, gibt es niemanden mehr, der das Loslassen nachreicht.
        if (command.count === 0) await controller.setRemoteMic(false)
        break
    }
  }

  const send = (msg: HostMessage): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg))
  }

  const pushState = (): void => {
    const crystal = useCrystal.getState()
    const state = { t: 'state' as const, state: crystal.state, paused: controller.isPaused(), until: crystal.pauseUntil }
    const key = JSON.stringify(state)
    if (key !== lastState) { send(state); lastState = key }
    if (crystal.captions !== lastCaptions) {
      lastCaptions = crystal.captions
      send({ t: 'captions', items: crystal.captions.slice(-30).map(({ id, who, text }) => ({ id, who, text: text.slice(-16000) })) })
    }
  }

  // Zustandswechsel weiterreichen. Der Store ist die einzige Stelle, an der
  // alle Quellen — Sitzung, Netz, Pause — schon zusammengeführt sind.
  unsubscribe = useCrystal.subscribe(pushState)

  controller.onOutputAudio = (pcm) => {
    if (socket?.readyState !== WebSocket.OPEN) return
    const frame = new Uint8Array(1 + pcm.byteLength)
    frame[0] = AUDIO_TAG.voice
    frame.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 1)
    socket.send(frame)
  }

  open()

  return {
    stop() {
      stopped = true
      if (retryTimer) window.clearTimeout(retryTimer)
      unsubscribe?.()
      controller.onOutputAudio = null
      socket?.close()
      socket = null
    }
  }
}
