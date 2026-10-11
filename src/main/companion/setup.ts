import { execFile } from 'node:child_process'
import { shell } from 'electron'
import type { CompanionSetup, CompanionBlocker } from '@shared/companion'
import { getSettings, setSettings } from '../store/settings'
import { companionStatus, isRunning } from './server'
import { ensureLocalCert, readLocalCert } from './cert'
import { localWakeTarget } from './wol'
import { ensureCert, tailnetName, tailscaleExecutable, tailscaleInstalled } from './tailscale'

/**
 * Die Einrichtung als Leiter statt als Formular.
 *
 * Vorher war das Verbinden eine Kette aus Schritten, die man in der richtigen
 * Reihenfolge tun musste, ohne dass irgendwo stand, welche. Ein Häkchen, ein
 * Knopf, davor eine Fremdsoftware mit zwei Schaltern in ihren eigenen
 * Einstellungen — und wenn einer davon fehlte, passierte wortlos nichts. Der
 * QR-Code erschien trotzdem, nur eben mit einer Adresse, an der das Mikrofon
 * gesperrt bleibt.
 *
 * Jetzt gibt es einen Knopf, und diese Datei beantwortet die einzige Frage, die
 * danach zählt: Was fehlt noch, und was kann ich dagegen tun? Jeder Rückgabewert
 * nennt genau eine Sache, und zu fast jeder gehört eine Handlung, die der Knopf
 * daneben ausführt. „Es geht nicht" ist keine zulässige Antwort.
 */

/**
 * Prüft die ganze Kette und meldet den ersten Haken.
 *
 * Der *erste*, nicht alle: Wer drei Meldungen gleichzeitig liest, weiß hinterher
 * nicht, womit er anfangen soll. Fällt einer weg, rückt der nächste nach.
 */
export async function companionSetup(): Promise<CompanionSetup> {
  const settings = getSettings()
  const rung =
    settings.companion.certSource === 'tailscale' ? await viaTailscale() : await viaOwnCert()
  // Einmal angehängt statt in jeder Stufe wiederholt: Die Stufen entscheiden,
  // was zu tun ist, nicht, welche Wege es überhaupt gibt.
  return { ...rung, tailscaleAvailable: tailscaleInstalled() }
}

/** Eine Stufe der Leiter, noch ohne die Angabe, welche Wege es gibt. */
type Rung = Omit<CompanionSetup, 'tailscaleAvailable'>

/**
 * Der Weg ohne Fremdsoftware: eine eigene Stelle für die Adresse im Heimnetz.
 *
 * Vier Stufen, und die letzte ist die einzige, die der Rechner nicht selbst
 * feststellen kann. Ob ein Profil auf dem Telefon installiert *und* scharf
 * geschaltet ist, sieht man von hier aus nicht — es gibt keinen Weg, das zu
 * erfragen. Also wird gefragt, einmal, und die Antwort bleibt stehen.
 */
async function viaOwnCert(): Promise<Rung> {
  const settings = getSettings()
  const status = companionStatus()
  const target = localWakeTarget()

  if (!target) {
    return {
      blocker: 'no-address',
      ready: false,
      headline: 'Keine Adresse im Netz',
      detail:
        'Der Rechner hängt an keinem Netzwerk, auf dessen Adresse ein Zertifikat lauten könnte. ' +
        'Steck ein Kabel ein oder verbinde das WLAN — danach hier noch einmal drücken.',
      action: 'no-address',
      actionLabel: 'Noch einmal nachsehen',
      status
    }
  }

  const cert = readLocalCert()
  if (!cert || cert.address !== target.address) {
    return {
      blocker: 'no-certificate',
      ready: false,
      headline: cert ? `Der Rechner heißt jetzt ${target.address}` : 'Noch kein Zertifikat',
      detail: cert
        ? 'Das vorhandene Zertifikat lautet auf die alte Adresse und passt nicht mehr. Ein neues ' +
          'ist in zwei Sekunden ausgestellt, und am Telefon ist dafür nichts zu tun — die Stelle ' +
          'dahinter bleibt dieselbe. Damit das nicht wiederkommt, gib dem Rechner im Router eine ' +
          'feste Adresse.'
        : 'Ohne Zertifikat gibt iOS das Mikrofon nicht frei — eine Adresse im Heimnetz über ' +
          'einfaches HTTP gilt dort als unsicher. James stellt sich eines selbst aus, für ' +
          `${target.address}. Es braucht kein Konto und keine Fremdsoftware.`,
      action: 'no-certificate',
      actionLabel: 'Zertifikat erstellen',
      status
    }
  }

  if (!settings.companion.enabled || !isRunning()) {
    return {
      blocker: 'server-off',
      ready: false,
      headline: 'Bereit zum Einschalten',
      detail: `Zertifikat für ${cert.address} liegt vor, gültig bis ${cert.expires.toLocaleDateString('de-DE')}.`,
      action: 'enable',
      actionLabel: 'Einschalten',
      status
    }
  }

  if (!settings.companion.caInstalled) {
    return {
      blocker: 'ca-not-installed',
      ready: false,
      headline: 'Das Telefon muss James noch trauen',
      detail:
        'Ersten Code abfotografieren — die Seite dahinter führt durch beide Schritte. Der zweite ' +
        'wird gern übersehen: Ein Profil zu installieren reicht unter iOS nicht, es muss danach ' +
        'unter Allgemein, Info, Zertifikatsvertrauenseinstellungen noch scharf geschaltet werden. ' +
        'Erst dann ist die Sprechtaste frei.',
      action: 'ca-not-installed',
      actionLabel: 'Erledigt — weiter zum Koppeln',
      status
    }
  }

  return {
    blocker: 'none',
    ready: true,
    headline: `Verbunden über ${cert.address}`,
    detail: status.secure
      ? 'Code abfotografieren, dann über „Teilen" auf den Home-Bildschirm.'
      : 'Der Server läuft noch ohne Zertifikat — schalte ihn einmal aus und wieder ein.',
    action: null,
    actionLabel: null,
    status
  }
}

/**
 * Der Weg über Tailscale — für den einen Fall, den der eigene nicht abdeckt.
 *
 * Ein Zertifikat auf eine Adresse im Heimnetz gilt im Heimnetz. Wer die
 * Fernbedienung auch von unterwegs will, braucht einen Namen, der von überall
 * auflöst, und ein Zertifikat darauf. Das ist der ganze Unterschied, und er ist
 * es nur wert, wenn man ihn braucht.
 */
async function viaTailscale(): Promise<Rung> {
  const settings = getSettings()
  const status = companionStatus()

  if (!tailscaleInstalled()) {
    return {
      blocker: 'no-tailscale',
      ready: false,
      headline: 'Tailscale fehlt',
      detail:
        'Es ist kostenlos, braucht ein Konto und muss auf beiden Geräten laufen. Wer nur zu Hause ' +
        'fernsteuern will, kommt ohne aus — dann unten wieder auf das eigene Zertifikat stellen.',
      action: 'no-tailscale',
      actionLabel: 'Tailscale herunterladen',
      status
    }
  }

  const hostname = await tailnetName()
  if (!hostname) {
    return {
      blocker: 'not-logged-in',
      ready: false,
      headline: 'Tailscale ist nicht angemeldet',
      detail:
        'Melde dich an; danach hier noch einmal auf Verbinden drücken. Falls die Anmeldung steht ' +
        'und trotzdem nichts kommt, fehlt in den Tailscale-Einstellungen unter DNS der Schalter ' +
        'für MagicDNS.',
      action: 'not-logged-in',
      actionLabel: 'Anmeldung öffnen',
      status
    }
  }

  const cert = await ensureCert()
  if (!cert) {
    return {
      blocker: 'no-certificate',
      ready: false,
      headline: `${hostname} steht, aber es gibt kein Zertifikat`,
      detail:
        'Im Tailscale-Adminbereich unter DNS muss HTTPS eingeschaltet sein — das ist ein eigener ' +
        'Schalter neben MagicDNS. Danach hier noch einmal drücken.',
      action: 'no-certificate',
      actionLabel: 'Tailscale-Einstellungen öffnen',
      status
    }
  }

  if (!settings.companion.enabled || !isRunning()) {
    return {
      blocker: 'server-off',
      ready: false,
      headline: 'Bereit zum Einschalten',
      detail: `Zertifikat für ${hostname} liegt vor.`,
      action: 'enable',
      actionLabel: 'Einschalten und Code zeigen',
      status
    }
  }

  return {
    blocker: 'none',
    ready: true,
    headline: `Verbunden über ${hostname}`,
    detail: status.secure
      ? 'Code abfotografieren, dann über „Teilen" auf den Home-Bildschirm.'
      : 'Der Server läuft noch ohne Zertifikat — schalte ihn einmal aus und wieder ein.',
    action: null,
    actionLabel: null,
    status
  }
}

/**
 * Führt aus, was der Knopf gerade anbietet.
 *
 * Absichtlich hier und nicht im Renderer: Was zu tun ist, hängt am Zustand des
 * Rechners, und der ist hier bekannt. Der Renderer soll nur einen Knopf
 * zeichnen und melden, dass er gedrückt wurde.
 *
 * Ausgenommen bleibt das Einschalten selbst — das nimmt der Renderer in die
 * Hand, weil die Einstellungsseite von einer Änderung sonst nichts erfährt und
 * hinterher „aus" anzeigen würde, während der Server läuft.
 */
export async function runSetupAction(action: CompanionBlocker | 'enable'): Promise<void> {
  switch (action) {
    case 'no-address':
      // Nichts zu tun — der Aufrufer prüft danach ohnehin neu, und genau das
      // ist hier die ganze Handlung.
      return

    case 'no-certificate': {
      const settings = getSettings()
      if (settings.companion.certSource === 'tailscale') {
        await shell.openExternal('https://login.tailscale.com/admin/dns')
        return
      }
      const target = localWakeTarget()
      if (target) await ensureLocalCert(target.address)
      return
    }

    case 'ca-not-installed': {
      const settings = getSettings()
      setSettings({ companion: { ...settings.companion, caInstalled: true } })
      return
    }

    case 'no-tailscale':
      await shell.openExternal('https://tailscale.com/download/windows')
      return

    case 'not-logged-in': {
      const exe = tailscaleExecutable()
      if (!exe) return
      // Nicht abwarten: `tailscale up` kehrt erst zurück, wenn die Anmeldung
      // im Browser durch ist, und bis dahin stünde das Einstellungsfenster.
      const child = execFile(exe, ['up'], { windowsHide: true }, () => undefined)
      child.unref?.()
      return
    }

    case 'enable':
    case 'server-off': {
      const settings = getSettings()
      if (!settings.companion.enabled) {
        // Das Einschalten löst über den Melder in `index.ts` den Start aus.
        setSettings({ companion: { ...settings.companion, enabled: true } })
      }
      return
    }

    default:
      return
  }
}
