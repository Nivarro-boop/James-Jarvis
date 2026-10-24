import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePairing, sameOrigin } from './pairing.ts'

test('liest den Kopplungs-Link vom Rechner', () => {
  const result = parsePairing(' https://192.168.1.20:8788/#host=192.168.1.20:8788&token=ab/c+d== ')
  assert.ok(result.ok)
  assert.equal(result.pairing.origin, 'https://192.168.1.20:8788')
  assert.equal(result.pairing.secure, true)
  assert.equal(result.pairing.url, 'https://192.168.1.20:8788/#host=192.168.1.20%3A8788&token=ab%2Fc%2Bd%3D%3D')
})

test('lehnt Links ohne Marke ab, auch den Zertifikats-Link', () => {
  assert.equal(parsePairing('https://192.168.1.20:8789/ca').ok, false)
  assert.equal(parsePairing('https://192.168.1.20:8788/#host=192.168.1.20:8788').ok, false)
  assert.equal(parsePairing('kein link').ok, false)
  assert.equal(parsePairing('javascript:alert(1)#host=a&token=b').ok, false)
})

test('lehnt fremde Hosts im Fragment und Anmeldedaten im Link ab', () => {
  assert.equal(parsePairing('https://evil.example/#host=192.168.1.20:8788&token=x').ok, false)
  assert.equal(parsePairing('https://u@192.168.1.20:8788/#host=u@192.168.1.20:8788&token=x').ok, false)
})

test('erlaubt nur genau den gekoppelten Ursprung', () => {
  const result = parsePairing('http://10.0.0.2:8788/#host=10.0.0.2:8788&token=x')
  assert.ok(result.ok)
  assert.equal(result.pairing.secure, false)
  assert.ok(sameOrigin(result.pairing, 'http://10.0.0.2:8788/'))
  assert.ok(sameOrigin(result.pairing, 'http://10.0.0.2:8788'))
  assert.ok(!sameOrigin(result.pairing, 'http://10.0.0.2:87889/'))
  assert.ok(!sameOrigin(result.pairing, 'https://10.0.0.2:8788/'))
  assert.ok(!sameOrigin(result.pairing, 'http://10.0.0.2:8788.evil.example/'))
})
