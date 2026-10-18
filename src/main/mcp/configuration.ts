import { createHash } from 'node:crypto'
import { ENV_NAME } from '@shared/mcp'
import type { McpServerConfig } from '@shared/types'

/** The SDK supplies a small OS allowlist; unrelated application secrets stay out. */
export function mcpEnvironment(
  config: McpServerConfig,
  inherited: Record<string, string>,
  readSecret: (name: string) => string | null | undefined,
  caseInsensitive = process.platform === 'win32'
): Record<string, string> {
  const environment = { ...inherited }
  const assign = (name: string, value: string): void => {
    if (!ENV_NAME.test(name) || typeof value !== 'string' || value.includes('\0')) {
      throw new Error(`Ungültige Umgebungsvariable für ${config.name}: ${name}`)
    }
    if (caseInsensitive) {
      const previous = Object.keys(environment).find(key => key.toLowerCase() === name.toLowerCase())
      if (previous) delete environment[previous]
    }
    environment[name] = value
  }
  for (const [name, value] of Object.entries(config.env ?? {})) assign(name, value)
  for (const name of config.secretEnv ?? []) {
    const value = readSecret(name)
    if (value) assign(name, value)
  }
  for (const [name, value] of Object.entries(environment)) {
    if (!(config.secretEnv ?? []).includes(name)) environment[name] = expandMcpEnvironment(value, environment)
  }
  return environment
}

export function expandMcpEnvironment(value: string, environment: Record<string, string>): string {
  return value.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name: string) => {
    const match = Object.keys(environment).find(key => key.toLowerCase() === name.toLowerCase())
    return match ? environment[match] : whole
  })
}

/** Preserve existing ordinary names; hash any lossy normalization or truncation. */
export function mcpToolName(serverId: string, remoteName: string): string {
  const raw = `mcp_${serverId}_${remoteName}`
  const normalized = raw.replace(/[^a-zA-Z0-9_]/g, '_')
  if (normalized === raw && normalized.length <= 63) return normalized
  return `${normalized.slice(0, 50)}_${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`
}
