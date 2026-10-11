/**
 * Ein Einzelbild aus der Kamera.
 *
 * Läuft im Renderer, weil `getUserMedia` nur dort existiert — die Begründung
 * steht ausführlich in `main/automation/camera.ts`. Hier geht es nur um die
 * beiden Dinge, die man dabei falsch machen kann.
 *
 * Erstens: sofort abgreifen liefert Schwarz. Eine Kamera braucht nach dem
 * Öffnen ein paar Bilder, bis Belichtung und Weißabgleich stehen; das erste
 * ist regelmäßig dunkel, das zweite überstrahlt. Deshalb wird unten auf einen
 * echten Bildwechsel gewartet und danach noch kurz.
 *
 * Zweitens: der Strom muss wieder zu. Ein vergessener Track hält die Kamera
 * offen, das Lämpchen bleibt an, und beim nächsten Aufruf ist das Gerät
 * belegt — von uns selbst.
 */

export interface CapturedFrame {
  base64: string
  mimeType: string
  width: number
  height: number
  label: string
}

/** Wonach ein Bild aussehen soll: genug für Text auf einer Verpackung, nicht mehr. */
const IDEAL_WIDTH = 1280
const IDEAL_HEIGHT = 720

/**
 * JPEG statt PNG, und mit 82 Prozent.
 *
 * Ein Kamerabild ist verrauscht — PNG speichert das Rauschen mit und wird
 * dabei drei- bis viermal so groß, ohne dass am Bild etwas besser wäre.
 * Bezahlt wird die Größe zweimal: einmal über die IPC-Brücke und einmal beim
 * Modell.
 */
const MIME = 'image/jpeg'
const QUALITY = 0.82

/** Wie lange höchstens auf das erste brauchbare Bild gewartet wird. */
const READY_TIMEOUT_MS = 5000

/** Nach dem ersten Bild noch so lange, damit die Belichtung nachzieht. */
const SETTLE_MS = 350

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Warten, bis das Videoelement tatsächlich etwas anzeigt.
 *
 * `loadedmetadata` allein reicht nicht — da stehen die Maße fest, aber es ist
 * noch kein Bild dekodiert. `requestVideoFrameCallback` sagt genau das und
 * gibt es in Chromium; wo es fehlt, tut es die Prüfung auf `readyState`.
 */
async function waitForPicture(video: HTMLVideoElement): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS

  const withCallback = video as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: () => void) => number
  }

  if (typeof withCallback.requestVideoFrameCallback === 'function') {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, READY_TIMEOUT_MS)
      withCallback.requestVideoFrameCallback!(() => {
        clearTimeout(timer)
        resolve()
      })
    })
    return
  }

  while (Date.now() < deadline) {
    if (video.readyState >= 2 && video.videoWidth > 0) return
    await wait(50)
  }
}

/**
 * Kamera öffnen, ein Bild machen, Kamera schließen.
 *
 * Der Gerätewunsch ist `ideal` und nicht `exact`: Eine abgezogene USB-Kamera
 * behält ihre Kennung in den Einstellungen, und mit `exact` bekäme man dann
 * einen `OverconstrainedError` statt des eingebauten Ersatzes.
 */
export async function grabFrame(deviceId: string | null): Promise<CapturedFrame> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Dieser Rechner bietet keinen Kamerazugriff an.')
  }

  let stream: MediaStream | null = null
  const video = document.createElement('video')

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
        width: { ideal: IDEAL_WIDTH },
        height: { ideal: IDEAL_HEIGHT }
      },
      audio: false
    })

    // `muted` und `playsInline` sind nötig, damit `play()` ohne Nutzergeste
    // durchgeht; sichtbar wird das Element nie.
    video.srcObject = stream
    video.muted = true
    video.playsInline = true
    await video.play().catch(() => undefined)

    await waitForPicture(video)
    await wait(SETTLE_MS)

    const width = video.videoWidth
    const height = video.videoHeight
    if (!width || !height) {
      throw new Error('Die Kamera hat kein Bild geliefert.')
    }

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Das Bild ließ sich nicht zeichnen.')
    context.drawImage(video, 0, 0, width, height)

    const dataUrl = canvas.toDataURL(MIME, QUALITY)
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    if (!base64) throw new Error('Das Bild war leer.')

    const track = stream.getVideoTracks()[0]

    return {
      base64,
      mimeType: MIME,
      width,
      height,
      label: track?.label || 'Kamera'
    }
  } finally {
    // Auch im Fehlerfall. Eine Kamera, die nach einem Fehlschlag anbleibt, ist
    // schlimmer als der Fehlschlag.
    for (const track of stream?.getTracks() ?? []) track.stop()
    video.srcObject = null
  }
}

/**
 * Auf Anforderungen aus dem Hauptprozess hören.
 *
 * Gibt die Abmeldefunktion zurück, wie die übrigen Ereignisse im Kristall auch.
 * Fehler werden nicht geworfen, sondern zurückgemeldet: Der Hauptprozess
 * wartet auf eine Antwort, und ein stiller Fehlschlag hier ließe das Werkzeug
 * zwölf Sekunden in die Zeitüberschreitung laufen, statt sofort zu sagen, was
 * los ist.
 */
export function listenForCameraRequests(): () => void {
  return window.jarvis.on('camera:capture', ({ id, deviceId }) => {
    void (async () => {
      try {
        const frame = await grabFrame(deviceId)
        await window.jarvis.invoke('camera:frame', { id, frame })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await window.jarvis
          .invoke('camera:frame', { id, error: friendlyCameraError(message) })
          .catch(() => undefined)
      }
    })()
  })
}

/**
 * Die Fehler des Browsers in Sätze übersetzen, die vorgelesen werden können.
 *
 * `NotAllowedError` und `NotReadableError` sehen für den Nutzer gleich aus —
 * es passiert nichts —, haben aber völlig verschiedene Ursachen und
 * verschiedene Abhilfen. Genau das soll der Satz sagen.
 */
function friendlyCameraError(message: string): string {
  if (/NotAllowedError|Permission denied/i.test(message)) {
    return (
      'Windows lässt den Kamerazugriff nicht zu. Sag dem Nutzer, er soll unter Einstellungen, ' +
      'Datenschutz, Kamera den Zugriff für Desktop-Apps einschalten.'
    )
  }
  if (/NotFoundError|DevicesNotFound/i.test(message)) {
    return 'An diesem Rechner ist keine Kamera angeschlossen.'
  }
  if (/NotReadableError|TrackStart|could not start/i.test(message)) {
    return 'Die Kamera ist gerade von einem anderen Programm belegt.'
  }
  if (/OverconstrainedError/i.test(message)) {
    return 'Die eingestellte Kamera gibt es nicht mehr. In den Einstellungen lässt sich eine andere wählen.'
  }
  return message
}
