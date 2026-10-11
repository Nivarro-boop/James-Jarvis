import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PIPER, WHISPER } from '@shared/config/defaults'
import type { LocalAsset, LocalAssetId, Settings } from '@shared/types'
import { broadcast } from '../ipc/emit'
import { forgetPiperWarmup } from '../providers/piper'
import { forgetWhisperWarmup } from '../providers/whisper'
import { getSettings, setSettings } from '../store/settings'
import {
  baseName,
  piperDir,
  piperEspeakData,
  piperExe,
  piperVoicePath,
  whisperDir,
  whisperModelPath,
  whisperServerExe,
  whisperVadPath
} from './paths'

/**
 * Die Beschaffung der lokalen Stücke.
 *
 * Mitgeliefert wird nichts davon: Das Sprachmodell allein wiegt eine halbe
 * Gigabyte, und die Binärdateien stammen aus fremden Projekten unter fremden
 * Lizenzen. Geholt wird deshalb auf ausdrücklichen Klick, und woher, steht in
 * `LocalAsset.url` sichtbar daneben.
 *
 * Vier Entscheidungen tragen dieses Modul:
 *
 * 1. **Gemeldet wird, während es läuft.** Der Strom aus `fetch` wird blockweise
 *    gelesen, statt am Ende in einem Rutsch auf die Platte zu gehen. Ein Balken,
 *    der bei `ggml-medium.bin` vier Minuten auf null steht und dann auf hundert
 *    springt, ist kein Balken — er ist von einem Absturz nicht zu unterscheiden.
 *    Die Zahl aus `Content-Length` schlägt dabei immer die Schätzung aus den
 *    Konstanten; fehlt sie, bleibt die Schätzung stehen, und es wird nichts
 *    anderes behauptet.
 *
 * 2. **Kein halbes Stück sieht wie ein ganzes aus.** Geladen wird nach `.teil`,
 *    und erst der vollständige Download wird auf den endgültigen Namen
 *    umbenannt. Der schlimmste Zustand wäre ein abgebrochener Download, der in
 *    der Liste als vorhanden steht: whisper startet dann mit einem angeschnittenen
 *    Modell und meldet einen Brocken, den niemand deuten kann. Was schiefgeht,
 *    hinterlässt deshalb nichts — lieber noch einmal laden als raten.
 *
 * 3. **Entpackt wird mit PowerShell.** Node bringt keinen Entpacker mit, und
 *    eine Abhängigkeit für zwei ZIP-Dateien im Leben einer Installation wäre
 *    schlecht bezahlt. `Expand-Archive` liegt auf jedem Windows, das diese App
 *    ohnehin voraussetzt, und die App redet für Maus und Tastatur schon über
 *    denselben Weg mit dem System (siehe `automation/inputServer.ts`). Danach
 *    wird nachgesehen, ob die erwartete Datei wirklich daliegt: Beide Archive
 *    tragen einen Ordner obendrauf — `Release/` das eine, `piper/` das andere —
 *    und ein Nutzer, der die Datei selbst eine Ebene hochschieben soll, ist ein
 *    Fehler dieses Moduls, keiner von ihm.
 *
 * 4. **Eine Stimme sind zwei Dateien.** Die `.onnx` trägt das Modell, die
 *    `.onnx.json` daneben die Abtastrate. Ohne die zweite weiß niemand, ob 16
 *    oder 22 kHz herauskommen, und der Ton klingt nach Zeitlupe oder Chipmunk.
 *    Beide werden geholt, beide geprüft.
 *
 * Und was geholt wurde, wird auch benutzt: Wer `ggml-base.bin` anklickt, will
 * mit `base` sprechen und nicht eine Datei besitzen, auf die nichts zeigt.
 * Deshalb schreibt dieses Modul den Pfad in die Einstellungen zurück, sobald das
 * Geholte ein anderes ist als das Eingestellte.
 */

/**
 * Ohne ein einziges Byte für so lange gilt die Leitung als tot.
 *
 * Eine Frist auf den ganzen Download wäre falsch: `ggml-medium.bin` sind
 * anderthalb Gigabyte, und auf einer müden Leitung dauert das ehrlich lange. Die
 * Frist gilt deshalb dem Stillstand, nicht der Dauer.
 */
const STALL_MS = 60_000

/**
 * So oft höchstens ein Fortschrittsereignis.
 *
 * Ein Block sind ein paar Kilobyte; ungedrosselt wären das bei einem halben
 * Gigabyte einige zehntausend Nachrichten über den IPC-Kanal, und die kosten
 * mehr Rechenzeit als der Download selbst. Fünfmal in der Sekunde reicht für ein
 * Auge vollkommen.
 */
const REPORT_EVERY_MS = 200

/**
 * Geschätzte Größe der `.onnx.json`.
 *
 * Sie steht in keiner Konstante, weil sie in keiner Tabelle steht — es sind
 * wenige Kilobyte Phonem-Tabelle. Die Schätzung lebt genau so lange, bis der
 * erste `Content-Length` der Antwort sie ersetzt.
 */
const VOICE_JSON_BYTES = 6_000

/** So lange darf `Expand-Archive` brauchen, bevor es als hängend gilt. */
const UNZIP_TIMEOUT_MS = 300_000

/** Kurznamen für Meldungen, in denen kein ganzes Etikett Platz hat. */
const NAMES: Record<LocalAssetId, string> = {
  'whisper-runtime': 'whisper',
  'whisper-model': 'Das Sprachmodell',
  'whisper-vad': 'Die Spracherkennung',
  'piper-runtime': 'piper',
  'piper-voice': 'Die Stimme'
}

/** Was gerade läuft. Zweimal dieselbe Datei gleichzeitig zu holen, endet im Streit um `.teil`. */
const running = new Set<LocalAssetId>()

/**
 * Der letzte gemeldete Stand je Stück.
 *
 * Damit eine Fehlermeldung den Balken nicht auf null zurückwirft: Wenn bei 480
 * von 487 Megabyte die Leitung abreißt, soll die Oberfläche zeigen können, wie
 * weit es war — das ist der Unterschied zwischen "Netz kurz weg" und "das
 * funktioniert bei mir grundsätzlich nicht".
 */
const lastSeen = new Map<LocalAssetId, { received: number; total: number }>()

function report(
  id: LocalAssetId,
  received: number,
  total: number,
  done: boolean,
  error: string | null
): void {
  lastSeen.set(id, { received, total })
  // Über `broadcast` und nicht über `sendToCrystal`: Die Einstellungsseite ist
  // ein eigenes Fenster, und genau dort steht der Knopf, der das hier auslöst.
  broadcast('local:progress', { id, received, total, done, error })
}

function fail(id: LocalAssetId, message: string): void {
  const seen = lastSeen.get(id) ?? { received: 0, total: 0 }
  broadcast('local:progress', { ...seen, id, done: false, error: message })
}

interface Meter {
  /** `Content-Length` der laufenden Datei — schlägt die Schätzung. */
  correct(announced: number): void
  /** Stand innerhalb der laufenden Datei. Gedrosselt, außer `force`. */
  tick(inCurrent: number, force?: boolean): void
  /** Diese Datei liegt; ab hier zählt die nächste. */
  next(actual: number): void
  /** Alles geholt und an Ort und Stelle. */
  done(): void
  /** Lag schon vollständig da — voller Balken, ohne dass ein Byte geflossen wäre. */
  skipped(): void
}

/**
 * Ein Balken über mehrere Dateien.
 *
 * Die Stimme besteht aus zwei Downloads, soll aber einen Fortschritt haben und
 * nicht zwei, die nacheinander bei null anfangen. Deshalb kennt der Zähler die
 * geschätzten Größen aller Teile von Anfang an und ersetzt jede Schätzung durch
 * die echte Zahl, sobald die Antwort sie mitbringt.
 */
function createMeter(id: LocalAssetId, parts: number[]): Meter {
  const sizes = [...parts]
  let index = 0
  let finished = 0
  let lastEmit = 0

  const total = (): number => sizes.reduce((sum, value) => sum + value, 0)

  return {
    correct(announced) {
      if (announced > 0 && index < sizes.length) sizes[index] = announced
    },
    tick(inCurrent, force = false) {
      const now = Date.now()
      if (!force && now - lastEmit < REPORT_EVERY_MS) return
      lastEmit = now
      const received = finished + inCurrent
      // Ohne das `max` überholt der Balken sein eigenes Ziel, wenn keine Größe
      // angekündigt war und die Schätzung zu klein geraten ist.
      report(id, received, Math.max(total(), received), false, null)
    },
    next(actual) {
      if (index < sizes.length) sizes[index] = actual
      finished += actual
      index += 1
    },
    done() {
      report(id, finished, Math.max(total(), finished), true, null)
    },
    skipped() {
      const size = total()
      report(id, size, size, true, null)
    }
  }
}

interface ModelEntry {
  file: string
  bytes: number
  label: string
}

interface VoiceEntry {
  id: string
  path: string
  bytes: number
  rate: number
  license: string
  label: string
}

function knownModel(file: string): ModelEntry | undefined {
  return WHISPER.models.find((model) => model.file.toLowerCase() === file.toLowerCase())
}

function knownVoice(id: string): VoiceEntry | undefined {
  return PIPER.voices.find((voice) => voice.id.toLowerCase() === id.toLowerCase())
}

/**
 * Das Modell, um das es hier geht.
 *
 * "Vorgabe" heißt nicht stur `WHISPER.defaultModel`, sondern: das, worauf die
 * Einstellungen zeigen. Solange dort nichts steht, ist beides dasselbe — steht
 * dort `ggml-base.bin`, wäre alles andere eine Überraschung. Und zeigt der
 * eingetragene Pfad auf eine fremde Datei, die es hier nirgends zu holen gibt,
 * beschreibt die Liste wieder die Vorgabe: Sie muss sagen, was der Knopf täte,
 * und der könnte eine fremde Datei nirgends herbekommen.
 */
function currentModel(settings: Settings): ModelEntry {
  const name = baseName(whisperModelPath(settings))
  return knownModel(name) ?? knownModel(WHISPER.defaultModel) ?? WHISPER.models[0]
}

function currentVoice(settings: Settings): VoiceEntry {
  const name = baseName(piperVoicePath(settings)).replace(/\.onnx$/i, '')
  return knownVoice(name) ?? knownVoice(PIPER.defaultVoice) ?? PIPER.voices[0]
}

/**
 * Die Wahl aus der Anfrage, oder die Vorgabe.
 *
 * Ein unbekannter Wert wird nicht stillschweigend zur Vorgabe: Wer sich vertippt
 * hat, bekäme sonst wortlos etwas anderes geladen als bestellt — bei einer Datei
 * von einer halben Gigabyte ist das kein freundliches Verhalten.
 */
function pickModel(settings: Settings, choice: string): ModelEntry {
  if (!choice) return currentModel(settings)
  const found = knownModel(choice)
  if (found) return found
  throw new Error(
    `Ein Sprachmodell namens ${choice} kenne ich nicht. Zur Wahl stehen ` +
      `${WHISPER.models.map((model) => model.file).join(', ')}.`
  )
}

function pickVoice(settings: Settings, choice: string): VoiceEntry {
  if (!choice) return currentVoice(settings)
  const found = knownVoice(choice)
  if (found) return found
  throw new Error(
    `Eine Stimme namens ${choice} kenne ich nicht. Zur Wahl stehen ` +
      `${PIPER.voices.map((voice) => voice.id).join(', ')}.`
  )
}

/**
 * Was da ist, was fehlt, und was es kosten würde.
 *
 * Bewusst nicht asynchron: Es sind fünf `existsSync` auf Pfade, die ohnehin
 * gerade angelegt werden. Eine Zusage daraus zu machen, würde nur jeden Aufrufer
 * zum Warten zwingen, ohne dass irgendwo etwas schneller wäre.
 */
export function localAssets(): LocalAsset[] {
  const settings = getSettings()
  const model = currentModel(settings)
  const voice = currentVoice(settings)
  const voiceFile = piperVoicePath(settings)

  return [
    {
      id: 'whisper-runtime',
      label: 'whisper.cpp — der Dienst, der zuhört',
      purpose:
        'Tippt ab, was du sagst. Ohne ihn hört James auf diesem Rechner gar nichts.',
      present: existsSync(whisperServerExe(settings)),
      path: whisperDir(settings),
      url: WHISPER.runtimeUrl,
      bytes: WHISPER.runtimeBytes,
      license: 'MIT — whisper.cpp von ggml-org'
    },
    {
      id: 'whisper-model',
      label: `Sprachmodell: ${model.label}`,
      purpose:
        'Die Gewichte selbst. Der Dienst ohne Modell ist ein Prozess, der auf jede Frage schweigt.',
      present: existsSync(whisperModelPath(settings)),
      path: whisperModelPath(settings),
      url: `${WHISPER.modelBaseUrl}${model.file}`,
      bytes: model.bytes,
      license: 'MIT — Gewichte von OpenAI, ggml-Fassung aus whisper.cpp'
    },
    {
      id: 'whisper-vad',
      label: 'Silero — die Erkennung von Sprache',
      purpose:
        'Trennt Sprache von Stille. Ohne sie gibt whisper bei Stille den Abspann einer fremden Untertitelung zurück.',
      present: existsSync(whisperVadPath(settings)),
      path: whisperVadPath(settings),
      url: WHISPER.vadUrl,
      bytes: WHISPER.vadBytes,
      license: 'MIT — Silero VAD'
    },
    {
      id: 'piper-runtime',
      label: 'piper — der Mund ohne Netz',
      purpose:
        'Spricht auf diesem Rechner, wenn ElevenLabs nicht kann oder nicht soll. Enthält piper.exe, die DLLs und espeak-ng-data.',
      present: existsSync(piperExe(settings)),
      path: piperDir(settings),
      url: PIPER.runtimeUrl,
      bytes: PIPER.runtimeBytes,
      license: 'MIT — rhasspy/piper, das Projekt ist archiviert'
    },
    {
      id: 'piper-voice',
      label: `Stimme: ${voice.label}`,
      purpose:
        'Die Stimme selbst — zwei Dateien: die .onnx mit dem Modell und die .onnx.json mit der Abtastrate.',
      // Beide Dateien, oder es zählt nicht als vorhanden. Eine Stimme ohne ihre
      // .onnx.json lädt piper zwar, aber niemand weiß dann, mit welcher Rate der
      // Ton abzuspielen ist.
      present: existsSync(voiceFile) && existsSync(`${voiceFile}.json`),
      path: voiceFile,
      url: `${PIPER.voiceBaseUrl}${voice.path}.onnx`,
      bytes: voice.bytes,
      license: voice.license
    }
  ]
}

/**
 * Ein Stück holen.
 *
 * `choice` ist bei `whisper-model` der Dateiname aus `WHISPER.models`, bei
 * `piper-voice` die id aus `PIPER.voices`; bei den übrigen dreien gibt es nichts
 * zu wählen, und ein trotzdem mitgeschickter Wert wird schlicht übergangen — die
 * Einstellungsseite hat ein Auswahlfeld, das versehentlich mitfährt, und das ist
 * kein Grund, dem Nutzer einen Fehler vorzuwerfen.
 *
 * `force` holt auch das, was schon daliegt. Der IPC-Vertrag kennt den Schalter
 * nicht — er ist für den Fall gedacht, dass ein Stück beschädigt ist und jemand
 * es ohne Umweg über den Dateimanager ersetzen will.
 *
 * Zurück kommt die frische Liste, nicht ein "ok": Der Aufrufer will danach
 * ohnehin wissen, wie die Lage jetzt ist, und eine zweite Runde über
 * `local:assets` wäre nur eine Gelegenheit, aus dem Tritt zu geraten.
 */
export async function installLocalAsset(
  id: LocalAssetId,
  choice?: string,
  force = false
): Promise<LocalAsset[]> {
  if (running.has(id)) {
    throw new Error(`${NAMES[id]} wird gerade schon geladen. Warte, bis der Balken durch ist.`)
  }
  running.add(id)
  try {
    await perform(id, (choice ?? '').trim(), force)
  } catch (err) {
    const message = (err as Error).message
    fail(id, message)
    throw new Error(message)
  } finally {
    running.delete(id)
  }
  return localAssets()
}

async function perform(id: LocalAssetId, choice: string, force: boolean): Promise<void> {
  const settings = getSettings()

  switch (id) {
    case 'whisper-runtime': {
      const meter = createMeter(id, [WHISPER.runtimeBytes])
      if (!force && existsSync(whisperServerExe(settings))) return meter.skipped()
      await installArchive(id, WHISPER.runtimeUrl, meter, whisperDir(settings), 'whisper-server.exe')
      // Andere Binärdatei, andere Rechenzeit — die alte Messung ist nichts mehr wert.
      forgetWhisperWarmup()
      return meter.done()
    }

    case 'whisper-model': {
      const model = pickModel(settings, choice)
      // Neben das, worauf die Einstellungen zeigen — wer whisper auf einer
      // anderen Platte hält, soll seine Modelle nicht plötzlich woanders finden.
      const target = join(dirname(whisperModelPath(settings)), model.file)
      const meter = createMeter(id, [model.bytes])
      if (!force && existsSync(target)) {
        useModel(settings, target)
        return meter.skipped()
      }
      await download(`${WHISPER.modelBaseUrl}${model.file}`, target, meter)
      useModel(settings, target)
      return meter.done()
    }

    case 'whisper-vad': {
      const target = whisperVadPath(settings)
      const meter = createMeter(id, [WHISPER.vadBytes])
      if (!force && existsSync(target)) return meter.skipped()
      await download(WHISPER.vadUrl, target, meter)
      return meter.done()
    }

    case 'piper-runtime': {
      const dir = piperDir(settings)
      const meter = createMeter(id, [PIPER.runtimeBytes])
      if (!force && existsSync(piperExe(settings))) return meter.skipped()
      await installArchive(id, PIPER.runtimeUrl, meter, dir, 'piper.exe')
      // espeak-ng-data ist keine Beigabe: Ohne den Ordner findet piper keine
      // Lautschrift und beendet sich beim ersten Satz. Er liegt im Archiv neben
      // der .exe — fehlt er hier, hat das Flachziehen oben etwas übersehen.
      if (!existsSync(piperEspeakData(settings))) {
        throw new Error(
          'piper.exe liegt, aber espeak-ng-data fehlt. Ohne diesen Ordner kann piper keinen Satz aussprechen — hol das Paket noch einmal.'
        )
      }
      return meter.done()
    }

    case 'piper-voice': {
      const voice = pickVoice(settings, choice)
      const dir = dirname(piperVoicePath(settings))
      const onnx = join(dir, `${voice.id}.onnx`)
      const json = `${onnx}.json`
      const meter = createMeter(id, [voice.bytes, VOICE_JSON_BYTES])
      // Nur eine der beiden Dateien zählt nicht. Dann wird auch die vorhandene
      // neu geholt: Welche der beiden angeschnitten ist, weiß hier niemand, und
      // sechzig Megabyte sind billiger als eine Stimme, die falsch klingt.
      if (!force && existsSync(onnx) && existsSync(json)) {
        useVoice(settings, onnx)
        return meter.skipped()
      }
      await download(`${PIPER.voiceBaseUrl}${voice.path}.onnx`, onnx, meter)
      await download(`${PIPER.voiceBaseUrl}${voice.path}.onnx.json`, json, meter)
      useVoice(settings, onnx)
      return meter.done()
    }
  }
}

/**
 * Das Geholte auch benutzen.
 *
 * Ein Download, der nichts ändert, ist für den Nutzer ein Download, der nicht
 * funktioniert hat: Er klickt `base`, wartet, und danach spricht weiterhin
 * `small`. Geschrieben wird nur, wenn sich der Pfad wirklich unterscheidet.
 *
 * Das `broadcast` gehört dazu, weil `setSettings` selbst keines schickt — das
 * tut sonst nur der IPC-Griff für `settings:set`, und ohne diese Zeile stünde in
 * einem offenen Einstellungsfenster weiter der alte Pfad.
 */
function useModel(settings: Settings, path: string): void {
  if (whisperModelPath(settings) === path) return
  broadcast('settings:changed', setSettings({ whisper: { ...settings.whisper, modelPath: path } }))
  forgetWhisperWarmup()
}

/**
 * Dasselbe für die Stimme — und hier wiegt das Vergessen schwerer.
 *
 * Beim Modell hält whisper den Pfad in seiner Startzeile, ein Wechsel setzt den
 * Dienst also ohnehin neu auf. Die piper-Stimme steckt dagegen in der geladenen
 * ONNX-Sitzung und lässt sich darin nicht austauschen. Ohne diesen Aufruf liefe
 * der Prozess mit der alten Stimme weiter, in den Einstellungen stünde die neue,
 * und beides bliebe unbemerkt, bis jemand hinhört.
 */
function useVoice(settings: Settings, path: string): void {
  if (piperVoicePath(settings) === path) return
  broadcast('settings:changed', setSettings({ piper: { ...settings.piper, voicePath: path } }))
  forgetPiperWarmup()
}

/**
 * Eine Datei holen — vollständig oder gar nicht.
 *
 * Geschrieben wird nach `<ziel>.teil`; erst wenn der Strom sauber zu Ende ist
 * und die gelesene Menge zu der passt, die angekündigt war, bekommt die Datei
 * ihren richtigen Namen. Alles andere räumt sich selbst weg.
 */
async function download(url: string, target: string, meter: Meter): Promise<void> {
  const part = `${target}.teil`
  await mkdir(dirname(target), { recursive: true })
  await rm(part, { force: true })

  const control = new AbortController()
  let watchdog = setTimeout(() => control.abort(), STALL_MS)
  const touch = (): void => {
    clearTimeout(watchdog)
    watchdog = setTimeout(() => control.abort(), STALL_MS)
  }

  let received = 0
  try {
    const response = await fetch(url, { signal: control.signal })
    if (!response.ok) {
      throw new Error(
        `${host(url)} hat die Datei mit ${response.status} verweigert. Prüf, ob die Adresse noch stimmt.`
      )
    }
    if (!response.body) {
      throw new Error(`${host(url)} hat auf die Anfrage nichts geschickt.`)
    }

    const announced = Number(response.headers.get('content-length') ?? 0)
    meter.correct(announced)
    meter.tick(0, true)

    const file = createWriteStream(part)
    /**
     * Ein Schreibstrom ohne Zuhörer für `error` wirft seine Ausnahme in den
     * Prozess und nimmt Electron mit — bei voller Platte oder gesperrtem Ordner
     * also genau dann, wenn ohnehin schon etwas nicht stimmt. Der Fehler wird
     * deshalb gemerkt und an der nächsten Stelle geworfen, an der ihn jemand
     * fangen kann. `closed` lehnt bewusst nie ab: Eine Zusage, die niemand mehr
     * erwartet, weil der Fehler oben schon geworfen wurde, wäre sonst eine
     * unbehandelte Ablehnung.
     */
    let broken: Error | null = null
    const closed = new Promise<void>((resolve) => {
      file.on('error', (err: Error) => {
        broken = err
        resolve()
      })
      file.on('finish', () => resolve())
    })

    const reader = response.body.getReader()
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        const value = chunk.value
        if (!value) continue
        touch()
        received += value.byteLength
        // Der Rückgabewert von `write` ist kein Schmuck: Ohne das Warten auf
        // `drain` sammelt sich der ganze Download im Arbeitsspeicher, weil das
        // Netz schneller liefert als die Platte schreibt. Bei anderthalb
        // Gigabyte ist das der Unterschied zwischen einer Datei und einem
        // gestorbenen Hauptprozess.
        if (!file.write(Buffer.from(value.buffer, value.byteOffset, value.byteLength))) {
          await once(file, 'drain')
        }
        if (broken) throw broken
        meter.tick(received)
      }
      file.end()
      await closed
      if (broken) throw broken
    } catch (err) {
      // Den Strom abbestellen, sonst bleibt die Verbindung offen und lädt
      // munter weiter in einen Puffer, den niemand mehr ausliest.
      await reader.cancel().catch(() => undefined)
      file.destroy()
      throw err
    }

    // Ein abgeschnittener Strom sieht von hier aus wie ein zu Ende gelesener.
    // Nur die angekündigte Länge verrät den Unterschied — und genau dieser Fall
    // ist der, der sonst als vermeintlich fertiges Modell liegen bliebe.
    if (announced > 0 && received !== announced) {
      throw new Error(
        `${baseName(target)} kam unvollständig an — ${received} von ${announced} Byte. ` +
          'Der angefangene Teil ist weggeräumt; ein zweiter Versuch fängt sauber neu an.'
      )
    }
  } catch (err) {
    await rm(part, { force: true })
    throw new Error(explain(err, url, received))
  } finally {
    clearTimeout(watchdog)
  }

  try {
    await rm(target, { force: true })
    await rename(part, target)
  } catch (err) {
    await rm(part, { force: true })
    throw new Error(
      `${baseName(target)} ließ sich nicht an seinen Platz legen: ${(err as Error).message}. ` +
        'Vermutlich hat ein laufender Dienst die alte Datei noch offen — starte James neu und hol es dann.'
    )
  }

  meter.next(received)
  meter.tick(0, true)
}

/**
 * Ein Archiv holen, entpacken und flachziehen.
 *
 * ZIP und entpackter Ordner liegen bewusst als Geschwister neben dem Zielordner
 * und nicht in einem Temp-Verzeichnis des Systems: `rename` über Laufwerksgrenzen
 * hinweg scheitert mit `EXDEV`, und der Zielordner darf laut den Einstellungen
 * auf einer ganz anderen Platte liegen. Beides wird am Ende weggeräumt, auch
 * wenn dazwischen etwas schiefgeht.
 */
async function installArchive(
  id: LocalAssetId,
  url: string,
  meter: Meter,
  dir: string,
  exeName: string
): Promise<void> {
  const zip = join(dirname(dir), `${id}.zip`)
  const unpacked = join(dirname(dir), `${id}.entpackt`)

  try {
    await download(url, zip, meter)
    // Der Balken steht jetzt voll, fertig ist es aber nicht: Entpacken dauert
    // bei zwanzig Megabyte spürbar. `done` bleibt deshalb aus — ein voller
    // Balken, der noch arbeitet, ist ehrlicher als einer, der zu früh grün wird.
    meter.tick(0, true)

    await rm(unpacked, { recursive: true, force: true })
    await mkdir(unpacked, { recursive: true })
    await powershell(
      `$ProgressPreference = 'SilentlyContinue'; ` +
        `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(unpacked)} -Force`
    )

    const home = await findHome(unpacked, exeName.toLowerCase())
    if (!home) {
      throw new Error(
        `In ${baseName(url)} steckt keine ${exeName}. Das Archiv ist nicht das, was hier erwartet wird.`
      )
    }
    await moveInto(home, dir)

    if (!existsSync(join(dir, exeName))) {
      throw new Error(`${exeName} ist nach dem Entpacken nicht in ${dir} angekommen.`)
    }
  } finally {
    await rm(zip, { force: true })
    await rm(unpacked, { recursive: true, force: true })
  }
}

/**
 * Wo im entpackten Baum die gesuchte Datei liegt.
 *
 * whisper packt seine Dateien unter `Release/`, piper unter `piper/` — beide
 * tragen also einen Ordner obendrauf, und beide könnten das beim nächsten
 * Release anders machen. Gesucht wird deshalb, statt einen Namen zu raten. Vier
 * Ebenen sind reichlich; wer tiefer packt, packt etwas anderes.
 */
async function findHome(dir: string, wanted: string, depth = 4): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true })
  if (entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === wanted)) return dir
  if (depth <= 0) return null
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = await findHome(join(dir, entry.name), wanted, depth - 1)
    if (found) return found
  }
  return null
}

/**
 * Den Inhalt eines Ordners in einen anderen schieben.
 *
 * Vorher wird weggeräumt, was am Zielort gleich heißt: `rename` über einen
 * bestehenden Ordner hinweg scheitert unter Windows, und beim zweiten Holen ist
 * `espeak-ng-data` genau so ein bestehender Ordner.
 */
async function moveInto(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from)) {
    const target = join(to, entry)
    await rm(target, { recursive: true, force: true })
    await rename(join(from, entry), target)
  }
}

/**
 * PowerShell einmal laufen lassen und auf sein Ende warten.
 *
 * Derselbe Aufruf wie bei der Eingabesteuerung — ohne Profil, ohne Rückfragen,
 * ohne Fenster. Anders als dort bleibt hier nichts stehen: Das Entpacken ist ein
 * einmaliger Vorgang, und einen Prozess dafür am Leben zu halten, hätte niemand
 * etwas davon.
 */
async function powershell(script: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true }
    )

    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Das Entpacken hat zu lange gedauert und wurde abgebrochen.'))
    }, UNZIP_TIMEOUT_MS)

    child.stderr?.setEncoding('utf-8')
    child.stderr?.on('data', (text: string) => {
      stderr += text
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`PowerShell ließ sich nicht starten: ${err.message}`))
    })

    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve()
        return
      }
      // Die erste Zeile von PowerShell ist die Fehlermeldung; alles danach ist
      // Stapelspur und hilft niemandem, der auf einen Knopf gedrückt hat.
      const first = stderr.trim().split(/\r?\n/)[0]?.trim()
      reject(new Error(first || `Das Entpacken brach mit Code ${code} ab.`))
    })
  })
}

/** In PowerShell sind einfache Anführungszeichen wörtlich; verdoppelt stehen sie für sich selbst. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function host(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * Aus einem geworfenen Ding ein Satz, den man lesen kann.
 *
 * `fetch` wirft für jeden Netzfehler denselben `TypeError`, und dessen Text ist
 * "fetch failed" oder "terminated" — das sagt niemandem etwas. Der brauchbare
 * Teil steht eine Ebene tiefer in `cause`; von dort kommt "getaddrinfo
 * ENOTFOUND huggingface.co", und damit lässt sich etwas anfangen.
 *
 * Ob schon Bytes geflossen sind, entscheidet über den Satz: Eine Leitung, die
 * nach vierhundert Megabyte abreißt, war sehr wohl zu erreichen, und jemandem
 * das Gegenteil zu erzählen, schickt ihn in die falsche Fehlersuche.
 *
 * Eigene Fehler dieses Moduls sind schon ganze Sätze und gehen unberührt durch.
 */
function explain(err: unknown, url: string, received: number): string {
  const error = err as Error & { cause?: { message?: string } }
  if (error.name === 'AbortError' || error.name === 'TimeoutError') {
    return (
      `Die Leitung zu ${host(url)} stand ${Math.round(STALL_MS / 1000)} Sekunden still. ` +
      'Abgebrochen — der angefangene Teil ist weggeräumt.'
    )
  }
  if (error instanceof TypeError) {
    const detail = error.cause?.message ?? error.message
    return received > 0
      ? `Die Verbindung zu ${host(url)} ist mitten im Laden abgerissen: ${detail}. Der angefangene Teil ist weggeräumt.`
      : `${host(url)} war nicht zu erreichen: ${detail}`
  }
  return error.message
}

/**
 * Fehlende lokale Stücke beim Start selbst holen.
 *
 * Nacheinander, nicht gleichzeitig: Fünf parallele Downloads teilen sich nur
 * dieselbe Leitung und machen jeden einzelnen langsamer. Ein Fehlschlag
 * hält die übrigen nicht auf; der Fortschritt erscheint wie beim Klick in den
 * Einstellungen, und beim nächsten Start wird es erneut versucht.
 */
export async function ensureLocalAssets(): Promise<void> {
  for (const asset of localAssets()) {
    if (asset.present || running.has(asset.id)) continue
    try {
      await installLocalAsset(asset.id)
      console.info(`[lokal] ${NAMES[asset.id]} automatisch installiert.`)
    } catch (err) {
      console.warn(`[lokal] ${NAMES[asset.id]} nicht installiert: ${(err as Error).message}`)
    }
  }
}
