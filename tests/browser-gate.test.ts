import assert from 'node:assert/strict'
import { it } from 'node:test'
import { browserGate } from '@shared/browserGate'

it('erkennt menschliche Sicherheitsprüfungen über Titel, Text und sichtbare Widgets', () => {
  for (const input of [
    { title: 'Robot Check', text: '' }, { title: 'Anmelden', text: 'Verify you are human' },
    { title: 'Anmelden', text: '', visibleChallenge: true }, { title: 'Anmelden', text: 'Ich bin kein Roboter' }
  ]) assert.equal(browserGate({ url: 'https://example.test', ...input }), 'captcha')
})
it('gibt vorhandene Sitzungen frei und verwechselt normale Seiten nicht mit Prüfungen', () => {
  assert.equal(browserGate({ url: 'https://example.test/account', title: 'Mein Konto', text: 'Hallo Anna' }), null)
  assert.equal(browserGate({ url: 'https://example.test/docs', title: 'Robot programming', text: 'Programmierung' }), null)
})
it('erkennt die Amazon-Anmeldung nur auf einer Amazon-Domain', () => {
  assert.equal(browserGate({ url: 'https://www.amazon.de/ap/signin', title: 'Anmelden', text: '' }), 'login')
  assert.equal(browserGate({ url: 'https://example.test/ap/signin', title: 'Dokumentation', text: '' }), null)
})
it('priorisiert die Sicherheitsprüfung vor der Anmeldung und verarbeitet ungültige URLs', () => {
  assert.equal(browserGate({ url: 'https://amazon.de/ap/signin', title: 'Robot Check', text: '' }), 'captcha')
  assert.equal(browserGate({ url: 'invalid', title: 'Robot Check', text: '' }), null)
})
