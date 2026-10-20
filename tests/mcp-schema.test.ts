import { strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { McpServerConfig } from '@shared/types'
import { serverToolDefinitions } from '@main/mcp/client'

function schemaFor(inputSchema: unknown) {
  const [definition] = serverToolDefinitions(
    { id: 'schema-test', name: 'Schema test' } as McpServerConfig,
    {} as never,
    [{ name: 'validate', inputSchema } as Tool]
  )
  return definition.schema
}

describe('MCP input schema nullable types', () => {
  it('accepts null and strings for required nullable string properties', () => {
    const schema = schemaFor({
      type: 'object',
      properties: { value: { type: ['string', 'null'] } },
      required: ['value']
    })

    strictEqual(schema.safeParse({ value: null }).success, true)
    strictEqual(schema.safeParse({ value: 'text' }).success, true)
    strictEqual(schema.safeParse({}).success, false)
  })

  it('allows omitted optional nullable properties and also accepts null', () => {
    const schema = schemaFor({
      type: 'object',
      properties: { value: { type: ['string', 'null'] } }
    })

    strictEqual(schema.safeParse({}).success, true)
    strictEqual(schema.safeParse({ value: null }).success, true)
    strictEqual(schema.safeParse({ value: 'text' }).success, true)
  })

  it('accepts null for a required nullable number, and integer types remain integral', () => {
    const schema = schemaFor({
      type: 'object',
      properties: {
        amount: { type: ['number', 'null'] },
        count: { type: 'integer' }
      },
      required: ['amount', 'count']
    })

    strictEqual(schema.safeParse({ amount: null, count: 2 }).success, true)
    strictEqual(schema.safeParse({ amount: 1.5, count: 2 }).success, true)
    strictEqual(schema.safeParse({ amount: 1, count: 2.5 }).success, false)
    strictEqual(schema.safeParse({ count: 2 }).success, false)
  })
})
