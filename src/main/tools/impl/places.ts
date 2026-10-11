import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { getSettings } from '../../store/settings'
import type { GeoPoint, LatLon, PlacesCard, RouteCard, RouteMode } from '@shared/types'
import { ROUTE_PATH_MAX } from '@shared/types'
import { clock, spokenDistance, spokenDuration } from '@shared/format'
import { osmPlaceUrl, osmRouteUrl, simplifyPath } from '@shared/geo'
import { geocode } from '../../maps/geocode'
import { searchPlaces } from '../../maps/poi'
import { route } from '../../maps/routing'

/**
 * Orte finden und Wege ausrechnen — mit eigener Ortssuche und eigenem Routing.
 *
 * Kein Schlüssel, kein kommerzieller Dienst: Die Daten kommen aus
 * OpenStreetMap über Photon, Nominatim und Overpass (siehe `maps/`). Beide
 * Werkzeuge sind deshalb immer da, ohne `requiresSecret`. Ohne sie antwortete
 * das Modell auf „wie lange fahr ich nach Graz" aus dem Gedächtnis, und eine
 * geschätzte Fahrzeit klingt genauso sicher wie eine gerechnete.
 *
 * Ohne Ortsangabe gilt der Standardstandort aus den Einstellungen, wie beim
 * Wetter. Keine Ortung über IP oder GPS, auch nicht als Gewichtung für die
 * Suche: Wo der Nutzer ist, sagt er selbst.
 *
 * Koordinaten, Linien und Links gehen nur über die Karte (`ctx.show`), nie ins
 * Ergebnis fürs Modell — dort kosten sie Token und helfen beim Vorlesen nicht.
 */

/**
 * Fremder Text, der als Knopf zurück an James geht, wird entschärft.
 *
 * Ortsnamen kommen aus OpenStreetMap, und jeder kann dort einen Namen
 * eintragen. Ein Klick schickt ihn als getippten Satz — ohne Zeilenumbrüche
 * und auf 80 Zeichen gekürzt kann daraus keine Anweisung werden.
 */
function clean(text: string): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat
}

/** Einen genannten Ort auflösen, mit dem Fehlertext, den das Modell vorlesen kann. */
async function locate(place: string, near: LatLon | undefined, signal?: AbortSignal): Promise<GeoPoint> {
  const hit = await geocode(place, near, { signal })
  if (!hit) throw new Error(`Den Ort "${place}" finde ich nicht. Frag nach einer genaueren Angabe, etwa mit Stadt oder Straße.`)
  return hit
}

// ─────────────────────────────────────────────────────────────
// Orte suchen
// ─────────────────────────────────────────────────────────────

const ortSuchen = defineTool({
  name: 'ort_suchen',
  group: 'web',
  description:
    'Findet Orte, Adressen, Geschäfte und Einrichtungen in der Nähe, mit Adresse und Entfernung. ' +
    'Für "wo ist die nächste Apotheke", "gibt es hier einen Supermarkt", "wo liegt der Stephansdom", ' +
    '"welche Adresse hat das Café Central".',
  spokenHint: 'Ich schaue nach.',
  schema: z.object({
    suche: z
      .string()
      .describe('Was gesucht wird: eine Art von Ort ("Apotheke", "Tankstelle"), ein Name oder eine Adresse.'),
    nahe: z
      .string()
      .optional()
      .describe('Optional: in der Nähe welchen Ortes. Ohne Angabe der eingestellte Standardstandort.'),
    anzahl: z.number().optional().describe('Wie viele Treffer, Standard drei, höchstens zehn.')
  }),
  async execute({ suche, nahe, anzahl }, ctx) {
    const signal = ctx?.signal
    const around = nahe?.trim() || getSettings().homeLocation.trim()
    const center = around ? await locate(around, undefined, signal) : undefined
    const limit = Math.min(10, Math.max(1, Math.round(anzahl ?? 3)))

    const found = (await searchPlaces(suche, center ?? null, limit, { signal })).slice(0, limit)

    if (found.length === 0) {
      return {
        treffer: [],
        bezugsort: center?.label,
        hinweis: `Zu "${suche}" finde ich nichts${center ? ` um ${center.label}` : ''}. Sag das in einem Satz und frag, ob woanders gesucht werden soll.`
      }
    }

    const card: PlacesCard = {
      kind: 'places',
      id: `places:${suche.trim().toLowerCase()}@${center?.label ?? ''}`,
      query: suche.trim(),
      ...(center ? { around: center } : {}),
      places: found,
      actions: [{ type: 'open', label: 'Karte', url: osmPlaceUrl(found[0]) }]
    }
    const onScreen = ctx?.show?.(card) ?? false

    return {
      bezugsort: center?.label,
      treffer: found.map((place) => ({
        name: place.name,
        adresse: place.address || undefined,
        entfernung: place.distanceM !== undefined ? spokenDistance(place.distanceM) : undefined,
        art: place.category
      })),
      hinweis: onScreen
        ? 'Die Treffer stehen auf dem Bildschirm. Nenne nur den ersten mit Entfernung, in einem Satz.'
        : center
          ? 'Nenne den ersten Treffer mit Entfernung in einem Satz. Weitere nur auf Nachfrage.'
          : 'Ohne Standardstandort gibt es keine Entfernungen. Nenne den ersten Treffer mit Adresse.'
    }
  }
}) as ToolDefinition

// ─────────────────────────────────────────────────────────────
// Route berechnen
// ─────────────────────────────────────────────────────────────

/** Die Verkehrsmittel, wie man sie sagt. Ohne Verkehrslage — die Dauer ist die bei freier Straße. */
const MODES: Record<RouteMode, { label: string; ask: string; chip: string }> = {
  auto: { label: 'mit dem Auto, ohne aktuelle Verkehrslage', ask: 'mit dem Auto', chip: 'Auto' },
  zu_fuss: { label: 'zu Fuß', ask: 'zu Fuß', chip: 'Zu Fuß' },
  fahrrad: { label: 'mit dem Fahrrad', ask: 'mit dem Fahrrad', chip: 'Fahrrad' }
}

const routeBerechnen = defineTool({
  name: 'route_berechnen',
  group: 'web',
  description:
    'Rechnet Fahrzeit und Entfernung von A nach B aus, mit dem Auto, zu Fuß oder mit dem Fahrrad. ' +
    'Für "wie lange brauche ich nach Graz", "wie weit ist es zum Flughafen", ' +
    '"wann bin ich dort, wenn ich jetzt losfahre".',
  spokenHint: 'Ich rechne den Weg aus.',
  schema: z.object({
    nach: z.string().describe('Ziel: Adresse, Ort oder bekannter Platz.'),
    von: z.string().optional().describe('Start. Ohne Angabe der eingestellte Standardstandort.'),
    modus: z.enum(['auto', 'zu_fuss', 'fahrrad']).optional().describe('Verkehrsmittel. Standard auto.')
  }),
  async execute({ nach, von, modus }, ctx) {
    const signal = ctx?.signal
    const start = von?.trim() || getSettings().homeLocation.trim()
    if (!start) {
      throw new Error('Noch kein Standardstandort eingestellt. Unter Zugänge den Ort speichern oder den Start nennen.')
    }

    // Erst der Start, dann das Ziel in seiner Nähe: „Hauptbahnhof" ist von
    // Wien aus ein anderer als von Graz aus.
    const from = await locate(start, undefined, signal)
    const to = await locate(nach, from, signal)
    const mode: RouteMode = modus ?? 'auto'
    const found = await route(from, to, mode, { signal })
    const arrivalAt = Date.now() + found.durationS * 1000

    const card: RouteCard = {
      kind: 'route',
      id: `route:${from.lat.toFixed(4)},${from.lon.toFixed(4)}>${to.lat.toFixed(4)},${to.lon.toFixed(4)}:${mode}`,
      from,
      to,
      mode,
      durationS: found.durationS,
      distanceM: found.distanceM,
      arrivalAt,
      ...(found.summary ? { summary: found.summary } : {}),
      path: simplifyPath(found.path, ROUTE_PATH_MAX),
      actions: [
        ...(Object.keys(MODES) as RouteMode[])
          .filter((other) => other !== mode)
          .map((other) => ({
            type: 'ask' as const,
            label: MODES[other].chip,
            prompt: `Und ${MODES[other].ask} von ${clean(from.label)} nach ${clean(to.label)}?`
          })),
        { type: 'open', label: 'Auf OpenStreetMap', url: osmRouteUrl(from, to, mode) }
      ]
    }
    ctx?.show?.(card)

    return {
      von: from.label,
      nach: to.label,
      unterwegs: MODES[mode].label,
      dauer: spokenDuration(found.durationS),
      entfernung: spokenDistance(found.distanceM),
      ankunft_bei_abfahrt_jetzt: `${clock(arrivalAt)} Uhr`,
      strecke: found.summary || undefined,
      hinweis: 'Antworte in einem Satz: Dauer zuerst, dann Entfernung. Strecke und Ankunft nur, wenn gefragt.'
    }
  }
}) as ToolDefinition

export const placeTools: ToolDefinition[] = [ortSuchen, routeBerechnen]

/** Nur für Tests. */
export const __internals = { clean }
