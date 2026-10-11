import { z } from 'zod'
import type { Page } from 'playwright-core'
import { defineTool, type ToolDefinition } from '../registry'
import { findOrOpen } from '../../automation/chromeCdp'
import { resolvePhoneNumber } from '../../providers/twilio'

/**
 * WhatsApp über den James-Browser.
 *
 * Derselbe Weg wie bei Gmail und Yahoo, und aus demselben Grund: Es gibt keine
 * offene Schnittstelle. Die WhatsApp Business API verlangt ein freigeschaltetes
 * Absenderkonto, kostet je Nachricht und verschickt unter einer anderen Nummer
 * als der eigenen — für „schreib Anna, dass ich später komme" ist das nicht
 * der richtige Weg. WhatsApp Web ist es: einmal den QR-Code scannen, danach
 * läuft es unter der eigenen Nummer und kostet nichts.
 *
 * Der Empfänger kommt nicht aus dem Suchfeld der Oberfläche, sondern über den
 * Verweis `wa.me`-Art, den WhatsApp selbst dafür anbietet. Das ist der
 * entscheidende Unterschied zu einem Klickroboter: Die Suchliste durchzugehen
 * und den ersten Treffer anzuklicken hieße, bei zwei ähnlichen Namen die
 * falsche Person anzuschreiben — und eine verschickte Nachricht kommt nicht
 * zurück. Die Nummer stammt aus dem Adressbuch, das der Nutzer selbst gepflegt
 * hat.
 */

const BASE = 'https://web.whatsapp.com'

/**
 * Die Eingabezeile am Fuß des Fensters.
 *
 * Mehrere Kandidaten, weil WhatsApp seine `data-tab`-Nummern zwischen
 * Fassungen verschiebt. Der Weg über `footer` trägt auch dann noch, wenn die
 * Nummer wieder eine andere ist — es gibt dort genau ein Eingabefeld.
 */
const COMPOSER = [
  'footer div[contenteditable="true"]',
  'div[data-testid="conversation-compose-box-input"]',
  'div[contenteditable="true"][data-tab="10"]',
  'div[contenteditable="true"][data-tab="6"]'
].join(', ')

/** Wie lange auf das geladene Gespräch gewartet wird. */
const READY_MS = 30_000

/**
 * Die Seite holen und dabei prüfen, ob überhaupt jemand angemeldet ist.
 *
 * Der QR-Code ist der einzige verlässliche Hinweis darauf. An der Adresse ist
 * nichts abzulesen — WhatsApp Web bleibt bei `web.whatsapp.com`, ob angemeldet
 * oder nicht.
 */
async function whatsappPage(url: string): Promise<Page> {
  const page = await findOrOpen('web.whatsapp.com', url)

  // Auch ein schon offener Tab muss zum Ziel — `findOrOpen` liefert ihn so,
  // wie er gerade steht.
  if (!page.url().startsWith(url)) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  }

  const loggedOut = await page
    .waitForSelector('canvas[aria-label*="Scan" i], canvas[aria-label*="QR" i], [data-testid="qrcode"]', {
      timeout: 4000,
      state: 'visible'
    })
    .catch(() => null)

  if (loggedOut) {
    await page.bringToFront().catch(() => undefined)
    throw new Error(
      'In WhatsApp Web ist niemand angemeldet — es zeigt gerade den QR-Code. Sag dem Nutzer, ' +
        'er soll ihn im James-Browser einmal mit dem Telefon scannen, dann geht es dauerhaft. ' +
        'Das Fenster steht schon offen.'
    )
  }

  return page
}

/** Nummer für den Verweis: nur Ziffern, ohne Plus. */
function forLink(phone: string): string {
  return phone.replace(/\D/g, '')
}

/**
 * Empfänger auflösen und dabei ehrlich bleiben.
 *
 * Es wird nichts geraten: Steht der Name nicht im Adressbuch, gibt es keine
 * Nachricht. Der Grund ist derselbe wie beim Mailversand — gesprochen kommt
 * eine Nummer nicht zuverlässig an, und eine Nachricht an die falsche Nummer
 * lässt sich nicht zurückholen.
 */
function recipient(to: string): { phone: string; name: string } {
  const found = resolvePhoneNumber(to)
  if (!found) {
    throw new Error(
      `Für "${to}" habe ich keine Telefonnummer. Sag dem Nutzer, er soll den Kontakt in den ` +
        'Einstellungen unter Kontakte anlegen — raten tue ich eine Nummer nicht.'
    )
  }
  return { phone: found.phone, name: found.name ?? found.phone }
}

/** Das Gespräch mit vorbereitetem Text öffnen. */
async function openChat(phone: string, text: string): Promise<Page> {
  const url = `${BASE}/send?phone=${forLink(phone)}&text=${encodeURIComponent(text)}`
  const page = await whatsappPage(url)

  const composer = await page.waitForSelector(COMPOSER, { timeout: READY_MS }).catch(() => null)
  if (!composer) {
    throw new Error(
      'Das Gespräch hat sich nicht geöffnet. Entweder ist die Nummer nicht bei WhatsApp, oder ' +
        'die Seite lädt noch. Sag dem Nutzer, was du versucht hast.'
    )
  }

  await page.bringToFront().catch(() => undefined)
  return page
}

// ─────────────────────────────────────────────────────────────

const compose = defineTool({
  name: 'whatsapp_compose',
  group: 'messaging',
  description:
    'Öffnet ein WhatsApp-Gespräch mit fertig eingetragener Nachricht, verschickt sie aber nicht. ' +
    'Der Nutzer drückt selbst auf Senden. Nimm das, wenn er die Nachricht vorher sehen will, ' +
    'oder wenn du dir beim Wortlaut nicht sicher bist.',
  schema: z.object({
    to: z.string().describe('Name aus dem Adressbuch oder eine Telefonnummer.'),
    message: z.string().describe('Der Text, so wie er dastehen soll.')
  }),
  spokenHint: 'Ich mach das Gespräch auf.',
  async execute({ to, message }) {
    const who = recipient(to)
    await openChat(who.phone, message)

    return {
      geöffnet: true,
      an: who.name,
      hinweis:
        `Das Gespräch mit ${who.name} steht offen und der Text ist eingetragen. Sag dem Nutzer, ` +
        'dass er nur noch auf Senden drücken muss — verschickt hast du nichts.'
    }
  }
}) as ToolDefinition

const send = defineTool({
  name: 'whatsapp_send',
  group: 'messaging',
  description:
    'Verschickt eine WhatsApp-Nachricht. Für "schreib X, dass ...". Der Empfänger muss mit ' +
    'Telefonnummer im Adressbuch stehen. Fragt vorher nach.',
  schema: z.object({
    to: z.string().describe('Name aus dem Adressbuch oder eine Telefonnummer.'),
    message: z.string().describe('Der Text, so wie er verschickt werden soll.')
  }),
  spokenHint: 'Ich schick das raus.',
  async execute({ to, message }) {
    const who = recipient(to)
    const page = await openChat(who.phone, message)

    /*
     * Enter statt Klick auf den Papierflieger.
     *
     * Der Knopf trägt je nach Fassung ein anderes Merkmal und sitzt an einer
     * anderen Stelle; die Eingabetaste verschickt in WhatsApp Web seit jeher.
     * Wichtig ist nur, dass der Eingabebereich den Fokus hat — sonst geht der
     * Tastendruck an die Gesprächsliste und blättert dort herum.
     */
    const composer = await page.$(COMPOSER)
    if (!composer) throw new Error('Das Eingabefeld war plötzlich weg. Nichts verschickt.')

    await composer.click()

    // Ohne diesen Blick verschickt man eine leere Nachricht, wenn der Text aus
    // dem Verweis nicht angekommen ist — und merkt es nie.
    const typed = (await composer.innerText().catch(() => '')).trim()
    if (typed.length === 0) {
      throw new Error(
        'Im Eingabefeld steht kein Text. Ich habe nichts verschickt. Sag dem Nutzer, dass die ' +
          'Nachricht nicht angekommen ist, und biete whatsapp_compose an.'
      )
    }

    await page.keyboard.press('Enter')

    // Der Oberfläche einen Moment geben, den Text zu übernehmen, bevor
    // nachgesehen wird.
    await page.waitForTimeout(900)

    // Leeres Eingabefeld heißt: die Nachricht ist heraus. Bleibt der Text
    // stehen, ist sie es nicht — und das soll James sagen, statt Erfolg zu
    // melden.
    const after = (await composer.innerText().catch(() => '')).trim()
    const gone = after.length === 0

    return {
      verschickt: gone,
      an: who.name,
      zeichen: message.length,
      hinweis: gone
        ? `Bestätige knapp, dass die Nachricht an ${who.name} raus ist. Kein Vorlesen des Textes.`
        : 'Die Nachricht steht noch im Eingabefeld — verschickt wurde sie offenbar nicht. Sag ' +
          'das dem Nutzer und lass ihn im offenen Fenster nachsehen.'
    }
  }
}) as ToolDefinition

const unread = defineTool({
  name: 'whatsapp_unread',
  group: 'messaging',
  description:
    'Sieht nach, in welchen WhatsApp-Gesprächen ungelesene Nachrichten liegen. Für "hab ich ' +
    'was auf WhatsApp" oder "wer hat geschrieben". Liest die Nachrichten selbst nicht.',
  schema: z.object({}),
  spokenHint: 'Ich schau nach.',
  async execute() {
    const page = await whatsappPage(BASE)
    await page.waitForSelector('#pane-side', { timeout: READY_MS }).catch(() => undefined)

    /*
     * Der ungelesen-Zähler ist das einzig Stabile an dieser Liste.
     *
     * WhatsApp beschriftet ihn für Screenreader — auf Deutsch „3 ungelesene
     * Nachrichten", auf Englisch „3 unread messages". Über diese Beschriftung
     * zu gehen ist haltbarer als über Klassennamen, die sich mit jeder
     * Fassung ändern, und liefert die Zahl gleich mit.
     */
    const chats = await page
      .evaluate(() => {
        const out: { name: string; anzahl: number }[] = []
        const rows = document.querySelectorAll('#pane-side div[role="listitem"]')

        for (const row of rows) {
          const badge = row.querySelector<HTMLElement>(
            'span[aria-label*="ungelesen" i], span[aria-label*="unread" i]'
          )
          if (!badge) continue

          const label = badge.getAttribute('aria-label') ?? ''
          const count = Number((label.match(/\d+/) ?? ['1'])[0])

          // Der erste Textknoten der Zeile ist der Gesprächsname; die
          // Vorschau steht darunter und bleibt bewusst außen vor.
          const title =
            row.querySelector('span[title]')?.getAttribute('title') ??
            row.textContent?.trim().slice(0, 40) ??
            'Unbekannt'

          out.push({ name: title, anzahl: Number.isFinite(count) ? count : 1 })
          if (out.length >= 15) break
        }
        return out
      })
      .catch(() => [] as { name: string; anzahl: number }[])

    if (chats.length === 0) {
      return { ungelesen: 0, hinweis: 'Nichts Ungelesenes auf WhatsApp.' }
    }

    return {
      gespräche: chats.length,
      ungelesen: chats.reduce((sum, c) => sum + c.anzahl, 0),
      von: chats,
      hinweis:
        'Nenne die Namen und wie viele es je sind, in einem Satz. Den Inhalt kennst du nicht — ' +
        'behaupte nichts darüber.'
    }
  }
}) as ToolDefinition

export const whatsappTools: ToolDefinition[] = [compose, send, unread]
