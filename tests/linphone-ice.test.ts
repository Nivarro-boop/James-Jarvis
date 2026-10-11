import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createSocket } from 'node:dgram'
import { createHmac } from 'node:crypto'
import { answerBindingRequest, buildStun, isStun, parseCandidates, xorMappedAddress } from '@main/telephony/sip/ice'
import { buildSdp, parseRemoteMedia, RtpSession } from '@main/telephony/sip/rtp'

const hex = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex')

describe('STUN für ICE-lite', () => {
  it('baut die Beispielantwort aus RFC 5769 Byte für Byte nach', () => {
    const software = Buffer.from('test vector', 'utf8')
    const message = buildStun(
      0x0101,
      hex('b7e7a701 bc34d686 fa87dfae'),
      [
        { type: 0x8022, value: software },
        { type: 0x0020, value: xorMappedAddress('192.0.2.1', 32853) }
      ],
      'VOkJxbRl1RmTxUk/WvJxBt',
      0x20
    )
    assert.equal(
      message.toString('hex'),
      hex(`
        0101003c 2112a442 b7e7a701 bc34d686 fa87dfae
        8022000b 74657374 20766563 746f7220
        00200008 0001a147 e112a643
        00080014 2b91f599 fd9e90c3 8c7489f9 2af9ba53 f06be7d7
        80280004 c07d4c96
      `).toString('hex')
    )
  })

  it('beantwortet nur Prüfanfragen mit dem eigenen ufrag', () => {
    const local = { ufrag: 'jame', pwd: 'abcdefghijklmnopqrstuvwx' }
    const request = (username: string, useCandidate: boolean): Buffer => {
      const attrs = [{ type: 0x0006, value: Buffer.from(username) }]
      if (useCandidate) attrs.push({ type: 0x0025, value: Buffer.alloc(0) })
      return buildStun(0x0001, Buffer.alloc(12, 7), attrs, local.pwd)
    }
    const from = { address: '198.51.100.4', port: 40000 }

    const answer = answerBindingRequest(request('jame:phon', true), from, local)
    assert.ok(answer)
    assert.equal(answer.useCandidate, true)
    assert.equal(answer.response.readUInt16BE(0), 0x0101)
    assert.ok(isStun(answer.response))
    // Die Prüfsumme muss mit unserem Passwort stimmen, sonst verwirft das Telefon die Antwort.
    const miOffset = answer.response.length - 8 - 24
    const head = Buffer.from(answer.response.subarray(0, miOffset))
    head.writeUInt16BE(miOffset - 20 + 24, 2)
    const mac = createHmac('sha1', local.pwd).update(head).digest()
    assert.deepEqual(answer.response.subarray(miOffset + 4, miOffset + 24), mac)

    assert.equal(answerBindingRequest(request('fremd:phon', false), from, local), null)
  })
})

describe('SDP des Telefons', () => {
  const linphone = (c: string, profile = 'RTP/AVP', extra = ''): string =>
    [
      'v=0',
      `o=nivarro 1 1 IN ${c.includes(':') ? 'IP6' : 'IP4'} ${c}`,
      's=Talk',
      `c=IN ${c.includes(':') ? 'IP6' : 'IP4'} ${c}`,
      't=0 0',
      `m=audio 7078 ${profile} 96 0 8 101`,
      'a=rtcp-mux',
      'a=candidate:1 1 UDP 2130706303 192.168.1.10 7078 typ host',
      'a=candidate:1 2 UDP 2130706302 192.168.1.10 7079 typ host',
      'a=candidate:2 1 UDP 1694498687 85.10.20.30 41000 typ srflx raddr 192.168.1.10 rport 7078',
      'a=candidate:3 1 UDP 16777215 91.121.0.1 50000 typ relay raddr 85.10.20.30 rport 41000',
      'a=candidate:4 1 UDP 2130706431 2a02:8388::1 7078 typ host',
      extra,
      ''
    ].join('\r\n')

  it('nimmt alle IPv4-Kandidaten, die c-Zeile zuerst', () => {
    const media = parseRemoteMedia(linphone('192.168.1.10'))
    assert.ok('targets' in media)
    assert.deepEqual(media.targets, [
      { address: '192.168.1.10', port: 7078 },
      { address: '85.10.20.30', port: 41000 },
      { address: '91.121.0.1', port: 50000 }
    ])
  })

  it('kommt mit einer IPv6-c-Zeile zurecht, solange es IPv4-Kandidaten gibt', () => {
    const media = parseRemoteMedia(linphone('2a02:8388::1'))
    assert.ok('targets' in media)
    assert.equal(media.targets[0].address, '85.10.20.30')
  })

  it('sagt, wenn das Telefon verschlüsselten Ton verlangt', () => {
    assert.deepEqual(parseRemoteMedia(linphone('192.168.1.10', 'RTP/SAVP')), { problem: 'srtp' })
  })

  it('liest nur Komponente 1 über UDP und IPv4', () => {
    const list = parseCandidates(linphone('192.168.1.10'))
    assert.equal(list.length, 3)
    assert.ok(list.every((c) => c.component === 1 && !c.address.includes(':')))
  })

  it('schreibt ICE-lite und Kandidaten ins eigene Angebot', () => {
    const sdp = buildSdp('203.0.113.5', 6000, {
      credentials: { ufrag: 'abcd', pwd: 'abcdefghijklmnopqrstuvwx' },
      candidates: [
        { foundation: '1', component: 1, transport: 'UDP', priority: 2130706431, address: '10.0.0.2', port: 5000, type: 'host' },
        { foundation: '2', component: 1, transport: 'UDP', priority: 1694498815, address: '203.0.113.5', port: 6000, type: 'srflx' }
      ],
      base: { address: '10.0.0.2', port: 5000 }
    })
    assert.match(sdp, /^a=ice-lite$/m)
    assert.match(sdp, /^a=rtcp-mux$/m)
    assert.match(sdp, /^a=candidate:2 1 UDP 1694498815 203\.0\.113\.5 6000 typ srflx raddr 10\.0\.0\.2 rport 5000$/m)
    assert.deepEqual(parseRemoteMedia(sdp), {
      targets: [
        { address: '203.0.113.5', port: 6000 },
        { address: '10.0.0.2', port: 5000 }
      ]
    })
  })
})

describe('RTP mit ICE', () => {
  it('beantwortet die Prüfanfrage des Telefons und bleibt dann bei dessen Adresse', async () => {
    const local = { ufrag: 'jame', pwd: 'abcdefghijklmnopqrstuvwx' }
    const rtp = await RtpSession.open(() => undefined)
    rtp.setIce(local)
    // Erst an eine Adresse, die nie antwortet — wie eine private IP aus der c-Zeile.
    rtp.connect([{ address: '127.0.0.1', port: 9 }])

    const phone = createSocket('udp4')
    await new Promise<void>((r) => phone.bind(0, '127.0.0.1', () => r()))
    const reply = new Promise<Buffer>((resolve) => phone.on('message', (msg) => isStun(msg) && resolve(msg)))
    const check = buildStun(
      0x0001,
      Buffer.alloc(12, 3),
      [
        { type: 0x0006, value: Buffer.from('jame:phon') },
        { type: 0x0025, value: Buffer.alloc(0) }
      ],
      local.pwd
    )
    phone.send(check, rtp.port, '127.0.0.1')
    const response = await reply
    assert.equal(response.readUInt16BE(0), 0x0101)
    assert.equal(rtp.destination, `127.0.0.1:${phone.address().port}`)
    rtp.close()
    phone.close()
  })
})
