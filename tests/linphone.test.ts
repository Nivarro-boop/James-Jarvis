import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createSocket } from 'node:dgram'
import { header, headers, param, parseMessage, SipStreamParser, uriOf, type SipMessage } from '@main/telephony/sip/message'
import { authorization, parseChallenges } from '@main/telephony/sip/digest'
import { buildSdp, parseSdp, publicAddress, RtpSession } from '@main/telephony/sip/rtp'
import { sameAddress } from '@main/telephony/sip/phone'

describe('SIP-Nachrichten', () => {
  it('zerlegt einen Strom in Nachrichten, auch über Paketgrenzen und mit Umlauten im Rumpf', () => {
    const body = 'v=0\r\ns=Grüße\r\n'
    const one = `INVITE sip:a@b SIP/2.0\r\nVia: SIP/2.0/TLS x;branch=z9hG4bK1, SIP/2.0/TLS y;branch=z9hG4bK2\r\nl: ${Buffer.byteLength(body)}\r\n\r\n${body}`
    const two = 'SIP/2.0 200 OK\r\nCSeq: 1 REGISTER\r\nContent-Length: 0\r\n\r\n'
    const all = Buffer.from(`\r\n\r\n${one}${two}`)
    const got: SipMessage[] = []
    const parser = new SipStreamParser((m) => got.push(m))
    for (let i = 0; i < all.length; i += 7) parser.push(all.subarray(i, i + 7))
    assert.equal(got.length, 2)
    assert.equal(got[0].method, 'INVITE')
    assert.equal(got[0].body, body)
    assert.equal(headers(got[0], 'via').length, 2)
    assert.equal(got[1].status, 200)
  })

  it('liest Tags und URIs', () => {
    const msg = parseMessage('SIP/2.0 200 OK\r\nTo: "Anna" <sip:anna@sip.linphone.org;transport=tls>;tag=abc', '')
    assert.equal(param(header(msg, 'to'), 'tag'), 'abc')
    assert.equal(uriOf(header(msg, 'to')), 'sip:anna@sip.linphone.org;transport=tls')
    assert.equal(param(header(msg, 'to'), 'transport'), undefined)
  })

  it('vergleicht Adressen ohne Parameter und Schreibweise', () => {
    assert.ok(sameAddress('sip:Anna@sip.linphone.org;transport=tls', 'anna@sip.linphone.org'))
    assert.ok(!sameAddress('sip:bob@sip.linphone.org', 'anna@sip.linphone.org'))
    assert.ok(!sameAddress('', ''))
  })
})

describe('Digest-Anmeldung', () => {
  it('rechnet das Beispiel aus RFC 2617 richtig', () => {
    const [challenge] = parseChallenges([
      'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"'
    ])
    const value = authorization(challenge, 'GET', '/dir/index.html', 'Mufasa', 'Circle Of Life', 1, '0a4f113b')
    assert.match(value, /response="6629fae49393a05397450978507c4ef1"/)
  })

  it('nimmt SHA-256 vor MD5', () => {
    const list = parseChallenges(['Digest realm="r", nonce="n", algorithm=MD5', 'Digest realm="r", nonce="n", algorithm=SHA-256'])
    assert.equal(list[0].algorithm, 'SHA-256')
  })
})

describe('Ton', () => {
  it('liest Adresse und Port aus dem SDP, Medienzeile vor Sitzungszeile', () => {
    const sdp = 'v=0\r\nc=IN IP4 1.1.1.1\r\nm=audio 4000 RTP/AVP 8 0 101\r\nc=IN IP4 2.2.2.2\r\n'
    assert.deepEqual(parseSdp(sdp), { address: '2.2.2.2', port: 4000 })
    assert.equal(parseSdp('v=0\r\nc=IN IP4 1.1.1.1\r\nm=audio 4000 RTP/AVP 8\r\n'), null)
    assert.deepEqual(parseSdp(buildSdp('3.3.3.3', 5000)), { address: '3.3.3.3', port: 5000 })
  })

  it('schickt µ-law in 20-ms-Paketen hin und her', async () => {
    const received: Buffer[] = []
    const a = await RtpSession.open(() => undefined)
    const b = await RtpSession.open((audio) => received.push(audio))
    a.connect({ address: '127.0.0.1', port: b.port })
    a.send(Buffer.alloc(320, 0x12))
    await new Promise((r) => setTimeout(r, 120))
    a.close()
    b.close()
    assert.ok(received.length >= 2)
    assert.equal(received[0].length, 160)
    assert.equal(received[0][0], 0x12)
  })

  it('liest die öffentliche Adresse aus der STUN-Antwort', async () => {
    const server = createSocket('udp4')
    await new Promise<void>((r) => server.bind(0, '127.0.0.1', () => r()))
    server.on('message', (req, from) => {
      const res = Buffer.alloc(32)
      res.writeUInt16BE(0x0101, 0)
      res.writeUInt16BE(12, 2)
      req.copy(res, 4, 4, 20)
      res.writeUInt16BE(0x0020, 20)
      res.writeUInt16BE(8, 22)
      res[25] = 0x01
      res.writeUInt16BE(5555 ^ 0x2112, 26)
      res.writeUInt32BE((((203 << 24) | (0 << 16) | (113 << 8) | 7) ^ 0x2112a442) >>> 0, 28)
      server.send(res, from.port, from.address)
    })
    const rtp = await RtpSession.open(() => undefined)
    const mapped = await publicAddress(rtp.udp, '127.0.0.1', server.address().port)
    rtp.close()
    server.close()
    assert.deepEqual(mapped, { address: '203.0.113.7', port: 5555 })
  })
})
