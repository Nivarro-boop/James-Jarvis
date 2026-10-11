import { randomUUID } from 'node:crypto'
import { getCrystalWindow } from '../windows/crystal'
import { sendToCrystal } from '../ipc/emit'
import { getSettings } from '../store/settings'

/**
 * Ein Einzelbild aus der Kamera holen.
 *
 * Der Umweg über den Renderer ist keiner: Es gibt im Hauptprozess keine
 * Kamera. `desktopCapturer` liefert Bildschirme und Fenster, für Webcams
 * existiert in Electron nichts Vergleichbares — der einzige Zugang ist
 * `getUserMedia`, und das ist eine Sache des Browserkontexts.
 *
 * Also fragt der Hauptprozess das Kristallfenster, das ohnehin läuft und
 * ohnehin schon das Mikrofon offen hat. Es macht ein Bild und schickt es
 * zurück. Die Wartenden liegen so lange in `pending`.
 *
 * Warum nicht dauerhaft ein Videostrom: Weil eine Kamera, die läuft, eine
 * Kamera ist, die leuchtet. Ein Assistent, dessen Kameralicht den ganzen Tag
 * an ist, wird abgeklebt — und dann nützt auch das Werkzeug nichts. Der Strom
 * geht deshalb für jedes Bild auf und sofort wieder zu.
 */

/**
 * Wie lange auf ein Bild gewartet wird.
 *
 * Großzügig bemessen, weil darin das Anlaufen der Kamera steckt: Eine USB-Webcam
 * braucht bis zur ersten brauchbaren Aufnahme regelmäßig eine Sekunde, manche
 * mit Autofokus zwei. Kürzer gesetzt bekäme man verlässlich ein schwarzes Bild
 * statt einer ehrlichen Zeitüberschreitung.
 */
const TIMEOUT_MS = 12_000

interface Pending {
  resolve(frame: CameraFrame): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

export interface CameraFrame {
  /** Rohdaten ohne den `data:`-Vorspann. */
  base64: string
  mimeType: string
  width: number
  height: number
  /** Was die Kamera von sich aus meldet — für die Rückmeldung an den Nutzer. */
  label: string
}

const pending = new Map<string, Pending>()

/**
 * Die Antwort des Renderers einsortieren.
 *
 * Wird von der IPC-Brücke aufgerufen. Ein unbekanntes Kennzeichen wird still
 * verworfen: Das passiert regulär, wenn die Wartezeit gerade abgelaufen war
 * und das Bild eine Zehntelsekunde zu spät kommt.
 */
export function deliverCameraFrame(
  id: string,
  frame: CameraFrame | null,
  error: string | null
): void {
  const waiting = pending.get(id)
  if (!waiting) return
  pending.delete(id)
  clearTimeout(waiting.timer)

  if (frame) waiting.resolve(frame)
  else waiting.reject(new Error(error || 'Die Kamera hat kein Bild geliefert.'))
}

/**
 * Ein Bild anfordern und darauf warten.
 *
 * Wirft mit einem Satz, der dem Nutzer vorgelesen werden kann — nicht mit
 * einer Fehlernummer. Die drei Fälle, die tatsächlich vorkommen, sind: kein
 * Fenster offen, keine Kamera vorhanden, Zugriff verweigert. Alle drei
 * bekommen unten ihren eigenen Satz, weil sich alle drei unterschiedlich
 * beheben lassen.
 */
export async function captureCameraFrame(): Promise<CameraFrame> {
  const window = getCrystalWindow()
  if (!window) {
    throw new Error(
      'Das James-Fenster ist zu, und nur darüber komme ich an die Kamera. ' +
        'Sag dem Nutzer, er soll James über das Tray-Symbol wieder öffnen.'
    )
  }

  const id = randomUUID()

  return new Promise<CameraFrame>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(
        new Error(
          'Die Kamera hat nicht rechtzeitig geantwortet. Meist heißt das, dass sie gerade ' +
            'von einem anderen Programm belegt ist.'
        )
      )
    }, TIMEOUT_MS)

    pending.set(id, { resolve, reject, timer })
    sendToCrystal('camera:capture', { id, deviceId: getSettings().cameraDeviceId })
  })
}

/** Not-Aus: alle Wartenden auflösen, damit kein Werkzeug hängen bleibt. */
export function abortCameraCaptures(): void {
  for (const [id, waiting] of pending) {
    clearTimeout(waiting.timer)
    waiting.reject(new Error('Abgebrochen.'))
    pending.delete(id)
  }
}
