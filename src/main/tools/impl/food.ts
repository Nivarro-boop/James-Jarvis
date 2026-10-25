import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { activePage, openPage, selectActivePage, setWindowVisible } from '../../automation/chromeCdp'
import { isFinalOrderLabel } from '@shared/orderGate'
import { getSettings } from '../../store/settings'

/**
 * Essen bestellen über die Lieferdienste, die der Nutzer ohnehin benutzt.
 *
 * Kein eigener Vertrag mit einem Lieferdienst, keine fremde Schnittstelle:
 * James bedient Lieferando, foodora, Wolt oder Uber Eats im James-Browser wie
 * ein Mensch — Adresse eintragen, Restaurant wählen, Gerichte in den Warenkorb,
 * zur Kasse. Angemeldet ist der Nutzer dort mit seinem eigenen Konto.
 *
 * Zwei harte Grenzen:
 * - Zahlungsdaten tippt James nie. Fehlt eine gespeicherte Zahlungsart,
 *   übernimmt der Nutzer im Browser.
 * - Abgeschickt wird nur über `order_place`. Das fragt immer nach — auch im
 *   autonomen Profil (siehe permissions.ts) — und zeigt Artikel, Preis und
 *   Adresse. chrome_click und chrome_interact verweigern den letzten Knopf
 *   (shared/orderGate.ts).
 */

interface Service {
  id: string
  name: string
  url: string
}

const SERVICES: Record<'AT' | 'DE' | 'CH', Service[]> = {
  AT: [
    { id: 'lieferando', name: 'Lieferando', url: 'https://www.lieferando.at/' },
    { id: 'foodora', name: 'foodora', url: 'https://www.foodora.at/' },
    { id: 'wolt', name: 'Wolt', url: 'https://wolt.com/de/aut' }
  ],
  DE: [
    { id: 'lieferando', name: 'Lieferando', url: 'https://www.lieferando.de/' },
    { id: 'wolt', name: 'Wolt', url: 'https://wolt.com/de/deu' },
    { id: 'ubereats', name: 'Uber Eats', url: 'https://www.ubereats.com/de' }
  ],
  CH: [
    { id: 'lieferando', name: 'Just Eat', url: 'https://www.just-eat.ch/' },
    { id: 'wolt', name: 'Wolt', url: 'https://wolt.com/de/che' },
    { id: 'ubereats', name: 'Uber Eats', url: 'https://www.ubereats.com/ch-de' }
  ]
}

/** Land aus der Zeitzone des Rechners — genauer als jede Vermutung aus dem Ortsnamen. */
export function deliveryCountry(timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): 'AT' | 'DE' | 'CH' {
  if (timeZone === 'Europe/Vienna') return 'AT'
  if (timeZone === 'Europe/Zurich') return 'CH'
  return 'DE'
}

export function pickService(wanted: string | undefined, country: 'AT' | 'DE' | 'CH'): Service {
  const list = SERVICES[country]
  return list.find((s) => s.id === wanted) ?? list[0]
}

const NEXT_STEPS = [
  'Mit chrome_elements das Adressfeld finden, die Lieferadresse eintragen und den passenden Vorschlag wählen.',
  'Nach dem Gericht oder Restaurant suchen. Dem Nutzer zwei bis drei passende Restaurants mit Bewertung, Lieferzeit und Mindestbestellwert nennen und ihn wählen lassen, außer er hat schon eines genannt.',
  'Gerichte in den Warenkorb legen. Größe und Extras nur so, wie der Nutzer sie gesagt hat; bei Unklarem kurz nachfragen.',
  'Zur Kasse gehen. Ist der Nutzer nicht angemeldet: website_login mit gespeichertem Konto, sonst chrome_prepare_login und auf ihn warten.',
  'Nie Karten- oder Zahlungsdaten eintragen. Fehlt eine gespeicherte Zahlungsart, sag dem Nutzer, dass er sie im Browser wählt.',
  'Zum Schluss Gesamtpreis inklusive Liefergebühr und Lieferzeit vorlesen und order_place mit der Nummer des Bestellknopfs aufrufen. Nie selbst auf den Bestellknopf klicken.'
]

const foodSearch = defineTool({
  name: 'food_search',
  group: 'shopping',
  description:
    'Essen bestellen, Schritt 1: öffnet einen Lieferdienst (Lieferando, foodora, Wolt, Uber Eats) im James-Browser ' +
    'und liefert die nächsten Schritte. Für „bestell mir Pizza", „ich will Sushi", „was liefert gerade". ' +
    'Danach mit chrome_elements und chrome_interact Adresse, Restaurant und Warenkorb bedienen; abgeschickt wird nur mit order_place.',
  schema: z.object({
    wunsch: z.string().describe('Gericht, Küche oder Restaurant, z. B. "Pizza Margherita" oder "Sushi".'),
    adresse: z.string().optional().describe('Lieferadresse. Ohne Angabe der Wohnort aus den Einstellungen.'),
    dienst: z.enum(['lieferando', 'foodora', 'wolt', 'ubereats']).optional().describe('Nur wenn der Nutzer einen bestimmten Dienst will.')
  }),
  spokenHint: 'Ich schau, was liefert.',
  async execute({ wunsch, adresse, dienst }) {
    const address = adresse?.trim() || getSettings().homeLocation.trim()
    if (!address) {
      return { status: 'frage', hinweis: 'Frag den Nutzer nach der Lieferadresse (Straße, Hausnummer, Ort).' }
    }
    const country = deliveryCountry()
    const service = pickService(dienst, country)
    const page = await openPage(service.url)
    selectActivePage(page)
    return {
      dienst: service.name,
      andereDienste: SERVICES[country].filter((s) => s.id !== service.id).map((s) => s.name),
      wunsch,
      lieferadresse: address,
      hinweisAdresse: adresse ? undefined : 'Nur der Wohnort aus den Einstellungen. Straße und Hausnummer beim Nutzer erfragen, wenn die Seite sie verlangt.',
      seite: await page.title(),
      nächsteSchritte: NEXT_STEPS
    }
  }
})

const orderPlace = defineTool({
  name: 'order_place',
  group: 'shopping',
  description:
    'Schickt eine Bestellung verbindlich ab, indem es den Bestellknopf (Nummer aus chrome_elements) drückt. ' +
    'Nur ganz am Ende, wenn Warenkorb, Adresse und Zahlungsart stimmen. Der Nutzer bestätigt immer vorher mit ' +
    'den Angaben, die du hier mitgibst — trag sie vollständig und ehrlich ein.',
  schema: z.object({
    ref: z.number().int().describe('Nummer des Bestellknopfs aus chrome_elements.'),
    shop: z.string().describe('Restaurant oder Shop.'),
    artikel: z.array(z.string()).min(1).describe('Jede Position mit Menge, z. B. "1× Pizza Margherita groß".'),
    gesamtpreis: z.string().describe('Endpreis inklusive Liefergebühr, wie auf der Seite angezeigt.'),
    lieferadresse: z.string(),
    zahlungsart: z.string().describe('Wie auf der Seite gewählt, z. B. "PayPal" oder "Barzahlung".')
  }),
  alwaysAsk: true,
  async execute({ ref }) {
    const page = await activePage()
    if (!page) throw new Error('Chrome hat keinen offenen Tab.')
    const el = page.locator(`[data-james-ref="${ref}"]`).first()
    if (!(await el.count())) throw new Error(`Element ${ref} gibt es nicht mehr. Erst chrome_elements erneut aufrufen.`)
    const label = await el.evaluate(e => (e.getAttribute('aria-label') || (e as HTMLElement).innerText || (e as HTMLInputElement).value || '').slice(0, 200))
    if (!isFinalOrderLabel(label)) {
      throw new Error(`Element ${ref} („${label.slice(0, 60)}") ist kein Bestellknopf. Mit chrome_elements den Knopf suchen, der die Bestellung abschickt.`)
    }
    // Leere Kartenfelder heißen: Hier müsste jemand Zahlungsdaten eintippen.
    // Das tut James nicht — der Nutzer übernimmt im sichtbaren Fenster.
    const emptyPayment = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLInputElement>('input')).some((input) => {
      const hint = `${input.autocomplete} ${input.name} ${input.id} ${input.placeholder}`.toLowerCase()
      const visible = input.getBoundingClientRect().width > 2 && getComputedStyle(input).visibility !== 'hidden'
      return visible && !input.value && /cc-number|cardnumber|card-number|kartennummer|creditcard/.test(hint)
    })).catch(() => false)
    if (emptyPayment) {
      await setWindowVisible(page, true)
      await page.bringToFront().catch(() => undefined)
      return { status: 'needs-user', reason: 'Die Seite will Kartendaten. Der Nutzer trägt sie selbst im Browser ein und bestellt dort, oder wählt eine gespeicherte Zahlungsart.' }
    }
    const before = page.url()
    await el.click({ timeout: 8000 })
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined)
    await page.waitForTimeout(2500)
    const text = (await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')).replace(/\s+/g, ' ').slice(0, 900)
    return {
      geklickt: label,
      seite: await page.title(),
      seiteGewechselt: page.url() !== before,
      seitentext: text,
      hinweis: 'Erst von Erfolg sprechen, wenn der Seitentext eine Bestellbestätigung oder Bestellnummer zeigt. Verlangt die Seite eine Bestätigung der Bank (3-D Secure), erledigt das der Nutzer.'
    }
  }
})

export const foodTools: ToolDefinition[] = [foodSearch as ToolDefinition, orderPlace as ToolDefinition]
