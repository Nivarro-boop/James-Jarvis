import { z } from 'zod'
import type { Page } from 'playwright-core'
import { defineTool, type ToolDefinition } from '../registry'
import { detectBlock, findOrOpen, getContext } from '../../automation/chromeCdp'
import { looksLikeEmail, resolveRecipient } from './contacts'

/**
 * Yahoo Mail über den James-Browser.
 *
 * Kein OAuth, kein Schlüssel, keine Cloud Console: Yahoo bietet für private
 * Konten keinen Weg, der einer Anwendung ohne kostenpflichtige Anmeldung das
 * Versenden erlaubt, und SMTP verlangt ein App-Passwort, das der Nutzer
 * anlegen, kopieren und hier hinterlegen müsste — also genau die Einrichtung,
 * die diese App überall sonst vermeidet. Der Browserweg braucht eine einmalige
 * Anmeldung im James-Chrome und danach nichts mehr.
 *
 * Anders als bei Gmail über den Browser wird hier wirklich verschickt, nicht
 * nur vorbereitet. Das darf es, weil die Kette davor vollständig ist:
 * `yahoo_send` steht in FORCED_ASK, die Rückfrage liest Name und Adresse laut
 * vor, und die Zusage prüft der Hauptprozess gegen das, was der Nutzer
 * tatsächlich gesagt hat. Bei `mail_compose` gibt es diese Kette nicht,
 * deshalb hört es dort beim Ausfüllen auf.
 */

const COMPOSE = 'https://mail.yahoo.com/d/compose'

/**
 * Die Kennungen, an denen Yahoos Oberfläche gegriffen wird.
 *
 * Mehrere pro Feld, und das ist keine Vorsicht auf Vorrat: Yahoo Mail ist eine
 * React-Anwendung, deren Klassennamen bei jedem Bau neu erzeugt werden. Stabil
 * sind allein die `data-test-id`-Attribute, die aus Yahoos eigenen Tests
 * stammen — und auch die wechseln über die Jahre. Fällt eine weg, trägt die
 * nächste; fällt die letzte weg, sagt das Werkzeug es deutlich, statt still
 * eine leere Mail zu verschicken.
 */
const SELECTORS = {
  to: [
    '[data-test-id="message-to-field"] input',
    '[data-test-id="message-to-field"]',
    'input[aria-label*="An"]',
    'input[aria-label*="To"]',
    '#message-to-field'
  ],
  subject: [
    '[data-test-id="compose-subject"] input',
    '[data-test-id="compose-subject"]',
    'input[placeholder*="Betreff"]',
    'input[placeholder*="Subject"]'
  ],
  body: [
    '[data-test-id="rte"]',
    'div[role="textbox"][contenteditable="true"]',
    '[contenteditable="true"]'
  ],
  send: [
    '[data-test-id="compose-send-button"]',
    'button[title*="Senden"]',
    'button[aria-label*="Senden"]',
    'button[title*="Send"]',
    'button[aria-label*="Send"]'
  ]
} as const

const NOT_SIGNED_IN =
  'Im James-Browser ist kein Yahoo-Konto angemeldet. Sag dem Nutzer, er soll sich dort ' +
  'einmal anmelden — der Knopf dafür steht in den Einstellungen unter Verbindungen. ' +
  'Danach läuft es von allein.'

export function yahooSignedOut(url: string): boolean {
  return /login\.yahoo\.|\/account\/challenge|guce\.yahoo\./i.test(url)
}

/** Öffnet ein Schreibfenster mit ausgefüllten Feldern und liefert die Seite. */
async function openCompose(to: string, subject: string, body: string): Promise<Page> {
  const params = new URLSearchParams()
  if (to) params.set('to', to)
  if (subject) params.set('subject', subject)
  if (body) params.set('body', body)

  const url = params.toString() ? `${COMPOSE}?${params.toString()}` : COMPOSE

  // Ein bestehendes Schreibfenster wiederverwenden statt Tabs zu stapeln —
  // nach drei Mails hätte der Nutzer sonst drei offene Entwürfe im Browser.
  const page = await findOrOpen('mail.yahoo.com/d/compose', url)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })

  const blocked = await detectBlock(page)
  if (blocked) throw new Error(blocked)
  if (yahooSignedOut(page.url())) throw new Error(NOT_SIGNED_IN)

  return page
}

/** Erster Treffer aus einer Kandidatenliste, oder null. */
async function firstVisible(page: Page, selectors: readonly string[]): Promise<string | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
      return selector
    }
  }
  return null
}

/**
 * Trägt die Felder notfalls von Hand nach.
 *
 * Die Adresszeile über die URL zu füllen klappt fast immer; Betreff und Text
 * gehen je nach Yahoo-Fassung mal durch und mal nicht. Nachgetragen wird
 * deshalb nur, was leer geblieben ist — sonst stünde der Text zweimal drin.
 */
async function fillIfEmpty(page: Page, selectors: readonly string[], value: string): Promise<boolean> {
  if (!value) return true
  const selector = await firstVisible(page, selectors)
  if (!selector) return false

  const locator = page.locator(selector).first()
  const current = await locator
    .evaluate((el) => (el as HTMLInputElement).value ?? el.textContent ?? '')
    .catch(() => '')
  if (current.trim().length > 0) return true

  await locator.click({ timeout: 8000 })
  await page.keyboard.type(value, { delay: 8 })
  return true
}

// ─────────────────────────────────────────────────────────────

const compose = defineTool({
  name: 'yahoo_compose',
  group: 'mail',
  description:
    'Öffnet bei Yahoo ein Schreibfenster mit ausgefüllten Feldern, verschickt aber nichts. ' +
    'Nimm das, wenn der Nutzer die Mail vor dem Absenden noch selbst ansehen oder ändern will. ' +
    'Soll sie wirklich rausgehen, nimm yahoo_send.',
  schema: z.object({
    to: z.string().describe('Name aus dem Kontaktbuch oder eine vollständige Mailadresse.'),
    subject: z.string().describe('Betreff.'),
    body: z.string().describe('Der Text der Mail.')
  }),
  async execute({ to, subject, body }) {
    const found = resolveRecipient(to)
    if (found.kind === 'none') {
      throw new Error(
        `Zu "${to}" steht keine Adresse im Kontaktbuch. Frag den Nutzer nach der Adresse oder ` +
          'verweise ihn auf die Seite Kontakte in den Einstellungen.'
      )
    }
    if (found.kind === 'many') {
      throw new Error(
        `Zu "${to}" stehen mehrere im Kontaktbuch: ` +
          `${found.matches.map((c) => `${c.name} (${c.email})`).join(', ')}. Frag nach, wer gemeint ist.`
      )
    }

    const page = await openCompose(found.contact.email, subject, body)
    await fillIfEmpty(page, SELECTORS.subject, subject)
    await fillIfEmpty(page, SELECTORS.body, body)
    await page.bringToFront()

    return {
      geöffnet: true,
      an: found.contact.name,
      adresse: found.contact.email,
      betreff: subject,
      hinweis:
        'Sag dem Nutzer, dass die Mail fertig ausgefüllt im Browser steht und er nur noch auf ' +
        'Senden drücken muss.'
    }
  }
}) as ToolDefinition

const send = defineTool({
  name: 'yahoo_send',
  group: 'mail',
  description:
    'Verschickt eine Mail über Yahoo. Der Empfänger darf der Name aus dem Kontaktbuch sein — ' +
    '"an Anna" genügt, die Adresse wird nachgeschlagen. Fragt immer vorher nach und liest ' +
    'dabei Name und Adresse vor.',
  schema: z.object({
    to: z.string().describe('Name aus dem Kontaktbuch oder eine vollständige Mailadresse.'),
    subject: z.string().describe('Betreff.'),
    body: z.string().describe('Der Text der Mail.')
  }),
  alwaysAsk: true,
  async execute({ to, subject, body }) {
    // Noch einmal auflösen, obwohl die Rückfrage es schon getan hat. Zwischen
    // Frage und Zusage können Minuten liegen, und die Adresse, die der Nutzer
    // gehört hat, muss dieselbe sein, an die es rausgeht.
    const found = resolveRecipient(to)
    if (found.kind === 'none') {
      throw new Error(
        `Zu "${to}" steht keine Adresse im Kontaktbuch. Ich verschicke nichts an eine geratene ` +
          'Adresse. Frag den Nutzer nach der Adresse — er kann sie unter Einstellungen, Kontakte ' +
          'eintragen, dann genügt künftig der Name.'
      )
    }
    if (found.kind === 'many') {
      throw new Error(
        `Zu "${to}" stehen mehrere im Kontaktbuch: ` +
          `${found.matches.map((c) => `${c.name} (${c.email})`).join(', ')}. Frag nach, wer gemeint ` +
          'ist, und ruf mich dann mit der vollständigen Adresse auf.'
      )
    }

    const address = found.contact.email
    if (!looksLikeEmail(address)) {
      throw new Error(`"${address}" ist keine brauchbare Mailadresse.`)
    }

    const page = await openCompose(address, subject, body)
    await fillIfEmpty(page, SELECTORS.subject, subject)
    await fillIfEmpty(page, SELECTORS.body, body)

    const sendSelector = await firstVisible(page, SELECTORS.send)
    if (!sendSelector) {
      // Nicht raten und irgendwohin klicken: Die Mail steht fertig da, der
      // Nutzer drückt selbst. Das ist der einzige ehrliche Ausgang, wenn Yahoo
      // seine Oberfläche umgebaut hat.
      await page.bringToFront()
      throw new Error(
        'Den Senden-Knopf finde ich bei Yahoo gerade nicht — die Seite sieht anders aus als ' +
          'erwartet. Die Mail steht fertig ausgefüllt im Browser. Sag dem Nutzer, er soll selbst ' +
          'auf Senden drücken.'
      )
    }

    await page.locator(sendSelector).first().click({ timeout: 10_000 })

    // Yahoo blendet nach dem Versand eine Bestätigung ein und schließt das
    // Schreibfenster. Bleibt der Knopf stehen, ist nichts rausgegangen —
    // dann lieber melden als "verschickt" behaupten.
    await page.waitForTimeout(1500)
    const stillOpen = await firstVisible(page, SELECTORS.send)
    if (stillOpen) {
      await page.bringToFront()
      throw new Error(
        'Der Senden-Knopf hat nicht reagiert — vielleicht fehlt ein Pflichtfeld oder Yahoo ' +
          'fragt etwas nach. Die Mail steht im Browser. Sag dem Nutzer, er soll dort nachsehen.'
      )
    }

    return {
      verschickt: true,
      an: found.contact.name,
      adresse: address,
      betreff: subject,
      hinweis: `Bestätige kurz, dass die Mail an ${found.contact.name} raus ist.`
    }
  }
}) as ToolDefinition

const openInbox = defineTool({
  name: 'yahoo_open',
  group: 'mail',
  description: 'Macht das Yahoo-Postfach im Browser auf, damit der Nutzer selbst hineinsieht.',
  schema: z.object({}),
  async execute() {
    const ctx = await getContext()
    const page = await findOrOpen('mail.yahoo.com', 'https://mail.yahoo.com/d/folders/1')
    await page.bringToFront()
    if (yahooSignedOut(page.url())) throw new Error(NOT_SIGNED_IN)
    return { geöffnet: 'Yahoo Postfach', tabs: ctx.pages().length }
  }
}) as ToolDefinition

export const yahooTools: ToolDefinition[] = [compose, send, openInbox]
