/**
 * Der letzte Knopf vor dem Geldausgeben.
 *
 * Mit chrome_interact oder chrome_click konnte das Modell bisher jeden Knopf
 * drücken — auch „Zahlungspflichtig bestellen". Diese Erkennung hält genau
 * diesen einen Schritt an: Er läuft nur noch über `order_place`, das der
 * Nutzer mit Artikeln, Preis und Adresse vor Augen bestätigt, auch im
 * autonomen Profil. Alles davor (Restaurant suchen, Warenkorb füllen, zur
 * Kasse) bleibt frei.
 *
 * Lieber einmal zu oft anhalten: Ein fälschlich erkannter Knopf kostet eine
 * Rückfrage, ein übersehener echtes Geld.
 */
const FINAL_ORDER = new RegExp(
  [
    'zahlungspflichtig',
    'kostenpflichtig',
    'bestellen und bezahlen',
    'jetzt (?:kaufen|bezahlen|bestellen)',
    'bestellung (?:aufgeben|abschicken|absenden|abschließen|bestätigen)',
    'kauf abschließen',
    'zahlung bestätigen',
    'bezahlen und bestellen',
    'place (?:your )?order',
    'pay now',
    'buy now',
    'confirm (?:and pay|order|purchase|payment)',
    'complete (?:order|purchase)',
    'submit order',
    'order now'
  ].join('|'),
  'i'
)

/** Ist das die Beschriftung eines Knopfes, der eine Bestellung verbindlich abschickt? */
export function isFinalOrderLabel(label: string): boolean {
  return FINAL_ORDER.test(label.replace(/\s+/g, ' ').trim())
}

export const FINAL_ORDER_REFUSAL =
  'Das ist der Knopf, der die Bestellung verbindlich abschickt. Nicht direkt klicken: Fass dem Nutzer ' +
  'Shop, Artikel, Gesamtpreis, Lieferadresse und Zahlungsart zusammen und ruf order_place mit der Nummer ' +
  'dieses Knopfes auf. Der Nutzer bestätigt dort.'
