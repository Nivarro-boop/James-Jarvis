import { saveContextPlan, workingContext } from './workingContext'
import type { ActivityItem, ActivityPlan, ActivitySnapshot, PlanStep } from '@shared/types'
import { broadcast } from '../ipc/emit'

/**
 * Was James gerade tut — für die Live-Anzeige im Hauptfenster.
 *
 * Bisher sagte die Kugel nur „Arbeitet". Bei einer Aufgabe mit zehn Schritten
 * war das zehnmal dasselbe Wort, und ob er hängt oder vorankommt, ließ sich
 * nicht erkennen. Jetzt steht jeder Schritt mit Zustand und Dauer in einer
 * Liste, dazu der Plan, den er sich für längere Aufgaben selbst schreibt, und
 * die Unteragenten, die im Hintergrund laufen.
 *
 * Bewusst nur im Speicher: Das Aktionslog in der Datenbank ist die dauerhafte
 * Spur. Das hier ist der Blick über die Schulter und darf beim Neustart leer
 * sein.
 */

const MAX_ITEMS = 40

const items: ActivityItem[] = []
let plan: ActivityPlan | null = workingContext().plan

let pending: NodeJS.Timeout | null = null

/** Zusammenfassen statt bei jedem Schritt senden — zehn Updates in 50 ms sind eines. */
function publish(): void {
  if (pending) return
  pending = setTimeout(() => {
    pending = null
    broadcast('activity:update', activitySnapshot())
  }, 60)
}

export function activitySnapshot(): ActivitySnapshot {
  return { items: [...items], plan }
}

/**
 * Lesbare Zeile zu einem Werkzeugaufruf.
 *
 * Kein Übersetzungswörterbuch für zweihundert Werkzeuge, sondern der Name
 * lesbar gemacht und das aussagekräftigste Argument dahinter — die Adresse,
 * die Suchanfrage, das Ziel. Daran erkennt man, was passiert, auch bei einem
 * Werkzeug, das ein MCP-Server erst gestern mitgebracht hat.
 */
export function describeTool(name: string, args: Record<string, unknown>): string {
  const mcp = /^mcp_([a-z0-9]+)_(.+)$/.exec(name)
  const base = (mcp ? mcp[2] : name).replace(/_/g, ' ')
  const label = mcp ? `${mcp[1]}: ${base}` : base
  const keys = ['url', 'query', 'goal', 'task', 'title', 'name', 'text', 'path', 'app', 'element', 'prompt', 'to']
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) {
      const short = value.trim().replace(/\s+/g, ' ')
      return `${label} — ${short.length > 70 ? `${short.slice(0, 69)}…` : short}`
    }
  }
  return label
}

/**
 * Der Satz in der Denkblase an der Kugel.
 *
 * Die Zeile aus `describeTool` ist für die Liste gemacht: Werkzeugname und
 * Argument. In der Blase soll stehen, was James gerade vorhat, so wie man es
 * sagen würde. Für die häufigen Werkzeuge gibt es dafür einen Satz; alle
 * anderen bekommen `undefined`, und die Blase nimmt dann die Listenzeile.
 */
export function thoughtFor(name: string, args: Record<string, unknown>): string | undefined {
  const s = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '')
  const cut = (text: string, max = 60): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
  switch (name) {
    case 'open_app':
      return s('name') ? `Öffne ${cut(s('name'))} …` : 'Öffne das Programm …'
    case 'close_app':
      return `Schließe ${cut(s('name') || 'das Programm')} …`
    case 'minecraft_launch':
      return 'Starte den Minecraft-Launcher …'
    case 'open_url':
      return `Öffne ${cut(s('url') || 'die Seite')} …`
    case 'focus_window':
      return 'Hole das Fenster nach vorn …'
    case 'stock_price':
      return `Schaue mir den aktuellen Kurs von ${cut(s('symbol') || 'der Aktie')} an …`
    case 'exchange_rate':
      return `Rechne ${s('von') || '?'} in ${s('nach') || '?'} um …`
    case 'web_search':
      return `Suche im Netz nach „${cut(s('query') || 'der Frage')}" …`
    case 'read_url':
    case 'chrome_read_page':
      return 'Lese die Seite …'
    case 'deep_research':
      return `Recherchiere „${cut(s('query') || 'das Thema')}" …`
    case 'desktop_task':
    case 'computer_task':
      return `Erledige am Bildschirm: ${cut(s('goal') || s('task') || 'die Aufgabe')}`
    case 'open_path':
      return `Öffne ${cut(s('path') || 'die Datei')} …`
    case 'file_find':
      return s('query') || s('name') ? `Suche ${cut(s('query') || s('name'))} …` : 'Suche die Datei …'
    case 'type_text':
      return 'Tippe den Text ein …'
    case 'screenshot_save':
    case 'screenshot':
      return 'Schaue mir den Bildschirm an …'
    case 'gmail_send':
    case 'yahoo_send':
      return `Schreibe die Mail an ${cut(s('to') || 'den Empfänger')} …`
    case 'weather':
      return 'Schaue nach dem Wetter …'
    case 'ort_suchen':
      return `Suche ${cut(s('suche') || 'den Ort')} …`
    case 'route_berechnen':
      return `Rechne den Weg nach ${cut(s('nach') || 'dort')} aus …`
    case 'news_headlines':
      return 'Hole die Nachrichten …'
    case 'calendar_agenda':
    case 'calendar_search':
      return 'Schaue in den Kalender …'
    case 'timer_set':
      return 'Stelle den Timer …'
    case 'music_play':
      return `Spiele ${cut(s('query') || 'Musik')} ab …`
    case 'remember':
      return 'Merke mir das …'
    case 'recall':
      return 'Überlege, was ich darüber weiß …'
    case 'presentation_create':
    case 'document_write':
    case 'spreadsheet_create':
      return `Erstelle ${cut(s('title') || 'das Dokument')} …`
    default:
      return undefined
  }
}

export function activityStart(item: Omit<ActivityItem, 'startedAt' | 'status'> & { status?: ActivityItem['status'] }): void {
  const existing = items.find((i) => i.id === item.id)
  if (existing) {
    Object.assign(existing, item, { status: item.status ?? 'running' })
  } else {
    items.unshift({ ...item, status: item.status ?? 'running', startedAt: Date.now() })
    if (items.length > MAX_ITEMS) items.length = MAX_ITEMS
  }
  publish()
}

/**
 * Denksatz oder Symbol nachtragen, ohne den Zustand anzufassen.
 *
 * Das Programmsymbol kommt manchmal erst, wenn das Programm schon gestartet
 * ist. Ein `activityStart` an der Stelle hätte den fertigen Schritt wieder auf
 * „läuft" gesetzt.
 */
export function activityAnnotate(id: string, update: { thought?: string; icon?: string }): void {
  const item = items.find((i) => i.id === id)
  if (!item) return
  if (update.thought) item.thought = update.thought
  if (update.icon) item.icon = update.icon
  publish()
}

export function activityEnd(id: string, ok: boolean, detail?: string): ActivityItem | undefined {
  const item = items.find((i) => i.id === id)
  if (!item) return undefined
  item.status = ok ? 'ok' : 'error'
  item.durationMs = Date.now() - item.startedAt
  if (detail) item.detail = detail.length > 200 ? `${detail.slice(0, 199)}…` : detail
  publish()
  return item
}

export function setPlan(title: string, steps: PlanStep[]): ActivityPlan {
  const next = { title, steps, updatedAt: Date.now() }
  saveContextPlan(next)
  plan = next
  publish()
  return plan
}

export function clearPlan(): void {
  saveContextPlan(null)
  plan = null
  publish()
}

export function currentPlan(): ActivityPlan | null {
  return plan
}

/** Die letzten erledigten Schritte, für die Lernschleife. */
export function recentActivity(sinceMs: number): ActivityItem[] {
  return items.filter((i) => i.startedAt >= sinceMs).reverse()
}
