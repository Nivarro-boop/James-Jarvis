import { createHash } from 'node:crypto'
import { clipboard } from 'electron'
import { Type, type ToolListUnion } from '@google/genai'
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { friendlyGeminiError, geminiClient } from '../../providers/gemini'
import { getSettings } from '../../store/settings'
import { consumeModelCall } from '../../agent/modelBudget'
import {
  activeDisplay,
  captureRegion,
  captureScreen,
  click,
  cursorPosition,
  displayForWindow,
  displayPoint,
  drag,
  focusWindow,
  inputBackendStatus,
  listWindows,
  mouseDown,
  mouseUp,
  moveMouse,
  pressHotkey,
  scroll,
  typeText,
  type DisplayTarget,
  type Modifier,
  type MouseButton,
  type ScrollDirection
} from '../../automation/desktop'
import { logAction, recordSaving } from '../../db'
import { modelTurn } from '../../providers/geminiTurn'
import { chatGptVision } from '../../providers/chatgptVision'

/**
 * Bildschirmgesteuerte Computerbedienung — die zweite Stufe.
 *
 * Zum Aufbau: Gemini bringt ein eingebautes Computer-Use-Werkzeug mit, das
 * aber im aktuellen SDK nur `ENVIRONMENT_BROWSER` kennt — für den Desktop gibt
 * es keinen Wert. Statt auf eine Vorschaufunktion zu setzen, deren
 * Desktop-Variante hier gar nicht ansprechbar ist, deklarieren wir den
 * Aktionsraum selbst als gewöhnliche Funktionen.
 *
 * Das hat drei Vorteile: es läuft mit jedem Modell, das Funktionsaufrufe kann,
 * wir bestimmen den Aktionsraum vollständig, und die Sicherheitsprüfung liegt
 * bei uns statt bei einem Modellurteil. Der Preis ist, dass wir Googles
 * `safety_decision` nicht bekommen — deshalb ist die eigene Sperrliste unten
 * nicht optional, sondern trägt die gesamte Absicherung.
 */

const MAX_STEPS = 30

/** Wie oft zwischendurch geprüft wird, ob ein gesperrtes Fenster aufging. */
const GUARD_EVERY = 4

/** Nach so vielen gleichen Versuchen hintereinander ist Schluss. */
const MAX_REPEATS = 3

/**
 * Wie viele Aktionen in einem Stapel stehen dürfen.
 *
 * Nach oben begrenzt, weil die Koordinaten eines Stapels alle vom selben Bild
 * stammen: Je länger die Kette, desto wahrscheinlicher ist der letzte Klick
 * schon nicht mehr dort, wo er beim Fotografieren war. Acht deckt jeden
 * Ablauf ab, den man ohne Zwischenblick sicher kennt — Feld anklicken,
 * markieren, tippen, bestätigen — und hört auf, bevor es Raten wird.
 */
const MAX_BATCH = 8

/**
 * Kachelbudget für die Bilder. Zwei sind auf 16:9 rund 1365 mal 768
 * Bildpunkte, drei rund 1536 mal 864 — jede Kachel kostet dasselbe wie ein
 * kurzer Absatz Text, und zwar bei jedem einzelnen Schritt.
 */
const VISION_TILES_SAVER = 2
const VISION_TILES_FULL = 3

/** Ein Zug des Modells, flach wie im Schema. */
interface ActionArgs {
  action?: string
  intent?: string
  x?: number
  y?: number
  toX?: number
  toY?: number
  width?: number
  height?: number
  modifiers?: unknown
  text?: string
  clear?: boolean
  keys?: string
  repeat?: number
  direction?: string
  amount?: number
  seconds?: number
  success?: boolean
  summary?: string
}

/**
 * Fenster und Vorhaben, bei denen James grundsätzlich nichts tut.
 *
 * Ausgeführt, weil die Fenstersteuerung (`window.ts`) denselben Schutz braucht:
 * Sie bedient dieselben Fenster, nur über den Bedienbaum statt über Bildpunkte.
 * Eine zweite, gepflegte Kopie dieser Liste wäre eine Kopie, die irgendwann
 * hinterherhinkt — und zwar an der Stelle, an der es am meisten wehtut.
 */
export const BLOCKED_PATTERNS = [
  /bank|sparkasse|raiffeisen|volksbank|erste bank|george|revolut|paypal|klarna|n26/i,
  /bitwarden|1password|lastpass|keepass|dashlane|passwor[dt]|kennwort/i,
  /kreditkarte|credit card|zahlungsmittel|payment method|checkout|kasse|bezahlen/i,
  /systemsteuerung|control panel|registry|regedit|gruppenrichtlinien|bitlocker/i,
  /steuer|elster|finanzamt/i
]

/** Text, der niemals getippt wird — unabhängig davon, wo. */
export const BLOCKED_INPUT =
  /passwor[dt]|kennwort|\bpin\b|cvv|cvc|iban|kartennummer|card number|seed phrase/i

/**
 * Der Aktionsraum, den das Modell benutzen darf.
 *
 * Eine einzige Funktion mit einem `action`-Feld statt neun einzelner — das ist
 * der Zuschnitt, den Anthropic für sein Computer-Use-Werkzeug gewählt hat, und
 * er hat hier zwei handfeste Gründe.
 *
 * Erstens die Stapelverarbeitung: `computer_batch` nimmt eine Liste von genau
 * dieser Form entgegen. Neun getrennte Funktionen ließen sich nicht ohne
 * Weiteres in eine Liste packen, weil Geminis Schema-Teilmenge kein `oneOf`
 * annimmt.
 *
 * Zweitens die Beschreibungen: sie gehen bei jedem der bis zu dreißig Schritte
 * erneut über die Leitung. Eine Deklaration statt neun ist an dieser Stelle
 * kein Aufräumen, sondern eine Ersparnis, die sich mit jedem Schritt
 * wiederholt.
 */
const INTENT = { type: Type.STRING, description: 'Worauf du zielst und warum, in wenigen Worten.' }

/** Alles, was in einem Stapel stehen darf — also alles außer `done`. */
const BATCHABLE = [
  'screenshot',
  'zoom',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'mouse_move',
  'left_mouse_down',
  'left_mouse_up',
  'drag',
  'scroll',
  'type',
  'key',
  'cursor_position',
  'read_clipboard',
  'write_clipboard',
  'wait'
] as const

/** Was das Bild verändern kann. Alles andere sieht nur hin. */
const CHANGES_SCREEN = new Set<string>([
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'left_mouse_down',
  'left_mouse_up',
  'drag',
  'scroll',
  'type',
  'key'
])

const ACTION_PROPERTIES = {
  x: { type: Type.NUMBER, description: 'Waagrecht, 0 bis 1000.' },
  y: { type: Type.NUMBER, description: 'Senkrecht, 0 bis 1000.' },
  toX: { type: Type.NUMBER, description: 'Nur für drag: Zielpunkt waagrecht.' },
  toY: { type: Type.NUMBER, description: 'Nur für drag: Zielpunkt senkrecht.' },
  width: { type: Type.NUMBER, description: 'Nur für zoom: Breite des Ausschnitts, 0 bis 1000.' },
  height: { type: Type.NUMBER, description: 'Nur für zoom: Höhe des Ausschnitts, 0 bis 1000.' },
  modifiers: {
    type: Type.ARRAY,
    items: { type: Type.STRING, enum: ['ctrl', 'shift', 'alt', 'win'] },
    description: 'Tasten, die während des Klicks gehalten werden.'
  },
  text: { type: Type.STRING, description: 'Nur für type und write_clipboard: der Text.' },
  clear: {
    type: Type.BOOLEAN,
    description: 'Nur für type: vorhandenen Inhalt vorher markieren und ersetzen.'
  },
  keys: {
    type: Type.STRING,
    description: 'Nur für key: Tasten mit Plus verbunden, etwa "strg+s" oder "alt+tab".'
  },
  repeat: { type: Type.NUMBER, description: 'Nur für key: wie oft, höchstens 30.' },
  direction: {
    type: Type.STRING,
    enum: ['up', 'down', 'left', 'right'],
    description: 'Nur für scroll.'
  },
  amount: { type: Type.NUMBER, description: 'Nur für scroll: Rasten, Standard vier.' },
  seconds: { type: Type.NUMBER, description: 'Nur für wait: höchstens fünf.' },
  intent: INTENT
} as const

const ACTION_DESCRIPTION = `
Eine Aktion auf dem Bildschirm.

screenshot: ein frisches Bild, ohne etwas zu verändern.
zoom: Ausschnitt in voller Auflösung — für zu kleinen Text, statt zu raten. Braucht x, y, width, height.
left_click, right_click, middle_click, double_click, triple_click: klickt bei x, y. triple_click markiert in einem Textfeld die ganze Zeile.
mouse_move: bewegt nur den Zeiger, für Menüs die beim Überfahren aufklappen.
left_mouse_down und left_mouse_up: Taste halten und loslassen, für Schieberegler und Rahmenauswahl.
drag: zieht von x, y nach toX, toY.
scroll: gib x und y an, das Rad wirkt dort wo der Zeiger steht.
type: tippt text in das Feld mit dem Eingabefokus. Mit x, y wird vorher dorthin geklickt, mit clear der Inhalt ersetzt.
key: drückt eine Kombination. Oft zuverlässiger als ein Klick.
cursor_position: wo der Zeiger gerade steht.
read_clipboard und write_clipboard: Zwischenablage lesen und setzen. Text aus einem Feld holst du mit strg+a, strg+c und read_clipboard — das ist genauer als Ablesen.
wait: wenn die Oberfläche noch lädt.
`.trim()

function actionSchema(withDone: boolean): Record<string, unknown> {
  return {
    type: Type.OBJECT,
    properties: {
      action: {
        type: Type.STRING,
        enum: withDone ? [...BATCHABLE, 'done'] : [...BATCHABLE],
        description: ACTION_DESCRIPTION
      },
      ...ACTION_PROPERTIES,
      ...(withDone
        ? {
            success: { type: Type.BOOLEAN, description: 'Nur für done.' },
            summary: {
              type: Type.STRING,
              description: 'Nur für done: was erreicht wurde, in einem Satz.'
            }
          }
        : {})
    },
    required: ['action', 'intent']
  }
}

const ACTION_DECLARATIONS: ToolListUnion = [
  {
    functionDeclarations: [
      {
        name: 'computer',
        description: 'Führt genau eine Aktion aus. Danach bekommst du ein neues Bild.',
        parameters: actionSchema(true)
      },
      {
        name: 'computer_batch',
        description:
          'Führt mehrere Aktionen nacheinander aus und zeigt danach ein Bild. Bricht bei der ' +
          'ersten fehlgeschlagenen Aktion ab und sagt, wie weit sie kam. Alle Koordinaten ' +
          'beziehen sich auf das Bild, das du gerade siehst — plane also nur so weit, wie du ' +
          'ohne neues Bild sicher bist. Höchstens acht Aktionen.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            actions: {
              type: Type.ARRAY,
              items: actionSchema(false)
            }
          },
          required: ['actions']
        }
      }
    ]
  }
]

const SYSTEM_INSTRUCTION = `
Du steuerst einen Windows-Rechner über Bildschirmfotos.

Koordinaten laufen von 0 bis 1000, unabhängig von der echten Auflösung:
0,0 ist oben links, 1000,1000 unten rechts — bezogen auf das Bild, das du
gerade siehst. Begründe jede Aktion im Feld intent.

Fass zusammen, was zusammengehört. Jedes einzelne computer bedeutet ein neues
Bildschirmfoto und einen weiteren Zug; computer_batch erledigt eine ganze
Folge und zeigt danach ein Bild. Wo du den Ablauf ohne Zwischenblick kennst —
ins Feld klicken, Inhalt ersetzen, Enter — gehört er in einen Stapel. Wo du
erst sehen musst, was passiert ist, nimmst du eine einzelne Aktion. Alle
Koordinaten eines Stapels beziehen sich auf das Bild von vorher; plane also
nur so weit, wie du dir ohne neues Bild sicher bist. Ein Stapel, der nach der
zweiten Aktion ins Leere greift, kostet mehr als zwei einzelne Züge.

So arbeitest du zuverlässig:

Sieh dir das Bild genau an, bevor du klickst, und benenne im intent das
Element, auf das du zielst. Ist Text zu klein, um ihn sicher zu lesen, nimm
zoom, statt zu raten. Musst du wissen, was in einem Feld steht, markiere es
mit strg+a, kopiere mit strg+c und lies es mit read_clipboard — das ist
genauer als jedes Ablesen und billiger als ein zweites Bild.

Tastatur schlägt Maus. Enter, Tab, Escape, Strg+S und die Pfeiltasten treffen
immer; ein Klick kann danebengehen. Ein gefülltes Textfeld überschreibst du
mit type und clear, nicht mit zwanzigmal Backspace.

Findest du etwas nicht, scrolle — und gib dabei x und y über der Fläche an,
die scrollen soll. Lädt etwas noch, nimm wait, statt blind weiterzuklicken.

Hat sich nach einer Aktion nichts am Bild verändert, wiederhole sie nicht.
Entweder war das Ziel daneben, oder das Fenster ist nicht im Vordergrund —
dann klicke es zuerst an. Nach drei erfolglosen Versuchen an derselben Stelle
rufst du done mit success false auf und sagst, was im Weg stand.

Diese Grenzen gelten ohne Ausnahme: Du gibst keine Passwörter, PINs,
Kartennummern oder andere Zahlungsdaten ein. Du schließt keine Käufe oder
Bestellungen ab. Du löst keine Sicherheitsabfragen. Stößt du auf so etwas,
rufe done mit success false auf und erklär im summary, woran es lag.
`.trim()

/**
 * Der Schubs zum Stapeln.
 *
 * Ein Modell, das einmal Einzelaktionen fährt, bleibt dabei — es hat ja
 * funktioniert. Der Hinweis kommt deshalb nicht in die Systemanweisung, wo er
 * einmal am Anfang gelesen und dann überschrieben wird, sondern an das
 * Ergebnis einer Einzelaktion, direkt neben dem Beleg dafür, dass sie geklappt
 * hat. Nicht bei jeder: sonst ist er nach drei Zügen Tapete.
 */
const BATCH_REMINDER =
  'Diese Aktion war absehbar — wenn du die nächsten Schritte ohne Zwischenblick kennst, ' +
  'nimm computer_batch und spar dir die Bilder dazwischen.'

/** Nach so vielen Einzelaktionen in Folge kommt der Hinweis einmal mit. */
const BATCH_REMINDER_AFTER = 3

const computerTask = defineTool({
  name: 'computer_task',
  group: 'system',
  description:
    'Übernimmt Maus und Tastatur und erledigt eine Aufgabe auf dem Bildschirm, gesteuert über ' +
    'Bildschirmfotos — langsam und teuer. Nimm zuerst desktop_task; das hier nur für Spiele, ' +
    'Zeichenflächen und Fenster ohne Bedienelemente. Für Programme starten nimm open_app, ' +
    'für Webseiten die Chrome-Werkzeuge. Passend für Dinge wie: im NoRisk Launcher ein Profil ' +
    'auswählen und starten, oder in einem Programm eine Einstellung ändern.',
  schema: z.object({
    goal: z.string().describe('Was erreicht werden soll, in einem Satz und konkret.'),
    startApp: z
      .string()
      .optional()
      .describe('Programm, das vorher in den Vordergrund geholt werden soll.')
  }),
  // Bewusst ohne Zwangsrückfrage: bei jedem "mach mal eben" erst zu fragen
  // macht das Werkzeug im Alltag unbenutzbar. Die Absicherung tragen die
  // Sperrliste unten und der Not-Aus über dreimal Escape — die bleiben, und
  // sie sind auch das, was wirklich schützt. Wer die Rückfrage möchte, stellt
  // computer_task in den Einstellungen auf "fragt nach".
  spokenHint: 'Okay.',
  async execute({ goal, startApp }, ctx) {
    const settings = getSettings()
    const useChatGpt = settings.brainProvider === 'chatgpt' || settings.speech.thinkProvider === 'chatgpt'
    const client = useChatGpt ? null : geminiClient()

    // Erst prüfen, ob überhaupt jemand Maus und Tastatur bewegen kann. Ohne
    // das läuft der Vision-Durchlauf los, macht Bildschirmfotos, bezahlt sie
    // und scheitert dann bei jedem einzelnen Schritt am selben Punkt.
    const backend = await inputBackendStatus()
    if (backend.grund) {
      throw new Error(
        'Ich komme gerade nicht an Maus und Tastatur. Sag dem Nutzer, dass die ' +
          `Bildschirmsteuerung nicht startet: ${backend.grund}`
      )
    }

    // Auf welchem Bildschirm gearbeitet wird, steht einmal am Anfang fest.
    // Mittendrin zu wechseln hieße, dass sich die Bedeutung der Koordinaten
    // unter dem Modell verändert.
    let display: DisplayTarget = activeDisplay()

    if (startApp) {
      const focused = await focusWindow(startApp).catch(() => null)
      display = displayForWindow(focused?.bounds) ?? display
      await sleep(800, ctx.signal)
    }

    // Sperrliste gegen den aktuellen Fensterzustand prüfen, bevor überhaupt
    // ein Foto gemacht wird.
    const guard = await checkWindows()
    if (guard) throw new Error(guard)

    /**
     * Wie groß die Bilder sein dürfen.
     *
     * Hängt am Sparmodus statt an einem eigenen Regler: Wer ihn einschaltet,
     * will genau diesen Handel — eine Kachel statt zwei halbiert die Bildkosten
     * jedes Schritts, und was dabei an Lesbarkeit verloren geht, holt `zoom`
     * gezielt wieder herein.
     */
    const tiles = settings.tokenSaver.enabled ? VISION_TILES_SAVER : VISION_TILES_FULL

    /**
     * Der Gesprächsverlauf — ohne Bilder.
     *
     * Er wechselt streng zwischen `user` und `model` und beginnt mit `user`.
     * Beides ist keine Stilfrage: Die API lehnt einen Verlauf, der mit einem
     * Funktionsaufruf des Modells anfängt, mit "function call turn comes
     * immediately after a user turn" ab — genau daran ist dieses Werkzeug
     * bisher bei jedem zweiten Schritt gestorben. Die Werkzeugantwort steckt
     * deshalb im selben user-Zug wie das nächste Bild und nicht in einem
     * eigenen.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const history: any[] = []
    /** Name des Aufrufs, dessen Ergebnis dem Modell noch mitzuteilen ist. */
    let pending: string | null = null
    let lastResult = ''
    let lastShotHash = ''
    /** Ausschnitte aus zoom — werden dem nächsten Zug beigelegt. */
    let details: { base64: string; mimeType: string }[] = []
    let repeatedSignature = ''
    let repeats = 0
    let singleActionRun = 0
    let expectedChange = false
    /** Wie viele Züge das Stapeln erspart hat, in Bildkosten gerechnet. */
    let savedTurns = 0
    const held = { left: false }

    try {
    const maxSteps = settings.tokenSaver.enabled ? 15 : MAX_STEPS
    for (let step = 0; step < maxSteps; step++) {
      if (ctx.signal.aborted) {
        return { abgebrochen: true, grund: 'Vom Nutzer gestoppt.', schritte: step }
      }

      // Ein gesperrtes Fenster kann auch mittendrin aufgehen — etwa weil ein
      // Klick die Bezahlseite geöffnet hat. Einmal am Anfang zu prüfen reicht
      // dafür nicht.
      if (step > 0 && step % GUARD_EVERY === 0) {
        const later = await checkWindows()
        if (later) return { abgebrochen: true, grund: later, schritte: step }
      }

      let shot = await captureScreen({ maxTiles: tiles, target: display })
      let shotHash = createHash('sha1').update(shot.base64).digest('hex')
      if (expectedChange && shotHash === lastShotHash) {
        await sleep(450, ctx.signal)
        ctx.signal.throwIfAborted()
        shot = await captureScreen({ maxTiles: tiles, target: display })
        shotHash = createHash('sha1').update(shot.base64).digest('hex')
      }
      const unchanged = expectedChange && shotHash === lastShotHash
      /**
       * Hat der letzte Zug überhaupt etwas bewegt?
       *
       * Entweder er konnte es gar nicht — ein `screenshot` verändert nichts —
       * oder er hätte es sollen und das Bild ist trotzdem dasselbe. Beides
       * heißt: der Zug war folgenlos. Nur `unchanged` zu nehmen würde eine
       * Schleife aus lauter `screenshot`-Aufrufen nie bemerken.
       */
      const ineffective = step > 0 && (!expectedChange || shotHash === lastShotHash)
      lastShotHash = shotHash

      // Retain complete user/model pairs, including Gemini thought signatures.
      trimHistory(history, settings.tokenSaver.enabled ? 6 : MAX_TURNS)
      const text = (step > 0 ? `Aufgabe: ${goal}\n` : '') + turnText(step, goal, display, lastResult, unchanged, details.length)
      const answer = pending
        ? { functionResponse: { name: pending, response: { status: lastResult } } }
        : null

      const parts: Record<string, unknown>[] = []
      if (answer) parts.push(answer)
      parts.push({ inlineData: { mimeType: shot.mimeType, data: shot.base64 } })
      for (const extra of details) {
        parts.push({ inlineData: { mimeType: extra.mimeType, data: extra.base64 } })
      }
      parts.push({ text })
      details = []

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let response: any
      try {
        if (useChatGpt) {
          const recent = history.map(turn => turn.parts.map((part: any) =>
            part.text ?? (part.functionCall ? JSON.stringify(part.functionCall) :
              part.functionResponse ? JSON.stringify(part.functionResponse) : '')
          ).filter(Boolean).join(' ')).join('\n')
          const declarations = (ACTION_DECLARATIONS[0] as any).functionDeclarations
          const result = await chatGptVision(settings.chatGptModel, SYSTEM_INSTRUCTION,
            `${text}\nLetzte Schritte:\n${recent}`,
            parts.filter(part => part.inlineData).map(part => {
              const image = part.inlineData as { mimeType: string; data: string }
              return { mimeType: image.mimeType, base64: image.data }
            }), declarations, ctx.signal)
          response = { functionCalls: result.output.filter(item => item.type === 'function_call').map(item => ({
            name: String(item.name ?? '').replace(/^jarvis\./, ''),
            args: typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments
          })) }
        } else {
          consumeModelCall()
          response = await client!.models.generateContent({
            model: settings.visionModel,
            contents: [...history, { role: 'user', parts }],
            config: {
              tools: ACTION_DECLARATIONS,
              systemInstruction: SYSTEM_INSTRUCTION,
              abortSignal: ctx.signal
            }
          })
        }
      } catch (err) {
        throw new Error(useChatGpt ? (err instanceof Error ? err.message : String(err)) : friendlyGeminiError(err))
      }

      // Derselbe Zug wandert in den Verlauf, nur ohne die Bilder: Es soll
      // immer genau ein Bildschirmfoto in der Anfrage stehen, das aktuelle.
      history.push({ role: 'user', parts: answer ? [answer, { text }] : [{ text }] })
      pending = null

      const call = firstFunctionCall(response)
      if (!call) {
        return {
          abgebrochen: true,
          grund: 'Das Modell hat keine Aktion vorgeschlagen.',
          schritte: step
        }
      }

      const batched = call.name === 'computer_batch'
      let steps: ActionArgs[] = batched
        ? (Array.isArray(call.args?.actions) ? call.args.actions : []).slice(0, MAX_BATCH)
        : [call.args ?? {}]

      /**
       * `done` beendet den Vorgang.
       *
       * Im Stapelschema steht es nicht, aber ein Modell hängt es trotzdem gern
       * hinten an. Dann führen wir aus, was davorsteht, und beenden — statt den
       * Stapel an einer "unbekannten Aktion" scheitern zu lassen und einen
       * ganzen Zug samt Bild dafür zu bezahlen, dass das Modell dasselbe gleich
       * noch einmal sagt.
       */
      const doneAt = steps.findIndex((s) => s.action === 'done')
      const finish = doneAt >= 0 ? steps[doneAt] : null
      if (finish) steps = steps.slice(0, doneAt)

      if (steps.length === 0 && !finish) {
        lastResult = 'Der Stapel war leer. Nenne mindestens eine Aktion.'
        expectedChange = false
        pending = call.name
        history.push(firstCallTurn(response, call))
        continue
      }

      // Die Sperrliste greift vor der ersten Aktion des Stapels, nicht erst
      // beim Ausführen: sonst liefe der harmlose Anfang los und erst der
      // fünfte Schritt fiele auf, wenn schon vier gewirkt haben.
      for (const one of steps) {
        const blocked = blockedAction(one)
        if (blocked) {
          logAction({
            tool: 'computer_task:blocked',
            args: { step, action: one.action, intent: one.intent },
            ok: false,
            error: blocked,
            durationMs: 0
          })
          return { abgebrochen: true, grund: blocked, schritte: step }
        }
      }

      /**
       * Immer dieselbe Aktion, und dabei passiert nichts — dann merkt das
       * Modell es nicht, und wir zahlen fünfundzwanzig Bildschirmfotos für
       * eine Schleife.
       *
       * Entscheidend ist das "und dabei passiert nichts". Vorher zählte schon
       * die Wiederholung für sich, und damit brach der Lauf mitten in
       * gewöhnlicher Bedienung ab: viermal Pfeil-runter in einer Liste,
       * dreimal scrollen auf einer langen Seite, Backspace in einem Feld. Das
       * sind keine Schleifen, das ist Tippen. Eine Schleife ist dieselbe
       * Aktion *ohne Wirkung*.
       */
      const signature = steps.map(actionSignature).join('>')
      repeats = signature === repeatedSignature && ineffective ? repeats + 1 : 0
      repeatedSignature = signature
      if (repeats >= MAX_REPEATS) {
        return {
          abgebrochen: true,
          grund: `Dieselbe Aktion (${steps[0].action}) hat ${MAX_REPEATS} Mal nichts bewirkt.`,
          schritte: step
        }
      }

      logAction({
        tool: batched ? 'computer_task:batch' : 'computer_task:step',
        args: { step, aktionen: steps.map((s) => s.action), intent: steps[0].intent },
        ok: true,
        durationMs: 0
      })

      history.push(firstCallTurn(response, call))
      pending = call.name

      const outcome = await runSteps(steps, display, tiles, ctx.signal, held)
      details = outcome.details
      expectedChange = outcome.changed
      lastResult = outcome.text

      // Jede Aktion über die erste hinaus ist ein Zug, der nicht stattfindet —
      // und damit ein Bildschirmfoto, das niemand bezahlt.
      const spared = outcome.ran - 1
      if (spared > 0) {
        savedTurns += spared
        recordSaving('vision', spared * shot.tokens)
      }

      if (finish) {
        return {
          fertig: Boolean(finish.success) && outcome.ok,
          ergebnis: String(finish.summary ?? ''),
          schritte: step,
          gestapelt: savedTurns
        }
      }

      // Der Schubs zum Stapeln, aber nur nach einer Strähne von Einzelzügen
      // und nur, wenn nichts schiefging — nach einem Fehlschlag hat das Modell
      // Dringenderes zu lesen.
      singleActionRun = batched ? 0 : singleActionRun + 1
      if (outcome.ok && singleActionRun >= BATCH_REMINDER_AFTER) {
        lastResult = `${lastResult} ${BATCH_REMINDER}`
        singleActionRun = 0
      }

      trimHistory(history)
    }

    return {
      abgebrochen: true,
      grund: `Nach ${maxSteps} Bildschritten war die Aufgabe nicht erledigt${settings.tokenSaver.enabled ? ' — Sparlimit erreicht' : ''}.`,
      gestapelt: savedTurns
    }
    } finally {
      if (held.left) await mouseUp('left').catch(() => undefined)
    }
  }
}) as ToolDefinition

// ─────────────────────────────────────────────────────────────

/**
 * Der Text, der jedem Bild beiliegt.
 *
 * Der Hinweis auf ein unverändertes Bild ist der wichtigste Teil: ohne ihn
 * klickt das Modell dieselbe Stelle wieder und wieder an, weil es den
 * Unterschied zwischen "hat gewirkt" und "hat nichts getan" allein am Foto
 * kaum erkennt.
 */
function turnText(
  step: number,
  goal: string,
  display: DisplayTarget,
  lastResult: string,
  unchanged: boolean,
  detailCount: number
): string {
  if (step === 0) {
    const screenHint = display.primary ? '' : ` Du siehst den ${display.label}.`
    return `Aufgabe: ${goal}${screenHint}`
  }

  const lines = [lastResult]
  if (unchanged) {
    lines.push(
      'Das Bild ist unverändert — die Aktion hat nichts bewirkt. Versuch etwas anderes, ' +
        'statt sie zu wiederholen.'
    )
  }
  if (detailCount === 1) {
    lines.push('Der Ausschnitt liegt als zweites Bild bei.')
  } else if (detailCount > 1) {
    lines.push(`Die ${detailCount} Ausschnitte liegen nach dem Vollbild bei, in dieser Reihenfolge.`)
  }
  lines.push('Mach weiter.')
  return lines.join(' ')
}

interface StepsOutcome {
  /** Was dem Modell als Ergebnis mitgeteilt wird. */
  text: string
  /** Wie viele Aktionen tatsächlich gelaufen sind. */
  ran: number
  /** Ob alle durchgekommen sind. */
  ok: boolean
  /** Ob sich das Bild verändert haben sollte. */
  changed: boolean
  details: { base64: string; mimeType: string }[]
}

/**
 * Führt eine Folge von Aktionen aus und beschreibt, wie weit sie kam.
 *
 * Bricht bei der ersten fehlgeschlagenen ab und sagt das auch — ein Stapel,
 * der stillschweigend zur Hälfte durchläuft, ist schlimmer als einer, der gar
 * nicht startet: Das Modell hielte die Oberfläche dann für einen Zustand, in
 * dem sie nicht ist.
 */
async function runSteps(
  steps: ActionArgs[],
  display: DisplayTarget,
  tiles: number,
  signal: AbortSignal,
  held: { left: boolean }
): Promise<StepsOutcome> {
  const lines: string[] = []
  const details: { base64: string; mimeType: string }[] = []
  let changed = false
  let ran = 0

  for (const [index, one] of steps.entries()) {
    // Dreimal Escape muss auch mitten im Stapel greifen. Ohne diese Prüfung
    // liefe er bis zur achten Aktion durch — der Not-Aus wirkte dann erst,
    // wenn ohnehin alles passiert ist, und wäre damit keiner.
    if (signal.aborted) {
      const left = steps.length - index
      lines.push(`abgebrochen, ${left} Aktionen nicht ausgeführt`)
      return { text: lines.join('; '), ran, ok: false, changed, details }
    }

    const action = String(one.action ?? '')
    try {
      if (action === 'zoom') {
        const region = await captureRegion(
          {
            x: Number(one.x ?? 0),
            y: Number(one.y ?? 0),
            width: Number(one.width ?? 200),
            height: Number(one.height ?? 200)
          },
          { target: display, maxTiles: tiles }
        )
        details.push({ base64: region.base64, mimeType: region.mimeType })
        lines.push(`${action}: Ausschnitt aufgenommen, ${region.width} mal ${region.height} Bildpunkte`)
      } else {
        if (action === 'left_mouse_down') held.left = true
        const note = await performAction(action, one, display, signal)
        if (action === 'left_mouse_up') held.left = false
        lines.push(`${action}: ${note}`)
      }
      signal.throwIfAborted()
      ran++
      if (CHANGES_SCREEN.has(action)) changed = true
    } catch (err) {
      if (signal.aborted) {
        signal.throwIfAborted()
      }
      const message = err instanceof Error ? err.message : String(err)
      // Fällt die Eingabesteuerung ganz aus, hat jeder weitere Schritt
      // denselben Fehler — dann lieber sofort abbrechen als fünfundzwanzig
      // Bildschirmfotos dafür zu bezahlen.
      if (/Bildschirmsteuerung ist nicht verfügbar|Eingabesteuerung/.test(message)) {
        throw err
      }
      const skipped = steps.length - index - 1
      lines.push(`${action}: fehlgeschlagen — ${message}`)
      if (skipped > 0) lines.push(`Abgebrochen, ${skipped} weitere Aktionen übersprungen.`)
      return { text: lines.join('; '), ran, ok: false, changed, details }
    }

    // Zwischen zwei Aktionen eines Stapels muss die Oberfläche nachziehen
    // können — sonst tippt der zweite Schritt in ein Feld, das der erste
    // gerade erst öffnet. Kürzer als die Pause am Zugende: hier wird kein
    // Foto gemacht, auf das etwas fertig sein müsste.
    if (action === 'wait') {
      await sleep(Math.min(5000, Math.max(0, Number(one.seconds ?? 2) * 1000)), signal)
    } else if (index < steps.length - 1 && CHANGES_SCREEN.has(action)) {
      await sleep(160, signal)
    }
  }

  // Der Oberfläche Zeit zum Nachziehen geben — sonst fotografiert der nächste
  // Durchlauf noch den alten Zustand.
  if (changed) await sleep(350, signal)

  return { text: `Ergebnis: ${lines.join('; ')}.`, ran, ok: true, changed, details }
}

/** So viele Züge bleiben stehen; sonst wird jeder Durchlauf teurer als der letzte. */
const MAX_TURNS = 10

/**
 * Kürzt den Verlauf von vorn und lässt ihn dabei gültig.
 *
 * Zwei Bedingungen müssen überleben: Er beginnt mit einem user-Zug — deshalb
 * wird immer eine gerade Anzahl abgeworfen — und keine Werkzeugantwort steht
 * ohne den Aufruf da, zu dem sie gehört. Letzteres trifft genau den neuen
 * Anfang, dessen Aufruf gerade weggefallen ist.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function trimHistory(history: any[], limit = MAX_TURNS): void {
  if (history.length <= limit) return

  const drop = history.length - limit
  history.splice(0, drop % 2 === 0 ? drop : drop + 1)

  const head = history[0]
  if (head?.role !== 'user' || !Array.isArray(head.parts)) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const kept = head.parts.filter((p: any) => !p?.functionResponse)
  head.parts = kept.length > 0 ? kept : [{ text: 'Mach weiter.' }]
}

/** Grober Fingerabdruck einer Aktion, um Wiederholungen zu erkennen. */
function actionSignature(a: ActionArgs): string {
  const round = (v: unknown): string => String(Math.round(Number(v ?? -1) / 10))
  return [a.action ?? '', round(a.x), round(a.y), a.keys ?? '', a.text ?? ''].join('|')
}

/**
 * Der Modellzug für den Verlauf — mit `thoughtSignature`, aber nur mit dem
 * ersten Funktionsaufruf. Ausgeführt und beantwortet wird nur der erste;
 * stünden weitere im Verlauf, lehnte Gemini die nächste Runde ab, weil die
 * Zahl der Antworten nicht zur Zahl der Aufrufe passt.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function firstCallTurn(response: any, call: { name: string; args: any }): { role: 'model'; parts: Record<string, unknown>[] } {
  const turn = modelTurn(response, [{ functionCall: { name: call.name, args: call.args } }])
  let seen = false
  const parts = turn.parts.filter((part) => {
    if (!part.functionCall) return true
    if (seen) return false
    seen = true
    return true
  })
  return { role: 'model', parts }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function firstFunctionCall(response: any): { name: string; args: any } | null {
  const calls = response?.functionCalls
  if (Array.isArray(calls) && calls.length > 0) return calls[0]

  const parts = response?.candidates?.[0]?.content?.parts ?? []
  for (const part of parts) {
    const fc = part.functionCall ?? part.function_call
    if (fc) return fc
  }
  return null
}

async function checkWindows(): Promise<string | null> {
  const windows = await listWindows().catch(() => [])
  for (const win of windows) {
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(win.title)) {
        return (
          `Auf dem Bildschirm ist "${win.title.slice(0, 60)}" offen. In Banking-, Passwort- und ` +
          'Bezahlfenstern übernehme ich grundsätzlich nicht. Schließ das Fenster, dann geht es.'
        )
      }
    }
  }
  return null
}

function blockedAction(a: ActionArgs): string | null {
  for (const key of ['x', 'y', 'toX', 'toY', 'width', 'height', 'repeat', 'amount', 'seconds'] as const) {
    if (a[key] !== undefined && !Number.isFinite(Number(a[key]))) return `Ungültiger Zahlenwert für ${key}. Schritt nicht ausgeführt.`
  }
  const text = String(a.text ?? '')
  if (text && BLOCKED_INPUT.test(text)) {
    return 'Der Schritt wollte etwas eingeben, das nach Zugangs- oder Zahlungsdaten aussieht. Abgebrochen.'
  }

  const intent = String(a.intent ?? '')
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(intent)) {
      return `Der Schritt zielt auf einen gesperrten Bereich (${intent.slice(0, 80)}). Abgebrochen.`
    }
  }

  if (/kaufen|bestellen|jetzt bezahlen|place order|buy now|kostenpflichtig/i.test(intent)) {
    return 'Der Schritt wollte einen Kauf abschließen. Das mache ich grundsätzlich nicht.'
  }

  return null
}

const MODIFIERS = new Set<Modifier>(['ctrl', 'shift', 'alt', 'win'])
const DIRECTIONS = new Set<ScrollDirection>(['up', 'down', 'left', 'right'])

/** Klickaktion → Maustaste und Anzahl. */
const CLICKS: Record<string, { button: MouseButton; count: number }> = {
  left_click: { button: 'left', count: 1 },
  right_click: { button: 'right', count: 1 },
  middle_click: { button: 'middle', count: 1 },
  double_click: { button: 'left', count: 2 },
  triple_click: { button: 'left', count: 3 }
}

function asModifiers(value: unknown): Modifier[] {
  if (!Array.isArray(value)) return []
  return value.filter((m): m is Modifier => MODIFIERS.has(m as Modifier))
}

/**
 * Führt eine einzelne Aktion aus und beschreibt in einem Halbsatz, was dabei
 * herauskam.
 *
 * Die Rückgabe ist nicht Zierde: In einem Stapel ist sie die einzige Auskunft
 * darüber, was zwischen zwei Bildern passiert ist — `cursor_position` und
 * `read_clipboard` haben überhaupt kein anderes Ergebnis.
 */
async function performAction(
  action: string,
  a: ActionArgs,
  display: DisplayTarget,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted()
  const at = (x: unknown, y: unknown): { x: number; y: number } =>
    displayPoint(display, Number(x ?? 0), Number(y ?? 0))

  const click_ = CLICKS[action]
  if (click_) {
    const point = at(a.x, a.y)
    await moveMouse(point.x, point.y)
    signal?.throwIfAborted()
    await click(click_.button, click_.count, asModifiers(a.modifiers))
    return 'ausgeführt'
  }

  switch (action) {
    case 'screenshot':
      // Das Bild macht die Schleife ohnehin nach jedem Zug. Hier steht die
      // Aktion, damit das Modell sie mitten in einen Stapel setzen kann, ohne
      // dass er dafür abbricht.
      return 'Bild folgt'

    case 'mouse_move': {
      const point = at(a.x, a.y)
      await moveMouse(point.x, point.y)
      return 'Zeiger bewegt'
    }

    case 'left_mouse_down': {
      const point = at(a.x, a.y)
      await mouseDown('left', point.x, point.y)
      return 'Taste gedrückt'
    }

    case 'left_mouse_up': {
      const point = at(a.x, a.y)
      await mouseUp('left', point.x, point.y)
      return 'Taste losgelassen'
    }

    case 'type': {
      if (a.x !== undefined && a.y !== undefined) {
        const point = at(a.x, a.y)
        await moveMouse(point.x, point.y)
        // Dreifachklick markiert die Zeile; das Getippte ersetzt sie dann.
        await click('left', a.clear ? 3 : 1)
        await sleep(120, signal)
      } else if (a.clear) {
        // Ohne Zielpunkt bleibt nur der Weg über die Tastatur.
        await pressHotkey('strg+a')
        await sleep(80, signal)
      }
      const text = String(a.text ?? '')
      signal?.throwIfAborted()
      await typeText(text)
      return `${text.length} Zeichen getippt`
    }

    case 'key': {
      const keys = String(a.keys ?? '')
      await pressHotkey(keys, Math.min(30, Math.max(1, Number(a.repeat ?? 1))))
      return `${keys} gedrückt`
    }

    case 'scroll': {
      const direction = DIRECTIONS.has(a.direction as ScrollDirection)
        ? (a.direction as ScrollDirection)
        : 'down'
      const amount = Math.min(20, Math.max(1, Number(a.amount ?? 4)))
      if (a.x !== undefined && a.y !== undefined) {
        const point = at(a.x, a.y)
        await scroll(direction, amount, point.x, point.y)
      } else {
        await scroll(direction, amount)
      }
      return 'gescrollt'
    }

    case 'drag': {
      const from = at(a.x, a.y)
      const to = at(a.toX, a.toY)
      await drag(from.x, from.y, to.x, to.y)
      return 'gezogen'
    }

    case 'cursor_position': {
      const point = await cursorPosition()
      return `Zeiger steht bei ${point.x}, ${point.y} in echten Bildpunkten`
    }

    case 'read_clipboard': {
      const text = clipboard.readText()
      if (!text) return 'Zwischenablage ist leer'
      // Gekappt, weil eine kopierte Seite sonst den halben Zug füllt.
      const shown = text.length > 1200 ? `${text.slice(0, 1200)}…` : text
      return `Zwischenablage: ${shown}`
    }

    case 'write_clipboard':
      clipboard.writeText(String(a.text ?? ''))
      return 'in die Zwischenablage gelegt'

    case 'wait':
      // Gewartet wird in runSteps, damit die Pause auch innerhalb eines
      // Stapels an der richtigen Stelle sitzt.
      return 'gewartet'

    default:
      throw new Error(`Unbekannte Aktion: ${action}`)
  }
}

export function computerDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = (): void => { clearTimeout(timer); reject(signal?.reason ?? new Error('Abgebrochen.')) }
    if (signal?.aborted) { reject(signal.reason); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve() }, ms)
    signal?.addEventListener('abort', cancel, { once: true })
  })
}
const sleep = computerDelay

const screenshotTool = defineTool({
  name: 'screenshot',
  group: 'system',
  description:
    'Macht ein Bild vom Bildschirm und beschreibt, was darauf zu sehen ist. ' +
    'Nutze das, wenn der Nutzer fragt "was siehst du" oder sich auf etwas Sichtbares bezieht.',
  schema: z.object({
    question: z
      .string()
      .optional()
      .describe('Was konkret interessiert. Ohne Angabe eine allgemeine Beschreibung.')
  }),
  async execute({ question }, ctx) {
    const settings = getSettings()
    if (settings.brainProvider === 'chatgpt' || settings.speech.thinkProvider === 'chatgpt') {
      const shot = await captureScreen({ maxTiles: settings.tokenSaver.enabled ? 2 : 4 })
      const response = await chatGptVision(settings.chatGptModel,
        'Beschreibe den Bildschirm kurz und sachlich. Nenne keine Passwörter oder andere sensible Inhalte. Führe keine Aktionen aus.',
        question ?? 'Welches Programm ist offen und was passiert gerade?', [shot], [], ctx.signal)
      return { beschreibung: response.text || 'Keine Beschreibung verfügbar.', bildschirm: shot.display.label }
    }
    const client = geminiClient()
    // Vier Kacheln statt der zwei aus dem Vision-Durchlauf: Hier gibt es nur
    // dieses eine Bild und keinen zoom, mit dem sich Kleingedrucktes
    // nachreichen ließe. Auf einem 16:9-Schirm sind das 1536 mal 864.
    const shot = await captureScreen({ maxTiles: settings.tokenSaver.enabled ? 2 : 4 })

    try {
      consumeModelCall()
      const response = await client.models.generateContent({
        model: settings.visionModel,
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: shot.mimeType, data: shot.base64 } },
              {
                text:
                  question ??
                  'Beschreib kurz, was auf dem Bildschirm zu sehen ist. Welches Programm ist offen und was passiert gerade?'
              }
            ]
          }
        ],
        config: {
          systemInstruction:
            'Antworte in zwei bis drei Sätzen auf Deutsch, ohne Aufzählungen und ohne Markdown. ' +
            'Die Antwort wird vorgelesen. Nenne keine Passwörter oder anderen sensiblen Inhalte, ' +
            'die zufällig sichtbar sind.'
        }
      })
      return { beschreibung: response.text, bildschirm: shot.display.label }
    } catch (err) {
      throw new Error(friendlyGeminiError(err))
    }
  }
}) as ToolDefinition

export const computerTools: ToolDefinition[] = [computerTask, screenshotTool]
