import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { getSettings } from '../../store/settings'
import {
  callService,
  entityState,
  isActionable,
  listEntities,
  matchEntities,
  type HomeEntity
} from '../../smarthome/homeAssistant'

/**
 * Licht, Steckdosen, Szenen.
 *
 * Die Werkzeuge hängen über `requiresSecret` am Home-Assistant-Token. Ohne ihn
 * werden sie nicht registriert und tauchen in den Function-Declarations gar
 * nicht erst auf — James kann dann nicht behaupten, er käme an die Lampen.
 * Warum der Umweg über Home Assistant nötig ist und Apple Home direkt nicht
 * geht, steht in `smarthome/homeAssistant.ts`.
 *
 * Die zweite Entscheidung hier ist die Sperre unten. Ein Schloss, ein Tor und
 * eine Alarmanlage werden nicht über eine gesprochene Rückfrage abgesichert,
 * sondern über einen Haken in den Einstellungen. Der Grund ist der Kanal
 * selbst: Was dieses Mikrofon hört, kann auch aus dem Fernseher kommen oder
 * durch die Balkontür. Eine Zusage, die man ruft, ist für „Licht aus" die
 * richtige Sicherung und für „Tür auf" keine.
 */

/**
 * Bereiche, die nicht ohne ausdrückliche Freigabe geschaltet werden.
 *
 * `cover` steht mit drin, weil dieselbe Entitätsart die Jalousie im
 * Wohnzimmer und das Garagentor sein kann und von außen nicht zu erkennen ist,
 * welche gemeint ist. Wer nur Jalousien hat, trägt `cover` in den
 * Einstellungen bei den freien Bereichen nach.
 */
const GUARDED = new Set(['lock', 'alarm_control_panel', 'cover'])

function allowed(domain: string): boolean {
  if (!GUARDED.has(domain)) return true
  return getSettings().smartHome.freeDomains.includes(domain)
}

/** Wie ein Zustand vorgelesen wird. */
function spoken(entity: HomeEntity): string {
  switch (entity.state) {
    case 'on':
      return 'an'
    case 'off':
      return 'aus'
    case 'unavailable':
      return 'nicht erreichbar'
    case 'unknown':
      return 'unbekannt'
    case 'open':
      return 'offen'
    case 'closed':
      return 'zu'
    case 'locked':
      return 'verriegelt'
    case 'unlocked':
      return 'entriegelt'
    default:
      return entity.unit ? `${entity.state} ${entity.unit}` : entity.state
  }
}

// ─────────────────────────────────────────────────────────────
// Nachsehen
// ─────────────────────────────────────────────────────────────

const devices = defineTool({
  name: 'home_devices',
  group: 'smarthome',
  requiresSecret: 'homeAssistant',
  description:
    'Listet die Geräte im Zuhause mit ihrem aktuellen Zustand. Für "welche Lampen gibt es", ' +
    '"ist im Wohnzimmer noch Licht an", "wie warm ist es im Schlafzimmer". Nutze das auch, ' +
    'wenn du den genauen Namen eines Geräts brauchst, bevor du es schaltest.',
  schema: z.object({
    query: z
      .string()
      .optional()
      .describe('Nach Raum oder Gerätename filtern, etwa "wohnzimmer". Ohne Angabe alles.'),
    onlyOn: z.boolean().optional().describe('Nur zeigen, was gerade an oder offen ist.')
  }),
  spokenHint: 'Ich schau nach.',
  async execute({ query, onlyOn }) {
    const all = await listEntities()
    let found = query ? matchEntities(all, query) : all

    if (onlyOn) {
      found = found.filter((e) => e.state === 'on' || e.state === 'open' || e.state === 'unlocked')
    }

    if (found.length === 0) {
      return {
        gefunden: 0,
        hinweis: query
          ? `Zu "${query}" finde ich nichts. Nenne dem Nutzer, dass es so kein Gerät gibt.`
          : 'Es sind keine Geräte eingebunden.'
      }
    }

    return {
      gefunden: found.length,
      geräte: found.slice(0, 40).map((e) => ({
        name: e.name,
        kennung: e.entityId,
        zustand: spoken(e),
        schaltbar: isActionable(e.domain)
      })),
      hinweis:
        'Fass zusammen statt aufzuzählen, sobald es mehr als fünf sind — etwa "vier Lampen an, ' +
        'drei aus". Die Kennung ist nur für dich; sprich immer den Namen.'
    }
  }
}) as ToolDefinition

// ─────────────────────────────────────────────────────────────
// Schalten
// ─────────────────────────────────────────────────────────────

/**
 * Welcher Dienst zu welcher Absicht gehört.
 *
 * Home Assistant benennt dasselbe je Bereich anders: Ein Staubsauger wird
 * `start`, nicht `turn_on`, ein Rollo `open_cover`, ein Schloss `unlock`.
 * Ohne diese Tabelle müsste das Modell die Namen kennen — und es rät sie,
 * sobald es sie nicht kennt.
 */
function serviceFor(domain: string, action: 'an' | 'aus' | 'umschalten'): string | null {
  if (action === 'umschalten') {
    return ['light', 'switch', 'fan', 'input_boolean', 'media_player', 'cover'].includes(domain)
      ? 'toggle'
      : null
  }

  const on = action === 'an'

  switch (domain) {
    case 'light':
    case 'switch':
    case 'fan':
    case 'input_boolean':
    case 'climate':
    case 'media_player':
      return on ? 'turn_on' : 'turn_off'
    case 'scene':
    case 'script':
      // Eine Szene lässt sich nur auslösen, nicht ausschalten.
      return on ? 'turn_on' : null
    case 'cover':
      return on ? 'open_cover' : 'close_cover'
    case 'lock':
      return on ? 'unlock' : 'lock'
    case 'vacuum':
      return on ? 'start' : 'return_to_base'
    default:
      return null
  }
}

const control = defineTool({
  name: 'home_control',
  group: 'smarthome',
  requiresSecret: 'homeAssistant',
  description:
    'Schaltet ein Gerät im Zuhause. Für "mach das Licht aus", "schalt die Steckdose an", ' +
    '"Szene Kino". Bei Lampen lässt sich zusätzlich die Helligkeit setzen. Wenn der Name nicht ' +
    'eindeutig ist, frag lieber nach, statt zu raten.',
  schema: z.object({
    device: z
      .string()
      .describe('Name oder Kennung des Geräts, so wie der Nutzer es nennt — etwa "Licht Wohnzimmer".'),
    action: z
      .enum(['an', 'aus', 'umschalten'])
      .describe('Bei Rollos heißt an auf und aus zu, bei Schlössern an entriegeln.'),
    brightness: z
      .number()
      .optional()
      .describe('Nur für Lampen: Helligkeit in Prozent, 1 bis 100. Setzt action auf an.'),
    temperature: z.number().optional().describe('Nur für Thermostate: Zieltemperatur in Grad.')
  }),
  spokenHint: 'Mach ich.',
  async execute({ device, action, brightness, temperature }) {
    const all = await listEntities()
    const matches = matchEntities(all, device).filter((e) => isActionable(e.domain))

    if (matches.length === 0) {
      return {
        geschaltet: false,
        hinweis:
          `Ein schaltbares Gerät namens "${device}" gibt es nicht. Sag das dem Nutzer und ` +
          'biete an, mit home_devices nachzusehen, wie es wirklich heißt.'
      }
    }

    if (matches.length > 1) {
      // Nicht raten. Zwei Lampen mit ähnlichem Namen sind der Normalfall, und
      // die falsche zu schalten fällt in einem anderen Raum gar nicht auf.
      return {
        geschaltet: false,
        mehrdeutig: matches.slice(0, 6).map((e) => e.name),
        hinweis:
          'Darauf passen mehrere Geräte. Frag den Nutzer, welches gemeint ist, und ruf danach ' +
          'erneut mit dem genauen Namen auf.'
      }
    }

    const entity = matches[0]

    if (!allowed(entity.domain)) {
      return {
        geschaltet: false,
        hinweis:
          `${entity.name} gehört zu den gesicherten Geräten — Schlösser, Tore und Alarmanlagen ` +
          'schalte ich nicht auf Zuruf. Sag dem Nutzer, dass er diesen Bereich in den ' +
          'Einstellungen unter Smart Home erst freigeben muss. Frag nicht nach und versuch es ' +
          'nicht anders herum.'
      }
    }

    // Eine genannte Helligkeit meint immer „an" — „mach es auf zwanzig Prozent
    // aus" ist kein Satz.
    const wanted = brightness !== undefined || temperature !== undefined ? 'an' : action
    const service = serviceFor(entity.domain, wanted)

    if (!service) {
      return {
        geschaltet: false,
        hinweis: `${entity.name} lässt sich nicht auf diese Weise schalten.`
      }
    }

    const data: Record<string, unknown> = {}
    if (brightness !== undefined && entity.domain === 'light') {
      data.brightness_pct = Math.min(100, Math.max(1, Math.round(brightness)))
    }
    if (temperature !== undefined && entity.domain === 'climate') {
      data.temperature = temperature
    }

    await callService({
      domain: entity.domain,
      service,
      entityId: entity.entityId,
      data: Object.keys(data).length > 0 ? data : undefined
    })

    /*
     * Kurz warten und nachsehen, was daraus geworden ist.
     *
     * Home Assistant bestätigt den Auftrag, nicht die Wirkung — eine Lampe, die
     * gerade keinen Strom hat, quittiert genauso wie eine, die angeht. Der
     * zweite Blick ist die einzige Stelle, an der dieser Unterschied auffällt.
     * Die halbe Sekunde ist die Zeit, die ein Funkbefehl über Zigbee oder
     * Thread bis zur Rückmeldung braucht.
     */
    await new Promise((resolve) => setTimeout(resolve, 500))
    const after = await entityState(entity.entityId)

    return {
      geschaltet: true,
      gerät: entity.name,
      zustand: after ? spoken(after) : 'unbekannt',
      ...(data.brightness_pct !== undefined ? { helligkeit: `${data.brightness_pct} Prozent` } : {}),
      hinweis:
        after && after.state === 'unavailable'
          ? 'Das Gerät meldet sich nicht zurück. Sag dem Nutzer, dass der Befehl raus ist, das ' +
            'Gerät aber nicht antwortet.'
          : 'Bestätige knapp in einem halben Satz. Keine Aufzählung, keine Wiederholung des Namens.'
    }
  }
}) as ToolDefinition

export const smartHomeTools: ToolDefinition[] = [devices, control]

/** Nur zum Testen. */
export const __internals = { serviceFor, GUARDED }
