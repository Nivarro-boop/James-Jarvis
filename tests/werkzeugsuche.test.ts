import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { registerAllTools } from '@main/tools'
import { CORE_TOOLS, declaredTools, getTool } from '@main/tools/registry'
import { searchTools } from '@main/tools/impl/toolSearch'
import { runTool } from '@main/tools/runner'

describe('Werkzeuge nachladen', () => {
  registerAllTools()

  it('deklariert im Sparmodus nur den Kern', () => {
    const names = declaredTools().map((t) => t.name)
    assert.ok(names.includes('tool_search'))
    assert.ok(names.every((n) => CORE_TOOLS.has(n)))
  })

  it('jeder Kernname ist ein echtes Werkzeug', () => {
    // call_me hängt am Linphone-Passwort und fehlt ohne es mit Absicht.
    for (const name of CORE_TOOLS) if (name !== 'call_me') assert.ok(getTool(name), name)
  })

  it('findet Mail-Werkzeuge über Stichworte', () => {
    const found = searchTools('mail posteingang', new Set()).map((t) => t.name)
    assert.ok(found.some((n) => n.startsWith('mail_')), found.join(','))
  })

  it('tool_use ruft das genannte Werkzeug auf', async () => {
    const result = await runTool({
      id: 't1',
      name: 'tool_use',
      args: { name: 'calculate', args_json: '{"expression":"2+3"}' }
    })
    assert.equal(result.name, 'tool_use')
    assert.equal(result.ok, true, result.error ?? '')
  })

  it('meldet kaputtes args_json, statt zu werfen', async () => {
    const result = await runTool({ id: 't2', name: 'tool_use', args: { name: 'calculate', args_json: '{' } })
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /JSON/)
  })
})

describe('Fachabschnitte nachladen', async () => {
  const { systemPromptDe, guidesForTools } = await import('@shared/prompts/system.de')

  it('lässt im Sparmodus die Fachabschnitte weg, behält Musik und Unumkehrbares', () => {
    const lazy = systemPromptDe('jarvis', true)
    assert.ok(lazy.length < systemPromptDe('jarvis').length - 3000)
    assert.ok(!lazy.includes('## Termine'))
    assert.ok(lazy.includes('## Musik'))
    assert.ok(lazy.includes('## Bevor du etwas Unumkehrbares tust'))
  })

  it('liefert den Abschnitt mit dem passenden Werkzeug', () => {
    assert.match(guidesForTools(['calendar_agenda']), /## Termine/)
    assert.equal(guidesForTools(['weather']), '')
  })

  it('nennt den Nutzer nicht beim Projektnamen', () => {
    assert.ok(!systemPromptDe('jarvis').includes('Void'))
    assert.ok(!systemPromptDe('sachlich').includes('Void'))
  })
})
