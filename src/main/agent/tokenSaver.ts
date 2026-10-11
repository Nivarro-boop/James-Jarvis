import { createHash } from 'node:crypto'
import type { DisplayCard, SavingKind, TokenReport } from '@shared/types'
import { COST_ESTIMATES } from '@shared/config/defaults'
import { getSettings } from '../store/settings'
import { modelUsageReport } from './modelUsage'
import { recordSaving, savingsByKind, savingsSince, savingsTotal } from '../db'

/**
 * Sparmodus.
 *
 * Vier Stellen, an denen ohne Funktionsverlust am meisten übrig bleibt:
 *
 * 1. Werkzeugergebnisse. Eine gelesene Mail kommt mit sechstausend Zeichen
 *    zurück, eine Preisliste mit dem Doppelten. Vorgelesen wird davon nie
 *    mehr als ein Absatz — bezahlt aber alles.
 *
 * 2. Werkzeugbeschreibungen. Die gehen bei jedem Verbindungsaufbau erneut
 *    über die Leitung, also alle fünfzehn Minuten, plus bei jedem Neustart
 *    nach Stille. Bei fünfzig Werkzeugen mit ausformulierten deutschen
 *    Beschreibungen ist das der größte einzelne Posten überhaupt.
 *
 * 3. Wiederholte Aufrufe. "Was liegt im Warenkorb" zweimal hintereinander
 *    muss nicht zweimal geladen und nicht zweimal bezahlt werden.
 *
 * 4. Hochgeladene Stille. Die zählt der Renderer, weil das lokale Gate dort
 *    sitzt; hier wird sie nur mitgeschrieben.
 *
 * Gezählt wird in geschätzten Token — vier Zeichen pro Token ist für
 * deutschen Text ein brauchbarer Daumenwert. Es geht um Größenordnungen,
 * nicht um eine Abrechnung.
 */

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / COST_ESTIMATES.CHARS_PER_TOKEN)
}

function enabled(): boolean {
  return getSettings().tokenSaver.enabled
}

// ─────────────────────────────────────────────────────────────
// Ergebnisse kürzen
// ─────────────────────────────────────────────────────────────

/**
 * Kürzt rekursiv, aber strukturerhaltend.
 *
 * Einfach `JSON.stringify(...).slice(0, n)` würde ungültiges JSON erzeugen,
 * und das Modell bekäme abgeschnittene Klammern statt Daten. Stattdessen
 * werden lange Zeichenketten gekappt und lange Listen beschnitten — die
 * Form bleibt lesbar.
 */
function shrink(value: unknown, budget: { left: number }, depth = 0): unknown {
  if (value === null || value === undefined) { budget.left -= 4; return value }
  if (depth > 6) return '…'

  if (typeof value === 'string') {
    if (value.length <= budget.left) {
      budget.left -= value.length
      return value
    }
    // Mindestens ein paar Wörter stehen lassen, sonst wird aus einer
    // Mailvorschau ein einzelnes Zeichen.
    const keep = Math.max(80, budget.left)
    budget.left = 0
    return `${value.slice(0, keep)}…`
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    budget.left -= String(value).length
    return value
  }

  if (Array.isArray(value)) {
    budget.left -= 2
    const out: unknown[] = []
    for (const item of value) {
      if (budget.left <= 0) {
        out.push(`… und ${value.length - out.length} weitere`)
        break
      }
      out.push(shrink(item, budget, depth + 1))
      budget.left--
    }
    return out
  }

  if (typeof value === 'object') {
    budget.left -= 2
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (budget.left <= 0) break
      budget.left -= JSON.stringify(key).length + 2
      out[key] = shrink(inner, budget, depth + 1)
    }
    return out
  }

  return value
}

/** Ergebnis eines Werkzeugs auf das eingestellte Maß bringen. */
export function compactResult(toolName: string, result: unknown): unknown {
  const settings = getSettings().tokenSaver
  if (!settings.enabled || settings.maxResultChars <= 0) return result

  const before = safeLength(result)
  if (before <= settings.maxResultChars) return result

  const shrunk = shrink(result, { left: settings.maxResultChars })
  const after = safeLength(shrunk)
  const saved = estimateTokens('x'.repeat(Math.max(0, before - after)))

  if (saved > 0) {
    recordSaving('result', saved)
    console.info(`[sparmodus] ${toolName}: ${before} → ${after} Zeichen`)
  }
  return shrunk
}

function safeLength(value: unknown): number {
  if (typeof value === 'string') return value.length
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

// ─────────────────────────────────────────────────────────────
// Zwischenspeicher für gleiche Aufrufe
// ─────────────────────────────────────────────────────────────

interface CacheEntry {
  value: unknown
  /**
   * Die Karten, die der Aufruf gezeigt hat. Ein Treffer muss sie erneut
   * schicken: Der Runner überspringt dabei `execute`, und vorher kam eine
   * weggeklickte Wetterkarte beim zweiten Fragen deshalb nie wieder.
   */
  cards: DisplayCard[]
  at: number
  /** Was der Aufruf beim ersten Mal gekostet hat — so viel spart jeder Treffer. */
  tokens: number
}

/** Ein Treffer im Zwischenspeicher: das Ergebnis fürs Modell und die Karten dazu. */
export interface CachedResult {
  value: unknown
  cards: DisplayCard[]
}

const cache = new Map<string, CacheEntry>()

/**
 * Werkzeuge, deren Ergebnis sich nicht von selbst ändert und die keine
 * Nebenwirkung haben. Alles andere wird nie aus dem Speicher beantwortet —
 * eine gecachte Bestätigung "in den Warenkorb gelegt" wäre schlicht gelogen.
 *
 * Ortssuche und Route stehen auch deshalb hier, weil Overpass und Nominatim
 * von Freiwilligen betrieben werden: Dieselbe Frage zweimal hintereinander
 * soll dort nicht zweimal ankommen.
 */
const CACHEABLE = /^(find_best_price|check_price|amazon_search|amazon_cart_view|gmail_search|gmail_summarize_inbox|gmail_read|gmail_unread_count|chrome_read_page|web_search|recall|list_windows|list_schedules|system_status|weather|ort_suchen|route_berechnen)$/

function cacheKey(toolName: string, args: unknown): string {
  return createHash('sha1')
    .update(`${toolName}:${JSON.stringify(args ?? {})}`)
    .digest('hex')
}

export function cachedResult(toolName: string, args: unknown): CachedResult | undefined {
  const settings = getSettings().tokenSaver
  if (!settings.enabled || settings.cacheTtlSec <= 0) return undefined
  if (!CACHEABLE.test(toolName)) return undefined

  const entry = cache.get(cacheKey(toolName, args))
  if (!entry) return undefined
  if (Date.now() - entry.at > settings.cacheTtlSec * 1000) return undefined

  recordSaving('cache', entry.tokens)
  console.info(`[sparmodus] ${toolName} aus dem Zwischenspeicher`)
  return { value: entry.value, cards: entry.cards }
}

export function rememberResult(toolName: string, args: unknown, value: unknown, cards: DisplayCard[] = []): void {
  const settings = getSettings().tokenSaver
  if (!settings.enabled || settings.cacheTtlSec <= 0) return
  if (!CACHEABLE.test(toolName)) return

  cache.set(cacheKey(toolName, args), {
    value,
    cards: [...cards],
    at: Date.now(),
    tokens: estimateTokens(String(safeLength(value) ? JSON.stringify(value) : ''))
  })

  // Der Speicher ist eine Abkürzung, kein Archiv.
  if (cache.size > 80) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) cache.delete(oldest[0])
  }
}

export function clearResultCache(): void {
  cache.clear()
}

// ─────────────────────────────────────────────────────────────
// Werkzeugbeschreibungen kürzen
// ─────────────────────────────────────────────────────────────

/**
 * Auf den ersten Satz kürzen.
 *
 * Der erste Satz sagt, wofür das Werkzeug da ist; der Rest sind Beispiele
 * und Abgrenzungen. Die helfen bei der Auswahl, kosten aber bei fünfzig
 * Werkzeugen mehrere tausend Token pro Verbindungsaufbau. Werkzeuge, deren
 * Name allein nichts verrät, behalten mehr Text — deshalb die Untergrenze.
 */
export function slimDescription(description: string): string {
  if (!enabled() || !getSettings().tokenSaver.slimDeclarations) return description
  if (description.length <= 120) return description

  const match = description.match(/^.{40,}?[.!?](\s|$)/s)
  const first = match ? match[0].trim() : description.slice(0, 120)
  return first.length < description.length ? first.slice(0, 160) : description.slice(0, 160)
}

/**
 * Nur den Kern der Werkzeuge deklarieren, den Rest über `tool_search`.
 * Hängt am selben Schalter wie das Kürzen der Beschreibungen.
 */
export function lazyToolsEnabled(): boolean {
  return enabled() && getSettings().tokenSaver.slimDeclarations
}

/** Nach dem Bauen der Deklarationen: was hat das Kürzen gebracht. */
export function recordDeclarationSaving(beforeChars: number, afterChars: number): void {
  if (!enabled()) return
  const saved = Math.ceil((beforeChars - afterChars) / COST_ESTIMATES.CHARS_PER_TOKEN)
  if (saved > 0) recordSaving('declarations', saved)
}

/** Vom Renderer gemeldet (nicht hochgeladene Stille). */
export function recordExternalSaving(kind: SavingKind, tokens: number): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return
  recordSaving(kind, tokens)
}

// ─────────────────────────────────────────────────────────────
// Bericht
// ─────────────────────────────────────────────────────────────

export function tokenReport(): TokenReport {
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const startOfMonth = new Date()
  startOfMonth.setDate(1)
  startOfMonth.setHours(0, 0, 0, 0)

  const today = savingsSince(startOfDay.getTime())
  const byKind = savingsByKind(startOfDay.getTime())
  const silence = byKind.find((k) => k.kind === 'silence')?.tokens ?? 0

  return {
    usage: modelUsageReport(),
    todayTokens: today,
    monthTokens: savingsSince(startOfMonth.getTime()),
    totalTokens: savingsTotal(),
    byKind,
    silenceSecondsToday: Math.round(silence / COST_ESTIMATES.AUDIO_TOKENS_PER_SECOND),
    todayUsd: (today / 1_000_000) * COST_ESTIMATES.USD_PER_MTOK_INPUT
  }
}
