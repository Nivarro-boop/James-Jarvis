import { z } from 'zod'
import type { DisplayCard, ToolGroup, ToolMeta, SecretKey } from '@shared/types'
import { hasSecret } from '../secrets/keystore'
import { lazyToolsEnabled, recordDeclarationSaving, slimDescription } from '../agent/tokenSaver'

/**
 * Zentrale Tool-Registry.
 *
 * Jedes Werkzeug wird einmal mit einem Zod-Schema definiert. Daraus entstehen
 * automatisch die Gemini-`functionDeclarations` für den Live-Socket und die
 * OpenAI-Tool-Schemas für OpenRouter — kein doppeltes Pflegen.
 *
 * Tools, deren Key fehlt, werden gar nicht erst registriert. So kann James
 * nicht behaupten, er könne etwas, das nicht eingerichtet ist.
 */

export interface ToolContext {
  /** Fragt per Stimme nach und wartet auf ja/nein. */
  confirm(spokenQuestion: string, details: Record<string, unknown>): Promise<boolean>
  /** Lässt James mittendrin etwas sagen ("einen Moment, ich schaue nach"). */
  say(text: string): void
  /** Setzt den Kristallzustand für die Dauer des Aufrufs. */
  setState(state: 'tool' | 'research' | 'thinking'): void
  /**
   * Zeigt eine Antwortkarte auf der Startseite — Kurs, Wetter, Orte, Route.
   *
   * Der einzige Weg dorthin; kein Werkzeug schickt `display:card` selbst.
   * `at` und `source` setzt der Runner, eine Karte mit derselben Id ersetzt
   * die vorige. Der Sparmodus legt die Karten mit dem Ergebnis ab und schickt
   * sie bei einem Treffer erneut.
   *
   * Gibt zurück, ob das Kristallfenster gerade sichtbar ist. Dann steht das
   * Ergebnis ohnehin auf dem Schirm, und die gesprochene Antwort darf kürzer
   * sein.
   */
  show(card: DisplayCard): boolean
  /** Ergänzt den laufenden Schritt der Live-Anzeige: Denksatz, Programmsymbol. */
  annotate(update: { thought?: string; icon?: string }): void
  signal: AbortSignal
}

export interface ToolDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string
  group: ToolGroup
  description: string
  schema: S
  alwaysAsk?: boolean
  /**
   * Liest nur, ändert nichts. Bisher nur bei MCP-Werkzeugen gesetzt, aus dem
   * `readOnlyHint`, den der Server selbst mitliefert.
   */
  readOnly?: boolean
  requiresSecret?: SecretKey
  spokenHint?: string
  execute(args: z.infer<S>, ctx: ToolContext): Promise<unknown>
}

const registry = new Map<string, ToolDefinition>()

export function defineTool<S extends z.ZodTypeAny>(def: ToolDefinition<S>): ToolDefinition<S> {
  return def
}

export function register(def: ToolDefinition): void {
  if (def.requiresSecret && !hasSecret(def.requiresSecret)) return
  if (registry.has(def.name)) {
    throw new Error(`Tool doppelt registriert: ${def.name}`)
  }
  registry.set(def.name, def)
}

export function registerAll(defs: ToolDefinition[]): void {
  for (const d of defs) register(d)
}

export function unregisterGroup(group: ToolGroup): void {
  for (const [name, def] of registry) {
    if (def.group === group) registry.delete(name)
  }
}

/** Remove only the definition owned by a connector, even if its old session closes late. */
export function unregisterTool(name: string, expected: ToolDefinition): void {
  if (registry.get(name) === expected) registry.delete(name)
}

/**
 * Alles außer den MCP-Werkzeugen entfernen.
 *
 * Damit lässt sich `registerAllTools()` erneut aufrufen, ohne dass `register`
 * über die Doppelregistrierung stolpert. Gebraucht wird das, sobald ein
 * Zugang dazukommt oder wegfällt: welche Werkzeuge überhaupt existieren,
 * entscheidet sich beim Registrieren an `requiresSecret`.
 *
 * Die MCP-Werkzeuge bleiben stehen — die hängen an keinem Schlüssel, sondern
 * an laufenden Serverprozessen, und ein Neuaufbau wäre hier nicht nur unnötig,
 * sondern würde sie ersatzlos verlieren.
 */
export function unregisterBuiltins(): void {
  for (const [name, def] of registry) {
    if (def.group !== 'mcp') registry.delete(name)
  }
}

export function getTool(name: string): ToolDefinition | undefined {
  return registry.get(name)
}

export function allTools(): ToolDefinition[] {
  return [...registry.values()]
}

export function toolMetas(): ToolMeta[] {
  return allTools().map((t) => ({
    name: t.name,
    group: t.group,
    description: t.description,
    alwaysAsk: t.alwaysAsk ?? false,
    requiresSecret: t.requiresSecret,
    spokenHint: t.spokenHint
  }))
}

// ─────────────────────────────────────────────────────────────
// Zod → JSON Schema
//
// Bewusst ein eigener, kleiner Konverter statt einer Abhängigkeit: die Gemini
// Function-Declarations akzeptieren nur eine enge Teilmenge von JSON Schema
// ($ref, allOf, oneOf und Formatangaben werden abgelehnt). Ein generischer
// Konverter erzeugt genau diese Konstrukte und der Socket antwortet dann mit
// einem wenig hilfreichen 400.
// ─────────────────────────────────────────────────────────────

export interface JsonSchema {
  type?: string
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  /**
   * Immer Zeichenketten, auch für Zahlen-Literale.
   *
   * Nicht aus Nachlässigkeit, sondern weil Gemini es so verlangt: `Schema.enum`
   * ist dort `string[]`. Alle drei Stellen, die hier etwas hineinschreiben —
   * `enum`, `literal` und die Union aus Literalen —, wandeln deshalb mit
   * `String()` um.
   *
   * Stand hier `(string | number)[]`, war der Typ weiter als die Wirklichkeit,
   * und die Telefonleitung, die als einzige gegen Geminis Typen prüft, musste
   * die Zahlen zur Laufzeit noch einmal umbauen — für einen Fall, den es nie
   * gab.
   */
  enum?: string[]
  nullable?: boolean
}

/**
 * Der Typ-Name eines Zod-Schemas in v4 liegt immer auf `_zod.def.type` —
 * die alten `instanceof`-Checks auf `ZodString` & Co. gibt es in v4 nicht
 * mehr, deshalb wird hier über diesen einen Schlüssel verzweigt.
 */
function typeName(schema: z.ZodTypeAny): string {
  return (schema._zod?.def as { type?: string } | undefined)?.type ?? 'unknown'
}

function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  // Wrapper abschälen, aber die Beschreibung mitnehmen.
  const description = schema.description
  const name = typeName(schema)

  // Eine Transformation ändert nicht, was der Aufrufer übergeben muss —
  // gesendet wird die Eingabeseite. Refinements bleiben sogar unverändert:
  // in v4 ist deren `def.type` der Grundtyp (etwa "string"), nur `checks`
  // kommen dazu, und die sind hier ohne Bedeutung.
  if (name === 'pipe') {
    return zodToJsonSchema((schema as any)._zod.def.in as z.ZodTypeAny)
  }
  if (name === 'optional' || name === 'nullable' || name === 'default') {
    const inner = zodToJsonSchema((schema as any)._zod.def.innerType as z.ZodTypeAny)
    return { ...inner, description: description ?? inner.description }
  }

  switch (name) {
    case 'string':
      return { type: 'string', description }
    case 'number':
      return { type: 'number', description }
    case 'boolean':
      return { type: 'boolean', description }
    // `z.enum` und `z.nativeEnum` sind beide Typ 'enum'; die Werte liegen in
    // `entries` — als Objekt bei `enum`, als Objekt bei `nativeEnum`.
    case 'enum':
      return {
        type: 'string',
        enum: Object.values((schema as any)._zod.def.entries as Record<string, unknown>).map(String),
        description
      }
    case 'literal': {
      const v = ((schema as any)._zod.def.values as unknown[])[0]
      return { type: typeof v === 'number' ? 'number' : 'string', enum: [String(v)], description }
    }
    case 'array':
      return { type: 'array', items: zodToJsonSchema((schema as any)._zod.def.element as z.ZodTypeAny), description }
    case 'object': {
      const shape = (schema as any)._zod.def.shape as Record<string, z.ZodTypeAny>
      const properties: Record<string, JsonSchema> = {}
      const required: string[] = []
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value)
        const inner = typeName(value)
        if (inner !== 'optional' && inner !== 'default') required.push(key)
      }
      return {
        type: 'object',
        description,
        properties,
        ...(required.length > 0 ? { required } : {})
      }
    }
    // Union von Literalen ist als Enum darstellbar; alles andere wird zu string
    // degradiert, weil Gemini oneOf nicht annimmt.
    case 'union': {
      const options = (schema as any)._zod.def.options as z.ZodTypeAny[]
      if (options.every((o) => typeName(o) === 'literal')) {
        return {
          type: 'string',
          enum: options.map((o) => String(((o as any)._zod.def.values as unknown[])[0])),
          description
        }
      }
      return { type: 'string', description }
    }
    case 'record':
      return { type: 'object', description }
    default:
      return { type: 'string', description }
  }
}

/**
 * Werkzeuge mit Rückfrage bekommen ein zusätzliches `confirmed`-Feld.
 * Über das teilt das Modell mit, dass es gefragt und eine Zusage bekommen hat;
 * geprüft wird die Zusage im Main-Prozess, nicht vom Modell.
 */
function withConfirmFlag(schema: JsonSchema, needsConfirm: boolean): JsonSchema {
  if (!needsConfirm) return schema
  return {
    ...schema,
    type: 'object',
    properties: {
      ...(schema.properties ?? {}),
      confirmed: {
        type: 'boolean',
        description:
          'Nur setzen, nachdem du den Nutzer gefragt und er ausdrücklich zugestimmt hat. ' +
          'Beim ersten Aufruf weglassen.'
      }
    }
  }
}

/**
 * Das Prädikat wird hereingereicht statt importiert: `permissions.ts` braucht
 * seinerseits die Registry, ein direkter Import wäre ein Zyklus.
 */
export type NeedsConfirm = (toolName: string) => boolean

function compactSchema(schema: JsonSchema): JsonSchema {
  return { ...schema,
    ...(schema.description ? { description: slimDescription(schema.description) } : {}),
    ...(schema.properties ? { properties: Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, compactSchema(value)])) } : {}),
    ...(schema.items ? { items: compactSchema(schema.items) } : {}) }
}

/**
 * Was das Modell immer direkt sieht, wenn der Sparmodus Werkzeuge nachlädt.
 * Alles andere findet es über `tool_search` — die Auswahl hier ist das, was
 * im Gespräch ständig gebraucht wird und keine Suchrunde kosten soll.
 */
export const CORE_TOOLS: ReadonlySet<string> = new Set([
  'tool_search',
  'tool_use',
  'web_search',
  'read_url',
  'weather',
  'stock_price',
  'calculate',
  'timezone_now',
  'open_app',
  'open_url',
  'volume',
  'media_control',
  'timer_set',
  'timer_list',
  'timer_cancel',
  'remember',
  'recall',
  'jarvis_quiet',
  'computer_task',
  'desktop_task',
  'music_play',
  'music_control',
  'plan_update',
  'skill_save',
  'skill_view',
  'self_repair',
  'call_me',
  // Muss ohne Suchrunde erreichbar sein: Gebraucht wird es genau dann, wenn
  // `tool_search` nichts gefunden hat.
  'report_capability_gap'
])

const META_TOOLS = new Set(['tool_search', 'tool_use'])

/** Die Werkzeuge, die dem Modell tatsächlich deklariert werden. */
export function declaredTools(): ToolDefinition[] {
  const lazy = lazyToolsEnabled()
  return allTools().filter((t) => (lazy ? CORE_TOOLS.has(t.name) : !META_TOOLS.has(t.name)))
}

/**
 * Function-Declarations für den Gemini-Live-Socket.
 *
 * Die gehen bei jedem Verbindungsaufbau erneut über die Leitung — also alle
 * fünfzehn Minuten und nach jeder Trennung wegen Stille. Bei fünfzig
 * Werkzeugen mit ausformulierten Beschreibungen ist das der größte einzelne
 * Kostenposten neben dem Audio selbst, deshalb kürzt der Sparmodus hier.
 */
export function geminiToolDeclarations(needsConfirm: NeedsConfirm = () => false): unknown[] {
  let before = 0
  let after = 0

  const declarations = declaredTools().map((t) => {
    const schema = compactSchema(withConfirmFlag(zodToJsonSchema(t.schema), needsConfirm(t.name)))
    const description = slimDescription(t.description)
    before += t.description.length
    after += description.length
    return {
      name: t.name,
      description,
      // Gemini lehnt ein leeres properties-Objekt ab — parameterlose Tools
      // bekommen deshalb gar kein parameters-Feld.
      ...(schema.properties && Object.keys(schema.properties).length > 0
        ? { parameters: schema }
        : {})
    }
  })

  recordDeclarationSaving(before, after)
  return [{ functionDeclarations: declarations }]
}

/** Tool-Schemas im OpenAI-Format für OpenRouter. */
export function openAiToolSchemas(needsConfirm: NeedsConfirm = () => false): unknown[] {
  return declaredTools().map((t) => {
    const schema = compactSchema(withConfirmFlag(zodToJsonSchema(t.schema), needsConfirm(t.name)))
    return {
      type: 'function',
      function: {
        name: t.name,
        description: slimDescription(t.description),
        parameters:
          schema.properties && Object.keys(schema.properties).length > 0
            ? schema
            : { type: 'object', properties: {} }
      }
    }
  })
}

/**
 * Ein Zod-Schema als JSON-Schema.
 *
 * Herausgegeben, seit die Telefonleitung ihre eigene, kürzere Werkzeugliste
 * deklariert (`telephony/phoneTools.ts`). Sie könnte nicht `geminiToolDeclarations`
 * benutzen und danach filtern: Das zählte die Ersparnis des Sparmodus mit, und
 * die Zahlen eines Anrufs gehören nicht in die Statistik der Sitzung am Rechner.
 */
export function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  return zodToJsonSchema(schema)
}

/** Nur zum Testen des Konverters. */
export const __internals = { zodToJsonSchema }
