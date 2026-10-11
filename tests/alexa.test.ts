import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { certUrlAllowed } from '@main/alexa/verify'

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
