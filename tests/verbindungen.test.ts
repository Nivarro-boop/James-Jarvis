import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ersteAntwort } from '@main/agent/connections'
import { friendlyGoogleError, googleErrorForUser } from '@main/providers/googleAuth'

/**
 * Zwei Kennzeichen gegeneinander, statt eines mit Frist.
 *
 * Die Verbindungsseite meldete für WhatsApp innerhalb einer Minute erst
 * „gekoppelt" und dann „nicht gekoppelt", ohne dass sich etwas geändert
 * hätte. Der Grund war die Form der Prüfung: Sie wartete sechs Sekunden auf
 * den QR-Code und las sein Ausbleiben als Kopplung. Auf einem kalten Profil
 * braucht die Seite länger als sechs Sekunden — die Antwort hing damit am
 * Ladetempo und nicht am Konto.
 */
describe('erste eindeutige Antwort', () => {
  const gleich = <T,>(wert: T): Promise<T> => Promise.resolve(wert)
  const spaeter = <T,>(wert: T, ms: number): Promise<T> =>
    new Promise((r) => setTimeout(() => r(wert), ms))

  it('nimmt die Antwort, die zuerst da ist', async () => {
    assert.equal(await ersteAntwort([spaeter(true, 30), gleich(false)]), false)
  })

  it('wartet auf eine eindeutige Antwort, statt das erste Nichtwissen zu nehmen', async () => {
    // Der eigentliche Fehler von damals: Das schnelle „weiß ich nicht" des
    // einen Kennzeichens darf das langsame Ja des anderen nicht überholen.
    assert.equal(await ersteAntwort([gleich(null), spaeter(true, 20)]), true)
  })

  it('sagt weiß ich nicht, wenn kein Kennzeichen kommt', async () => {
    assert.equal(await ersteAntwort([gleich(null), spaeter(null, 20)]), null)
  })

  it('zählt einen Fehlschlag wie ein Nichtwissen und nicht wie ein Nein', async () => {
    assert.equal(await ersteAntwort([Promise.reject(new Error('weg')), spaeter(true, 20)]), true)
  })

  it('gibt ohne Kandidaten nichts vor', async () => {
    assert.equal(await ersteAntwort([]), null)
  })
})

/**
 * Wer den Fehler liest, entscheidet über seinen Wortlaut.
 *
 * Unter dem Knopf „Mit Google verbinden" stand die Anweisung an das
 * Sprachmodell: „Sag dem Nutzer, er soll in den Einstellungen eine
 * Google-Anmeldung hinterlegen." Gelesen hat sie jemand, der genau dort schon
 * stand und gerade gedrückt hatte — und was er eintragen soll, stand nicht
 * dabei.
 */
describe('Google-Fehler für zwei Leser', () => {
  const faelle = [
    new Error('invalid_grant: token has been expired or revoked'),
    new Error('redirect_uri_mismatch'),
    new Error('invalid_client: unauthorized'),
    new Error('access_denied'),
    new Error('insufficientPermissions')
  ]

  it('richtet dem Modell aus, was es sagen soll', () => {
    const texte = faelle.map(friendlyGoogleError)
    assert.ok(texte.some((t) => /Sag dem Nutzer/.test(t)))
  })

  it('weist den Nutzer nie an, es sich selbst auszurichten', () => {
    for (const fall of faelle) {
      const text = googleErrorForUser(fall)
      assert.ok(!/Sag dem Nutzer/.test(text), `agentische Anweisung im Fenster: ${text}`)
    }
  })

  it('schickt den Nutzer nicht dorthin, wo er ohnehin steht', () => {
    // „Trag es in den Einstellungen ein" ist im Einstellungsfenster keine
    // Wegbeschreibung, sondern eine Sackgasse.
    const text = googleErrorForUser(new Error('invalid_client: unauthorized'))
    assert.ok(!/in den Einstellungen/.test(text), text)
  })

  it('lässt unbekannte Fehler im Wortlaut stehen, gekürzt', () => {
    const lang = 'x'.repeat(400)
    assert.equal(googleErrorForUser(new Error(lang)).length, 240)
  })
})
