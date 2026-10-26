import { DEFAULT_SETTINGS } from './defaults'

/** Validate partial updates and saved settings before they enter live services. */
export function validateSettingsPatch(patch: unknown): void {
  const visit = (value: unknown, template: unknown, path: string): void => {
    if (value === undefined) return
    const bad = (): never => { throw new Error(`Ungültige Einstellung: ${path || 'Einstellungen'}.`) }
    if (template === null) {
      if (value !== null && typeof value !== 'string') bad()
      return
    }
    if (Array.isArray(template)) {
      if (!Array.isArray(value)) return bad()
      if (path === 'pcProfileFolders' || path === 'pcProfileExcludedFolders') {
        if (value.length > 30 || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 1000 || /[\0\r\n]/.test(item) || item.startsWith('\\\\'))) bad()
        return
      }
      if (path === 'mcpServers') {
        const ids = new Set<string>()
        for (const server of value) {
            visit(server, { id: '', name: '', enabled: false, command: '', args: [''], env: {}, secretEnv: [''], url: '', headers: {} }, path)
          if (typeof server.id !== 'string' || !server.id.trim() || ids.has(server.id) ||
            typeof server.name !== 'string' || typeof server.enabled !== 'boolean' ||
            typeof server.command !== 'string' || !Array.isArray(server.args)) bad()
          ids.add(server.id)
          if (server.url !== undefined && server.url !== '') {
            try { if (!['http:', 'https:'].includes(new URL(server.url).protocol)) bad() }
            catch { bad() }
          }
          if (server.secretEnv?.some((name: string) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) bad()
            if (server.headers !== undefined) {
              if (!server.url || !server.headers || typeof server.headers !== 'object' || Array.isArray(server.headers)) bad()
              for (const [name, value] of Object.entries(server.headers)) {
                if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof value !== 'string' || !/^(Bearer |Basic )?\$\{[A-Za-z_][A-Za-z0-9_]{0,127}\}$/i.test(value)) bad()
                const variable = (value as string).match(/\$\{([^}]+)\}/)?.[1]
                if (!server.secretEnv?.includes(variable)) bad()
              }
            }
        }
        return
      }
      for (const item of value) {
        if (template.length) visit(item, template[0], path)
        else if (!item || typeof item !== 'object' || Array.isArray(item)) bad()
      }
      return
    }
    if (typeof template === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return bad()
      for (const [key, child] of Object.entries(value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) bad()
        if (path === 'mcpServers.env') {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof child !== 'string') bad()
        } else if (path === 'permissions') {
          if (child !== '' && !['allow', 'ask', 'deny'].includes(String(child))) bad()
        } else if (Object.hasOwn(template!, key)) {
          visit(child, (template as Record<string, unknown>)[key], path ? `${path}.${key}` : key)
        }
      }
      return
    }
    if (typeof value !== typeof template || (typeof value === 'number' && !Number.isFinite(value))) bad()
  }
  visit(patch, DEFAULT_SETTINGS, '')
  const p = patch as Record<string, unknown>
  const enums: Record<string, string[]> = {
    brainProvider: ['gemini', 'ollama', 'openrouter', 'openai', 'anthropic', 'chatgpt', 'lmstudio', 'jarvis'],
    'speech.provider': ['gemini', 'elevenlabs', 'piper', 'openai'],
    'speech.thinkProvider': ['gemini', 'ollama', 'chatgpt'],
    'speech.hearProvider': ['gemini', 'whisper'],
    'piper.backend': ['auto', 'exe', 'python'],
    persona: ['jarvis', 'sachlich', 'herzlich'],
    'personality.address': ['auto', 'du', 'sie']
  }
  const get = (path: string): unknown => path.split('.').reduce<unknown>((v, key) =>
    v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined, p)
  for (const [path, choices] of Object.entries(enums)) {
    const value = get(path)
    if (value !== undefined && !choices.includes(String(value))) throw new Error(`Ungültige Auswahl: ${path}.`)
  }
  const ranges: Record<string, [number, number]> = {
    dailyCostLimitUsd: [0, 1_000_000], 'audio.outputGain': [0, 4],
    'audio.jitterBufferMs': [0, 5000], 'wake.threshold': [0, 1],
    'vad.localGateThreshold': [0, 1], 'vad.silenceDurationMs': [100, 10_000],
    'vad.prefixPaddingMs': [0, 5000], 'companion.port': [1, 65533],
    'whisper.port': [1, 65535],
    'music.spotifyRedirectPort': [1, 65535]
  }
  for (const [path, [min, max]] of Object.entries(ranges)) {
    const value = get(path)
    if (value !== undefined && (typeof value !== 'number' || value < min || value > max ||
        ((path.endsWith('.port') || path.endsWith('Port')) && !Number.isInteger(value)))) throw new Error(`Wert außerhalb des gültigen Bereichs: ${path}.`)
  }
  const humor = get('personality.humor')
  if (humor !== undefined && (!Number.isInteger(humor) || (humor as number) < 0 || (humor as number) > 3)) {
    throw new Error('Humor muss 0, 1, 2 oder 3 sein.')
  }
  const name = get('personality.name')
  if (name !== undefined && (typeof name !== 'string' || !/^[\p{L}][\p{L}\p{M} .'-]{0,31}$/u.test(name.trim()))) {
    throw new Error('Name: 1 bis 32 Buchstaben, ohne Sonderzeichen.')
  }
  const wakeModel = get('wake.modelName')
  if (wakeModel !== undefined && (typeof wakeModel !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.onnx$/.test(wakeModel))) {
    throw new Error('Weckwort-Modell muss ein ONNX-Dateiname ohne Pfad sein.')
  }
}
