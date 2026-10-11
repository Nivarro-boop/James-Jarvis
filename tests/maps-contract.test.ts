import { after, before, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { app } from 'electron'
import { z } from 'zod'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { closeDb } from '@main/db'
import type { DisplayCard, LonLat, WeatherCard } from '@shared/types'
import { ROUTE_PATH_MAX } from '@shared/types'
import { clock, formatDistance, formatDuration, spokenDistance, spokenDuration } from '@shared/format'
import { boundsOf, distanceM, osmPlaceUrl, osmRouteUrl, simplifyPath } from '@shared/geo'
import { isValidTile, readTile } from '@main/maps/tiles'
import { mapsUserAgent } from '@main/maps/net'
import { getSettings, setSettings } from '@main/store/settings'
import { cachedResult, clearResultCache, rememberResult } from '@main/agent/tokenSaver'
import { utilityTools } from '@main/tools/impl/utility'
import { placeTools } from '@main/tools/impl/places'

/**
 * Der gemeinsame Vertrag für Karten, Ortssuche, Routen und Antwortkarten:
 * Formatierung, Geometrie, Kachelprüfung und der Weg einer Karte durch den
 * Runner — auch aus dem Sparmodus-Zwischenspeicher.
 */

// Einstellungen und Datenbank landen in einem eigenen Ordner, nicht im Profil.
const root = mkdtempSync(join(tmpdir(), 'james-maps-'))
before(() => {
  mock.method(app, 'getPath', () => root)
})
after(() => {
  closeDb()
  mock.restoreAll()
  assert.ok(root.startsWith(join(tmpdir(), 'james-maps-')))
  rmSync(root, { recursive: true, force: true })
})

describe('Entfernung und Dauer', () => {
  it('sagt sie so, wie man sie spricht', () => {
    assert.equal(spokenDuration(30), 'eine Minute')
    assert.equal(spokenDuration(1500), '25 Minuten')
    assert.equal(spokenDuration(3600), '1 Stunde')
    assert.equal(spokenDuration(3900), '1 Stunde 5 Minuten')
    assert.equal(spokenDuration(9000), '2 Stunden 30 Minuten')
    assert.equal(spokenDistance(347), '350 Meter')
    assert.equal(spokenDistance(2440), '2,4 Kilometer')
    assert.equal(spokenDistance(14230), '14 Kilometer')
    // An den Rundungsgrenzen: nicht „1000 Meter" und nicht „10,0 Kilometer".
    assert.equal(spokenDistance(996), '1,0 Kilometer')
    assert.equal(spokenDistance(9960), '10 Kilometer')
  })

  it('schreibt sie knapp für die Karte, mit denselben Grenzen', () => {
    assert.equal(formatDistance(347), '350 m')
    assert.equal(formatDistance(4), '10 m')
    assert.equal(formatDistance(996), '1,0 km')
    assert.equal(formatDistance(2440), '2,4 km')
    assert.equal(formatDistance(9960), '10 km')
    assert.equal(formatDistance(1_234_000), '1234 km')
    assert.equal(formatDuration(20), '1 min')
    assert.equal(formatDuration(1500), '25 min')
    assert.equal(formatDuration(3600), '1 h')
    assert.equal(formatDuration(3900), '1 h 5 min')
  })

  it('zeigt die Uhrzeit, auch in fremder Zone und ohne zu werfen', () => {
    const ms = Date.UTC(2026, 9, 9, 12, 5)
    assert.equal(clock(ms, 'UTC'), '12:05')
    assert.equal(clock(ms, 'Europe/Vienna'), '14:05')
    assert.match(clock(ms, 'Nirgendwo/Gibtsnicht'), /^\d\d:\d\d$/)
  })
})

describe('Geometrie', () => {
  it('rechnet die Luftlinie Wien–Graz', () => {
    const km = distanceM({ lat: 48.2083, lon: 16.3725 }, { lat: 47.0707, lon: 15.4395 }) / 1000
    assert.ok(km > 140 && km < 150, String(km))
  })

  it('nimmt Punkte und Linien in denselben Ausschnitt', () => {
    assert.equal(boundsOf([]), null)
    assert.deepEqual(boundsOf([{ lat: 48, lon: 16 }, [15, 47] as LonLat, { lat: 49, lon: 17 }]), {
      south: 47,
      west: 15,
      north: 49,
      east: 17
    })
  })

  it('vereinfacht eine Linie auf die Grenze und behält Enden und Ecken', () => {
    // Eine lange gerade Strecke mit einem scharfen Knick in der Mitte.
    const path: LonLat[] = []
    for (let i = 0; i <= 5000; i++) path.push([16 + i / 10000, 48 + (i === 2500 ? 0.05 : 0)])
    const small = simplifyPath(path)
    assert.ok(small.length <= ROUTE_PATH_MAX)
    assert.deepEqual(small[0], path[0])
    assert.deepEqual(small.at(-1), path.at(-1))
    assert.ok(small.some((p) => p[1] === 48.05), 'der Knick muss bleiben')
    // Reihenfolge bleibt erhalten.
    for (let i = 1; i < small.length; i++) assert.ok(small[i][0] > small[i - 1][0])
    // Kurze Linien bleiben, wie sie sind — als Kopie.
    const short: LonLat[] = [[16, 48], [16.1, 48.1]]
    assert.deepEqual(simplifyPath(short), short)
    assert.notEqual(simplifyPath(short), short)
    assert.equal(simplifyPath(path, 2).length, 2)
  })

  it('baut nur https-Links auf openstreetmap.org', () => {
    assert.equal(osmPlaceUrl({ lat: 48.2083, lon: 16.3725 }), 'https://www.openstreetmap.org/?mlat=48.20830&mlon=16.37250#map=17/48.20830/16.37250')
    const url = osmRouteUrl({ lat: 48.2, lon: 16.37 }, { lat: 47.07, lon: 15.44 }, 'fahrrad')
    assert.ok(url.startsWith('https://www.openstreetmap.org/directions?engine=fossgis_osrm_bike&route='), url)
    assert.ok(url.includes('48.20000%2C16.37000%3B47.07000%2C15.44000'), url)
  })
})

describe('Kacheln und Kartendienste', () => {
  it('lässt nur Kacheln durch, die es geben kann', async () => {
    assert.ok(isValidTile(0, 0, 0))
    assert.ok(isValidTile(14, 16383, 16383))
    assert.ok(!isValidTile(15, 0, 0), 'über Zoom 14 vergrößert der Zeichner')
    assert.ok(!isValidTile(2, 4, 0))
    assert.ok(!isValidTile(2, -1, 0))
    assert.ok(!isValidTile(2, 1.5, 0))
    assert.ok(!isValidTile(Number.NaN, 0, 0))
    assert.equal(await readTile(3, 99, 0), null)
  })

  it('nennt sich ehrlich, mit Kontaktadresse', () => {
    assert.match(mapsUserAgent(), /^James-Jarvis\/\S+ \(\+https:\/\/github\.com\/Nivarro-boop\/James-Jarvis\)$/)
  })

  it('kennt keine Spur eines kommerziellen Kartendienstes mehr', () => {
    const text = JSON.stringify(placeTools.map((tool) => [tool.name, tool.description]))
    assert.doesNotMatch(text, /mapbox|token/i)
    assert.deepEqual(placeTools.map((tool) => tool.name), ['ort_suchen', 'route_berechnen'])
  })
})

describe('Antwortkarten', () => {
  const forecast = {
    current: { time: '2026-10-09T10:00', temperature_2m: 20, apparent_temperature: 19, weather_code: 2, wind_speed_10m: 5, relative_humidity_2m: 50 },
    daily: {
      time: ['2026-10-09', '2026-10-10', '2026-10-11'],
      weather_code: [2, 61, 0],
      temperature_2m_max: [20, 15, 18],
      temperature_2m_min: [10, 9, 8],
      precipitation_probability_max: [5, 80, null]
    },
    hourly: {
      time: ['2026-10-09T09:00', '2026-10-09T10:00', '2026-10-09T11:00'],
      temperature_2m: [18, 20, 21],
      precipitation_probability: [0, 10, null],
      wind_speed_10m: [4, 5, 6],
      weather_code: [1, 2, 3]
    }
  }

  it('das Wetter geht über ctx.show, mit der ganzen Woche, und das Modell bekommt nur seine Tage', async (t) => {
    t.mock.method(globalThis, 'fetch', async (url: unknown) =>
      new Response(JSON.stringify(String(url).includes('geocoding')
        ? { results: [{ name: 'Wien', latitude: 48.2083, longitude: 16.3725, admin1: 'Wien' }] }
        : forecast))
    )
    const shown: DisplayCard[] = []
    const ctx = { show: (card: DisplayCard) => (shown.push(card), true), signal: new AbortController().signal } as any
    const tool = utilityTools.find((each) => each.name === 'weather')!
    const result = (await tool.execute(tool.schema.parse({ place: 'Wien', days: 1 }), ctx)) as any

    assert.equal(shown.length, 1)
    const card = shown[0] as WeatherCard
    assert.equal(card.kind, 'weather')
    assert.ok(card.id.startsWith('weather:'))
    assert.equal(card.place, 'Wien, Wien')
    assert.equal(card.lat, 48.2083)
    assert.equal(card.apparent, 19)
    assert.equal(card.code, 2)
    assert.equal(card.daily.length, 3)
    assert.deepEqual(card.daily[2], { date: '2026-10-11', description: 'klar', code: 0, max: 18, min: 8, rain: 0 })
    // Stunden ab jetzt, nicht die vergangene.
    assert.deepEqual(card.hourly.map((h) => h.time), ['2026-10-09T10:00', '2026-10-09T11:00'])
    assert.equal(card.hourly[1].rain, 0)

    assert.equal(result.vorhersage.length, 1)
    // Koordinaten und Stundenwerte gehen nur an die Karte.
    assert.doesNotMatch(JSON.stringify(result), /"lat"|hourly|48\.2/)
  })

  it('der Sparmodus legt die Karten mit dem Ergebnis ab und gibt sie zurück', (t) => {
    const before = getSettings().tokenSaver
    t.after(() => { setSettings({ tokenSaver: before }); clearResultCache() })
    setSettings({ tokenSaver: { ...before, enabled: true, cacheTtlSec: 60 } })
    clearResultCache()
    const card = { kind: 'sources', id: 'sources:x', query: 'x', sources: [] } as DisplayCard
    rememberResult('weather', { place: 'Wien' }, { ort: 'Wien' }, [card])
    assert.deepEqual(cachedResult('weather', { place: 'Wien' }), { value: { ort: 'Wien' }, cards: [card] })
    assert.equal(cachedResult('weather', { place: 'Graz' }), undefined)
    rememberResult('calculate', {}, 'x', [card])
    assert.equal(cachedResult('calculate', {}), undefined, 'nur Werkzeuge ohne Nebenwirkung')
  })

  it('der Runner stempelt Karten und schickt sie bei einem Treffer im Zwischenspeicher erneut', async (t) => {
    // Der Runner mit allem, was dazugehört — nur der Weg ins Fenster ist
    // ersetzt, damit sich zählen lässt, was dort ankommt.
    const sent: [string, any][] = []
    ;(globalThis as any).__jamesSent = sent
    const bundle = await build({
      stdin: {
        contents: [
          "export { runTool } from './runner'",
          "export { register, defineTool, unregisterBuiltins } from './registry'",
          "export { setSettings, getSettings } from '../store/settings'",
          "export { clearResultCache } from '../agent/tokenSaver'",
          "export { closeDb } from '../db'"
        ].join('\n'),
        resolveDir: resolve('src/main/tools'),
        loader: 'ts'
      },
      bundle: true,
      write: false,
      format: 'cjs',
      platform: 'node',
      target: 'node22',
      packages: 'external',
      logLevel: 'silent',
      alias: { '@shared': resolve('src/shared'), '@main': resolve('src/main') },
      plugins: [{
        name: 'emit-fixture',
        setup(b) {
          b.onResolve({ filter: /(^|\/)ipc\/emit$|^\.\/emit$/ }, () => ({ path: 'emit', namespace: 'fixture' }))
          b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            loader: 'js',
            contents:
              'const sent = globalThis.__jamesSent;' +
              'export const sendToCrystal = (c, p) => { sent.push([c, p]); return true };' +
              'export const sendToSettings = () => true; export const broadcast = () => {};' +
              'export const speak = () => true; export const crystalVisible = () => true;'
          }))
        }
      }]
    })
    const dir = join(resolve('out'), 'tests', 'fixtures')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `runner-cards-${process.pid}.cjs`)
    writeFileSync(file, bundle.outputFiles[0].text)
    const runner = createRequire(file)(file)
    t.after(() => {
      runner.unregisterBuiltins()
      runner.closeDb()
      rmSync(file, { force: true })
    })

    runner.setSettings({ confirmActions: false, tokenSaver: { ...runner.getSettings().tokenSaver, enabled: true, cacheTtlSec: 60 } })
    runner.clearResultCache()
    let runs = 0
    runner.register(runner.defineTool({
      name: 'weather',
      group: 'web',
      description: 'Testwetter',
      schema: z.object({ place: z.string() }),
      async execute({ place }: { place: string }, ctx: any) {
        runs++
        const visible = ctx.show({ kind: 'sources', id: `w:${place}`, query: place, sources: [] })
        ctx.show({ kind: 'sources', id: `w:${place}`, query: `${place}!`, sources: [] })
        return { ort: place, sichtbar: visible }
      }
    }))

    const first = await runner.runTool({ id: '1', name: 'weather', args: { place: 'Wien' } })
    assert.equal(first.ok, true)
    assert.equal(first.result.sichtbar, true)
    const cards = sent.filter(([channel]) => channel === 'display:card').map(([, card]) => card)
    assert.equal(cards.length, 2)
    assert.equal(cards[0].source, 'weather')
    assert.equal(typeof cards[0].at, 'number')

    sent.length = 0
    const second = await runner.runTool({ id: '2', name: 'weather', args: { place: 'Wien' } })
    assert.equal(second.ok, true)
    assert.equal(runs, 1, 'der zweite Aufruf kommt aus dem Zwischenspeicher')
    const again = sent.filter(([channel]) => channel === 'display:card').map(([, card]) => card)
    // Nur die letzte Fassung je Id, frisch gestempelt.
    assert.equal(again.length, 1)
    assert.equal(again[0].query, 'Wien!')
    assert.ok(again[0].at >= cards[1].at)
  })
})
