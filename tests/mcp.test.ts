import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isSecretEnvName, parseMcpConfig, uniqueServerId } from '@shared/mcp'

describe('parseMcpConfig', () => {
  it('liest den Block aus der Playwright-Anleitung und ergänzt -y', () => {
    const servers = parseMcpConfig(`{
      "mcpServers": {
        "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] }
      }
    }`)
    deepStrictEqual(servers, [
      { name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp@latest'], env: {}, secrets: {} }
    ])
  })

  it('legt Schlüssel getrennt ab und verwirft Platzhalter', () => {
    const [server] = parseMcpConfig(`{
      "mcpServers": {
        "brave": {
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-brave-search"],
          "env": { "BRAVE_API_KEY": "abc123", "GITHUB_TOKEN": "<YOUR_TOKEN>", "LOG_LEVEL": "info" }
        }
      }
    }`)
    deepStrictEqual(server.secrets, { BRAVE_API_KEY: 'abc123', GITHUB_TOKEN: '' })
    deepStrictEqual(server.env, { LOG_LEVEL: 'info' })
  })

  it('versteht den Inhalt ohne mcpServers, ohne äußere Klammern und einen Einzelserver', () => {
    strictEqual(parseMcpConfig('{ "a": { "command": "node", "args": ["x.js"] } }')[0].name, 'a')
    strictEqual(parseMcpConfig('"a": { "command": "node" },')[0].command, 'node')
    strictEqual(parseMcpConfig('{ "command": "uvx", "args": ["mcp-server-git"] }')[0].command, 'uvx')
  })

  it('teilt einen Befehl mit Argumenten in einem Feld auf', () => {
    const [server] = parseMcpConfig('{ "x": { "command": "npx -y paket --flag" } }')
    strictEqual(server.command, 'npx')
    deepStrictEqual(server.args, ['-y', 'paket', '--flag'])
  })

  it('nimmt ferne Server über https an', () => {
    const [server] = parseMcpConfig('{ "mcpServers": { "higgsfield": { "url": "https://mcp.higgsfield.ai/mcp" } } }')
    strictEqual(server.url, 'https://mcp.higgsfield.ai/mcp')
    strictEqual(server.command, '')
  })

  it('lehnt SSE, http, und kaputtes JSON verständlich ab', () => {
    throws(() => parseMcpConfig('{ "r": { "type": "sse", "url": "https://x.example" } }'), /SSE/)
    throws(() => parseMcpConfig('{ "r": { "url": "http://x.example" } }'), /https/)
    throws(() => parseMcpConfig('{ nicht json'), /kein gültiges JSON/)
    throws(() => parseMcpConfig(''), /noch nichts/)
  })
})

describe('Hilfen', () => {
  it('erkennt Schlüsselnamen', () => {
    strictEqual(isSecretEnvName('OPENAI_API_KEY'), true)
    strictEqual(isSecretEnvName('GITHUB_PERSONAL_ACCESS_TOKEN'), true)
    strictEqual(isSecretEnvName('LOG_LEVEL'), false)
  })

  it('vergibt freie Kennungen', () => {
    const existing = [{ id: 'playwright', name: 'P', enabled: true, command: 'npx', args: [] }]
    strictEqual(uniqueServerId('Playwright', existing), 'playwright2')
  })
})
