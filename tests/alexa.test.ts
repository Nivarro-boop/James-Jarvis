import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { certUrlAllowed } from '@main/alexa/verify'
import { createRequestDeduper, RequestDeduperFullError } from '@main/alexa/idempotency'

/**
 * Der Türsteher der Alexa-Anbindung.
 *
 * Diese eine Funktion trägt die ganze Sicherheit des Endpunkts. Sie
 * entscheidet, von wo die Zertifikatskette geladen werden darf — und wer hier
 * etwas durchlässt, das nicht Amazons S3 ist, hat gar nichts geprüft: Ein
 * Angreifer würde einfach seine eigene Kette unterschieben und alles Weitere
 * selbst unterschreiben. Die Unterschrift wäre dann einwandfrei, nur eben
 * seine.
 *
 * Deshalb steht sie hier so ausführlich unter Beschuss wie keine andere.
 */
describe('Woher die Zertifikatskette kommen darf', () => {
  it('lässt Amazons eigene Adresse durch', () => {
    assert.equal(
      certUrlAllowed('https://s3.amazonaws.com/echo.api/echo-api-cert-7.pem'),
      true
    )
  })

  it('lässt sie auch mit ausgeschriebenem Port durch', () => {
    assert.equal(certUrlAllowed('https://s3.amazonaws.com:443/echo.api/cert.pem'), true)
  })

  // Ohne Verschlüsselung könnte jemand auf dem Weg die Kette austauschen.
  it('lehnt http ab', () => {
    assert.equal(certUrlAllowed('http://s3.amazonaws.com/echo.api/cert.pem'), false)
  })

  it('lehnt einen fremden Host ab', () => {
    assert.equal(certUrlAllowed('https://angreifer.de/echo.api/cert.pem'), false)
  })

  /*
   * Die Falle, auf die eine schludrige Prüfung hereinfällt.
   *
   * `startsWith('/echo.api')` ohne Schrägstrich am Ende ließe das hier durch —
   * und der Pfad gehört einem beliebigen Ordner, in den jeder S3-Kunde
   * schreiben darf.
   */
  it('lehnt einen Pfad ab, der nur so anfängt wie der richtige', () => {
    assert.equal(certUrlAllowed('https://s3.amazonaws.com/echo.api.angreifer/cert.pem'), false)
  })

  it('lehnt einen anderen Ordner bei demselben S3 ab', () => {
    assert.equal(certUrlAllowed('https://s3.amazonaws.com/beliebig/cert.pem'), false)
  })

  // Sonst käme man mit /echo.api/../beliebig/ wieder heraus.
  it('lehnt Pfade mit zwei Punkten ab', () => {
    assert.equal(certUrlAllowed('https://s3.amazonaws.com/echo.api/../fremd/cert.pem'), false)
  })

  it('lässt sich von doppelten Schrägstrichen nicht täuschen', () => {
    assert.equal(certUrlAllowed('https://s3.amazonaws.com//echo.api/cert.pem'), true)
  })

  it('lehnt einen anderen Port ab', () => {
    assert.equal(certUrlAllowed('https://s3.amazonaws.com:8443/echo.api/cert.pem'), false)
  })

  /*
   * Ein Host, der auf den erlaubten endet, ist nicht der erlaubte.
   * `endsWith('s3.amazonaws.com')` wäre hier hereingefallen.
   */
  it('lehnt einen Host ab, der nur so aufhört wie der richtige', () => {
    assert.equal(certUrlAllowed('https://boese-s3.amazonaws.com.angreifer.de/echo.api/c.pem'), false)
  })

  it('nimmt Groß- und Kleinschreibung im Host, wie Hostnamen es tun', () => {
    assert.equal(certUrlAllowed('https://S3.AMAZONAWS.COM/echo.api/cert.pem'), true)
  })

  it('lehnt ab, was gar keine Adresse ist', () => {
    assert.equal(certUrlAllowed('kein-url'), false)
    assert.equal(certUrlAllowed(''), false)
  })
})

describe('Alexa requestId-Deduplizierung', () => {
  it('teilt laufende Ausführung und Antwort mit gleichzeitigem Replay', async () => {
    const dedupe = createRequestDeduper({ maxEntries: 4, ttlMs: 1000 })
    let calls = 0
    let finish!: (answer: string) => void
    const operation = (): Promise<string> => {
      calls++
      return new Promise((resolve) => { finish = resolve })
    }
    const first = dedupe.run('same-request', operation)
    const duplicate = dedupe.run('same-request', operation)
    await Promise.resolve()
    assert.equal(calls, 1)
    finish('done')
    assert.equal(await first, 'done')
    assert.equal(await duplicate, 'done')
    assert.equal(await dedupe.run('same-request', operation), 'done')
    assert.equal(calls, 1)
  })

  it('behält auch einen unklaren/abgewiesenen Ausgang, statt erneut zu starten', async () => {
    const dedupe = createRequestDeduper({ maxEntries: 4, ttlMs: 1000 })
    let calls = 0
    const operation = async (): Promise<string> => {
      calls++
      throw new Error('ambiguous')
    }
    await assert.rejects(dedupe.run('failed-request', operation), /ambiguous/)
    await assert.rejects(dedupe.run('failed-request', operation), /ambiguous/)
    assert.equal(calls, 1)
  })

  it('begrenzt laufende Einträge und lässt sie nicht zur Kapazität frei verdrängen', async () => {
    const dedupe = createRequestDeduper({ maxEntries: 1, ttlMs: 1000 })
    let finish!: () => void
    const first = dedupe.run('in-flight', () => new Promise<void>((resolve) => { finish = resolve }))
    await Promise.resolve()
    await assert.rejects(dedupe.run('other', async () => undefined), RequestDeduperFullError)
    finish()
    await first
  })

  it('verdrängt keine abgeschlossene Kennung vor Ablauf der TTL', async () => {
    const dedupe = createRequestDeduper({ maxEntries: 1, ttlMs: 1000 })
    let calls = 0
    const operation = async (): Promise<number> => ++calls
    assert.equal(await dedupe.run('cached', operation), 1)
    await assert.rejects(dedupe.run('new-request', operation), RequestDeduperFullError)
    assert.equal(await dedupe.run('cached', operation), 1)
    assert.equal(calls, 1)
  })

  it('entfernt abgeschlossene Kennungen nach ihrer TTL', async () => {
    const dedupe = createRequestDeduper({ maxEntries: 2, ttlMs: 15 })
    let calls = 0
    const operation = async (): Promise<number> => ++calls
    assert.equal(await dedupe.run('expires', operation), 1)
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(await dedupe.run('expires', operation), 2)
  })
})
