import { randomUUID } from 'node:crypto'
import type { ActivityItem } from '@shared/types'
import { getSettings } from '../store/settings'
import { thinkText } from '../providers/text'
import { activityEnd, activityStart } from './activity'
import { findSkill, listSkills, saveSkill } from './skills'

/**
 * Die Lernschleife.
 *
 * Nach dem Vorbild von Hermes' Hintergrundprüfung: Sobald James eine Aufgabe
 * mit mehreren Schritten hinter sich hat und danach Ruhe einkehrt, schaut ein
 * kurzer Textaufruf auf die Schritte und entscheidet, ob daraus eine
 * Anleitung für das nächste Mal werden soll — oder ob eine vorhandene
 * verbessert werden muss.
 *
 * Bewusst im Hintergrund und nicht als Aufforderung an das Sprachmodell: Das
 * hat mitten im Gespräch anderes zu tun, und jeder zusätzliche Satz im Prompt
 * kostet bei jeder Verbindung. Ein Aufruf nach getaner Arbeit kostet einmal
 * und stört niemanden.
 *
 * Gelernt wird nur aus erfolgreichen Abläufen. Einer, der scheiterte, wäre
 * eine Anleitung zum Scheitern.
 */

/** Ab so vielen erfolgreichen Schritten lohnt ein Blick. */
const MIN_STEPS = 4
/** So lange muss Ruhe sein, bevor geprüft wird. */
const IDLE_MS = 90_000
/** Werkzeuge, die selbst nichts über den Ablauf aussagen. */
const IGNORED = /^(plan_update|skill_|delegate_|memory_tidy|remember|recall|forget|quiet|get_time)/

let burst: ActivityItem[] = []
let timer: NodeJS.Timeout | null = null
let reviewing = false
/** Fertigkeiten, die James in diesem Ablauf mit skill_view gelesen hat. */
let usedSkills = new Set<string>()

/**
 * Vom Werkzeug `skill_view` gerufen. Wie bei Hermes verbessert sich eine
 * Fertigkeit nach ihrer Benutzung selbst: Lief der Ablauf anders als in der
 * Anleitung, wird sie danach überarbeitet — auch bei kurzen Abläufen.
 */
export function noteSkillUsed(name: string): void {
  if (!getSettings().learnSkills) return
  usedSkills.add(name)
}

/** Vom Runner nach jedem abgeschlossenen Schritt der Sprachschleife gerufen. */
export function noteFinishedStep(item: ActivityItem): void {
  // Wie bei Hermes zählen auch Fehlschläge mit: Sie werden nicht zur Anleitung,
  // aber als Fallstrick in eine. Unteragenten-Schritte gehören zum Ablauf dazu.
  if (item.source === 'learning' || (item.status !== 'ok' && item.status !== 'error') || !item.tool || IGNORED.test(item.tool)) return
  if (!getSettings().learnSkills || getSettings().tokenSaver.enabled || getSettings().gamingMode) return
  burst.push(item)
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void review(), IDLE_MS)
  // Hintergrundlernen darf einen bereits beendeten Prozess nicht offen halten.
  timer.unref()
}

interface Verdict {
  save?: boolean
  name?: string
  description?: string
  steps?: string
}

function parseVerdict(text: string): Verdict | null {
  const match = /\{[\s\S]*\}/.exec(text)
  if (!match) return null
  try {
    return JSON.parse(match[0]) as Verdict
  } catch {
    return null
  }
}

async function review(): Promise<void> {
  timer = null
  const steps = burst
  burst = []
  const used = [...usedSkills]
  usedSkills = new Set()
  if (reviewing || getSettings().tokenSaver.enabled || getSettings().gamingMode || !getSettings().learnSkills) return
  // Mit gelesener Fertigkeit genügt ein Schritt: Gerade Fehlschläge zeigen,
  // wo die Anleitung nicht mehr stimmt. Ohne bleibt es bei längeren,
  // erfolgreichen Abläufen.
  const refine = used.length > 0 && steps.length > 0
  if (!refine && (steps.filter((s) => s.status === 'ok').length < MIN_STEPS || steps.at(-1)?.status !== 'ok')) return
  reviewing = true

  const id = randomUUID()
  activityStart({ id, label: 'Lernschleife — prüft, ob sich eine Anleitung lohnt', source: 'learning' })
  try {
    const usedText = used
      .map((name) => findSkill(name))
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .map((s) => `### ${s.name}\n${s.description}\n${s.steps}`)
      .join('\n\n')
    const existing = listSkills()
      .slice(0, 40)
      .map((s) => `- ${s.name}: ${s.description}`)
      .join('\n')
    const log = steps
      .map((s, i) => `${i + 1}. ${s.label}${s.status === 'error' ? ` — FEHLGESCHLAGEN: ${(s.detail ?? '').slice(0, 160)}` : ''}`)
      .join('\n')

    const answer = await thinkText({
      system: [
        'Du prüfst einen gerade erledigten Ablauf eines Desktop-Assistenten. Entscheide, ob daraus',
        'eine wiederverwendbare Anleitung (Fertigkeit) werden soll.',
        '',
        'Ja nur, wenn der Ablauf wiederkommen kann (z. B. „Stream vorbereiten", „Rechnung als PDF',
        'ablegen") und das Wissen über die Reihenfolge oder Fallstricke beim nächsten Mal Zeit spart.',
        'Nein bei Einmaligem, bei reinen Auskünften und bei Abläufen mit persönlichen Daten.',
        'Gibt es schon eine passende Fertigkeit, nimm genau ihren Namen und schreib eine verbesserte Fassung.',
        'Fehlgeschlagene Schritte gehören nicht in die Schritte, aber als „Fallstricke:" ans Ende, mit dem,',
        'was stattdessen funktioniert hat.',
        'Wurde eine Fertigkeit benutzt und wich der Ablauf von ihr ab (Fehler, Umweg, fehlender Schritt),',
        'speichere unter genau ihrem Namen die berichtigte Fassung. Lief alles wie beschrieben: save false.',
        '',
        'Antworte nur mit JSON: {"save": true|false, "name": "...", "description": "ein Satz, wann man',
        'sie braucht", "steps": "nummerierte Schritte mit den Werkzeugnamen und Hinweisen"}'
      ].join('\n'),
      user: `Vorhandene Fertigkeiten:\n${existing || '(keine)'}\n\n${usedText ? `Benutzte Fertigkeiten im Volltext:\n${usedText}\n\n` : ''}Ablauf:\n${log}`,
      maxTokens: 900
    })

    const verdict = parseVerdict(answer.text)
    if (!verdict?.save || !verdict.name || !verdict.steps) {
      activityEnd(id, true, 'Nichts Wiederverwendbares dabei.')
      return
    }
    const { skill, created } = saveSkill({
      name: verdict.name,
      description: verdict.description ?? '',
      steps: verdict.steps,
      source: 'auto'
    })
    activityEnd(id, true, `${created ? 'Neue Fertigkeit' : 'Fertigkeit verbessert'}: ${skill.name}`)
  } catch (err) {
    activityEnd(id, false, err instanceof Error ? err.message : String(err))
  } finally {
    reviewing = false
  }
}
