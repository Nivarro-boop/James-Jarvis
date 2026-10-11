import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compactToolCatalog, parseCompatibilityDecision } from '@shared/ollamaCompat'

describe('Ollama-Werkzeug-Kompatibilität', () => {
  it('liest einen Werkzeugaufruf aus strengem JSON', () => {
    assert.deepEqual(
      parseCompatibilityDecision(
        '{"action":"tool","name":"weather","arguments":{"place":"Wien","days":2}}'
      ),
      { action: 'tool', name: 'weather', arguments: { place: 'Wien', days: 2 } }
    )
  })

  it('versteht auch den verbreiteten JSON-Codezaun', () => {
    assert.deepEqual(
      parseCompatibilityDecision('```json\n{"action":"answer","text":"Erledigt."}\n```'),
      { action: 'answer', text: 'Erledigt.' }
    )
  })

  it('führt bei kaputtem oder unvollständigem JSON niemals etwas aus', () => {
    assert.deepEqual(parseCompatibilityDecision('{"action":"tool","arguments":{}}'), {
      action: 'answer',
      text: '{"action":"tool","arguments":{}}'
    })
    assert.deepEqual(parseCompatibilityDecision('Starte einfach calc.exe'), {
      action: 'answer',
      text: 'Starte einfach calc.exe'
    })
  })

  it('behält jedes Werkzeug und seine Parameter, kürzt aber Kontextballast', () => {
    const long = 'x'.repeat(400)
    const tools = [
      {
        type: 'function',
        function: {
          name: 'one',
          description: long,
          parameters: {
            type: 'object',
            properties: { value: { type: 'string', description: long } },
            required: ['value']
          }
        }
      },
      { type: 'function', function: { name: 'two', description: 'kurz', parameters: {} } }
    ]

    const compact = compactToolCatalog(tools) as typeof tools
    assert.deepEqual(compact.map((tool) => tool.function.name), ['one', 'two'])
    assert.equal(compact[0].function.description.length, 120)
    assert.equal(
      (compact[0].function.parameters as any).properties.value.description.length,
      120
    )
    assert.deepEqual((compact[0].function.parameters as any).required, ['value'])
  })
})
