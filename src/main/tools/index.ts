import { registerAll, unregisterBuiltins } from './registry'
import { webTools } from './impl/web'
import { researchTools } from './impl/research'
import { systemTools } from './impl/system'
import { pcTools } from './impl/pc'
import { utilityTools } from './impl/utility'
import { placeTools } from './impl/places'
import { fileTools } from './impl/files'
import { shellTools } from './impl/shell'
import { timerTools } from './impl/timers'
import { reminderTools } from './impl/reminders'
import { introspectionTools } from './impl/tokens'
import { quietTools } from './impl/quiet'
import { memoryTools } from './impl/memory'
import { priceWatchTools } from './impl/priceWatch'
import { shoppingTools } from './impl/shopping'
import { chromeTools } from './impl/chrome'
import { computerTools } from './impl/computer'
import { windowTools } from './impl/window'
import { gmailTools } from './impl/gmail'
import { gmailWebTools } from './impl/gmailWeb'
import { yahooTools } from './impl/yahoo'
import { contactTools } from './impl/contacts'
import { minecraftTools } from './impl/minecraft'
import { higgsfieldTools } from './impl/higgsfield'
import { selfHealTools } from './impl/selfheal'
import { calendarTools } from './impl/calendar'
import { stocksTools } from './impl/stocks'
import { knowledgeTools } from './impl/knowledge'
import { officeTools } from './impl/office'
import { cameraTools } from './impl/camera'
import { organizeTools } from './impl/organize'
import { whatsappTools } from './impl/whatsapp'
import { smartHomeTools } from './impl/smarthome'
import { musicTools } from './impl/music'
import { monitorTools } from './impl/monitor'
import { agentTools } from './impl/agent'
import { desktopTools } from './impl/desktop'
import { toolSearchTools } from './impl/toolSearch'
import { selfConfigTools } from './impl/selfConfig'
import { linphoneTools } from './impl/linphone'
import { capabilityGapTools } from './impl/capabilityGap'

/**
 * Sammelstelle aller Werkzeuge.
 *
 * Die Reihenfolge spielt keine Rolle — die Registry überspringt automatisch
 * alles, wofür der nötige Zugang fehlt. Dadurch taucht ein Werkzeug ohne
 * Einrichtung gar nicht erst in den Function-Declarations auf, und James
 * kann nicht behaupten, er könne etwas, das nicht geht.
 *
 * Genau deshalb muss das hier wiederholbar sein: Ob ein Werkzeug existiert,
 * entscheidet sich einmalig beim Registrieren. Lief das nur beim Start, blieben
 * Twitch, Higgsfield und die Gmail-Schnittstelle bis zum nächsten Neustart der
 * App verschwunden — auch nachdem der Schlüssel längst eingetragen war. Das
 * Aufräumen davor macht den erneuten Aufruf möglich; ohne es würfe `register`
 * beim ersten Werkzeug "doppelt registriert".
 */
export function registerAllTools(): void {
  unregisterBuiltins()
  registerAll([
    ...toolSearchTools,
    ...selfConfigTools,
    ...linphoneTools,
    ...webTools,
    ...utilityTools,
    // Ortssuche und Routen aus OpenStreetMap, ohne Schlüssel — deshalb immer
    // da. Ohne sie schätzte das Modell Fahrzeiten aus dem Gedächtnis.
    ...placeTools,
    ...researchTools,
    ...systemTools,
    ...pcTools,
    ...fileTools,
    ...shellTools,
    ...timerTools,
    ...reminderTools,
    ...introspectionTools,
    ...quietTools,
    // Der Bedienbaum vor dem Bild: Für ein gewöhnliches Fenster ist er der
    // genauere, der billigere und der einzige Weg, der ohne Vordergrund
    // auskommt. Das Bild bleibt für alles ohne benannte Bedienelemente.
    ...windowTools,
    // Die schnelle Steuerung vor der mit dem Auge: Bedienbaum, Stapel,
    // gespeicherte Abläufe — und nur wo das nicht geht, Bildschirmfotos.
    ...desktopTools,
    ...computerTools,
    ...chromeTools,
    ...memoryTools,
    ...shoppingTools,
    ...priceWatchTools,
    // Der Browserweg zuerst: er braucht keine Einrichtung und ist deshalb
    // der, der bei den meisten überhaupt funktioniert. Die Werkzeuge der
    // Google-Schnittstelle kommen nur dazu, wenn ein OAuth-Client hinterlegt
    // ist — sonst überspringt die Registry sie ohnehin.
    ...gmailWebTools,
    ...gmailTools,
    // Das Adressbuch vor dem Versand: Yahoo löst seine Empfänger darüber auf,
    // und ein Werkzeug, das auf ein anderes zeigt, sollte es auch geben.
    ...contactTools,
    ...yahooTools,
    ...minecraftTools,
    ...higgsfieldTools,
    ...selfHealTools,
    ...calendarTools,
    ...stocksTools,
    ...knowledgeTools,
    ...officeTools,
    ...cameraTools,
    ...organizeTools,
    // Der Browserweg wie bei Gmail und Yahoo — braucht keinen Schlüssel,
    // sondern eine einmalige Anmeldung im James-Browser.
    ...whatsappTools,
    // Hängt am Home-Assistant-Token. Fehlt der, überspringt die Registry die
    // Gruppe, und James behauptet gar nicht erst, er käme an die Lampen.
    ...smartHomeTools,
    // Musik hängt bewusst an keinem Schlüssel: Die Ausgabegeräte von Windows
    // aufzulisten und umzustellen geht immer, und die Apple-Music-App nimmt
    // einen Link entgegen, sobald sie installiert ist. Nur Spotify verlangt
    // eine Anmeldung, und was ohne sie nicht geht, sagen die Werkzeuge selbst.
    ...musicTools,
    // Nur lesend: Auslastung und offene Programme, für Spiel- und Streamfragen.
    ...monitorTools,
    // Plan, Fertigkeiten, Unteragenten — die Arbeitsweise nach Hermes.
    ...agentTools,
    // Was James fehlt, meldet er selbst — gesendet nur mit Zustimmung.
    ...capabilityGapTools
  ])
}
