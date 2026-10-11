import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  capabilityGapReport,
  detectRefusal,
  gapFingerprint,
  redactPersonal,
  suggestFix,
  type CapabilityGap
} from '@shared/capabilityGap'

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length

function gap(text: string): CapabilityGap {
  return {
    request: text,
    answer: text,
    reason: text,
    suggestion: text,
    tools: Array.from({ length: 20 }, () => ({ tool: text, kind: 'error' as const, detail: text })),
    channel: text,
    sources: ['answer', 'tool', 'model']
  }
}

describe('Ablehnung erkennen', () => {
  for (const answer of [
    'Das kann ich leider nicht.',
    'Dafür habe ich kein Werkzeug.',
    'Ich habe keinen Zugriff auf deine Mails.',
    'Das steht am Telefon nicht zur Verfügung.',
    "I can't do that.",
    'Das kann ich über Alexa nicht.',
    'Dazu habe ich leider keinen Zugang.',
    'Leider kann ich für dich keine Mails schicken.',
    'Das übersteigt meine Fähigkeiten.',
    'Kann ich leider nicht.',
    'Ich kann das leider nicht.',
    'Da kann ich dir leider nicht helfen.',
    'Musik abspielen kann ich derzeit nicht.',
    'Ich bin ein Sprachassistent und kann leider keine Anrufe tätigen.',
    'Mir fehlt leider der Zugriff auf deine Kontakte.',
    'Ich bin leider nicht dazu in der Lage.',
    'Leider ist das nicht möglich.',
    'Ich kann leider keinen Termin finden, weil ich keinen Zugriff auf deinen Kalender habe.'
  ]) {
    it(`erkennt „${answer}“`, () => assert.ok(detectRefusal(answer), answer))
  }

  for (const answer of [
    'Kann ich sonst noch helfen?',
    'Das kann ich nicht nur, sondern auch noch mehr.',
    'Ich kann nicht garantieren, dass es regnet.',
    'Das kann ich nicht garantieren.',
    'Du kannst das nicht.',
    'Erledigt, die Mail ist raus.',
    'Das Geschäft kann heute nicht liefern.',
    'Ich habe keine Termine gefunden.',
    'Klar, das kann ich gern machen.',
    'Ich kann nicht genau sagen, ob es morgen regnet.',
    'Ich kann in deinem Kalender keinen Termin mit Anna finden.',
    'Ich habe keine Verbindungsprobleme festgestellt.',
    'Mir fehlt noch die Uhrzeit. Wann soll ich dich erinnern?',
    'Ohne deine Bestätigung kann ich die Mail nicht senden. Soll ich?'
  ]) {
    it(`lässt „${answer}“ durch`, () => assert.equal(detectRefusal(answer), null))
  }

  it('liefert den ablehnenden Satz, nicht die ganze Antwort', () => {
    assert.equal(detectRefusal('Gern geschehen. Das kann ich leider nicht. Aber ich suche dir etwas.'), 'Das kann ich leider nicht.')
  })
})

describe('Persönliches entfernen', () => {
  const text =
    'Schreib max.muster@example.com, ruf +43 660 1234567 an, IBAN AT61 1904 3002 3457 3201, ' +
    'Schlüssel sk-abcdefghijklmnop und AIzaSyA1234567890abcdefghijklmnop, ' +
    'Seite https://example.com/privat/kunde?id=7'
  const clean = redactPersonal(text)

  it('entfernt Adressen, Nummern, IBAN, Schlüssel und Linkpfade', () => {
    assert.doesNotMatch(clean, /max\.muster|example\.com\/privat|kunde\?id/)
    assert.doesNotMatch(clean, /660 1234567|AT61|sk-abc|AIzaSy/)
    assert.match(clean, /\[E-Mail\]/)
    assert.match(clean, /\[Nummer\]/)
    assert.match(clean, /\[IBAN\]/)
    assert.match(clean, /\[Schlüssel\]/)
    assert.match(clean, /https:\/\/example\.com\/…/)
  })

  it('entfernt gesprochene Passwörter, Zugangsdaten im Link und den Namen im Profilpfad', () => {
    const spoken = redactPersonal('Melde mich an, mein Passwort ist Sonne123 und die PIN lautet 4711.')
    assert.doesNotMatch(spoken, /Sonne123|4711/)
    const link = redactPersonal('Öffne https://max:geheim!1@intern.example/pfad')
    assert.doesNotMatch(link, /max|geheim/)
    assert.match(link, /https:\/\/intern\.example\/…/)
    const paths = redactPersonal("ENOENT: open 'C:\\Users\\Max Muster\\Desktop\\a.txt' und /home/maxm/b")
    assert.doesNotMatch(paths, /Max Muster|maxm/)
    assert.match(paths, /C:\\Users\\\[Name\]\\Desktop/)
  })

  it('bleibt bei langen Wörtern ohne Leerzeichen schnell', () => {
    // Quadratisch wären das bei 200 000 Zeichen eine halbe Minute.
    const started = performance.now()
    for (const text of ['x'.repeat(200_000), 'a.'.repeat(100_000), 'ab-'.repeat(70_000)]) {
      redactPersonal(text)
      detectRefusal(text)
    }
    assert.ok(performance.now() - started < 2000)
  })
})

describe('Bericht für die Fehlerseite', () => {
  it('bleibt mit Umlauten und sehr langem Text unter den Grenzen des Empfängers', () => {
    for (const text of ['ä'.repeat(20_000), 'Ü"\\€'.repeat(8000), '"'.repeat(20_000), '€'.repeat(20_000), 'x'.repeat(50_000)]) {
      const report = capabilityGapReport('1.3.3', 'win32', gap(text))
      assert.ok(report.message.length <= 2000)
      assert.ok(report.details.length <= 10_000)
      assert.ok(bytes(report) < 16_384, `${bytes(report)} Bytes`)
      assert.equal(JSON.parse(report.details).kind, 'capability-gap')
    }
  })

  it('trägt Anfrage, Antwort, Grund, Vorschlag und Werkzeuge, aber keine Mailadresse', () => {
    const report = capabilityGapReport('1.3.3', 'win32', {
      request: 'Schick die Rechnung an anna@example.org',
      answer: 'Das kann ich leider nicht.',
      reason: 'Kein Werkzeug für Rechnungen.',
      suggestion: suggestFix({ request: 'Rechnung', tools: [{ tool: 'invoice_send', kind: 'unknown', detail: '' }] }),
      tools: [{ tool: 'invoice_send', kind: 'unknown', detail: 'anna@example.org' }],
      channel: 'live',
      sources: ['answer', 'tool']
    })
    assert.equal(report.level, 'info')
    assert.equal(report.kind, 'capability-gap')
    assert.equal(report.source, 'JARVIS')
    const details = JSON.parse(report.details)
    assert.equal(details.appVersion, '1.3.3')
    assert.equal(details.answer, 'Das kann ich leider nicht.')
    assert.match(details.suggestion, /invoice_send/)
    assert.deepEqual(details.sources, ['answer', 'tool'])
    assert.doesNotMatch(JSON.stringify(report), /anna@example\.org/)
  })

  it('erkennt dieselbe Lücke am Fingerabdruck wieder', () => {
    const a = gapFingerprint({ request: 'Bitte Rechnung schicken', tools: [] })
    const b = gapFingerprint({ request: 'schicken, bitte: Rechnung!', tools: [] })
    assert.equal(a, b)
    assert.notEqual(a, gapFingerprint({ request: 'Bitte Rechnung schicken', tools: [{ tool: 'x', kind: 'unknown', detail: '' }] }))
  })
})
