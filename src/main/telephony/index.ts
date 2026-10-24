import type { TelephonyStatus } from '@shared/types'
import { getSettings } from '../store/settings'
import {
  callServerRunning,
  clearPublicRoutes,
  hangUpAll,
  hasPublicRoutes,
  issueTicket,
  setPublicBase,
  startCallServer,
  stopCallServer
} from './callServer'
import { ensurePublicUrl, stopFunnel, stopCloudflaredTunnel } from './tunnel'
import { clearIncomingWebhook, isOwnerPhone, setIncomingWebhook } from '../providers/twilio'

export { setCallServerEvents } from './callServer'

/**
 * Was ein Gespräch braucht, bevor der erste Anruf rausgeht.
 *
 * Drei Dinge müssen zusammenkommen, und sie werden erst dann besorgt, wenn
 * sie gebraucht werden: ein laufender Dienst, eine öffentliche Adresse, ein
 * Merkmal für genau diesen Anruf. Beim Start der App nichts davon aufzubauen
 * ist Absicht — ein Tunnel, der seit dem Hochfahren offensteht, weil vor drei
 * Wochen einmal telefoniert wurde, ist genau das, was die Einstellung
 * vermeiden soll.
 */

let currentPublicUrl: string | null = null
let currentSource: 'tailscale' | 'cloudflared' | 'manuell' | null = null
/**
 * Ob die Telefonie gerade erreichbar ist.
 *
 * Getrennt vom laufenden Server: Der Eingang kann stehenbleiben, weil noch
 * jemand anderer daran hängt (die Alexa-Skill), während die Telefonie schon
 * abgeschaltet ist. `telephonyStatus` meldet dann ehrlich "aus" statt
 * "läuft, aber ohne Adresse".
 */
let telephonyUp = false

type Endpoint = { publicUrl: string; source: 'tailscale' | 'cloudflared' | 'manuell' }

/**
 * Eingang und Tunnel hochfahren und die Anrufadresse festhalten.
 *
 * Derselbe Dreischritt stand dreimal ausgeschrieben hier — binden, Tunnel,
 * Adresse merken — und wich beim dritten Mal schon in einer Kleinigkeit ab.
 * Gibt die Adresse samt Herkunft zurück oder wirft mit einem Satz, der
 * unverändert beim Nutzer landen kann.
 */
async function bringUpEndpoint(port: number, manualUrl: string): Promise<Endpoint> {
  // Erst binden, dann den Tunnel: Der Server kann auf einen anderen Port
  // ausweichen, und der Tunnel muss auf den zeigen, den er wirklich hat.
  // Die Fehlerursache steht in `cause`, damit die Aufrufer zwischen "kein
  // Port" und "keine Adresse" unterscheiden können, ohne Texte zu vergleichen.
  let bound: number
  try {
    bound = await startCallServer(port)
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err), { cause: 'port' })
  }
  const tunnel = await ensurePublicUrl(manualUrl, bound)
  if (!tunnel.publicUrl || !tunnel.source) {
    throw new Error(tunnel.hint ?? 'Es gibt keine öffentliche Adresse, unter der Twilio anrufen könnte.', {
      cause: 'tunnel'
    })
  }

  setPublicBase(tunnel.publicUrl)
  currentPublicUrl = tunnel.publicUrl
  currentSource = tunnel.source
  telephonyUp = true
  return { publicUrl: tunnel.publicUrl, source: tunnel.source }
}

/**
 * Ein gescheitertes `bringUpEndpoint` als Status für die Einstellungen.
 *
 * Kein Port heißt: gar nichts läuft, auch kein Tunnel. Keine Adresse heißt:
 * Der Server steht, aber niemand kommt herein. Zwei verschiedene Zustände,
 * zwei verschiedene Hinweise.
 */
function endpointFailure(err: unknown): TelephonyStatus {
  const message = err instanceof Error ? err.message : String(err)
  const hint =
    err instanceof Error && err.cause === 'port'
      ? `Der Telefondienst konnte keinen Port belegen: ${message.slice(0, 160)}`
      : message
  return { running: false, publicUrl: null, source: null, hint }
}

/**
 * Dienst und Tunnel hochfahren und eine Anrufadresse ausgeben.
 *
 * Wirft mit einem Satz, der sagt, was fehlt — der Text landet unverändert
 * beim Nutzer, gesprochen oder in den Einstellungen.
 */
export async function prepareConversation(to: string, opening?: string): Promise<string> {
  const settings = getSettings().telephony
  if (!settings?.conversation) {
    throw new Error(
      'Das Gespräch am Telefon ist ausgeschaltet. In den Einstellungen unter Konten & Standort lässt es ' +
        'sich einschalten — es macht diesen Rechner über einen Tunnel erreichbar.'
    )
  }

  // `bringUpEndpoint` wirft bereits mit einem Satz für den Nutzer.
  const endpoint = await bringUpEndpoint(settings.port, settings.publicUrl ?? '')

  // Ein ausgehender Anruf an die eigene Nummer ist dasselbe Gespräch wie ein
  // eingehender von ihr — "ruf mich an und sag mir, was heute ansteht" wäre
  // sonst genau die Frage, die James dann nicht beantworten darf.
  const token = issueTicket(to, opening?.trim() || settings.opening, undefined, isOwnerPhone(to))
  return `${endpoint.publicUrl.replace(/\/+$/, '')}/twilio/voice?t=${encodeURIComponent(token)}`
}

/**
 * Erreichbar werden.
 *
 * Der Gegensatz zu `prepareConversation`: Dort wird alles für einen einzelnen
 * Anruf besorgt und danach wieder abgebaut. Hier bleibt es stehen, solange die
 * App läuft — sonst wäre niemand da, wenn jemand anruft.
 *
 * Der letzte Schritt ist der, den es ohne diese Funktion nicht gäbe: Twilio
 * die aktuelle Adresse zu nennen. Ein Quick-Tunnel heißt bei jedem Start
 * anders, und ein Webhook aus der vorigen Sitzung zeigt ins Leere.
 */
export async function startIncoming(): Promise<TelephonyStatus> {
  const settings = getSettings().telephony
  if (!settings?.incoming) {
    return { running: false, publicUrl: null, source: null, hint: 'Eingehende Anrufe sind ausgeschaltet.' }
  }

  let endpoint: Endpoint
  try {
    endpoint = await bringUpEndpoint(settings.port, settings.publicUrl ?? '')
  } catch (err) {
    return endpointFailure(err)
  }

  const hook = await setIncomingWebhook(endpoint.publicUrl)
  if (!hook.ok) {
    return {
      running: true,
      publicUrl: endpoint.publicUrl,
      source: endpoint.source,
      hint:
        `Der Dienst läuft, aber Twilio weiß nichts davon: ${hook.error} — ` +
        'bis das behoben ist, kommen keine Anrufe an.'
    }
  }

  return { running: true, publicUrl: endpoint.publicUrl, source: endpoint.source }
}

export function telephonyStatus(): TelephonyStatus {
  const up = telephonyUp && callServerRunning()
  if (!up && callServerRunning()) {
    return {
      running: false,
      publicUrl: null,
      source: null,
      hint: 'Die Telefonie ist ausgeschaltet, der öffentliche Eingang bleibt für andere Dienste offen.'
    }
  }
  return {
    running: up,
    publicUrl: currentPublicUrl,
    source: currentSource
  }
}

/**
 * Alles wieder zumachen.
 *
 * Wird beim Beenden der App gerufen und wenn der Nutzer das Gespräch
 * abschaltet. Der Funnel wird nur zugemacht, wenn wir ihn selbst aufgemacht
 * haben — einen von Hand eingerichteten cloudflared-Tunnel abzuschalten wäre
 * ein Übergriff auf etwas, das uns nicht gehört.
 */
export async function shutdownTelephony(clearWebhook = false): Promise<void> {
  // Nur beim bewussten Abschalten, nicht beim Beenden der App: Das Beenden
  // soll auf keinen Netzaufruf warten müssen. Wer die App zumacht, ist ohnehin
  // gleich nicht mehr erreichbar — wer die Einstellung ausschaltet, will es
  // dauerhaft, und dann darf die Adresse bei Twilio nicht stehenbleiben.
  if (clearWebhook) await clearIncomingWebhook()

  /*
   * Server und Tunnel stehen lassen, wenn noch jemand daran hängt.
   *
   * Seit die Alexa-Skill sich als Pfad an denselben Server hängt, ist
   * „Telefonie aus" nicht mehr dasselbe wie „Eingang zu". Ohne diese Prüfung
   * legte das Abschalten der Telefonie stillschweigend auch den Echo lahm —
   * und zwar so, dass es niemandem auffällt, bis das erste Mal jemand
   * „Alexa, frag James" sagt und nichts passiert.
   *
   * Die laufenden Gespräche werden trotzdem beendet: Das ist es, wofür der
   * Aufruf da ist. Nur der Server bleibt stehen.
   */
  if (hasPublicRoutes()) {
    hangUpAll()
    currentPublicUrl = null
    currentSource = null
    telephonyUp = false
    return
  }

  await stopCallServer()
  if (currentSource === 'tailscale') await stopFunnel()
  if (currentSource === 'cloudflared') stopCloudflaredTunnel()
  currentPublicUrl = null
  currentSource = null
  telephonyUp = false
}

/**
 * Alles zu, ohne Rücksicht darauf, wer noch daran hängt.
 *
 * Gebraucht beim Beenden der App — und zwar genau deshalb, weil die beiden
 * anderen Abschaltwege einander schonen: `shutdownTelephony` lässt den Server
 * stehen, solange Alexa hängt, und `stopAlexa` lässt ihn stehen, solange die
 * Telefonie erreichbar sein soll. Sind beide eingeschaltet, verlässt sich jeder
 * auf den anderen, und niemand macht zu. Übrig bliebe ein Funnel, der die App
 * überlebt und weiter auf einen Port zeigt, hinter dem nichts mehr sitzt.
 *
 * Beide Tunnelarten werden abgeräumt, ohne vorher zu fragen, welche es war:
 * Die Abschaltungen prüfen selbst, ob es etwas zu tun gibt, und beim Beenden
 * ist eine Prüfung zu wenig schlimmer als eine zu viel.
 */
export async function shutdownPublicEndpoint(): Promise<void> {
  clearPublicRoutes()
  // Tunnel zuerst und gleichzeitig mit dem Server: Beim Beenden bleibt nur
  // wenig Zeit, und ein offener Funnel ist das, was die App überleben würde.
  stopCloudflaredTunnel()
  await Promise.all([stopFunnel(), stopCallServer()])
  currentPublicUrl = null
  currentSource = null
  telephonyUp = false
}

/** Prüft die Einrichtung, ohne zu telefonieren. */
export async function testTelephonySetup(): Promise<TelephonyStatus> {
  const settings = getSettings().telephony
  // Für eingehende Anrufe gehört der Webhook zur Prüfung. Der alte Weg sah
  // ausschließlich auf `conversation` und erklärte eine reine Erreichbarkeit
  // deshalb fälschlich für ausgeschaltet.
  if (settings?.incoming) return startIncoming()
  if (!settings?.conversation) {
    return {
      running: false,
      publicUrl: null,
      source: null,
      hint: 'Telefonate und eingehende Anrufe sind ausgeschaltet.'
    }
  }
  let endpoint: Endpoint
  try {
    endpoint = await bringUpEndpoint(settings.port, settings.publicUrl ?? '')
  } catch (err) {
    return endpointFailure(err)
  }
  return { running: true, publicUrl: endpoint.publicUrl, source: endpoint.source }
}
