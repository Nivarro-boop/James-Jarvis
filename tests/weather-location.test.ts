import { it } from 'node:test'
import assert from 'node:assert/strict'
import { app } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getSettings, setSettings } from '@main/store/settings'
import { utilityTools } from '@main/tools/impl/utility'

it('verwendet Standardort, respektiert expliziten Ort und fragt bei fehlendem Standort', async t => {
  const root = mkdtempSync(join(tmpdir(), 'james-weather-'))
  t.mock.method(app, 'getPath', () => root)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: any) => {
    requests.push(String(url))
    return new Response(JSON.stringify(String(url).includes('geocoding')
      ? { results: [{ name: 'Testort', latitude: 48, longitude: 16 }] }
      : { current: { temperature_2m: 20, apparent_temperature: 20, weather_code: 0, wind_speed_10m: 5, relative_humidity_2m: 50 }, daily: { time: ['2026-10-08'], weather_code: [0], temperature_2m_max: [20], temperature_2m_min: [10], precipitation_probability_max: [5] }, hourly: { time: [], temperature_2m: [], precipitation_probability: [], wind_speed_10m: [] } }))
  })
  const tool = utilityTools.find(tool => tool.name === 'weather')!
  const before = getSettings().homeLocation
  setSettings({ homeLocation: 'Wien' })
  await tool.execute(tool.schema.parse({}), {} as any)
  assert.match(requests[0], /name=Wien/)
  assert.match(requests[1], /forecast_days=7/)
  requests.length = 0
  await tool.execute(tool.schema.parse({ place: 'Berlin', days: 2 }), {} as any)
  assert.match(requests[0], /name=Berlin/)
  setSettings({ homeLocation: '' })
  await assert.rejects(() => tool.execute(tool.schema.parse({}), {} as any), /Standardstandort/)
  setSettings({ homeLocation: before })
})
