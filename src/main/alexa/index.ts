import type { AlexaStatus } from '@shared/types'
import { getSettings } from '../store/settings'
import { hasSecret } from '../secrets/keystore'
import { ensurePublicUrl, stopCloudflaredTunnel, stopFunnel } from '../telephony/tunnel'
import {
  registerPublicRoute,
  setPublicBase,
  startCallServer,
  stopCallServer,
  unregisterPublicRoute
} from '../telephony/callServer'
import { alexaRoute, ALEXA_PATH } from './server'

/**
 * James über den Echo Dot ansprechen.
 *
 * ── Was das ist und was es nicht ist ──
 *
 * Es ist eine Alexa-Skill, die auf diesen Rechner zeigt. „Alexa, frag James,
 * was heute ansteht" geht an Amazon, Amazon schickt die Wörter durch den
 * Tunnel hierher, James antwortet, der Echo liest vor.
 *
 * Es ist **nicht** ein zweiter James im Wohnzimmer und auch kein Ersatz für
 * das Weckwort am Rechner. Der Unterschied fällt beim ersten Satz auf: Es
 * bleibt immer „Alexa, frag James …". Amazon lässt Dritte das Weckwort nicht
 * ändern — es gibt keine Einstellung dafür, keinen Umweg und keinen Trick.
 * Wer „Hey James" sagen will, sagt es dem Rechner.
 *
 * ── Ein Server, ein Tunnel ──
 *
 * Der Endpunkt hängt als Pfad am öffentlichen Server der Telefonie und nicht
 * an einem eigenen. Das ist keine Sparsamkeit, sondern die einzige Fassung,
 * die funktioniert: Tailscale Funnel bildet genau einen lokalen Port auf die
 * öffentliche 443 ab, und ein laufender cloudflared-Tunnel wird
 * wiederverwendet. Zwei Dienste, die sich je einen Tunnel aufmachen, melden
 * beide „läuft" — und einer bekommt still den Verkehr des anderen. Die lange
 * Fassung steht bei `registerPublicRoute`.
 *
 * Daraus folgt die Portwahl: Es gibt keine eigene, es ist die der Telefonie.
 * Ein zweiter Port in den Einstellungen wäre eine Angabe, die nichts bewirkt.
 *
 * ── Warum es standardmäßig aus ist ──
 *
 * Aus demselben Grund wie Telefonie und Fernbedienung. Eingeschaltet steht ein
 * Endpunkt im offenen Netz, hinter dem ein Assistent mit Zugriff auf Kalender,
 * Musik und Licht sitzt. Was ihn schützt, steht in `verify.ts`; dass ihn
 * überhaupt jemand aufmacht, soll eine Entscheidung sein.
 */

let publicUrl: string | null = null
let source: 'tailscale' | 'cloudflared' | 'manuell' | null = null
let mounted = false

/**
 * Den Endpunkt hochfahren und die Adresse ausgeben, die in die Skill gehört.
 *
 * Wirft mit einem Satz, der sagt, was fehlt — der Text landet unverändert im
 * Einstellungsfenster.
 */
export async function startAlexa(): Promise<AlexaStatus> {
  const settings = getSettings()
  const alexa = settings.alexa

  if (!alexa.enabled) {
    throw new Error(
      'Die Alexa-Anbindung ist ausgeschaltet. In den Einstellungen unter Alexa lässt sie sich ' +
        'einschalten — sie macht diesen Rechner über einen Tunnel erreichbar.'
    )
  }

  /*
   * Ohne Skill-Kennung wird gar nicht erst gestartet.
   *
   * Sie ist nicht nur ein Formularfeld, sondern die letzte Prüfung in
   * `verify.ts`: Ohne sie könnte jede fremde Skill auf diese Adresse zeigen,
   * und deren Anfragen trügen echte Amazon-Unterschriften. Ein Dienst, der
   * ohne sie lauscht, wäre offen für jeden, der die Adresse kennt.
   */
  if (!hasSecret('alexaSkillId')) {
    throw new Error(
      'Es ist keine Skill-Kennung hinterlegt. Ohne sie könnte jede fremde Skill auf diesen ' +
        'Rechner zeigen — sie steht im Alexa-Entwicklerbereich oben bei der Skill und fängt mit ' +
        'amzn1.ask.skill an.'
    )
  }

  const port = settings.telephony.port
  // Die eigene Adresse hat Vorrang; steht dort nichts, gilt die der Telefonie.
  // Beide meinen denselben Tunnel, und der zeigt auf denselben Port.
  const manual = alexa.publicUrl.trim() || settings.telephony.publicUrl.trim()

  /*
   * Erst binden, dann den Tunnel.
   *
   * Der Server kann auf einen anderen Port ausweichen — auf diesem Rechner
   * belegt die Fernbedienung fürs Telefon ausgerechnet 8790, die Vorgabe der
   * Telefonie. Ein Tunnel, der auf den gewünschten statt auf den tatsächlichen
   * Port zeigt, führt ins Leere und sieht dabei vollkommen richtig aus.
   */
  const bound = await startCallServer(port)
  const tunnel = await ensurePublicUrl(manual, bound)
  if (!tunnel.publicUrl) {
    throw new Error(
      tunnel.hint ?? 'Es gibt keine öffentliche Adresse, unter der Amazon anklopfen könnte.'
    )
  }

  setPublicBase(tunnel.publicUrl)
  registerPublicRoute(ALEXA_PATH, alexaRoute)
  mounted = true

  publicUrl = tunnel.publicUrl
  source = tunnel.source

  return alexaStatus()
}

/** Den Endpunkt wieder abhängen. */
export async function stopAlexa(): Promise<AlexaStatus> {
  unregisterPublicRoute(ALEXA_PATH)
  mounted = false

  /*
   * Server und Tunnel nur zumachen, wenn die Telefonie sie nicht noch braucht.
   *
   * Beide hängen daran. Sie hier bedingungslos zu schließen legte mitten im
   * Gespräch die Leitung — und der Fehler wäre am Telefon aufgefallen, nicht
   * hier.
   */
  const telephony = getSettings().telephony
  if (!telephony.conversation && !telephony.incoming) {
    await stopCallServer()
    if (source === 'tailscale') await stopFunnel()
    if (source === 'cloudflared') stopCloudflaredTunnel()
  }

  publicUrl = null
  source = null
  return alexaStatus()
}

export function alexaStatus(): AlexaStatus {
  const settings = getSettings().alexa
  return {
    running: mounted,
    enabled: settings.enabled,
    hasSkillId: hasSecret('alexaSkillId'),
    publicUrl,
    source,
    /**
     * Die vollständige Adresse zum Abtippen.
     *
     * Sie muss im Alexa-Entwicklerbereich als Endpunkt stehen, und zwar genau
     * so. Sie hier fertig zusammenzusetzen erspart die häufigste Fehlerquelle
     * beim Einrichten: einen fehlenden Pfad am Ende.
     */
    endpoint: publicUrl ? `${publicUrl.replace(/\/+$/, '')}${ALEXA_PATH}` : null
  }
}
