import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { MusicDevice } from '@shared/types'
import { matchDevice } from '@main/music'
import { toAppLink } from '@main/music/appleMusic'
import { matchPlaylist, __internals as spotifyInternals, type SpotifyHit } from '@main/music/spotify'

/**
 * Die Entscheidungen der Musikschicht, ohne Netz und ohne Windows.
 *
 * Drei Stellen, an denen ein Fehler nicht abstürzt, sondern etwas Falsches
 * tut: Welches Gerät ist gemeint, welcher Fehler von Spotify heißt was, und
 * welcher Link landet in der App statt im Browser. Alle drei fallen im Betrieb
 * erst auf, wenn Musik im falschen Zimmer läuft oder gar nicht.
 */

function device(name: string, kind: MusicDevice['kind'], type = 'Lautsprecher'): MusicDevice {
  return { id: `${kind}:${name}`, name, kind, type, active: false, volumePercent: null }
}

const DEVICES: MusicDevice[] = [
  device('Echo Dot Wohnzimmer', 'connect'),
  device('Annas iPhone', 'connect', 'Telefon'),
  device('Lautsprecher (Razer BlackShark V2)', 'output'),
  device('S27C36x (NVIDIA High Definition Audio)', 'output')
]

describe('Welches Gerät gemeint ist', () => {
  it('nimmt den genauen Namen', () => {
    const match = matchDevice(DEVICES, 'Echo Dot Wohnzimmer')
    assert.equal(match.found, true)
    assert.equal(match.found && match.device.name, 'Echo Dot Wohnzimmer')
  })

  it('ignoriert Groß- und Kleinschreibung', () => {
    const match = matchDevice(DEVICES, 'echo dot wohnzimmer')
    assert.equal(match.found && match.device.kind, 'connect')
  })

  it('findet über einen Teil des Namens — niemand sagt den vollen', () => {
    const match = matchDevice(DEVICES, 'echo')
    assert.equal(match.found && match.device.name, 'Echo Dot Wohnzimmer')
  })

  it('findet auch, wenn die Wörter in anderer Reihenfolge kommen', () => {
    const match = matchDevice(DEVICES, 'wohnzimmer echo')
    assert.equal(match.found && match.device.name, 'Echo Dot Wohnzimmer')
  })

  it('sucht auch in der Geräteart', () => {
    const match = matchDevice(DEVICES, 'telefon')
    assert.equal(match.found && match.device.name, 'Annas iPhone')
  })

  /*
   * Die Stufen greifen der Reihe nach, und die genauere gewinnt. „Lautsprecher"
   * steht im Namen genau eines Geräts — dass zwei andere ebenfalls
   * Lautsprecher *sind*, macht daraus keine offene Frage. Der Name ist das,
   * was Windows anzeigt und was der Nutzer vor Augen hat.
   */
  it('lässt den Namenstreffer gegen die bloße Geräteart gewinnen', () => {
    const match = matchDevice(DEVICES, 'lautsprecher')
    assert.equal(match.found, true)
    assert.equal(match.found && match.device.name, 'Lautsprecher (Razer BlackShark V2)')
  })

  it('nimmt den genauen Namen, auch wenn ein längerer ihn enthält', () => {
    const doubled = [device('Küche', 'connect'), device('Küche Fenster', 'output')]
    const match = matchDevice(doubled, 'küche')
    assert.equal(match.found, true)
    assert.equal(match.found && match.device.name, 'Küche')
  })

  /*
   * Der eigentliche Punkt: Zwei Echos, beide passen gleich gut, keiner genau.
   * Musik im falschen Zimmer fällt frühestens auf, wenn sich jemand wundert —
   * zurückgefragt wird deshalb, statt zu raten.
   */
  it('rät nicht, wenn zwei verschiedene Geräte gleich gut passen', () => {
    const twoEchos = [device('Echo Dot Küche', 'connect'), device('Echo Dot Bad', 'connect')]
    const match = matchDevice(twoEchos, 'echo dot')
    assert.equal(match.found, false)
    assert.deepEqual(
      !match.found && match.ambiguous.map((d) => d.name),
      ['Echo Dot Küche', 'Echo Dot Bad']
    )
  })

  /*
   * Derselbe Lautsprecher steht regelmäßig in beiden Listen — einmal als
   * Connect-Gerät, einmal als gekoppelter Bluetooth-Ausgang. Das ist keine
   * offene Frage, sondern zwei Wege zum selben Ziel, und Connect ist der
   * bessere: Er lässt James' Stimme, wo sie ist.
   */
  it('hält denselben Namen in beiden Listen nicht für zwei Geräte', () => {
    const both = [device('Echo Dot', 'output'), device('Echo Dot', 'connect')]
    const match = matchDevice(both, 'echo dot')
    assert.equal(match.found, true)
    assert.equal(match.found && match.device.kind, 'connect')
  })

  it('gibt nichts zurück, wenn nichts passt', () => {
    const match = matchDevice(DEVICES, 'badezimmer')
    assert.equal(match.found, false)
    assert.equal(!match.found && match.ambiguous.length, 0)
  })

  it('gibt nichts zurück, wenn gar kein Name genannt wurde', () => {
    const match = matchDevice(DEVICES, '   ')
    assert.equal(match.found, false)
  })

  it('kommt mit einer leeren Liste klar', () => {
    const match = matchDevice([], 'echo')
    assert.equal(match.found, false)
  })
})

describe('Spotifys Fehler in verständliche Sätze', () => {
  const { friendlyError } = spotifyInternals

  it('erklärt beim fehlenden Gerät, was zu tun ist', () => {
    const text = friendlyError(404, { error: { reason: 'NO_ACTIVE_DEVICE' } })
    assert.match(text, /kein aktives Gerät/)
    assert.match(text, /einmal auf dem gewünschten Gerät starten/)
  })

  it('nennt Premium beim Namen statt einen Statuscode', () => {
    const text = friendlyError(403, { error: { reason: 'PREMIUM_REQUIRED' } })
    assert.match(text, /Premium/)
    assert.doesNotMatch(text, /403/)
  })

  // Ein 403 ohne Grund ist bei Spotify praktisch immer dasselbe: kein Premium.
  it('behandelt auch einen 403 ohne Begründung als Premium-Frage', () => {
    assert.match(friendlyError(403, {}), /Premium/)
  })

  /*
   * Aber eben nicht jeder. „Zurück" am Anfang einer Playlist kommt ebenfalls
   * als 403 zurück — und dem Nutzer, der Premium hat, vorzulesen, er brauche
   * Premium, ist die eine Antwort, die er sicher nicht gebrauchen kann.
   */
  it('hält eine Einschränkung nicht für eine Premium-Frage', () => {
    const text = friendlyError(403, {
      error: { reason: 'UNKNOWN', message: 'Player command failed: Restriction violated' }
    })
    assert.doesNotMatch(text, /Premium/)
    assert.match(text, /kein Zurück/)
  })

  it('schickt bei abgelaufener Anmeldung in die Einstellungen', () => {
    assert.match(friendlyError(401, {}), /Einstellungen/)
  })

  it('sagt beim Bremsen, dass Warten hilft', () => {
    assert.match(friendlyError(429, {}), /Minute/)
  })

  it('bleibt bei Unbekanntem trotzdem ein Satz', () => {
    const text = friendlyError(500, { error: { message: 'Server error' } })
    assert.match(text, /^Spotify meldet einen Fehler \(500\)/)
    assert.match(text, /\.$/)
  })
})

describe('Die eigene Playlist finden', () => {
  const own = [
    playlist('Chill'),
    playlist('Chill Abends Winter'),
    playlist('Autofahrt lang'),
    playlist('Sport')
  ]

  function playlist(name: string): SpotifyHit {
    return { uri: `spotify:playlist:${name}`, name, by: 'Void', kind: 'playlist' }
  }

  it('nimmt den genauen Namen, auch wenn ein längerer ihn enthält', () => {
    assert.equal(matchPlaylist(own, 'Chill')?.name, 'Chill')
  })

  it('findet über einen Teil des Namens', () => {
    assert.equal(matchPlaylist(own, 'autofahrt')?.name, 'Autofahrt lang')
  })

  /*
   * Bei mehreren Teiltreffern gewinnt der kürzeste. „Winter" steckt nur in
   * einer, aber wer „Chill Abends" sagt, meint nicht die kürzeste — deshalb
   * greift davor die Wortprüfung.
   */
  it('nimmt bei mehreren Teiltreffern den kürzesten', () => {
    const doubled = [playlist('Ruhig lange Fassung'), playlist('Ruhig')]
    assert.equal(matchPlaylist(doubled, 'ruhig')?.name, 'Ruhig')
  })

  it('findet auch, wenn die Wörter in anderer Reihenfolge kommen', () => {
    assert.equal(matchPlaylist(own, 'winter chill')?.name, 'Chill Abends Winter')
  })

  it('gibt nichts zurück, wenn nichts passt', () => {
    assert.equal(matchPlaylist(own, 'weihnachten'), null)
  })

  it('gibt nichts zurück, wenn gar kein Name genannt wurde', () => {
    assert.equal(matchPlaylist(own, '  '), null)
  })

  it('kommt mit einer leeren Liste klar', () => {
    assert.equal(matchPlaylist([], 'chill'), null)
  })
})

describe('Der Link in die Apple-Music-App', () => {
  /*
   * Nur das Schema wird getauscht. Die Webadresse ginge im Browser auf und
   * startete dort den Web-Player — der spielt zwar, aber in einem Fenster, das
   * niemand angefordert hat, und meldet sich nicht zuverlässig bei den
   * Medientasten von Windows an.
   */
  it('macht aus der Webadresse einen App-Aufruf', () => {
    assert.equal(
      toAppLink('https://music.apple.com/at/album/nevermind/1440783617?i=1440783625'),
      'music://music.apple.com/at/album/nevermind/1440783617?i=1440783625'
    )
  })

  it('nimmt auch http', () => {
    assert.equal(toAppLink('http://music.apple.com/at/artist/nirvana/112018'), 'music://music.apple.com/at/artist/nirvana/112018')
  })

  it('lässt einen schon fertigen App-Aufruf in Ruhe', () => {
    assert.equal(toAppLink('music://music.apple.com/at/search?term=x'), 'music://music.apple.com/at/search?term=x')
  })
})
