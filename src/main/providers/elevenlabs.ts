import { ELEVEN } from '@shared/config/defaults'
import type { ElevenQuota, ElevenVoice } from '@shared/types'
import { createStateGate } from '@shared/stateGate'
import { getSecret } from '../secrets/keystore'

/**
 * ElevenLabs — aber nur das, was der Hauptprozess davon wissen muss.
 *
 * Gesprochen wird im Renderer, weil der Ton dort hingehört (siehe
 * `renderer/audio/elevenVoice.ts`). Hier steht die andere Hälfte: die Frage, ob
 * überhaupt noch Kontingent da ist, und die Auswahl von Stimme und Modell.
 *
 * Warum diese Hälfte hier und nicht dort: Die Kontingentfrage darf nicht vor
 * jedem Satz erneut über die Leitung gehen — sie kostet eine Rundreise, und
 * genau dieser Zeitverlust läge zwischen "sag was" und dem ersten Ton. Also
 * einmal fragen und zwei Minuten glauben. Ein Zwischenspeicher im Renderer wäre
 * bei jedem Öffnen des Kristallfensters wieder leer; hier überlebt er das.
 */

/**
 * So lange gilt eine Auskunft über das Kontingent.
 *
 * Zwei Minuten sind ein Kompromiss aus zwei Fehlern: Zu lang, und wir sprechen
 * gegen eine Wand, die längst da ist. Zu kurz, und jede Antwort beginnt mit
 * einer Rundreise nach Amerika. Der harte Fall — Kontingent geht mitten im Satz
 * zu Ende — wird ohnehin nicht hier gefangen, sondern am Sprech-Socket selbst.
 */
const QUOTA_TTL_MS = 120_000

/** Stimmen und Modelle ändern sich selten; einmal pro Programmlauf reicht. */
const LIST_TTL_MS = 30 * 60_000

interface Cached<T> {
  value: T
  at: number
}

let quotaCache: Cached<ElevenQuota> | null = null
let voiceCache: Cached<ElevenVoice[]> | null = null
let modelCache: Cached<string[]> | null = null

/**
 * Was zuletzt über ElevenLabs ins Protokoll ging.
 *
 * Die Stimmenliste wird bei jedem Öffnen der Einstellungen neu gefragt, und
 * ohne Schlüssel scheitert sie jedes Mal mit demselben Satz — vierzehnmal
 * dieselbe Zeile, obwohl sich nichts geändert hat. Der Satz steht einmal da;
 * ändert sich der Grund oder wechselt der Schlüssel, steht er wieder da.
 */
const quiet = createStateGate(LIST_TTL_MS)

/** Nach einem Schlüsselwechsel ist jede gespeicherte Auskunft wertlos. */
export function forgetElevenCache(): void {
  quotaCache = null
  voiceCache = null
  modelCache = null
  quiet.clear()
}

function fresh<T>(cache: Cached<T> | null, ttl: number): T | null {
  if (!cache) return null
  return Date.now() - cache.at < ttl ? cache.value : null
}

const EMPTY: ElevenQuota = {
  ok: false,
  reason: null,
  used: 0,
  limit: 0,
  remaining: 0,
  resetsAt: null
}

function refused(reason: string): ElevenQuota {
  return { ...EMPTY, reason }
}

/**
 * Ein abgelehnter Aufruf mit dem Grund, den ElevenLabs in den Rumpf schreibt.
 *
 * Der Statuscode allein reicht nicht: 401 heißt bei ElevenLabs sowohl
 * „Schlüssel falsch" als auch „dem Schlüssel fehlt eine Berechtigung" — und
 * das Zweite ist kein Grund, auf die Stimme zu verzichten. Unterschieden wird
 * am Feld `detail.status`. Die alte Fassung warf nur `http-400` und schrieb
 * den Grund nirgends hin; im Protokoll stand dann nur „Verbindung gescheitert".
 */
export class ElevenError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    readonly detail: string
  ) {
    super(`http-${httpStatus}${code ? `:${code}` : ''}`)
  }
}

/** Liest `{ detail: { status, message } }` oder `{ detail: "…" }` aus dem Rumpf. */
export function parseElevenError(httpStatus: number, body: string): ElevenError {
  let code = ''
  let detail = ''
  try {
    const d = (JSON.parse(body) as { detail?: unknown }).detail
    if (typeof d === 'string') detail = d
    else if (Array.isArray(d)) detail = d.map((x) => (x as { msg?: string })?.msg ?? '').join('; ')
    else if (d && typeof d === 'object') {
      const obj = d as { status?: unknown; code?: unknown; message?: unknown }
      code = typeof obj.status === 'string' ? obj.status : typeof obj.code === 'string' ? obj.code : ''
      detail = typeof obj.message === 'string' ? obj.message : ''
    }
  } catch {
    detail = body.slice(0, 200)
  }
  return new ElevenError(httpStatus, code, detail)
}

async function call<T>(path: string, keyOverride?: string): Promise<T> {
  // Getrimmt: Ein beim Kopieren mitgenommener Zeilenumbruch ist im Header
  // ungültig, und fetch wirft dann, bevor überhaupt etwas hinausgeht.
  const key = (keyOverride ?? getSecret('elevenlabs'))?.trim()
  if (!key) throw new Error('kein-schluessel')
  // Unsichtbare Zeichen aus der Zwischenablage (geschütztes Leerzeichen,
  // Zero-Width-Space) lässt fetch im Header nicht zu.
  if (/[^\x21-\x7e]/.test(key)) throw new Error('schluessel-zeichen')

  const response = await fetch(`${ELEVEN.api}${path}`, {
    headers: { 'xi-api-key': key },
    // Ohne Frist hängt ein Netz, das nicht antwortet, die Sitzung auf. Zehn
    // Sekunden sind großzügig für eine Abfrage, die nur Zahlen zurückgibt.
    signal: AbortSignal.timeout(10_000)
  })

  if (!response.ok) {
    const error = parseElevenError(response.status, await response.text().catch(() => ''))
    console.warn(`[eleven] ${path} abgelehnt: ${response.status} ${error.code} ${error.detail}`)
    throw error
  }
  return (await response.json()) as T
}

/**
 * Hat ElevenLabs endgültig nein gesagt?
 *
 * Ja bei falschem Schlüssel, gesperrtem Konto und aufgebrauchtem Kontingent.
 * Nein bei fehlender Berechtigung für genau diese Abfrage, bei Netzfehlern und
 * bei Störungen auf der Gegenseite — dann soll der Sprech-Sockel es versuchen.
 */
export function isDefinitiveRefusal(err: unknown): boolean {
  if (err instanceof Error && (err.message === 'kein-schluessel' || err.message === 'schluessel-zeichen')) return true
  if (!(err instanceof ElevenError)) return false
  if (err.code === 'missing_permissions' || err.code === 'needs_authorization') return false
  if (['invalid_api_key', 'api_key_id_used_as_api_key', 'detected_unusual_activity', 'quota_exceeded', 'account_suspended'].includes(err.code)) return true
  return err.httpStatus === 401 && !err.code
}

/** Rohe Fehler sind für die Einstellungsseite unbrauchbar. */
export function explain(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (raw === 'kein-schluessel') return 'Es ist kein ElevenLabs-Schlüssel hinterlegt.'
  if (raw === 'schluessel-zeichen') {
    return 'Im ElevenLabs-Schlüssel steckt ein unsichtbares Zeichen. Kopier ihn neu und füg ihn nochmal ein.'
  }
  if (err instanceof ElevenError) {
    switch (err.code) {
      case 'invalid_api_key':
        return 'ElevenLabs nimmt den Schlüssel nicht an. Kopier ihn neu aus elevenlabs.io unter Developers, API Keys.'
      case 'api_key_id_used_as_api_key':
        return 'Das ist die Kennung des ElevenLabs-Schlüssels, nicht der Schlüssel selbst. Der echte Schlüssel beginnt mit „sk_“ und wird nur beim Anlegen angezeigt; leg bei Bedarf einen neuen an.'
      case 'missing_permissions':
        return 'Dem ElevenLabs-Schlüssel fehlt eine Berechtigung. Gib ihm bei ElevenLabs unter API Keys Zugriff auf Text to Speech, Voices, Models und User.'
      case 'detected_unusual_activity':
        return 'ElevenLabs hat den Gratiszugang gesperrt (ungewöhnliche Aktivität, oft wegen VPN). Ohne VPN oder mit bezahltem Tarif geht es wieder.'
      case 'quota_exceeded':
        return 'Das Kontingent bei ElevenLabs ist aufgebraucht.'
      case 'payment_required':
      case 'paid_plan_required':
        return 'Das geht bei ElevenLabs nur mit bezahltem Tarif.'
    }
    if (err.httpStatus === 401) return 'ElevenLabs nimmt den Schlüssel nicht an. Prüf ihn in den Einstellungen.'
    if (err.httpStatus === 403) return 'Dieser Schlüssel darf das nicht — ihm fehlt eine Berechtigung.'
    if (err.httpStatus === 429) return 'Zu viele Anfragen auf einmal. Gleich nochmal.'
    if (err.httpStatus >= 500) return 'ElevenLabs hat gerade selbst ein Problem.'
    return `ElevenLabs lehnt ab (${err.httpStatus}${err.detail ? `: ${err.detail}` : ''}).`
  }
  if (raw.includes('timeout') || raw.includes('abort')) return 'ElevenLabs antwortet nicht.'
  // Die eigentliche Ursache gehört ins Protokoll, sonst bleibt nur der Satz.
  console.warn('[eleven] Verbindung gescheitert:', raw, (err as { cause?: unknown })?.cause ?? '')
  return 'Ich komme gerade nicht zu ElevenLabs durch.'
}

/**
 * Einen neuen Schlüssel prüfen, bevor er gespeichert wird.
 *
 * Über die Modellliste: kostet kein Zeichen. Fehlt dem Schlüssel nur die
 * Berechtigung dafür, ist er trotzdem echt — dann wird gespeichert und
 * gesagt, was fehlt.
 */
export async function checkElevenKey(value: string): Promise<{ ok: boolean; error?: string; note?: string }> {
  try {
    await call<unknown>('/models', value)
    return { ok: true }
  } catch (err) {
    if (err instanceof ElevenError && err.code === 'missing_permissions') return { ok: true, note: explain(err) }
    if (isDefinitiveRefusal(err)) return { ok: false, error: explain(err) }
    // Netz weg oder Störung: nicht am Speichern hindern.
    return { ok: true, note: `Gespeichert, aber nicht geprüft: ${explain(err)}` }
  }
}

interface Subscription {
  character_count?: number
  character_limit?: number
  status?: string
  next_character_count_reset_unix?: number
}

/**
 * Wie viel Kontingent noch da ist.
 *
 * `ok` heißt: Es darf gesprochen werden. Alles andere ist ein Grund, der auf der
 * Einstellungsseite lesbar sein muss — "geht nicht" ohne Warum ist die
 * Fehlermeldung, über die man am längsten grübelt.
 */
export async function elevenQuota(force = false): Promise<ElevenQuota> {
  if (!force) {
    const cached = fresh(quotaCache, QUOTA_TTL_MS)
    if (cached) return cached
  }

  let quota: ElevenQuota
  try {
    const sub = await call<Subscription>('/user/subscription')
    const used = sub.character_count ?? 0
    const limit = sub.character_limit ?? 0
    const remaining = Math.max(0, limit - used)
    quota = {
      // Ein Konto ohne Obergrenze gibt es; dann steht dort eine Null, und die
      // heißt "unbegrenzt", nicht "aufgebraucht".
      ok: limit === 0 || remaining > 0,
      reason:
        limit > 0 && remaining <= 0
          ? 'Das Kontingent bei ElevenLabs ist aufgebraucht. Ich spreche solange mit Geminis Stimme.'
          : null,
      used,
      limit,
      remaining: limit === 0 ? Number.MAX_SAFE_INTEGER : remaining,
      resetsAt: sub.next_character_count_reset_unix ?? null
    }
  } catch (err) {
    quota = isDefinitiveRefusal(err)
      ? refused(explain(err))
      : // Unklar ist nicht nein. Ein Schlüssel ohne „User: read" oder ein
        // kurzer Netzfehler verhindert die Abfrage, nicht das Sprechen. Ob die
        // Stimme geht, sagt der Sprech-Sockel — und der meldet sich mit einem
        // Grund, nach dem auf Gemini umgeschaltet wird. Bisher hieß jeder
        // Fehler hier „ElevenLabs steht nicht bereit", und James sprach nie.
        {
          ok: true,
          reason: `Kontingent unbekannt: ${explain(err)}`,
          used: 0,
          limit: 0,
          remaining: Number.MAX_SAFE_INTEGER,
          resetsAt: null,
          unverified: true
        }
  }

  // Eine unsichere Auskunft nur zwanzig Sekunden glauben, nicht zwei Minuten.
  quotaCache = { value: quota, at: quota.unverified ? Date.now() - QUOTA_TTL_MS + 20_000 : Date.now() }
  return quota
}

/**
 * Was der Renderer nach dem Sprechen abzieht.
 *
 * Ohne das wäre die gespeicherte Auskunft bis zu zwei Minuten lang zu
 * großzügig — und das ist genau die Zeitspanne, in der jemand die letzten
 * Zeichen seines Kontingents verspricht. Genau abrechnen kann das hier nicht;
 * es geht darum, den Umschaltpunkt nicht zu verschlafen.
 */
export function noteElevenSpent(chars: number, creditMultiplier = 1): void {
  if (!quotaCache || chars <= 0) return
  const quota = quotaCache.value
  if (!quota.ok || quota.limit === 0) return
  const credits = Math.max(1, Math.ceil(chars * creditMultiplier))
  const remaining = Math.max(0, quota.remaining - credits)
  quotaCache = {
    at: quotaCache.at,
    value: { ...quota, used: quota.used + credits, remaining, ok: remaining > 0 }
  }
}

interface VoiceList {
  voices?: { voice_id?: string; name?: string; category?: string }[]
}

export async function elevenVoices(): Promise<ElevenVoice[]> {
  const cached = fresh(voiceCache, LIST_TTL_MS)
  if (cached) return cached

  try {
    const list = await call<VoiceList>('/voices')
    const voices = (list.voices ?? [])
      .filter((voice) => typeof voice.voice_id === 'string')
      .map((voice) => ({
        id: voice.voice_id as string,
        name: voice.name ?? 'Ohne Namen',
        category: voice.category ?? 'premade'
      }))
    voices.sort((a, b) => rank(a.category) - rank(b.category))
    voiceCache = { value: voices, at: Date.now() }
    quiet.forget('stimmen')
    return voices
  } catch (err) {
    const reason = explain(err)
    if (quiet.changed('stimmen', reason)) console.warn('[eleven] Stimmen nicht abrufbar:', reason)
    return []
  }
}

/**
 * Die Reihenfolge, in der Stimmen angeboten werden — und damit auch die, aus
 * der die erste automatisch genommen wird.
 *
 * Die mitgelieferten stehen vorn, und das ist gegen die Erwartung. Der Grund
 * steht in einer Fehlermeldung: Stimmen aus der Bibliothek — Kategorie
 * `professional` — sind im Gratistarif gesperrt, und der Anbieter sagt das
 * nicht beim Auflisten, sondern erst beim Sprechen, mit `paid_plan_required`.
 * Eine automatische Wahl, die zuverlässig scheitert, ist schlechter als eine
 * gewöhnliche, die funktioniert. Wer eine bestimmte will, wählt sie in den
 * Einstellungen; die Liste zeigt weiterhin alle.
 */
function rank(category: string): number {
  if (category === 'premade') return 0
  if (category === 'cloned') return 1
  if (category === 'generated') return 2
  return 3
}

/**
 * Eine Hörprobe.
 *
 * Der Grund, warum es sie gibt: Eine Stimme aus einer Liste zu wählen, ohne sie
 * gehört zu haben, ist raten. Man merkt es erst im Gespräch, und dann wieder in
 * den Einstellungen, und dazwischen liegt jedes Mal ein Neustart der Sitzung.
 * Ein Knopf, der einen Satz sprechen lässt, erspart die ganze Schleife.
 *
 * Als MP3 und nicht als rohes PCM: Hier hängt kein Player, hier hängt ein
 * gewöhnliches Audio-Element im Einstellungsfenster, und das versteht MP3 von
 * sich aus.
 */
export async function elevenPreview(
  voiceId: string,
  text: string
): Promise<{ ok: boolean; audio?: string; error?: string }> {
  const key = getSecret('elevenlabs')?.trim()
  if (!key) return { ok: false, error: 'Es ist kein ElevenLabs-Schlüssel hinterlegt.' }
  if (!voiceId) return { ok: false, error: 'Wähl erst eine Stimme.' }

  const modelId = (await elevenBestModel()) ?? ELEVEN.modelPreference[0]
  try {
    const response = await fetch(
      `${ELEVEN.api}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({ text, model_id: modelId })
      }
    )

    if (!response.ok) {
      // Der Anbieter schreibt den Grund in den Rumpf, nicht in den Status —
      // gerade die gesperrte Bibliotheksstimme sähe sonst aus wie ein Ausfall.
      const raw = await response.text()
      const detail = /paid_plan|payment/i.test(raw)
        ? 'Diese Stimme gibt es nur mit bezahltem Tarif.'
        : explain(parseElevenError(response.status, raw))
      return { ok: false, error: detail }
    }

    const audio = Buffer.from(await response.arrayBuffer()).toString('base64')
    noteElevenSpent(text.length, /flash|turbo/.test(modelId) ? 0.5 : 1)
    return { ok: true, audio }
  } catch (err) {
    return { ok: false, error: explain(err) }
  }
}

interface ModelList {
  model_id?: string
  can_do_text_to_speech?: boolean
  languages?: { language_id?: string }[]
}

/**
 * Das schnellste Modell, das dieses Konto sprechen darf.
 *
 * Abgefragt statt eingebaut: Eine fest verdrahtete Kennung, die es nicht mehr
 * gibt, wäre ein Fehler ohne Rückweg — und welche Modelle freigeschaltet sind,
 * hängt am Tarif. Die Wunschliste steht in `ELEVEN.modelPreference`; was nicht
 * darauf steht, wird genommen, wenn sonst nichts übrig bleibt.
 */
export async function elevenBestModel(
  mode: 'saving' | 'quality' = 'saving'
): Promise<string | null> {
  const preference = mode === 'quality' ? ELEVEN.qualityModelPreference : ELEVEN.modelPreference
  let usableIds = fresh(modelCache, LIST_TTL_MS)
  try {
    if (!usableIds) {
      const models = await call<ModelList[]>('/models')
      usableIds = models
        .filter((model) => model.can_do_text_to_speech && model.model_id)
        .map((model) => model.model_id as string)
      modelCache = { value: usableIds, at: Date.now() }
    }
  } catch (err) {
    console.warn('[eleven] Modelle nicht abrufbar:', explain(err))
    // Kein Grund aufzugeben: Die erste Wahl ist der übliche Name, und schlägt
    // sie fehl, meldet sich der Sprech-Socket mit einem klaren Fehler.
    usableIds = [preference[0] ?? ELEVEN.modelPreference[0]]
  }
  return preference.find((wanted) => usableIds?.includes(wanted)) ?? usableIds?.[0] ?? null
}
