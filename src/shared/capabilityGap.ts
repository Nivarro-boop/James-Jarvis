/**
 * Fähigkeitslücken: Stellen, an denen James sagt oder merkt, dass er etwas
 * nicht kann.
 *
 * Gesammelt wird das, damit es ins nächste Update kommt. Deshalb trägt ein
 * Bericht nicht nur den Satz „das kann ich nicht“, sondern auch, worum es ging,
 * woran es lag und was man bauen müsste. Alles hier ist rein und ohne Electron,
 * damit Renderer, Hauptprozess und Tests dieselbe Erkennung benutzen.
 *
 * Anders als die Fehlerstatistik enthält ein solcher Bericht Gesprächstext.
 * Er geht deshalb nur mit eigener Zustimmung hinaus (`capabilityGaps`) und
 * vorher durch `redactPersonal`.
 */

/** Woher der Hinweis auf die Lücke stammt. */
export type GapSource = 'answer' | 'tool' | 'model'

/** Wie ein Werkzeugaufruf gescheitert ist, soweit es für eine Lücke zählt. */
export type GapToolFailureKind = 'unknown' | 'no-match' | 'invalid' | 'locked' | 'error'

export interface GapToolFailure {
  tool: string
  kind: GapToolFailureKind
  /** Fehlertext oder bei `no-match` die Suchworte. */
  detail: string
}

export interface CapabilityGap {
  /** Was der Nutzer wollte. */
  request: string
  /** Was James geantwortet hat; leer, wenn nur ein Werkzeug gescheitert ist. */
  answer: string
  /** Erkannter oder vom Modell genannter Grund. */
  reason: string
  /** Was man ändern müsste, damit James es kann. */
  suggestion: string
  /** Beteiligte Werkzeuge mit ihrem Scheitern. */
  tools: GapToolFailure[]
  /** Sprachweg oder Kanal: live, realtime, cascade, text, alexa, telefon … */
  channel: string
  sources: GapSource[]
}

export const GAP_LIMITS = { request: 600, answer: 1200, reason: 300, suggestion: 800, detail: 300, tools: 6 } as const

/**
 * Formulierungen, mit denen James ablehnt oder Unvermögen einräumt.
 *
 * Bewusst auf die erste Person beschränkt: „Das kannst du nicht“ oder „das
 * Geschäft kann heute nicht liefern“ sind keine Lücken von James.
 *
 * Füllwörter stehen als `[\p{L}\p{N}]+` und nicht als `\w+`: `\w` kennt keine
 * Umlaute, und „Das kann ich über Alexa nicht“ fiel sonst durch.
 *
 * „kann ich … nicht“ gilt mit jedem Wort davor: „Da kann ich dir nicht
 * helfen“, „Musik abspielen kann ich nicht“ und das knappe „Kann ich leider
 * nicht“ sind die häufigsten Absagen. An 70 Beispielantworten fielen sonst ein
 * Drittel der Absagen durch.
 */
const W = String.raw`[\p{L}\p{N}]+\s+`
/** Was nach „nicht“ steht, ohne dass eine Fähigkeit fehlt: „nicht garantieren“, „nicht genau sagen“. */
const HEDGE = String.raw`(?:nur|genau|garantieren|versprechen|ausschließen|empfehlen|verstehen|hören|sagen,\s+ob)\b`
/** „Ich kann keinen Termin mit Anna finden“ ist ein Suchergebnis, keine Grenze. */
const NO_RESULT = String.raw`(?![^.!?,;:–—]{0,200}?\b(?:finden|feststellen|entdecken|gefunden|festgestellt|entdeckt)\b)`
const NOUN = String.raw`(?:werkzeug|zugriff|zugangsdaten|zugang|möglichkeit|funktion|berechtigung|schnittstelle|fähigkeit|anbindung|verbindung|rechte)(?:e|en|n|s)?\b`
const NEGATION = String.raw`(?:nicht\b(?!\s+${HEDGE})|keine?n?\s+\p{L}|nichts\s+(?:machen|tun|unternehmen|ausrichten)\b)`

const REFUSALS: RegExp[] = [
  new RegExp(String.raw`\bkann\s+ich\s+${NO_RESULT}(?:${W}){0,3}?${NEGATION}`, 'iu'),
  new RegExp(String.raw`\bich\s+kann\s+${NO_RESULT}(?:${W}){0,4}?(?:nicht|keine?n?)(?:\s+(?!${HEDGE})\p{L}|\s*(?:[.!,;:?–—-]|$))`, 'iu'),
  // „Ich bin nur ein Sprachassistent und kann keine Anrufe tätigen.“
  new RegExp(String.raw`\bich\s+(?:bin|habe)\b[^.!?]{0,80}?\b(?:und|aber)\s+kann\s+(?:${W}){0,3}?${NEGATION}`, 'iu'),
  new RegExp(String.raw`\b(?:ich\s+(?:habe|hab)|(?:habe|hab)\s+ich|(?:weil|da|dass)\s+ich|gibt\s+es\s+bei\s+mir|bei\s+mir\s+gibt\s+es)\s+${NO_RESULT}(?:${W}){0,3}?(?:kein(?:e|en)?|nicht\s+(?:die|den|das))\s+(?:${W})?${NOUN}`, 'iu'),
  new RegExp(String.raw`\b${NOUN}\s+(?:${W}){0,3}?habe\s+ich\s+(?:${W}){0,2}?nicht\b`, 'iu'),
  // Nur mit Werkzeug und Co.: „Mir fehlt noch die Uhrzeit“ ist eine Rückfrage.
  new RegExp(String.raw`\bfehl(?:t|en)\s+mir\s+(?:${W}){0,3}?${NOUN}|\bmir\s+fehl(?:t|en)\s+(?:${W}){0,3}?${NOUN}`, 'iu'),
  /\b(?:steht|stehen)\s+(?:mir\s+)?(?:[\p{L}\p{N}]+\s+){0,3}?nicht\s+zur\s+verfügung\b/iu,
  /\b(?:das|dies|es)\s+(?:ist|geht)\s+(?:mir\s+)?(?:[\p{L}\p{N}]+\s+){0,2}?(?:nicht\s+möglich|nicht)\s*[.!,]/iu,
  /\b(?:das|dies|es)\s+(?:ist|wäre)\s+(?:[\p{L}\p{N}]+\s+){0,5}?nicht\s+möglich\b|\b(?:ist|wäre)\s+(?:das|dies|es)\s+(?:mir\s+)?(?:[\p{L}\p{N}]+\s+){0,2}?nicht\s+möglich\b/iu,
  /\b(?:bin|wäre)\s+ich\s+(?:[\p{L}\p{N}]+\s+){0,2}?nicht\s+(?:[\p{L}\p{N}]+\s+)?in\s+der\s+lage\b|\bich\s+bin\s+(?:[\p{L}\p{N}]+\s+){0,2}?nicht\s+(?:[\p{L}\p{N}]+\s+)?in\s+der\s+lage\b/iu,
  /\b(?:das|dies)\s+(?:beherrsche|unterstütze|schaffe)\s+ich\s+(?:[\p{L}\p{N}]+\s+)?nicht\b|\b(?:beherrsche|unterstütze)\s+ich\s+(?:das|dies|es)\s+(?:[\p{L}\p{N}]+\s+)?nicht\b/iu,
  // Vor „ü“ greift `\b` nicht — es zählt nur ASCII als Wortzeichen.
  /\b(?:außerhalb|jenseits)\s+meiner\s+(?:möglichkeiten|fähigkeiten)\b|(?<![\p{L}\p{N}])übersteigt\s+meine\b|\bnicht\s+zu\s+meinen\s+(?:fähigkeiten|funktionen|aufgaben)\b/iu,
  /\bda\s+muss\s+ich\s+(?:leider\s+)?passen\b/iu,
  /\bwird\s+(?:[\p{L}\p{N}]+\s+){0,3}?nicht\s+unterstützt\b/iu,
  /\bi\s+(?:can(?:no|')t|cannot|am\s+unable|'m\s+unable|am\s+not\s+able|'m\s+not\s+able)\b/i,
  /\bi\s+(?:don't|do\s+not)\s+have\s+(?:access|a\s+tool|the\s+ability|permission)\b/i
].map((pattern) => new RegExp(pattern.source, `${pattern.flags}g`))

/** „Ohne deine Bestätigung kann ich die Mail nicht senden“ wartet auf ein Ja und ist keine Lücke. */
const AWAITS_CONSENT = /\bohne\s+(?:deine|ihre|eine|dein|ihr)\s+(?:ausdrückliche\s+)?(?:bestätigung|zustimmung|freigabe|erlaubnis|okay|ok)\b/iu

function firstSentenceAround(text: string, index: number): string {
  const start = Math.max(text.lastIndexOf('.', index - 1), text.lastIndexOf('!', index - 1), text.lastIndexOf('?', index - 1), text.lastIndexOf('\n', index - 1)) + 1
  const rest = text.slice(index)
  const endMatch = /[.!?\n]/.exec(rest)
  const end = endMatch ? index + endMatch.index + 1 : text.length
  return text.slice(start, end).trim()
}

/**
 * Der Satz, in dem James ablehnt, oder `null`.
 *
 * Rückfragen („Kann ich sonst noch helfen?“) zählen nicht: Sie enthalten keine
 * Verneinung. Höfliche Einschränkungen wie „das kann ich nicht garantieren“
 * werden ausgelassen, weil dahinter keine fehlende Fähigkeit steckt.
 */
export function detectRefusal(answer: string): string | null {
  const text = answer.replace(/\s+/g, ' ').trim()
  if (text.length < 8) return null
  for (const pattern of REFUSALS) {
    for (const match of text.matchAll(pattern)) {
      const sentence = firstSentenceAround(text, match.index)
      if (!AWAITS_CONSENT.test(sentence)) return clip(sentence, GAP_LIMITS.reason)
    }
  }
  return null
}

const PERSONAL: Array<[RegExp, string]> = [
  [/\b(?:AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9_-]{8,}|sk_[A-Za-z0-9]{8,}|ya29\.[0-9A-Za-z_.-]+|1\/\/[0-9A-Za-z_-]{20,}|AC[0-9a-f]{32})\b/g, '[Schlüssel]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [Schlüssel]'],
  // Gesprochen kommt kein Doppelpunkt: „mein Passwort ist Sonne123“.
  [/\b(api[_-]?key|token|secret|password|passwort|kennwort|authorization|pin|tan)(\s*[:=]\s*|\s+(?:ist|lautet|is|heißt)(?:\s*[:=])?\s+)\S+/gi, '$1$2[Schlüssel]'],
  [/\b[0-9a-f]{32,}\b/gi, '[Schlüssel]'],
  // Vor der E-Mail-Regel: Sonst bliebe von „https://nutzer:kennwort@host“ der
  // Teil vor dem „@“ als Host stehen.
  [/\bhttps?:\/\/(?:[^\s/?#@]*@)?([^\s/?#@]+)[^\s]*/gi, 'https://$1/…'],
  // Der Rückblick lässt die Suche nur am Anfang eines Wortes beginnen. Ohne ihn
  // wird ein langes Wort ohne „@“ quadratisch: 50 000 Zeichen, zwei Sekunden.
  [/(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[E-Mail]'],
  // Fehlertexte von Werkzeugen nennen Pfade, und der Profilordner trägt oft den Namen.
  [/\b([A-Za-z]:[\\/]+(?:Users|Benutzer)[\\/]+)[^\\/\r\n"'<>|:*?]+/gi, '$1[Name]'],
  [/(\/(?:home|Users)\/)[^/\s"'<>|:*?]+/g, '$1[Name]'],
  [/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g, '[IBAN]'],
  [/(?:\+|\b00)?\d[\d ()/-]{6,}\d/g, '[Nummer]']
]

/** Schlüssel, Adressen, Nummern und Links aus Gesprächstext entfernen. */
export function redactPersonal(text: string): string {
  let out = text
  for (const [pattern, replacement] of PERSONAL) out = out.replace(pattern, replacement)
  return out
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}

/** Ein Lösungsvorschlag aus dem, was beim Werkzeugaufruf passiert ist. */
export function suggestFix(input: { request: string; tools: GapToolFailure[]; modelSuggestion?: string }): string {
  const parts: string[] = []
  if (input.modelSuggestion?.trim()) parts.push(input.modelSuggestion.trim())
  for (const t of input.tools) {
    switch (t.kind) {
      case 'unknown':
        parts.push(`Das Modell hat das Werkzeug „${t.tool}“ aufgerufen, das es nicht gibt. Werkzeug bauen oder Beschreibung/Prompt so ändern, dass das passende Werkzeug gewählt wird.`)
        break
      case 'no-match':
        parts.push(`tool_search fand nichts zu „${t.detail}“. Neues Werkzeug dafür bauen (src/main/tools/impl) und in der Registry eintragen, oder Stichworte in vorhandenen Beschreibungen ergänzen.`)
        break
      case 'invalid':
        parts.push(`„${t.tool}“ wurde mit ungültigen Argumenten aufgerufen (${t.detail}). Schema und Beschreibung schärfen.`)
        break
      case 'locked':
        parts.push(`„${t.tool}“ ist in den Einstellungen gesperrt. Freigabe prüfen oder James darauf hinweisen lassen.`)
        break
      case 'error':
        parts.push(`„${t.tool}“ ist gescheitert (${t.detail}). Fehlerbehandlung oder Zugang dieses Werkzeugs prüfen.`)
        break
    }
  }
  if (parts.length === 0) {
    parts.push(`James hat keine passende Fähigkeit. Werkzeug oder Anleitung für diese Art Anfrage ergänzen: „${clip(input.request, 160)}“.`)
  }
  return clip([...new Set(parts)].join(' '), GAP_LIMITS.suggestion)
}

/** Gleiche Lücke, gleicher Schlüssel — damit dieselbe Bitte nicht zwanzigmal ankommt. */
export function gapFingerprint(gap: Pick<CapabilityGap, 'request' | 'tools'>): string {
  const words = gap.request
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 3)
    .sort()
    .slice(0, 12)
    .join(' ')
  const tools = [...new Set(gap.tools.map((t) => `${t.kind}:${t.tool}`))].sort().join(',')
  return `${words}|${tools}`
}

/** Reinigt und kürzt eine Lücke, bevor sie das Gerät verlässt. */
export function sanitizeGap(gap: CapabilityGap): CapabilityGap {
  return {
    request: clip(redactPersonal(gap.request), GAP_LIMITS.request),
    answer: clip(redactPersonal(gap.answer), GAP_LIMITS.answer),
    reason: clip(redactPersonal(gap.reason), GAP_LIMITS.reason),
    suggestion: clip(redactPersonal(gap.suggestion), GAP_LIMITS.suggestion),
    tools: gap.tools.slice(0, GAP_LIMITS.tools).map((t) => ({
      tool: clip(t.tool, 80),
      kind: t.kind,
      detail: clip(redactPersonal(t.detail), GAP_LIMITS.detail)
    })),
    channel: clip(gap.channel, 30),
    sources: [...new Set(gap.sources)]
  }
}

/** Unter den 16 KB des Empfängers, mit Luft für Kopfzeilen. */
const REPORT_BYTES = 15_000

function reportBytes(report: unknown): number {
  return new TextEncoder().encode(JSON.stringify(report)).length
}

/**
 * Bericht im Format des Empfängers (`error-dashboard`).
 *
 * `kind` kennt erst der neue Empfänger; ein alter verwirft das Feld und
 * speichert den Bericht als gewöhnliche Info-Meldung. `details` bleibt unter
 * 9000 Zeichen, damit auch Umlaute die Grenze von 16 KB nicht reißen.
 *
 * Zeichen allein reichen dafür nicht: `details` wird beim Versand ein zweites
 * Mal verpackt, und Anführungszeichen oder Rückstriche wachsen dabei auf das
 * Vierfache, „€“ belegt drei Bytes. Deshalb wird am Ende in Bytes gemessen und
 * notfalls weiter gekürzt.
 */
export function capabilityGapReport(version: string, platform: string, raw: CapabilityGap) {
  const gap = sanitizeGap(raw)
  const message = clip(`JARVIS: Fähigkeit fehlt – ${gap.reason || gap.request}`, 400)
  const build = (details: string) => ({
    level: 'info' as const,
    kind: 'capability-gap' as const,
    message,
    source: 'JARVIS',
    details
  })
  const payload = { kind: 'capability-gap', appVersion: version, platform, ...gap }
  let details = JSON.stringify(payload)
  if (details.length > 9000) details = JSON.stringify({ ...payload, answer: clip(gap.answer, 300) })
  for (let factor = 2; factor <= 64 && (details.length > 9000 || reportBytes(build(details)) > REPORT_BYTES); factor *= 2) {
    const cut = (text: string, max: number) => clip(text, Math.max(20, Math.floor(max / factor)))
    details = JSON.stringify({
      ...payload,
      request: cut(gap.request, GAP_LIMITS.request),
      answer: cut(gap.answer, 300),
      reason: cut(gap.reason, GAP_LIMITS.reason),
      suggestion: cut(gap.suggestion, GAP_LIMITS.suggestion),
      tools: gap.tools.slice(0, Math.max(1, Math.floor(GAP_LIMITS.tools / factor))).map((t) => ({
        ...t,
        tool: cut(t.tool, 80),
        detail: cut(t.detail, GAP_LIMITS.detail)
      })),
      channel: cut(gap.channel, 30)
    })
  }
  return build(details)
}
