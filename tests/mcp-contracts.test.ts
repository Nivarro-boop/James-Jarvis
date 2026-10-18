import assert from 'node:assert/strict'
import { it } from 'node:test'
import { exportMcpConfig, parseMcpConfig, resolveMcpHeaders, splitMcpArgs, validateMcpUrl, MCP_PRESETS } from '@shared/mcp'
import { validateSettingsPatch } from '@shared/config/validation'

it('accepts HTTPS/loopback HTTP and rejects protocol tricks and URL credentials', () => {
  for (const url of ['https://example.com/mcp', 'http://localhost:3000/mcp', 'http://127.0.0.1/mcp', 'http://[::1]/mcp']) assert.ok(validateMcpUrl(url))
  for (const url of ['ftp://localhost/mcp', 'file://localhost/C:/a', 'http://example.com', 'https://user:password@example.com/mcp', 'https://example.com/mcp#token', 'https://example.com/mcp?api_key=private']) assert.throws(() => validateMcpUrl(url))
})

it('imports direct remote configs without leaving literal header credentials in settings', () => {
  const [parsed] = parseMcpConfig(JSON.stringify({ url: 'https://example.com/mcp', headers: { Authorization: 'Bearer private-test-token', 'X-Custom': 'second-secret' } }))
  assert.equal(parsed.secrets.MCP_HEADER_AUTHORIZATION, 'Bearer private-test-token')
  const config = { ...parsed, id: 'example', enabled: true, secretEnv: Object.keys(parsed.secrets) }
  const { secrets, ...stored } = config
  validateSettingsPatch({ mcpServers: [stored] })
  assert.doesNotMatch(JSON.stringify(stored), /private-test-token|second-secret/)
  assert.deepEqual(resolveMcpHeaders(stored, name => secrets[name]), { Authorization: 'Bearer private-test-token', 'X-Custom': 'second-secret' })
  assert.doesNotMatch(exportMcpConfig([stored]), /private-test-token|second-secret/)
})

it('preserves Bearer references, moves ordinary named header credentials to the vault and rejects malformed fields', () => {
  const [parsed] = parseMcpConfig(JSON.stringify({ url: 'https://example.com', env: { CUSTOM: 'private' }, headers: { Authorization: 'Bearer ${CUSTOM}' } }))
  assert.deepEqual(parsed.env, {})
  assert.equal(parsed.secrets.CUSTOM, 'private')
  assert.throws(() => resolveMcpHeaders({ headers: parsed.headers, secretEnv: ['CUSTOM'] }, () => 'a\r\nInjected: x'))
  assert.throws(() => resolveMcpHeaders({ headers: { Authorization: 'Bearer visible-secret ${CUSTOM}' }, secretEnv: ['CUSTOM'] }, () => 'private'))
  assert.throws(() => parseMcpConfig('{"command":"node","env":{"BAD":{"nested":true}}}'))
  assert.throws(() => parseMcpConfig('{"url":"https://example.com","headers":{"X-A":"one","x-a":"two"}}'))
})

it('keeps quoted paths, apostrophes, empty arguments and explicit executable paths intact', () => {
  assert.deepEqual(splitMcpArgs('"C:\\Program Files\\node.exe" --root="C:\\Bob\'s Notes" ""'), ['C:\\Program Files\\node.exe', "--root=C:\\Bob's Notes", ''])
  const [quoted] = parseMcpConfig(JSON.stringify({ command: '"C:\\Program Files\\node.exe" "C:\\My Notes\\server.js"' }))
  assert.equal(quoted.command, 'C:\\Program Files\\node.exe')
  assert.deepEqual(quoted.args, ['C:\\My Notes\\server.js'])
  assert.equal(parseMcpConfig(JSON.stringify({ command: 'C:\\Program Files\\node.exe', args: ['server.js'] }))[0].command, 'C:\\Program Files\\node.exe')
  assert.throws(() => splitMcpArgs('"unfinished'))
})

it('catalog templates validate and exporting unusual IDs cannot change the output prototype', () => {
  for (const preset of MCP_PRESETS) validateSettingsPatch({ mcpServers: [{ id: preset.id, name: preset.name, enabled: true, command: preset.command, args: preset.args, url: preset.url, headers: preset.headers, secretEnv: preset.secretEnv }] })
  const exported = JSON.parse(exportMcpConfig([{ id: '__proto__', name: 'Test', enabled: false, command: 'node', args: [] }]))
  assert.ok(Object.hasOwn(exported.mcpServers, '__proto__'))
})
