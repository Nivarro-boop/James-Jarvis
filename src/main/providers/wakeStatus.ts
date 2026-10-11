import { app } from 'electron'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSettings } from '../store/settings'

/** Selbst trainierte Klassifikatoren, die ohne Einstellung genommen werden. */
const KNOWN_MODELS = ['jarvis.onnx', 'hey_james.onnx']

/** Hier liegen die Modelle — im Paket neben dem Fenster, sonst im Quellbaum. */
function wakeRoot(): string {
  return app.isPackaged ? join(__dirname, '../renderer/wakeword')
    : join(app.getAppPath(), 'src/renderer/public/wakeword')
}

export function wakeStatus(): { installed: boolean; missing: string[]; model: string } {
  const root = wakeRoot()
  const configured = getSettings().wake.modelName
  // Liegt das eingestellte Modell nicht da, ein anderes vorhandenes nehmen:
  // Wer `WAKE=jarvis` trainiert, soll danach nicht noch umstellen müssen.
  const model = existsSync(join(root, configured)) ? configured
    : KNOWN_MODELS.find(name => existsSync(join(root, name))) ?? configured
  const missing = ['melspectrogram.onnx', 'embedding_model.onnx', model].filter(name => !existsSync(join(root, name)))
  return { installed: missing.length === 0, missing, model }
}

/** Nur ein Dateiname, nie ein Pfad: Der Renderer darf hier nichts anderes lesen. */
const MODEL_NAME = /^[\w.-]+\.onnx$/
/** Vite hängt im Paket einen Hash an (`ort-wasm-simd-threaded-Cpm-ox6i.wasm`). */
const RUNTIME_WASM = /^ort-wasm-simd-threaded(?:-[\w-]+)?\.wasm$/

/** Die WASM-Binärdatei von onnxruntime: erst im gebauten Fenster, dann in node_modules. */
function runtimeWasm(): string | null {
  const folders = [join(__dirname, '../renderer/assets'), join(app.getAppPath(), 'node_modules/onnxruntime-web/dist')]
  for (const folder of folders) {
    try {
      const hit = readdirSync(folder).find(name => RUNTIME_WASM.test(name))
      if (hit) return join(folder, hit)
    } catch {
      // Den Ordner gibt es in dieser Fassung nicht — der nächste.
    }
  }
  return null
}

/**
 * Die Bytes einer Weckwort-Datei für den Renderer.
 *
 * Chromium verbietet `fetch` auf `file://`, und genau von dort lädt das
 * fertige Paket sein Fenster: Die Modelle ließen sich nie holen, im Protokoll
 * stand jedes Mal "TypeError: Failed to fetch". Der Hauptprozess liest die
 * Datei stattdessen selbst — auch aus dem asar-Archiv, das Electron für
 * `fs` durchsichtig macht. `name` ist `runtime` oder ein `.onnx`-Dateiname;
 * alles andere (Pfade, andere Endungen) gibt `null`, nie Inhalt.
 */
export function readWakeAsset(name: string): Uint8Array | null {
  try {
    if (name === 'runtime') {
      const file = runtimeWasm()
      return file ? readFileSync(file) : null
    }
    if (!MODEL_NAME.test(name)) return null
    const file = join(wakeRoot(), name)
    return existsSync(file) ? readFileSync(file) : null
  } catch {
    // Der Renderer meldet das einmal selbst, mit dem Dateinamen.
    return null
  }
}
