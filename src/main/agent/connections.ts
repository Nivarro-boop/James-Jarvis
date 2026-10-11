import type { Page } from 'playwright-core'
import type { ConnectionStatus } from '@shared/types'
import {
  amazonSignedIn,
  browserProfileExists,
  getContext,
  probeContext
} from '../automation/chromeCdp'
import { inputBackendStatus } from '../automation/desktop'
import { hasGoogleAuth } from '../providers/googleAuth'
import { hasSecret } from '../secrets/keystore'
import { ollamaHealth } from '../providers/ollama'
import { getSettings } from '../store/settings'

/**
 * Was gerade wirklich funktioniert.
 *
 * Gedacht als eine Seite in den Einstellungen und ein Werkzeug für die
 * Stimme. Der Anlass: "Gmail geht nicht" kann fünf verschiedene Ursachen
 * haben — kein Chrome-Zugang, nicht angemeldet, kein OAuth-Client, abgelaufene
 * Zustimmung, gesperrte Fernsteuerung. Ohne diese Übersicht rät man.
 */

/**
 * Für Seiten, die Nichtangemeldete nicht woandershin schicken.
 *
 * `check` unten erkennt eine fehlende Anmeldung normalerweise an der Adresse,
 * auf der man landet. WhatsApp bleibt aber unter derselben — dort entscheidet
 * allein der Blick in die Seite. Diese Marke kann in keiner Adresse vorkommen
 * und schaltet die Prüfung damit ab, ohne dass an `check` etwas geändert
 * werden müsste.
 */
const NO_REDIRECT = 'niemals-in-einer-adresse'

const LOGIN_FIX =
  'Einmal im James-Browser anmelden — der Knopf hier daneben macht die Seite auf. ' +
  'Danach bleibt die Anmeldung.'

/**
 * Die erste eindeutige Antwort gewinnt; kommt keine, bleibt es unklar.
 *
 * Auf ein einzelnes Merkmal mit fester Frist zu warten ist bei Seiten, die
 * langsam laden, ein Münzwurf: Die Frist läuft ab, „Merkmal nicht gefunden"
 * wird als sein Gegenteil gelesen, und dieselbe Prüfung zweimal hintereinander
 * kommt zu entgegengesetzten Ergebnissen — genau so meldete WhatsApp einmal
 * „gekoppelt" und Sekunden später „nicht gekoppelt".
 *
 * Zwei Merkmale gegeneinander laufen zu lassen entscheidet dagegen an dem, was
 * tatsächlich auf der Seite erscheint. Und wenn keines erscheint, ist die
 * ehrliche Antwort `null` statt einer geratenen.
 */
export async function ersteAntwort(
  kandidaten: Array<Promise<boolean | null>>
): Promise<boolean | null> {
  if (kandidaten.length === 0) return null
  return new Promise((resolve) => {
    let offen = kandidaten.length
    const melde = (wert: boolean | null): void => {
      if (wert !== null) resolve(wert)
      else if (--offen === 0) resolve(null)
    }
    for (const kandidat of kandidaten) {
      void kandidat.then(melde, () => melde(null))
    }
  })
}

/** Der QR-Code steht nur da, solange kein Telefon gekoppelt ist. */
const WHATSAPP_QR =
  'canvas[aria-label*="Scan" i], canvas[aria-label*="QR" i], [data-testid="qrcode"]'

/** Die Chatliste gibt es umgekehrt erst nach der Kopplung. */
const WHATSAPP_CHATS = '#pane-side, [data-testid="chat-list"], [aria-label="Chat list" i]'

/**
 * Ob in diesem Profil ein Telefon mit WhatsApp Web gekoppelt ist.
 *
 * `null` heißt: keines der beiden Kennzeichen kam — die Seite hing, oder
 * WhatsApp hat sie umgebaut. Dann sagt die Prüfung das, statt zu raten.
 */
async function whatsappGekoppelt(page: Page): Promise<boolean | null> {
  const sichtbar = (auswahl: string, antwort: boolean): Promise<boolean | null> =>
    page
      .waitForSelector(auswahl, { timeout: 12_000, state: 'visible' })
      .then(() => antwort)
      .catch(() => null)

  return ersteAntwort([sichtbar(WHATSAPP_CHATS, true), sichtbar(WHATSAPP_QR, false)])
}

/**
 * Prüft, ob in einem Tab eine bestimmte Seite angemeldet ist.
 *
 * Es wird nur gelesen, was ohnehin offen ist oder sich mit einem stillen
 * Aufruf beantworten lässt — kein Anmeldeversuch, keine Eingabe.
 *
 * `start` entscheidet, ob dafür der James-Browser hochgefahren werden darf.
 * Vom Knopf in den Einstellungen aus ja: eine Prüfung, die "weiß ich nicht"
 * antwortet, hilft niemandem. Aus dem Sprachwerkzeug heraus nein — auf die
 * Frage "geht Gmail?" soll nicht ungefragt ein Fenster aufgehen.
 */
async function chromeProbe(start: boolean): Promise<{
  chrome: ConnectionStatus
  gmail: ConnectionStatus
  yahoo: ConnectionStatus
  amazon: ConnectionStatus
  whatsapp: ConnectionStatus
}> {
  const base = {
    chrome: {
      id: 'chrome' as const,
      label: 'James-Browser',
      ok: false,
      detail: 'nicht erreichbar',
      fix:
        'James benutzt ein eigenes Chrome-Profil — dein normales Chrome bleibt unangetastet ' +
        'und muss nicht geschlossen werden. Der Browser startet von selbst, sobald eine ' +
        'Anfrage ihn braucht.'
    },
    gmail: {
      id: 'gmailWeb' as const,
      label: 'Gmail über den Browser',
      ok: false,
      detail: 'ungeprüft',
      fix: LOGIN_FIX
    },
    yahoo: {
      id: 'yahoo' as const,
      label: 'Yahoo Mail',
      ok: false,
      detail: 'ungeprüft',
      fix:
        'Ohne Anmeldung verschickt James keine Mail über Yahoo. ' + LOGIN_FIX
    },
    amazon: {
      id: 'amazon' as const,
      label: 'Amazon-Warenkorb',
      ok: false,
      detail: 'ungeprüft',
      fix: LOGIN_FIX
    },
    whatsapp: {
      id: 'whatsapp' as const,
      label: 'WhatsApp',
      ok: false,
      detail: 'ungeprüft',
      fix:
        'Einmal den QR-Code im James-Browser mit dem Telefon scannen — in WhatsApp unter ' +
        'Einstellungen, Verknüpfte Geräte. Danach bleibt die Kopplung.'
    }
  }

  const waiting = 'geht erst, wenn der Browser läuft'

  let ctx
  try {
    ctx = start ? await getContext() : await probeContext()
  } catch (err) {
    base.chrome.detail = err instanceof Error ? err.message : String(err)
    base.gmail.detail = waiting
    base.yahoo.detail = waiting
    base.amazon.detail = waiting
    base.whatsapp.detail = waiting
    return base
  }

  if (!ctx) {
    base.chrome.detail = 'läuft gerade nicht'
    base.gmail.detail = waiting
    base.yahoo.detail = waiting
    base.amazon.detail = waiting
    base.whatsapp.detail = waiting
    return base
  }

  base.chrome.ok = true
  const offen = ctx.pages().length
  base.chrome.detail = browserProfileExists()
    ? `läuft, ${offen} ${offen === 1 ? 'Tab' : 'Tabs'} offen`
    : 'läuft, Profil ist noch frisch'

  /**
   * `signedOutMarker` reicht nur, wo die Seite bei fehlender Anmeldung
   * tatsächlich woandershin führt. Amazon tut das beim Warenkorb nicht,
   * deshalb darf ein Aufrufer zusätzlich in der Seite selbst nachsehen.
   *
   * `inPage` darf `null` sagen, und das heißt „nicht erkennbar" — nicht
   * „angemeldet". Kurz stand hier `!== false`, und damit wurde jede Seite,
   * die zu langsam lud oder ihr Kennzeichen umbenannt hatte, als angemeldet
   * gemeldet. Ein grünes Häkchen, das nichts geprüft hat, ist schlimmer als
   * ein ehrliches Achselzucken: Danach sucht man den Fehler überall, nur
   * nicht bei der Anmeldung.
   */
  const check = async (
    url: string,
    signedOutMarker: string,
    inPage?: (page: Page) => Promise<boolean | null>
  ): Promise<{ ok: boolean; detail: string; unklar?: boolean }> => {
    const page = await ctx.newPage()
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 })
      if (page.url().includes(signedOutMarker)) {
        return { ok: false, detail: 'nicht angemeldet' }
      }
      if (inPage) {
        const urteil = await inPage(page)
        if (urteil === false) return { ok: false, detail: 'nicht angemeldet' }
        if (urteil === null) return { ok: false, detail: 'nicht erkennbar', unklar: true }
      }
      return { ok: true, detail: 'angemeldet' }
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message.slice(0, 90) : 'Fehler',
        unklar: true
      }
    } finally {
      await page.close().catch(() => undefined)
    }
  }

  const [gmail, yahoo, amazon, whatsapp] = await Promise.all([
    check('https://mail.google.com/mail/u/0/#inbox', 'accounts.google.com'),
    // Yahoo leitet Nichtangemeldete auf login.yahoo.com um — hier reicht die
    // Adresse als Kriterium, anders als bei Amazon, das den Gast-Warenkorb
    // unter derselben Adresse zeigt.
    check('https://mail.yahoo.com/d/folders/1', 'login.yahoo.'),
    check('https://www.amazon.de/gp/cart/view.html', '/ap/signin', amazonSignedIn),
    /*
     * WhatsApp lässt sich nicht an der Adresse erkennen.
     *
     * Angemeldet oder nicht — die Seite bleibt `web.whatsapp.com`. Deshalb
     * hier keine Weiterleitungsmarke, sondern ein Blick in die Seite.
     */
    check('https://web.whatsapp.com/', NO_REDIRECT, whatsappGekoppelt)
  ])

  base.gmail.ok = gmail.ok
  base.gmail.detail = gmail.detail
  base.yahoo.ok = yahoo.ok
  base.yahoo.detail = yahoo.detail
  base.amazon.ok = amazon.ok
  base.amazon.detail = amazon.detail
  base.whatsapp.ok = whatsapp.ok
  /*
   * Nur das sichere Nein wird zu „nicht gekoppelt" umbenannt. Vorher stand
   * hier `whatsapp.ok ? … : 'nicht gekoppelt'`, und damit sah eine
   * Zeitüberschreitung genauso aus wie ein tatsächlich abgemeldetes Konto —
   * der Nutzer scannt dann einen QR-Code, der gar nicht das Problem war.
   */
  base.whatsapp.detail = whatsapp.ok
    ? 'gekoppelt'
    : whatsapp.detail === 'nicht angemeldet'
      ? 'nicht gekoppelt'
      : whatsapp.detail
  return base
}

export async function checkConnections(start = false): Promise<ConnectionStatus[]> {
  const backend = await inputBackendStatus()

  const input: ConnectionStatus = {
    id: 'input',
    label: 'Maus und Tastatur',
    ok: !backend.grund,
    detail: backend.grund ? 'kein Weg gefunden' : `über ${backend.name}`,
    // Der Grund steht im Hilfetext und nicht im Kurzbefund: Dort ist Platz
    // dafür, und ohne ihn ist „kein Weg gefunden" eine Sackgasse.
    fix:
      'Ohne das gibt es keine Bildschirmsteuerung. Chrome- und Programm-Werkzeuge laufen weiter.' +
      (backend.grund ? ` ${backend.grund}` : '')
  }

  const gmailApi: ConnectionStatus = {
    id: 'gmailApi',
    label: 'Gmail über die Google-Schnittstelle',
    ok: hasGoogleAuth(),
    detail: !hasSecret('googleOAuthClientId')
      ? 'kein OAuth-Client hinterlegt'
      : hasGoogleAuth()
        ? 'verbunden'
        : 'eingerichtet, aber nicht verbunden',
    fix: 'Optional. Ohne sie läuft Gmail über den Browser — das reicht für lesen, öffnen und schreiben.'
  }

  /**
   * Der lokale Denkmotor.
   *
   * Steht nur in der Liste, wenn er auch gewählt ist: Wer Ollama gar nicht
   * benutzt, soll auf einer Seite mit Verbindungen kein rotes Kreuz für etwas
   * finden, das er nie einrichten wollte.
   */
  const settings = getSettings()
  const usesOllama =
    settings.speech.thinkProvider === 'ollama' || settings.brainProvider === 'ollama'
  const local: ConnectionStatus[] = []
  if (usesOllama) {
    const health = await ollamaHealth()
    local.push({
      id: 'ollama',
      label: 'Ollama auf diesem Rechner',
      /**
       * Fehlende Werkzeuge sind kein Ausfall.
       *
       * Kurz stand hier `ok: health.ok && health.tools`, und das war falsch
       * herum gedacht: Wer den lokalen Weg bewusst wählt, nimmt in Kauf, dass
       * sein Modell nur redet — ein rotes Kreuz für den Normalfall ist
       * Fehlalarm. Was das Modell kann und was nicht, steht im Text daneben,
       * und ausführlicher unter Stimme.
       */
      ok: health.ok,
      detail: health.detail,
      fix:
        health.models.length === 0
          ? 'Ollama starten — ohne den Dienst gibt es kein lokales Denken. ' +
            'Solange spricht Gemini.'
          : 'Soll James auch etwas erledigen und nicht nur antworten, führt der Weg ' +
            'unter Stimme über Google.'
    })
  }

  const chrome = await chromeProbe(start)
  return [
    ...local,
    chrome.chrome,
    chrome.gmail,
    chrome.yahoo,
    chrome.amazon,
    chrome.whatsapp,
    gmailApi,
    input
  ]
}
