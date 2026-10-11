import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  Downsampler24kTo8k,
  muLawToPcm8k,
  pcm8kToMuLaw,
  upsample8kTo16k
} from '@main/telephony/audio'
import { decodeTwilioMedia, pinMatches, twilioSignature } from '@main/telephony/callServer'
import { normalizePhone } from '@main/providers/twilio'

describe('Telefon-Audio', () => {
  it('behält Paketgrenzen beim Heruntertasten verlustfrei bei', () => {
    const source = Int16Array.from({ length: 997 }, (_, i) => Math.round(Math.sin(i / 9) * 12000))

    const whole = new Downsampler24kTo8k().push(source)
    const streaming = new Downsampler24kTo8k()
    const pieces = [source.slice(0, 101), source.slice(101, 416), source.slice(416)]
    const chunked = pieces.flatMap((piece) => [...streaming.push(piece)])

    assert.deepEqual(chunked, [...whole])
    assert.equal(whole.length, Math.floor(source.length / 3))
  })

  it('hält µ-law beim Hin- und Rückweg im erwartbaren Telefonfehler', () => {
    const source = Int16Array.from([-30000, -12000, -1000, 0, 1000, 12000, 30000])
    const restored = muLawToPcm8k(pcm8kToMuLaw(source))
    for (let i = 0; i < source.length; i++) {
      assert.ok(Math.abs(restored[i] - source[i]) < 1200, `${source[i]} → ${restored[i]}`)
    }
  })

  it('setzt beim Hochabtasten ohne Knacken am vorigen Paket an', () => {
    const first = upsample8kTo16k(Int16Array.from([1000, 2000]))
    const second = upsample8kTo16k(Int16Array.from([3000]), first.last)
    assert.deepEqual([...second.out], [2500, 3000])
  })
})

describe('Twilio-Eingänge', () => {
  it('nimmt ein echtes 20-ms-Medienpaket an', () => {
    const frame = Buffer.alloc(160, 0xff)
    assert.deepEqual(decodeTwilioMedia(frame.toString('base64')), frame)
  })

  it('weist kaputtes Base64 und übergroße Pakete ab', () => {
    assert.equal(decodeTwilioMedia('kein base64!'), null)
    assert.equal(decodeTwilioMedia(Buffer.alloc(641).toString('base64')), null)
    assert.equal(decodeTwilioMedia(''), null)
  })

  it('normalisiert österreichische Nummern für Twilio', () => {
    assert.equal(normalizePhone('0664 123 45 67', 'AT'), '+436641234567')
    assert.equal(normalizePhone('0043 664 123 45 67', 'AT'), '+436641234567')
    assert.equal(normalizePhone('+43 (664) 123-45-67', 'AT'), '+436641234567')
  })

  it('berechnet Twilios dokumentiertes HMAC-Format stabil', () => {
    const one = twilioSignature('secret', 'https://example.test/twilio', { To: '+431', From: '+432' })
    const two = twilioSignature('secret', 'https://example.test/twilio', { From: '+432', To: '+431' })
    assert.equal(one, two)
    assert.match(one, /^[A-Za-z0-9+/]+=*$/)
  })

  it('vergleicht die Telefon-PIN exakt', () => {
    assert.equal(pinMatches('4711', '4711'), true)
    assert.equal(pinMatches('4712', '4711'), false)
    assert.equal(pinMatches('471', '4711'), false)
    assert.equal(pinMatches('47110', '4711'), false)
    assert.equal(pinMatches('', '4711'), false)
  })
})
