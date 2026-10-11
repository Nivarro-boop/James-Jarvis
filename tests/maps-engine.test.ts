import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { solveRoute } from '@main/maps/routing'
import type { OsmElement } from '@main/maps/net'
import { decodeTile, project } from '@shared/mapVector'
const nodes: OsmElement[] = [{ type: 'node', id: 1, lat: 48, lon: 16 }, { type: 'node', id: 2, lat: 48, lon: 16.01 }, { type: 'node', id: 3, lat: 48.005, lon: 16.005 }]
const from = { lat: 48, lon: 16 }, to = { lat: 48, lon: 16.01 }
const way = (id: number, ids: number[], tags: Record<string, string>): OsmElement => ({ type: 'way', id, nodes: ids, tags })
describe('Eigene Wegsuche', () => {
  it('wählt für Autos den schnelleren Umweg und zu Fuß den kürzeren Weg', () => {
    const network = [...nodes, way(10, [1, 2], { highway: 'living_street', name: 'Langsam' }), way(11, [1, 3, 2], { highway: 'primary', name: 'Schnell' })]
    const car = solveRoute(network, from, to, 'auto'), foot = solveRoute(network, from, to, 'zu_fuss')
    assert.equal(car.path.length, 3); assert.equal(foot.path.length, 2)
    assert.ok(car.distanceM > foot.distanceM); assert.equal(car.summary, 'Schnell')
  })
  it('beachtet Einbahnstraßen und ihre Fahrradausnahme', () => {
    const network = [...nodes, way(10, [1, 2], { highway: 'residential', oneway: 'yes', 'oneway:bicycle': 'no' })]
    assert.throws(() => solveRoute(network, to, from, 'auto'), /kein durchgehender/)
    assert.equal(solveRoute(network, to, from, 'fahrrad').path.length, 2)
    assert.equal(solveRoute(network, to, from, 'zu_fuss').path.length, 2)
  })
  it('lässt gesperrte Wege aus und berücksichtigt Fußgängerzugang', () => {
    const network = [...nodes, way(10, [1, 2], { highway: 'residential', access: 'private', foot: 'yes' })]
    assert.throws(() => solveRoute(network, from, to, 'auto'))
    assert.ok(solveRoute(network, from, to, 'zu_fuss').distanceM > 700)
  })
  it('bricht ab und meldet getrennte Netze', () => {
    const controller = new AbortController(); controller.abort()
    assert.throws(() => solveRoute([...nodes, way(10, [1, 2], { highway: 'residential' })], from, to, 'auto', controller.signal), /abort/i)
    assert.throws(() => solveRoute(nodes, from, to, 'auto'))
  })
})
describe('Vektorkacheln', () => {
  it('dekodiert eine Linie mit vorzeichenbehafteten Deltas', () => {
    const geom = [9, 20, 40, 10, 9, 6]
    const feature = [24, 2, 34, geom.length, ...geom]
    const name = [...new TextEncoder().encode('waterway')]
    const layer = [10, name.length, ...name, 18, feature.length, ...feature, 40, 128, 32]
    const shapes = decodeTile(new Uint8Array([26, layer.length, ...layer]))
    assert.deepEqual(shapes, [{ layer: 'waterway', extent: 4096, type: 2, paths: [[[10, 20], [5, 23]]] }])
  })
  it('weist abgeschnittene Daten zurück und begrenzt Mercator an den Polen', () => {
    assert.throws(() => decodeTile(new Uint8Array([26, 100, 1])))
    assert.deepEqual(project(0, 0), [0.5, 0.5]); assert.ok(project(0, 90).every(Number.isFinite))
  })
})


