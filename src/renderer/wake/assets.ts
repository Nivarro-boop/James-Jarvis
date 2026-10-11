/**
 * Wie die Weckwort-Dateien ins Fenster kommen — und wie laut ein Fehlschlag ist.
 *
 * Getrennt von `wakeword.ts`, weil nichts davon onnxruntime braucht und es sich
 * deshalb ohne die Laufzeit prüfen lässt.
 */

export type LogLevel = 'info' | 'warn' | 'error'

/** Eine Adresse für den Dev-Server oder die Bytes selbst. */
export type ModelSource = string | Uint8Array

/**
 * Läuft das Fenster von `file://` — fertiges Paket und `electron-vite preview`?
 *
 * Dort lehnt Chromium `fetch` ab ("Failed to fetch"), also auch das, was
 * onnxruntime intern für Modelle und WASM tut. Nur der Dev-Server (http)
 * liefert die Dateien über eine Adresse aus.
 */
export function pageIsLocalFile(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'file:'
}

/** `ArrayBuffer.isView` statt `instanceof`: Die Bytes kommen aus einem anderen Realm. */
export function hasBytes(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && value.byteLength > 0
}

/**
 * Die Bytes als `Uint8Array` dieses Fensters.
 *
 * Über die Brücke zwischen Preload und Seite (contextIsolation) kommt ein
 * Typed Array womöglich aus der anderen Welt. onnxruntime prüft mit
 * `instanceof Uint8Array` und lehnte es dann als "Invalid argument" ab —
 * obwohl alle Bytes da sind. Eine Sicht auf denselben Speicher genügt; nichts
 * wird kopiert, und ein schon passendes Array bleibt, wie es ist.
 */
export function asBytes(bytes: ArrayBufferView): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/**
 * Wo `name` herkommt: als Adresse, solange `fetch` geht, sonst als Bytes aus
 * dem Hauptprozess. Eine Datei, die dort nicht lesbar ist, ist ein Fehler mit
 * Namen — nicht erst ein "Failed to fetch" tief in onnxruntime.
 */
export async function modelSource(
  name: string,
  url: string,
  env: { fromFile: boolean; read(name: string): Promise<unknown> }
): Promise<ModelSource> {
  if (!env.fromFile) return url
  const bytes = await env.read(name)
  if (!hasBytes(bytes)) throw new Error(`${name} ist im Programmordner nicht lesbar`)
  return asBytes(bytes)
}

/** Der Fehler als Text, mit Typ (`TypeError: Failed to fetch`) und ohne Realm-Tricks. */
export function errorText(err: unknown): string {
  const raw = err as { name?: unknown; message?: unknown } | null
  if (typeof raw?.message !== 'string') return String(err)
  return typeof raw.name === 'string' && raw.name !== 'Error' ? `${raw.name}: ${raw.message}` : raw.message
}

/** Aus einem beliebigen Fehler eine Meldung, die sagt, *was* nicht ging. */
export function loadError(what: string, err: unknown): Error {
  return new Error(`${what}: ${errorText(err)}`)
}

/**
 * Meldet jede Zeile höchstens einmal.
 *
 * Das Weckwort wird beim Start gebaut, beim Modellwechsel und beim
 * Einschalten neu — fehlt die Datei, hat jeder dieser Wege dieselbe Zeile ins
 * Protokoll geschrieben, und die Selbstheilung hat jede davon als neue Störung
 * gelesen. Der Schlüssel ist der Text selbst: Ein anderer Grund wird wieder
 * gemeldet, derselbe nicht.
 */
export function createOnce(
  emit: (level: LogLevel, ...args: unknown[]) => void
): (level: LogLevel, ...args: unknown[]) => boolean {
  const told = new Set<string>()
  return (level, ...args) => {
    const key = `${level}:${args.map(String).join(' ')}`
    if (told.has(key)) return false
    told.add(key)
    emit(level, ...args)
    return true
  }
}
