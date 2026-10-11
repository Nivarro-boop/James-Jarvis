import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { thinkText } from '../providers/text'
import {
  uiaExpand,
  uiaFocus,
  uiaInvoke,
  uiaRead,
  uiaSetValue,
  uiaToggle,
  type UiaElement,
  type UiaTree
} from '../automation/uia'
import { focusWindow, pressHotkey, typeText } from '../automation/desktop'
import { BLOCKED_INPUT, BLOCKED_PATTERNS } from '../tools/impl/computer'
import { activityEnd, activityStart } from './activity'
import { abortable } from '../../shared/async'
import { z } from 'zod'

/**
 * Die schnelle Bildschirmsteuerung — James' eigene.
 *
 * `computer_task` schaut bei jedem Schritt auf ein Bildschirmfoto: rund
 * sechzehnhundert Token pro Blick, dazu ein Modell, das Bildpunkte schätzen
 * muss. Das hier liest stattdessen den Bedienbaum, den Windows zu jedem
 * Fenster führt — Rollen, Namen, Fähigkeiten — als Text. Das sind ein paar
 * hundert Token, und das Modell wählt Elemente beim Namen statt Koordinaten.
 *
 * Drei Dinge machen es billig und schnell:
 *
 * 1. **Text statt Bild.** Der Baum kostet einen Bruchteil eines Fotos.
 * 2. **Stapel.** Pro Modellaufruf bis zu sechs Aktionen — Feld beschreiben,
 *    Haken setzen, OK drücken —, danach erst wieder lesen.
 * 3. **Abläufe merken.** Was einmal geklappt hat, wird mit Rolle und Namen
 *    der Elemente gespeichert. Beim nächsten Mal mit derselben Aufgabe im
 *    selben Programm spielt James den Ablauf ohne einen einzigen
 *    Modellaufruf ab. Findet er ein Element nicht mehr, übernimmt ab dort das
 *    Modell und der Ablauf wird neu gelernt.
 *
 * Hat ein Fenster keinen brauchbaren Baum — Spiele, Zeichenflächen,
 * Videobilder —, springt `computer_task` mit Auge und Zeiger ein.
 *
 * Die Sperrliste gilt hier wie dort: kein Bankfenster, kein Passwortspeicher,
 * keine Passwörter oder Kartennummern tippen.
 */

const MAX_TURNS = 12
const MAX_ACTIONS_PER_TURN = 6
const TREE_LIMIT = 160
/** Unter so vielen bedienbaren Elementen taugt der Baum nicht — dann das Auge. */
const MIN_ACTIONABLE = 3

const ACTION_SCHEMA = z.discriminatedUnion('do', [
  z.object({ do: z.enum(['press', 'toggle', 'expand', 'collapse', 'focus']), ref: z.number().int().positive() }),
  z.object({ do: z.literal('write'), ref: z.number().int().positive(), text: z.string() }),
  z.object({ do: z.literal('keys'), keys: z.string().min(1) }),
  z.object({ do: z.literal('type'), text: z.string() }),
  z.object({ do: z.literal('wait'), seconds: z.number().min(0).max(5) }),
  z.object({ do: z.literal('done'), success: z.boolean(), summary: z.string().min(1) })
])

export function parseDesktopActions(text: string): DesktopAction[] {
  const parsed = JSON.parse(/\{[\s\S]*\}/.exec(text)?.[0] ?? '{}') as { actions?: unknown }
  const actions = z.array(ACTION_SCHEMA).safeParse(parsed.actions ?? [])
  if (!actions.success) throw new SyntaxError('Ungültiger Bedienbaum-Plan: Aktion oder Pflichtfeld fehlt.')
  return actions.data.slice(0, MAX_ACTIONS_PER_TURN)
}

/**
 * Die Knöpfe der Titelleiste hat jedes Fenster — auch eins, dessen Inhalt
 * für den Bedienbaum unsichtbar ist (Spiele, viele Electron-Programme).
 * Mitgezählt sähe so ein Fenster bedienbar aus, und das Modell stünde vor
 * einem Baum aus „Minimieren" und „Schließen".
 */
const WINDOW_CHROME = /^(minimieren|maximieren|wieder\W*her\W*stellen|schließen|minimize|maximize|restore|close)$/i

export type DesktopAction =
  | { do: 'press' | 'toggle' | 'expand' | 'collapse' | 'focus'; ref: number }
  | { do: 'write'; ref: number; text: string }
  | { do: 'keys'; keys: string }
  | { do: 'type'; text: string }
  | { do: 'wait'; seconds: number }
  | { do: 'done'; success: boolean; summary: string }

/** Ein gespeicherter Schritt: das Element über Rolle und Namen, nicht über die Nummer. */
export type RoutineStep =
  | { do: 'press' | 'toggle' | 'expand' | 'collapse' | 'focus'; rolle: string; name: string }
  | { do: 'write'; rolle: string; name: string; text: string }
  | { do: 'keys'; keys: string }
  | { do: 'type'; text: string }
  | { do: 'wait'; seconds: number }

interface Routine {
  goal: string
  app: string
  steps: RoutineStep[]
  uses: number
  updated: string
}

export interface DesktopResult {
  ok: boolean
  summary: string
  /** model = mit Modell, replay = gespeicherter Ablauf, vision = Bildschirmfoto-Weg nötig. */
  mode: 'model' | 'replay' | 'vision'
  steps: number
  modelCalls: number
}

// ── Gespeicherte Abläufe ─────────────────────────────────────

function routinesFile(): string {
  return join(app.getPath('userData'), 'desktop-routines.json')
}

function loadRoutines(): Record<string, Routine> {
  try {
    return existsSync(routinesFile()) ? JSON.parse(readFileSync(routinesFile(), 'utf-8')) : {}
  } catch {
    return {}
  }
}

function saveRoutines(all: Record<string, Routine>): void {
  try {
    writeFileSync(routinesFile(), JSON.stringify(all, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[desktop] Abläufe nicht gespeichert:', err)
  }
}

/**
 * Das Programm aus dem Fenstertitel.
 *
 * Titel tragen meist vorne das Dokument und hinten das Programm: „Rechnung.docx
 * - Word", „Einstellungen - NoRisk Launcher". Gemerkt wird nur der hintere Teil,
 * sonst gälte ein Ablauf nur für genau dieses eine Dokument.
 */
export function appFromTitle(title: string): string {
  const parts = title.split(/\s[-–—|]\s/)
  return (parts[parts.length - 1] ?? title).trim().toLowerCase()
}

/** Schlüssel eines Ablaufs: Aufgabe ohne Füllwörter und Zahlen, dazu das Programm. */
export function routineKey(goal: string, appName: string): string {
  const words = goal
    .toLowerCase()
    .replace(/[^a-zäöüß ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !['bitte', 'mal', 'und', 'die', 'der', 'das', 'den', 'dem', 'ein', 'eine'].includes(w))
  // Sortiert: „Dunkelmodus einschalten" und „schalte… Dunkelmodus ein" sind
  // nicht gleich, „Dunkelmodus an machen" und „mach Dunkelmodus an" schon.
  return `${appName.toLowerCase()}|${[...new Set(words)].sort().join(' ')}`
}

// ── Baum und Aktionen ────────────────────────────────────────

function line(e: UiaElement): string {
  const parts = [`${e.ref}:`, `[${e.rolle}]`, `"${e.name}"`]
  if (e.wert) parts.push(`= "${e.wert.slice(0, 50)}"`)
  if (e.zustand) parts.push(`(${e.zustand})`)
  if (e.kann.length > 0) parts.push(`| ${e.kann.join(',')}`)
  return parts.join(' ')
}

export function actionable(tree: UiaTree): UiaElement[] {
  return tree.elemente.filter((e) => e.kann.length > 0 && !WINDOW_CHROME.test(e.name.replace(/\u00ad/g, '')))
}

function checkWindow(title: string): void {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(title)) {
      throw new Error(`Das Fenster „${title}" fasse ich nicht an. Das muss der Nutzer selbst machen.`)
    }
  }
}

function checkText(text: string): void {
  if (BLOCKED_INPUT.test(text)) {
    throw new Error('Passwörter, PINs und Zahlungsdaten tippe ich nicht ein.')
  }
}

async function execute(action: DesktopAction, tree: UiaTree, windowTitle: string): Promise<string> {
  const known = (ref: number): UiaElement => {
    const el = tree.elemente.find((e) => e.ref === ref)
    if (!el) throw new Error(`Element ${ref} gibt es im zuletzt gelesenen Fenster nicht.`)
    return el
  }
  switch (action.do) {
    case 'press':
      known(action.ref)
      return uiaInvoke(action.ref)
    case 'toggle':
      known(action.ref)
      await uiaToggle(action.ref)
      return 'umgeschaltet'
    case 'expand':
    case 'collapse':
      known(action.ref)
      await uiaExpand(action.ref, action.do === 'collapse')
      return action.do === 'expand' ? 'aufgeklappt' : 'zugeklappt'
    case 'focus':
      known(action.ref)
      await uiaFocus(action.ref)
      return 'fokussiert'
    case 'write':
      known(action.ref)
      checkText(action.text)
      await uiaSetValue(action.ref, action.text)
      return 'geschrieben'
    case 'keys':
      // Tasten gehen ans Vordergrundfenster — also erst dorthin.
      await focusWindow(windowTitle).catch(() => undefined)
      await pressHotkey(action.keys)
      return `Tasten ${action.keys}`
    case 'type':
      checkText(action.text)
      await focusWindow(windowTitle).catch(() => undefined)
      await typeText(action.text)
      return 'getippt'
    case 'wait':
      await new Promise((r) => setTimeout(r, Math.min(5, Math.max(0.2, action.seconds)) * 1000))
      return 'gewartet'
    case 'done':
      return action.summary
  }
}

/** Aus einer Modellaktion den speicherbaren Schritt machen. */
function toRoutineStep(action: DesktopAction, tree: UiaTree): RoutineStep | null {
  if (action.do === 'done') return null
  if ('ref' in action) {
    const el = tree.elemente.find((e) => e.ref === action.ref)
    if (!el || !el.name) return null
    return action.do === 'write'
      ? { do: 'write', rolle: el.rolle, name: el.name, text: action.text }
      : { do: action.do, rolle: el.rolle, name: el.name }
  }
  return action
}

/** Einen gespeicherten Schritt im frischen Baum wiederfinden. */
export function resolveStep(step: RoutineStep, tree: UiaTree): DesktopAction | null {
  if (!('rolle' in step)) return step as DesktopAction
  const el =
    tree.elemente.find((e) => e.rolle === step.rolle && e.name === step.name) ??
    tree.elemente.find((e) => e.name === step.name)
  if (!el) return null
  return step.do === 'write' ? { do: 'write', ref: el.ref, text: step.text } : { do: step.do, ref: el.ref }
}

// ── Das Modell ───────────────────────────────────────────────

const SYSTEM = [
  'Du bedienst ein Windows-Fenster über seinen Bedienbaum. Jede Zeile ist ein Element:',
  '`Nummer: [Rolle] "Name" = "Wert" (Zustand) | Fähigkeiten`.',
  'Fähigkeiten: Invoke = drücken, Value = beschreiben, Toggle = umschalten, ExpandCollapse = aufklappen.',
  '',
  'Antworte nur mit JSON: {"actions": [ ... ]} mit höchstens sechs Aktionen, die du sicher ohne',
  'Zwischenblick ausführen kannst. Danach liest du das Fenster neu. Aktionen:',
  '{"do":"press","ref":N} {"do":"write","ref":N,"text":"..."} {"do":"toggle","ref":N}',
  '{"do":"expand","ref":N} {"do":"collapse","ref":N} {"do":"focus","ref":N}',
  '{"do":"keys","keys":"strg+s"} {"do":"type","text":"..."} {"do":"wait","seconds":1}',
  '{"do":"done","success":true,"summary":"ein Satz, was erreicht wurde"}',
  '',
  'Regeln: Nimm nur Nummern aus dem aktuellen Baum. Ist das Ziel erreicht oder unmöglich, beende',
  'mit done. Keine Käufe abschließen, keine Passwörter oder Zahlungsdaten eingeben, nichts löschen,',
  'was nicht ausdrücklich verlangt ist.'
].join('\n')

async function askModel(
  goal: string,
  tree: UiaTree,
  history: string[],
  signal: AbortSignal
): Promise<DesktopAction[]> {
  const prompt = [
    `Aufgabe: ${goal}`,
    `Fenster: ${tree.fenster} (${tree.gezeigt} von ${tree.gefunden} Elementen)`,
    history.length ? `Bisher getan:\n${history.slice(-12).join('\n')}` : 'Noch nichts getan.',
    '',
    'Bedienbaum:',
    ...tree.elemente.map(line)
  ].join('\n')

  const response = await thinkText({ system: SYSTEM, user: prompt, maxTokens: 600, signal })
  const text = response.text
  return parseDesktopActions(text)
}

// ── Der Ablauf ───────────────────────────────────────────────

export async function runDesktopTask(
  goal: string,
  appHint: string | undefined,
  signal: AbortSignal,
  vision: () => Promise<DesktopResult>
): Promise<DesktopResult> {
  signal.throwIfAborted()
  const activityId = randomUUID()
  activityStart({ id: activityId, label: `Bildschirm (schnell) — ${goal}`, source: 'agent', tool: 'desktop_task' })

  const target = appHint?.trim() || 'aktiv'
  if (appHint) await focusWindow(appHint).catch(() => undefined)

  const finish = (result: DesktopResult): DesktopResult => {
    activityEnd(activityId, result.ok, `${result.summary} (${result.mode}, ${result.modelCalls} Modellaufrufe)`)
    return result
  }
  const step = (label: string, ok = true): void => {
    const id = randomUUID()
    activityStart({ id, label, parentId: activityId, source: 'agent' })
    activityEnd(id, ok)
  }

  let tree: UiaTree
  try { tree = await abortable(uiaRead(target, TREE_LIMIT), signal) }
  catch (error) {
    if (signal.aborted) return finish({ ok: false, summary: 'Abgebrochen.', mode: 'model', steps: 0, modelCalls: 0 })
    step('Bedienbaum nicht erreichbar — wechsle zum Bildschirmfoto-Weg', false)
    return finish(await vision())
  }
  checkWindow(tree.fenster)

  if (actionable(tree).length < MIN_ACTIONABLE) {
    step('Kein Bedienbaum — wechsle zum Bildschirmfoto-Weg')
    return finish(await vision())
  }

  const appName = appHint?.trim().toLowerCase() || appFromTitle(tree.fenster)
  const key = routineKey(goal, appName)
  const routines = loadRoutines()
  const learned: RoutineStep[] = []
  const history: string[] = []
  let modelCalls = 0
  let steps = 0

  // 1. Gespeicherten Ablauf abspielen, solange er passt.
  const routine = routines[key]
  let replayIntact = Boolean(routine)
  if (routine) {
    for (const saved of routine.steps) {
      if (signal.aborted) return finish({ ok: false, summary: 'Abgebrochen.', mode: 'replay', steps, modelCalls })
      let action = resolveStep(saved, tree)
      if (!action) {
        await new Promise((r) => setTimeout(r, 700))
        tree = await uiaRead(target, TREE_LIMIT)
        action = resolveStep(saved, tree)
      }
      if (!action) {
        replayIntact = false
        step('Gespeicherter Ablauf passt nicht mehr — Modell übernimmt', false)
        break
      }
      const result = await execute(action, tree, tree.fenster)
      learned.push(saved)
      steps++
      history.push(`- ${JSON.stringify(saved)} → ${result}`)
      step(`${saved.do}${'name' in saved ? ` „${saved.name}"` : ''}`)
      if (saved.do !== 'wait') {
        await new Promise((r) => setTimeout(r, 250))
        tree = await uiaRead(target, TREE_LIMIT)
        checkWindow(tree.fenster)
      }
    }
    if (replayIntact) {
      routine.uses++
      routines[key] = routine
      saveRoutines(routines)
      return finish({ ok: true, summary: `Gespeicherten Ablauf „${routine.goal}" abgespielt.`, mode: 'replay', steps, modelCalls })
    }
  }

  // 2. Mit dem Modell, Stapel für Stapel.
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (signal.aborted) return finish({ ok: false, summary: 'Abgebrochen.', mode: 'model', steps, modelCalls })
    let actions: DesktopAction[]
    try { actions = await abortable(askModel(goal, tree, history, signal), signal) }
    catch (error) {
      if (signal.aborted) return finish({ ok: false, summary: 'Abgebrochen.', mode: 'model', steps, modelCalls })
      if (!(error instanceof SyntaxError)) return finish({ ok: false, summary: error instanceof Error ? error.message : String(error), mode: 'model', steps, modelCalls: modelCalls + 1 })
      step('Bedienbaum-Plan fehlgeschlagen — wechsle zum Bildschirmfoto-Weg', false)
      return finish(await vision())
    }
    modelCalls++
    if (actions.length === 0) {
      step('Kein Bedienbaum-Plan — wechsle zum Bildschirmfoto-Weg', false)
      return finish(await vision())
    }

    for (const action of actions) {
      if (action.do === 'done') {
        if (action.success && learned.length > 0) {
          routines[key] = {
            goal,
            app: appName,
            steps: learned,
            uses: (routines[key]?.uses ?? 0) + 1,
            updated: new Date().toISOString().slice(0, 10)
          }
          saveRoutines(routines)
        }
        return finish({ ok: action.success, summary: action.summary, mode: 'model', steps, modelCalls })
      }
      let result: string
      try {
        result = await execute(action, tree, tree.fenster)
      } catch (err) {
        result = `Fehler: ${err instanceof Error ? err.message : String(err)}`
        if (/fasse ich nicht an|tippe ich nicht/.test(result)) {
          return finish({ ok: false, summary: result.slice(7), mode: 'model', steps, modelCalls })
        }
      }
      const saved = toRoutineStep(action, tree)
      if (saved && !result.startsWith('Fehler')) learned.push(saved)
      steps++
      history.push(`- ${JSON.stringify(action)} → ${result}`)
      step(`${action.do}${'ref' in action ? ` „${tree.elemente.find((e) => e.ref === action.ref)?.name ?? action.ref}"` : ''}`, !result.startsWith('Fehler'))
      // Nach einem Fehler nicht blind weiter: neu lesen und neu planen.
      if (result.startsWith('Fehler')) break
    }

    await new Promise((r) => setTimeout(r, 300))
    tree = await uiaRead(target, TREE_LIMIT)
    checkWindow(tree.fenster)
  }

  return finish({ ok: false, summary: `Nach ${MAX_TURNS} Runden nicht fertig.`, mode: 'model', steps, modelCalls })
}

export function forgetRoutines(): number {
  const count = Object.keys(loadRoutines()).length
  saveRoutines({})
  return count
}
