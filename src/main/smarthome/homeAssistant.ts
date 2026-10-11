import type { SmartHomeStatus } from '@shared/types'
import { getSecret, hasSecret } from '../secrets/keystore'
import { getSettings } from '../store/settings'

/**
 * Der Draht ins Haus.
 *
 * Warum Home Assistant und nicht Apple Home: HomeKit hat keine Schnittstelle,
 * die ein Windows-Programm ansprechen könnte. Es gibt kein REST, keine Wolke
 * für Dritte, und das Kopplungsverfahren ist auf genau einen Steuernden
 * ausgelegt — ein Zubehör, das in der Home-App liegt, nimmt in aller Regel
 * keinen zweiten mehr an. Das ist eine Entscheidung von Apple und keine Lücke
 * hier; es gibt schlicht nichts anzurufen.
 *
 * Home Assistant ist der Übersetzer, den es dafür gibt: Auf der einen Seite
 * spricht es über die HomeKit-Controller-Anbindung mit demselben Zubehör, auf
 * der anderen stellt es eine gewöhnliche HTTP-Schnittstelle bereit, die von
 * hier aus erreichbar ist.
 *
 * Alles unten ist bewusst nur ein dünner Umschlag um diese Schnittstelle.
 * Zustandslogik gehört nach Home Assistant, nicht hierher — was James kann,
 * soll sich mit dem decken, was auch die App auf dem Telefon kann.
 */

/**
 * Kurz gehalten, weil im Heimnetz alles unter einer Sekunde antwortet.
 *
 * Ein längerer Wert hilft nicht: Wenn Home Assistant nicht läuft oder der Name
 * nicht auflöst, kommt gar keine Antwort, und dann sind fünf Sekunden Warten
 * nur fünf Sekunden Stille im Gespräch.
 */
const TIMEOUT_MS = 5000

function baseUrl(): string {
  return getSettings().smartHome.baseUrl.trim().replace(/\/+$/, '')
}

/**
 * Ein Aufruf gegen die Schnittstelle.
 *
 * Die Fehlermeldungen sind ganze Sätze, weil sie vorgelesen werden. Die drei,
 * die wirklich vorkommen, unterscheiden sich in dem, was zu tun ist: falscher
 * Token, falsche Adresse, Dienst aus. Ein „HTTP 401" sagt dazu nichts.
 */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getSecret('homeAssistant')
  if (!token) {
    throw new Error(
      'Für Home Assistant ist kein Token hinterlegt. Sag dem Nutzer, er soll ihn in den ' +
        'Einstellungen unter Zugänge eintragen.'
    )
  }

  const url = `${baseUrl()}${path}`

  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {})
      },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/abort|timeout/i.test(message)) {
      throw new Error(
        `Home Assistant antwortet unter ${baseUrl()} nicht. Läuft es, und stimmt die Adresse?`
      )
    }
    throw new Error(
      `Ich erreiche Home Assistant unter ${baseUrl()} nicht. Prüf die Adresse in den Einstellungen.`
    )
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      'Home Assistant weist den Token ab. Er ist abgelaufen oder gehört zu einem anderen Konto — ' +
        'ein neuer lässt sich im Profil unter „Langlebige Zugriffstoken" anlegen.'
    )
  }
  if (!response.ok) {
    throw new Error(`Home Assistant meldet einen Fehler (${response.status}).`)
  }

  // Manche Dienstaufrufe antworten mit einer leeren Liste und ohne Rumpf.
  const text = await response.text()
  if (!text) return null as T
  /*
    Ein 200er heißt nicht, dass JSON kommt.

    Steht ein Reverse Proxy vor Home Assistant — und bei den meisten
    Installationen tut er das —, dann liefert der bei abgelaufener Anmeldung
    oder falschem Host gern eine HTML-Seite aus, und zwar mit Status 200. Jede
    andere Fehlerlage in dieser Datei hat einen Satz, den man vorlesen kann;
    diese hatte als Einzige einen Parser-Fehler.
  */
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(
      `Unter ${baseUrl()} antwortet etwas, aber kein Home Assistant — die Antwort ist kein JSON. ` +
        'Zeigt die Adresse wirklich auf Home Assistant und nicht auf eine Anmeldeseite davor?'
    )
  }
}

// ─────────────────────────────────────────────────────────────
// Entitäten
// ─────────────────────────────────────────────────────────────

export interface HomeEntity {
  /** Etwa `light.wohnzimmer_decke`. */
  entityId: string
  /** Der Bereich vor dem Punkt — `light`, `switch`, `lock`. */
  domain: string
  /** Der Name, den der Nutzer in der App sieht. */
  name: string
  /** `on`, `off`, `unavailable`, bei Sensoren ein Messwert. */
  state: string
  /** Maßeinheit bei Sensoren, sonst leer. */
  unit: string
}

interface RawState {
  entity_id: string
  state: string
  attributes?: { friendly_name?: string; unit_of_measurement?: string }
}

/**
 * Bereiche, die James überhaupt anfasst.
 *
 * Alles andere blendet er aus — nicht aus Vorsicht, sondern weil eine
 * Home-Assistant-Installation nach ein paar Wochen mehrere hundert Entitäten
 * hat, von denen die allermeisten Diagnosewerte sind: Signalstärken,
 * Firmwarestände, Batteriespannungen. Die vollständige Liste ans Modell zu
 * geben wäre teuer und würde die Lampe, die gemeint ist, im Rauschen
 * verstecken.
 */
const USEFUL_DOMAINS = new Set([
  'light',
  'switch',
  'scene',
  'script',
  'fan',
  'cover',
  'lock',
  'climate',
  'media_player',
  'input_boolean',
  'vacuum',
  'sensor',
  'binary_sensor'
])

/** Die, in denen geschaltet und nicht nur gemessen wird. */
const ACTIONABLE_DOMAINS = new Set([
  'light',
  'switch',
  'scene',
  'script',
  'fan',
  'cover',
  'lock',
  'climate',
  'media_player',
  'input_boolean',
  'vacuum'
])

export function isActionable(domain: string): boolean {
  return ACTIONABLE_DOMAINS.has(domain)
}

function toEntity(raw: RawState): HomeEntity {
  const [domain] = raw.entity_id.split('.')
  return {
    entityId: raw.entity_id,
    domain,
    name: raw.attributes?.friendly_name || raw.entity_id,
    state: raw.state,
    unit: raw.attributes?.unit_of_measurement ?? ''
  }
}

export async function listEntities(): Promise<HomeEntity[]> {
  const raw = await call<RawState[]>('/api/states')
  if (!Array.isArray(raw)) return []
  return raw
    .map(toEntity)
    .filter((e) => USEFUL_DOMAINS.has(e.domain))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'))
}

/**
 * Ein Gerät über den gesprochenen Namen finden.
 *
 * Der Nutzer sagt „das Licht im Wohnzimmer", nicht
 * `light.wohnzimmer_decke_links`. Gesucht wird deshalb in mehreren Stufen —
 * erst genau, dann als Wortmenge —, und mehrere Treffer werden nicht geraten,
 * sondern zurückgegeben: „Welche der drei?" ist eine bessere Antwort als die
 * falsche Lampe.
 */
export function matchEntities(entities: HomeEntity[], query: string): HomeEntity[] {
  const needle = query.toLowerCase().trim()
  if (!needle) return []

  // Genau die Kennung — das trifft, wenn das Modell sie aus einer vorherigen
  // Auflistung übernommen hat.
  const exactId = entities.filter((e) => e.entityId.toLowerCase() === needle)
  if (exactId.length > 0) return exactId

  const exactName = entities.filter((e) => e.name.toLowerCase() === needle)
  if (exactName.length > 0) return exactName

  const contains = entities.filter(
    (e) => e.name.toLowerCase().includes(needle) || e.entityId.toLowerCase().includes(needle)
  )
  if (contains.length > 0) return contains

  // Zuletzt: jedes Wort der Anfrage muss irgendwo vorkommen. Damit findet
  // „wohnzimmer licht" auch „Licht Wohnzimmer".
  const words = needle.split(/\s+/).filter((w) => w.length > 2)
  if (words.length === 0) return []

  return entities.filter((e) => {
    const haystack = `${e.name} ${e.entityId}`.toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

// ─────────────────────────────────────────────────────────────
// Schalten
// ─────────────────────────────────────────────────────────────

export interface ServiceCall {
  domain: string
  service: string
  entityId: string
  data?: Record<string, unknown>
}

export async function callService({ domain, service, entityId, data }: ServiceCall): Promise<void> {
  await call(`/api/services/${domain}/${service}`, {
    method: 'POST',
    body: JSON.stringify({ entity_id: entityId, ...(data ?? {}) })
  })
}

/** Den Zustand einer einzelnen Entität frisch holen. */
export async function entityState(entityId: string): Promise<HomeEntity | null> {
  try {
    const raw = await call<RawState>(`/api/states/${encodeURIComponent(entityId)}`)
    return raw ? toEntity(raw) : null
  } catch {
    // Nach dem Schalten nur zur Bestätigung gedacht — ein Fehlschlag hier soll
    // nicht die gelungene Aktion zu einer misslungenen machen.
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// Zustand für die Einstellungen
// ─────────────────────────────────────────────────────────────

export async function smartHomeStatus(): Promise<SmartHomeStatus> {
  const url = baseUrl()
  const hasToken = hasSecret('homeAssistant')

  if (!hasToken) {
    return {
      reachable: false,
      hasToken: false,
      baseUrl: url,
      error: 'Kein Token hinterlegt.'
    }
  }

  try {
    const info = await call<{ version?: string }>('/api/config')
    const entities = await listEntities()
    return {
      reachable: true,
      hasToken: true,
      baseUrl: url,
      version: info?.version,
      entities: entities.filter((e) => isActionable(e.domain)).length
    }
  } catch (err) {
    return {
      reachable: false,
      hasToken: true,
      baseUrl: url,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}
