import assert from 'node:assert/strict'
import { it } from 'node:test'
import { z } from 'zod'
import { allTools, register, unregisterGroup, type ToolDefinition } from '@main/tools/registry'
import { searchTools } from '@main/tools/impl/toolSearch'

function definition(name: string, description: string): ToolDefinition {
  return { name, group: 'web', description, schema: z.object({}), execute: async () => undefined }
}

it('refreshes normalized tool metadata and never retains removed, replaced or excluded tools', () => {
  const tool = definition('cache_lookup', 'Wetter ansehen')
  register(tool)
  try {
    assert.equal(searchTools('Wetter', new Set())[0], tool)
    assert.deepEqual(searchTools('Kalender', new Set()), [])
    tool.description = 'Kalender lesen'
    assert.equal(searchTools('Kalender', new Set())[0], tool)
    assert.deepEqual(searchTools('Wetter', new Set()), [])
    const exclude = new Set([tool.name])
    assert.deepEqual(searchTools('Kalender', exclude), [])
    exclude.clear()
    assert.equal(searchTools('Kalender', exclude)[0], tool)
    unregisterGroup('web')
    assert.deepEqual(searchTools('Kalender', exclude), [])
    const replacement = definition(tool.name, 'Kontakte finden')
    register(replacement)
    assert.equal(searchTools('Kontakte', exclude)[0], replacement)
    assert.deepEqual(searchTools('Kalender', exclude), [])
  } finally { unregisterGroup('web') }
})

it('retains weighted ranking, stable ties, exclusions and empty query behavior', () => {
  for (let n = 0; n < 120; n++) register(definition(`connector_${n % 3 === 0 ? 'Kalender' : 'Files'}_${n}`,
    `${n % 2 ? 'Kalender lesen' : 'Dateien suchen'} ${n % 5 ? 'Plugin' : 'Termine'}`))
  const exclude = new Set(['connector_Kalender_0', 'connector_Files_1'])
  const reference = (query: string): string[] => {
    const words = query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(w => w.length > 1)
    return allTools().filter(tool => !exclude.has(tool.name)).map(tool => {
      const name = tool.name.toLowerCase()
      const text = `${name} ${tool.group} ${tool.description}`.toLowerCase()
      return { name: tool.name, score: words.reduce((total, word) => total + (name.includes(word) ? 3 : text.includes(word) ? 1 : 0), 0) }
    }).filter(tool => tool.score > 0).sort((a, b) => b.score - a.score).slice(0, 5).map(tool => tool.name)
  }
  try {
    for (const query of ['Kalender lesen', 'Termine Plugin', 'Dateien suchen', 'FILES', '???', 'a', 'Kalender Kalender']) {
      assert.deepEqual(searchTools(query, exclude).map(tool => tool.name), reference(query))
      assert.deepEqual(searchTools(query, exclude).map(tool => tool.name), reference(query))
    }
  } finally { unregisterGroup('web') }
})
