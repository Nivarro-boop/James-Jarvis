export type CompatibilityDecision =
  | { action: 'answer'; text: string }
  | { action: 'tool'; name: string; arguments: Record<string, unknown> }

/** Streng lesen; ungültiges JSON wird als gesprochene Antwort behandelt. */
export function parseCompatibilityDecision(raw: string): CompatibilityDecision {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  let parsed: Record<string, unknown> | null = null
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>
  } catch {
    // Freier Text darf niemals als Aktion interpretiert werden.
  }
  if (parsed?.action === 'tool' && typeof parsed.name === 'string' && parsed.name.trim()) {
    const args =
      parsed.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments)
        ? (parsed.arguments as Record<string, unknown>)
        : {}
    return { action: 'tool', name: parsed.name.trim(), arguments: args }
  }
  if (parsed?.action === 'answer' && typeof parsed.text === 'string') {
    return { action: 'answer', text: parsed.text.trim() }
  }
  return { action: 'answer', text: raw.trim() }
}

/** Alle Werkzeuge behalten, wiederholten Beschreibungstext begrenzen. */
export function compactToolCatalog(tools: unknown[]): unknown[] {
  const compactSchema = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(compactSchema)
    if (!value || typeof value !== 'object') return value
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(source)) {
      if (key === 'description') {
        if (typeof entry === 'string' && entry.trim()) out[key] = entry.trim().slice(0, 120)
      } else {
        out[key] = compactSchema(entry)
      }
    }
    return out
  }
  return tools.map((tool) => compactSchema(tool))
}
