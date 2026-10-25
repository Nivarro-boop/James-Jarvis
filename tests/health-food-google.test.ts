import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { describeHealth, parseHealthSnapshot } from '@shared/health'
import { isFinalOrderLabel } from '@shared/orderGate'
import { isPhoneMessage } from '@shared/companion'
import { deliveryCountry, pickService } from '@main/tools/impl/food'
import { builtinGoogleClient } from '@main/providers/googleBuiltin'
import { buildSystemPrompt } from '@main/agent/prompt'
import { getSettings, setSettings } from '@main/store/settings'
import { permissionFor } from '@main/tools/permissions'
import { registerAllTools } from '@main/tools'

const NOW = Date.UTC(2026, 9, 25, 12)

describe('Apple Health vom iPhone', () => {
  it('übernimmt gültige Tageswerte, neueste zuerst', () => {
    const snapshot = parseHealthSnapshot({
      takenAt: NOW - 60_000,
      days: [
        { date: '2026-10-24', steps: 8000.4 },
        { date: '2026-10-25', steps: 4321, sleepHours: 7.25, restingHeartRate: 58 }
      ],
      heartRate: { bpm: 72.4, at: NOW - 120_000 },
      weight: { kg: 81.26, at: NOW - 86_400_000 }
    }, NOW)
    assert.ok(snapshot)
    assert.equal(snapshot.days[0].date, '2026-10-25')
    assert.equal(snapshot.days[0].steps, 4321)
    assert.equal(snapshot.days[1].steps, 8000)
    assert.equal(snapshot.heartRate?.bpm, 72)
    assert.equal(snapshot.weight?.kg, 81.3)
  })

  it('verwirft unsinnige, fremde und künftige Werte', () => {
    const snapshot = parseHealthSnapshot({
      takenAt: NOW,
      days: [{ date: '2026-10-25', steps: -5, sleepHours: 30, restingHeartRate: 'viel', evil: '<script>' }, { date: 'gestern', steps: 10 }],
      heartRate: { bpm: 60, at: NOW + 86_400_000 }
    }, NOW)
    assert.ok(snapshot)
    assert.deepEqual(snapshot.days, [{ date: '2026-10-25' }])
    assert.equal(snapshot.heartRate, undefined)
    assert.equal(parseHealthSnapshot({ takenAt: NOW + 3_600_000, days: [] }, NOW), null)
    assert.equal(parseHealthSnapshot('nein', NOW), null)
    assert.equal(parseHealthSnapshot({ takenAt: NOW, days: [] }, NOW), null)
  })

  it('beschreibt die Werte vorlesbar und nennt ihr Alter', () => {
    const snapshot = parseHealthSnapshot({ takenAt: NOW - 3 * 3_600_000, days: [
      { date: '2026-10-25', steps: 4321, sleepHours: 7.5 },
      { date: '2026-10-24', steps: 8000 },
      { date: '2026-10-23', steps: 6000 }
    ] }, NOW)!
    const text = describeHealth(snapshot, NOW)
    assert.match(text, /vor 3 Stunden/)
    assert.match(text, /4\.321 Schritte/)
    assert.match(text, /7 Std\. 30 Min\. Schlaf/)
    assert.match(text, /Durchschnitt der 2 Tage davor: 7\.000 Schritte/)
  })

  it('lässt die Health-Nachricht durchs Telefonprotokoll, aber nur als Objekt', () => {
    assert.ok(isPhoneMessage({ t: 'health', data: { takenAt: 1, days: [] } }))
    assert.ok(!isPhoneMessage({ t: 'health', data: [] }))
    assert.ok(!isPhoneMessage({ t: 'health' }))
  })
})

describe('Essen bestellen', () => {
  it('erkennt den letzten Bestellknopf, aber nicht den Weg dorthin', () => {
    for (const label of ['Zahlungspflichtig bestellen', 'Bestellen und bezahlen', 'Bestellung aufgeben', 'Jetzt kaufen', 'Place order', 'Pay now'])
      assert.ok(isFinalOrderLabel(label), label)
    for (const label of ['Zur Kasse', 'In den Warenkorb', 'Warenkorb ansehen', 'Weiter', 'Adresse bestätigen'])
      assert.ok(!isFinalOrderLabel(label), label)
  })

  it('wählt den Lieferdienst nach Land und Wunsch', () => {
    assert.equal(deliveryCountry('Europe/Vienna'), 'AT')
    assert.equal(deliveryCountry('Europe/Zurich'), 'CH')
    assert.equal(deliveryCountry('Europe/Berlin'), 'DE')
    assert.match(pickService(undefined, 'AT').url, /lieferando\.at/)
    assert.match(pickService('wolt', 'AT').url, /wolt\.com\/de\/aut/)
    // Unbekannter Wunsch fällt auf den ersten Dienst des Landes zurück.
    assert.match(pickService('foodora', 'DE').url, /lieferando\.de/)
  })

  it('fragt vor dem Abschicken immer nach, auch im autonomen Profil', () => {
    registerAllTools()
    const before = getSettings().confirmActions
    try {
      setSettings({ confirmActions: false })
      assert.equal(permissionFor('order_place'), 'ask')
      assert.equal(permissionFor('food_search'), 'allow')
    } finally {
      setSettings({ confirmActions: before })
    }
  })
})

describe('Google mit einem Klick', () => {
  it('nimmt nur echte Client-IDs mit Geheimnis', () => {
    const id = process.env.JARVIS_GOOGLE_CLIENT_ID
    const secret = process.env.JARVIS_GOOGLE_CLIENT_SECRET
    try {
      process.env.JARVIS_GOOGLE_CLIENT_ID = '123-abc.apps.googleusercontent.com'
      process.env.JARVIS_GOOGLE_CLIENT_SECRET = 'GOCSPX-test'
      assert.deepEqual(builtinGoogleClient(), { id: '123-abc.apps.googleusercontent.com', secret: 'GOCSPX-test' })
      process.env.JARVIS_GOOGLE_CLIENT_ID = 'irgendwas'
      assert.equal(builtinGoogleClient(), null)
      process.env.JARVIS_GOOGLE_CLIENT_ID = '123-abc.apps.googleusercontent.com'
      process.env.JARVIS_GOOGLE_CLIENT_SECRET = ''
      assert.equal(builtinGoogleClient(), null)
    } finally {
      if (id === undefined) delete process.env.JARVIS_GOOGLE_CLIENT_ID; else process.env.JARVIS_GOOGLE_CLIENT_ID = id
      if (secret === undefined) delete process.env.JARVIS_GOOGLE_CLIENT_SECRET; else process.env.JARVIS_GOOGLE_CLIENT_SECRET = secret
    }
  })
})

describe('Tokenverbrauch', () => {
  it('stellt die gleichbleibenden Arbeitsregeln vor alles Veränderliche', () => {
    const prompt = buildSystemPrompt({ query: 'Wetter' })
    const rules = prompt.indexOf('## Wie du längere Aufgaben angehst')
    const date = prompt.indexOf('Heute ist ')
    assert.ok(rules > 0 && date > rules)
    // Nichts zwischen Regeln und Datum hängt an der Uhrzeit.
    const head = prompt.slice(0, rules + 200)
    assert.ok(!/Beim Verbindungsaufbau war es/.test(head))
  })
})
