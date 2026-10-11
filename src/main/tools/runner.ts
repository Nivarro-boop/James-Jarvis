import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { z } from 'zod'
import type { DisplayCard, ToolCallRequest, ToolCallResult } from '@shared/types'
import type { GapToolFailureKind } from '@shared/capabilityGap'
import { getTool, type ToolContext } from './registry'
import {
  isHardDenied,
  issueChallenge,
  permissionFor,
  regrantConfirmation,
  verifyConfirmation
} from './permissions'
import { resolveRecipient } from './impl/contacts'
import { resolveMemory } from './impl/memory'
import { resolvePhoneNumber } from '../providers/twilio'
import { abortCameraCaptures } from '../automation/camera'
import { cachedResult, compactResult, rememberResult } from '../agent/tokenSaver'
import { withModelBudget } from '../agent/modelBudget'
import { getSettings } from '../store/settings'
import { TOOL_SEARCH, TOOL_USE } from './impl/toolSearch'
import { gapUserText, noteToolFailure, withGapUserText } from '../agent/capabilityGaps'
import { logAction } from '../db'
import { crystalVisible, sendToCrystal, speak } from '../ipc/emit'
import { activityAnnotate, activityEnd, activityStart, describeTool, thoughtFor } from '../agent/activity'
import { noteFinishedStep } from '../agent/learning'

/**
 * Führt einen Tool-Aufruf aus: Rechte prüfen, gegebenenfalls Rückfrage
 * auslösen, ausführen, protokollieren.
 *
 * Es wird nie geworfen. Ein abgebrochener Tool-Aufruf würde die Live-Sitzung
 * hängen lassen — das Modell wartet auf eine Antwort, und ohne sie schweigt es
 * einfach. Fehler gehen deshalb immer als verwertbarer Text zurück.
 */

let killSwitch = new AbortController()

export function abortAllTools(): void {
  killSwitch.abort()
  killSwitch = new AbortController()
  /*
   * Das Kamerabild hängt an keinem Signal, sondern an einer Antwort aus dem
   * Renderer — es muss eigens aufgelöst werden.
   *
   * Ohne diese Zeile stünde `camera_look` nach dreimal Escape noch zwölf
   * Sekunden lang in seiner Wartezeit, und die Kamera bliebe so lange an. Ein
   * Not-Aus, bei dem das Lämpchen weiterleuchtet, ist keiner.
   */
  abortCameraCaptures()
}

const running = new Set<string>()
const cancellable = new Map<string, AbortController>()

export function cancelToolCall(id: string): void { cancellable.get(id)?.abort() }

export async function runCancellableTool(req: ToolCallRequest): Promise<ToolCallResult> {
  if (cancellable.has(req.id)) return { id: req.id, name: req.name, ok: false, error: 'Auftrag läuft bereits.', durationMs: 0 }
  const controller = new AbortController()
  cancellable.set(req.id, controller)
  try { return await runTool(req, controller.signal) }
  finally { cancellable.delete(req.id) }
}

export function hasRunningTools(): boolean {
  return running.size > 0
}

/**
 * Werkzeuge, die in der Live-Anzeige nicht als eigener Schritt stehen.
 *
 * Der Plan ist die Anzeige selbst — ein Schritt „plan update" darüber wäre
 * nur Rauschen.
 */
const INVISIBLE = new Set(['plan_update'])

function unwrapToolUse(
  args: Record<string, unknown> | undefined
): { name: string; args: Record<string, unknown> } | { error: string } {
  const name = typeof args?.name === 'string' ? args.name.trim() : ''
  if (!name || name === TOOL_USE) return { error: 'tool_use braucht den Namen eines Werkzeugs aus tool_search.' }
  const raw = args?.args_json
  if (raw === undefined || raw === '') return { name, args: {} }
  try {
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { name, args: parsed as Record<string, unknown> }
    }
  } catch {
    // unten gemeldet
  }
  return { error: 'args_json ist kein JSON-Objekt.' }
}

/** Das Feld, über das das Modell eine erteilte Zustimmung mitteilt. */
const CONFIRMED_FLAG = 'confirmed'

/**
 * Für die Fähigkeitslücken: Was der Nutzer wollte, steht im Gesprächszug, bei
 * Unteragenten in dem des Auftrags. Ablehnungen und Abbrüche gehören nicht
 * hierher — die zeigen keine fehlende Fähigkeit. Wirft nie.
 */
function noteGap(req: ToolCallRequest, kind: GapToolFailureKind, detail: string): void {
  noteToolFailure({ tool: req.name, kind, detail, userText: req.userTurn?.lastUserText || gapUserText() })
}

/** `tool_search` ohne Treffer: das deutlichste Zeichen, dass ein Werkzeug fehlt. */
function emptySearch(raw: unknown): boolean {
  const tools = (raw as { tools?: unknown } | null | undefined)?.tools
  return Array.isArray(tools) && tools.length === 0
}

export async function runTool(req: ToolCallRequest, parentSignal?: AbortSignal): Promise<ToolCallResult> {
  // Nachgeladenes Werkzeug: auf den echten Aufruf umschreiben, damit Rechte,
  // Rückfrage und Protokoll genau so greifen wie bei einem direkten Aufruf.
  if (req.name === TOOL_USE) {
    const inner = unwrapToolUse(req.args)
    if ('error' in inner) {
      return { id: req.id, name: req.name, ok: false, error: inner.error, durationMs: 0 }
    }
    const result = await runTool({ ...req, name: inner.name, args: inner.args }, parentSignal)
    return { ...result, id: req.id, name: req.name }
  }

  const started = Date.now()

  const finish = (
    ok: boolean,
    payload: { result?: unknown; error?: string },
    args: unknown,
    confirmed: boolean | null = null,
    /**
     * Was das Werkzeug wirklich geliefert hat. Steht nur im Aktionslog; ans
     * Modell geht die gekürzte Fassung aus `payload`.
     *
     * Ohne diese Trennung schrieb der Sparmodus seine vierzehnhundert Zeichen
     * auch ins Log — also ausgerechnet an die einzige Stelle, an der sich eine
     * Aktion nachvollziehen lässt, weil es keine Chatoberfläche gibt. Das Log
     * kürzt selbst, aber erst bei viertausend Zeichen.
     */
    rawResult: unknown = payload.result
  ): ToolCallResult => {
    const durationMs = Date.now() - started
    logAction({
      tool: req.name,
      args,
      ok,
      result: rawResult,
      error: payload.error,
      durationMs,
      confirmed
    })
    return { id: req.id, name: req.name, ok, ...payload, durationMs }
  }

  if (isHardDenied(req.name)) {
    return finish(
      false,
      {
        error:
          'Diese Aktion ist dauerhaft gesperrt. Kaufabschlüsse und die Eingabe von Zahlungsdaten ' +
          'führt James grundsätzlich nicht aus. Öffne stattdessen die Seite und übergib an den Nutzer.'
      },
      req.args
    )
  }

  const tool = getTool(req.name)
  if (!tool) {
    noteGap(req, 'unknown', req.name)
    return finish(false, { error: `Unbekanntes Werkzeug: ${req.name}` }, req.args)
  }

  // `confirmed` ist unser Meta-Feld und gehört nicht ins Tool-Schema.
  const rawArgs = { ...(req.args ?? {}) }
  const claimsConfirmed = rawArgs[CONFIRMED_FLAG] === true
  delete rawArgs[CONFIRMED_FLAG]

  const parsed = tool.schema.safeParse(rawArgs)
  if (!parsed.success) {
    const issues = (parsed.error as z.ZodError).issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    noteGap(req, 'invalid', issues)
    return finish(false, { error: `Ungültige Argumente — ${issues}` }, rawArgs)
  }

  const args = parsed.data as Record<string, unknown>
  if (parentSignal?.aborted) return finish(false, { error: 'Vom Nutzer abgebrochen.' }, args)
  const permission = permissionFor(req.name)

  if (permission === 'deny') {
    noteGap(req, 'locked', 'In den Einstellungen gesperrt.')
    return finish(false, { error: 'Dieses Werkzeug ist in den Einstellungen gesperrt.' }, args)
  }

  let confirmed: boolean | null = null

  if (permission === 'ask') {
    // Erster Aufruf: nicht ausführen, sondern das Modell die Frage stellen
    // lassen. Der Kristall wird rot, damit auch sichtbar ist, dass gewartet wird.
    const ask = (): ToolCallResult => {
      activityStart({
        id: req.id,
        label: describeTool(req.name, args),
        tool: req.name,
        status: 'waiting',
        parentId: req.parentId,
        source: req.parentId ? 'agent' : 'jarvis'
      })
      const question = buildQuestion(req.name, args)
      const instruction = issueChallenge(req.name, args, question)
      sendToCrystal('confirm:request', {
        id: randomUUID(),
        toolName: req.name,
        spokenQuestion: question,
        details: args
      })
      return finish(false, { error: instruction }, args, null)
    }

    if (!claimsConfirmed) return ask()

    const verdict = verifyConfirmation(req.name, args, req.userTurn)
    sendToCrystal('confirm:resolved', { id: req.id, approved: verdict.ok })
    if (!verdict.ok) {
      // Kein offener Vorgang zu diesen Argumenten heißt nicht "abgelehnt",
      // sondern "die Frage steht noch aus". Ein bloßes Nein hat das Modell
      // hier schon in eine Endlosschleife geschickt: es blieb bei
      // `confirmed: true` und bekam immer dieselbe Absage zurück. Also stellen
      // wir die Frage gleich neu, statt in der Sackgasse zu stehen.
      if (verdict.reissue) return ask()
      return finish(false, { error: verdict.reason }, args, false)
    }
    confirmed = true
  }

  // Sparmodus: derselbe Aufruf mit denselben Argumenten kurz hintereinander
  // wird nicht zweimal ausgeführt und nicht zweimal bezahlt. Greift nur bei
  // Werkzeugen ohne Nebenwirkung — eine gecachte Bestätigung "in den
  // Warenkorb gelegt" wäre schlicht falsch.
  const cached = cachedResult(req.name, args)
  if (cached !== undefined) {
    // Die Karte gehört zur Antwort. `execute` läuft hier nicht, also schickt
    // sie niemand sonst — frisch gestempelt, damit sie wieder volle Zeit steht.
    for (const card of cached.cards) sendToCrystal('display:card', { ...card, at: Date.now() })
    return finish(true, { result: cached.value }, args, confirmed)
  }

  // Den Griff auf das Signal festhalten, statt später erneut `killSwitch` zu
  // lesen: `abortAllTools()` bricht den Controller nicht nur ab, es ersetzt ihn
  // durch einen frischen. Ein späteres `killSwitch.signal.aborted` fragt also
  // den Nachfolger — und der ist nie abgebrochen. Der Fehlerzweig unten hat
  // deshalb nach dreimal Escape nie "vom Nutzer abgebrochen" gemeldet, sondern
  // die rohe Fehlermeldung des mittendrin gekappten Werkzeugs.
  const signal = parentSignal ? AbortSignal.any([killSwitch.signal, parentSignal]) : killSwitch.signal

  // Alles, was der Aufruf gezeigt hat, je Id die letzte Fassung — für den
  // Sparmodus, der die Karten mit dem Ergebnis ablegt.
  const shown: DisplayCard[] = []

  const ctx: ToolContext = {
    confirm: async () => true, // Rückfragen laufen über den Gesprächsfluss, nicht hier.
    say: (text) => speak(text),
    setState: (state) => sendToCrystal('state:set', { state, reason: req.name }),
    show: (card) => {
      const stamped: DisplayCard = { ...card, at: Date.now(), source: req.name }
      const same = shown.findIndex((c) => c.id === stamped.id)
      if (same >= 0) shown[same] = stamped
      else shown.push(stamped)
      return sendToCrystal('display:card', stamped) && crystalVisible()
    },
    annotate: (update) => activityAnnotate(req.id, update),
    signal
  }

  running.add(req.id)
  // Die Anzeige bekommt den Schritt, sobald er wirklich läuft — nicht schon
  // bei der Rückfrage, die steht oben als „wartet".
  if (!INVISIBLE.has(req.name)) {
    activityStart({
      id: req.id,
      label: describeTool(req.name, args),
      tool: req.name,
      parentId: req.parentId,
      source: req.parentId ? 'agent' : 'jarvis',
      thought: thoughtFor(req.name, args)
    })
  }
  sendToCrystal('state:set', {
    state: tool.group === 'research' ? 'research' : 'tool',
    reason: req.name
  })

  try {
    const userText = req.userTurn?.lastUserText || gapUserText()
    const raw = await withModelBudget(req.budgetId ?? req.id, getSettings().tokenSaver.enabled, () =>
      withGapUserText(userText, () => tool.execute(args, ctx)))
    if (req.name === TOOL_SEARCH && emptySearch(raw)) noteGap(req, 'no-match', String(args.query ?? ''))
    // Beide Fassungen gehen weiter: ins Aktionslog das, was das Werkzeug
    // tatsächlich geliefert hat, ans Modell die knappe.
    const result = compactResult(req.name, raw ?? 'Erledigt.')
    rememberResult(req.name, args, result, shown)
    const step = activityEnd(req.id, true)
    if (step) noteFinishedStep(step)
    return finish(true, { result }, args, confirmed, raw)
  } catch (err) {
    // Der Not-Aus zuerst, und zwar noch vor dem Nachreichen der Zustimmung:
    // dreimal Escape verwirft ausdrücklich alle offenen Rückfragen und erteilten
    // Zusagen. Der Abbruch erreicht das Werkzeug aber erst danach, und eine
    // Zusage, die sich hier hinterher wieder einträgt, hätte genau das
    // ausgehebelt, wofür der Not-Aus da ist.
    if (signal.aborted) {
      activityEnd(req.id, false, 'Vom Nutzer abgebrochen.')
      return finish(false, { error: 'Vom Nutzer abgebrochen.' }, args, confirmed)
    }

    // Die Zustimmung ist beim Prüfen verbraucht worden, die Aktion aber nie
    // passiert. Für einen zweiten Versuch mit denselben Argumenten gilt sie
    // deshalb kurz weiter — sonst müsste der Nutzer eine Frage beantworten,
    // die er gerade eben schon beantwortet hat.
    if (confirmed) regrantConfirmation(req.name, args)

    const message = err instanceof Error ? err.message : String(err)
    noteGap(req, 'error', message)
    const failed = activityEnd(req.id, false, message)
    if (failed) noteFinishedStep(failed)
    return finish(false, { error: message }, args, confirmed)
  } finally {
    running.delete(req.id)
    if (running.size === 0) {
      sendToCrystal('state:set', { state: 'idle', reason: 'tools done' })
    }
  }
}

/**
 * Die Frage, die das Modell stellen soll.
 *
 * Sie muss konkret genug sein, dass man ohne Blick auf einen Bildschirm
 * entscheiden kann. "Soll ich fortfahren?" hilft niemandem.
 */
function buildQuestion(name: string, args: Record<string, unknown>): string {
  const s = (key: string): string => String(args[key] ?? '')

  switch (name) {
    case 'gmail_send':
      return `Ich schicke eine Mail an ${s('to')} mit dem Betreff ${s('subject')}. Soll ich?`

    /**
     * Die Adresse gehört in die Frage, nicht ins Protokoll.
     *
     * Gesprochen sagt der Nutzer "schreib eine Mail an Anna". Welche Adresse
     * daraus wird, entscheidet das Kontaktbuch — und genau das ist die Stelle,
     * an der eine Verwechslung teuer wird und danach nicht mehr auffällt. Also
     * wird hier schon aufgelöst und die gefundene Adresse laut vorgelesen: Der
     * Nutzer hört, wohin es geht, bevor er zustimmt.
     */
    case 'yahoo_send': {
      const to = s('to')
      const found = resolveRecipient(to)
      if (found.kind === 'none') {
        return (
          `Zu ${to} habe ich keine Adresse im Kontaktbuch, und raten tue ich sie nicht. ` +
          'Sag mir die Adresse oder trag sie in den Einstellungen unter Kontakte ein.'
        )
      }
      if (found.kind === 'many') {
        const names = found.matches.map((c) => `${c.name} unter ${c.email}`).join(', oder ')
        return `Zu ${to} stehen mehrere im Kontaktbuch: ${names}. Wen meinst du?`
      }
      const betreff = s('subject')
      return (
        `Ich schicke eine Mail an ${found.contact.name}, ${found.contact.email}` +
        `${betreff ? `, mit dem Betreff ${betreff}` : ''}. Soll ich?`
      )
    }
    /**
     * Wie bei `yahoo_send`: erst auflösen, dann fragen.
     *
     * Der Suchbegriff steht für nichts — was verschwindet, entscheidet sich
     * erst beim Abgleich mit dem Gedächtnis. Gefragt wurde bisher nach dem
     * Begriff, gelöscht wurde die Erinnerung, und dazwischen lag der ganze
     * Spielraum von `includes`.
     */
    case 'forget': {
      const found = resolveMemory(s('text'))
      if (found.kind === 'none') {
        return (
          'Dazu finde ich keine Erinnerung, die ich eindeutig zuordnen kann. ' +
          'Nenne mir ihren Wortlaut, nicht nur ein Stichwort.'
        )
      }
      if (found.kind === 'many') {
        return (
          `Darauf passen mehrere Erinnerungen: ${found.matches.map((m) => m.text).join(', oder ')}. ` +
          'Welche soll weg?'
        )
      }
      return `Ich lösche die Erinnerung: ${found.entry.text}. Soll ich?`
    }
    case 'gmail_reply':
      return 'Ich schicke die Antwort ab. Soll ich?'
    case 'gmail_trash':
      return 'Ich lege die Mail in den Papierkorb. Von dort ist sie dreißig Tage wiederherstellbar. Soll ich?'
    case 'amazon_cart_add':
      return `Ich lege ${s('productName') || s('asin')} in deinen Amazon Warenkorb. Soll ich?`
    case 'amazon_cart_remove':
      return `Ich nehme ${s('productName') || s('asin')} aus deinem Warenkorb. Soll ich?`
    case 'amazon_open_checkout':
      return 'Ich mache die Amazon Kasse auf. Bestellen musst du selbst. Soll ich sie öffnen?'
    // `file_write` nimmt Ordnername und Dateiname, keinen Pfad — ein Pfad ist
    // dort gar nicht ausdrückbar. Gefragt wurde trotzdem nach `path`, und das
    // gibt es in den Argumenten nicht: herausgekommen ist "Ich schreibe die
    // Datei . Soll ich?", also eine Zusage zu einer ungenannten Datei.
    case 'file_write':
      return `Ich schreibe die Datei ${s('name')} nach ${s('folder') || 'Dokumente'}. Soll ich?`
    case 'file_trash':
      return (
        `Ich lege ${basename(s('path')) || 'die Datei'} in den Papierkorb. ` +
        'Von dort ist sie zurückholbar. Soll ich?'
      )
    /**
     * Wie bei `yahoo_send`: erst auflösen, dann fragen.
     *
     * Der Nutzer sagt „schreib Anna". Welche Nummer daraus wird, entscheidet
     * das Adressbuch — und eine WhatsApp-Nachricht an die falsche Nummer ist
     * nicht nur weg, sie steht bei einem Fremden im Gespräch. Also wird die
     * Nummer vorgelesen, bevor jemand zustimmt.
     */
    case 'whatsapp_send': {
      const to = s('to')
      const found = resolvePhoneNumber(to)
      if (!found) {
        return (
          `Zu ${to} habe ich keine Telefonnummer im Adressbuch, und raten tue ich sie nicht. ` +
          'Sag mir die Nummer oder trag sie in den Einstellungen unter Kontakte ein.'
        )
      }
      const text = s('message')
      return (
        `Ich schicke ${found.name ?? found.phone} auf WhatsApp: ${text.slice(0, 140)}` +
        `${text.length > 140 ? '…' : ''}. Soll ich?`
      )
    }
    case 'file_organize': {
      const by = s('by') === 'monat' ? 'nach Monat' : 'nach Dateityp'
      return (
        `Ich sortiere den Ordner ${s('folder')} ${by} in Unterordner. Gelöscht wird nichts, und ` +
        'ich kann es rückgängig machen. Soll ich?'
      )
    }
    case 'run_command':
      return `Ich führe den Befehl ${s('command')} aus. Soll ich?`
    case 'computer_task':
      return `Ich übernehme Maus und Tastatur und erledige folgendes: ${s('goal')}. Soll ich?`
    case 'price_watch_create':
      return `Ich behalte ${s('productName')} im Auge und melde mich, sobald es unter ${s('targetPrice')} Euro fällt. Soll ich?`
    case 'schedule_task':
      return `Ich richte einen wiederkehrenden Auftrag ein: ${s('label') || s('prompt')}. Soll ich?`
    default: {
      const preview = Object.entries(args)
        .slice(0, 2)
        .map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`)
        .join(', ')
      return `Ich führe ${name} aus${preview ? ` mit ${preview}` : ''}. Soll ich?`
    }
  }
}
