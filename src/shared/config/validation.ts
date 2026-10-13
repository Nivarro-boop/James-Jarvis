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
      if (path === 'mcpServers') {
        const ids = new Set<string>()
        for (const server of value) {
          visit(server, { id: '', name: '', enabled: false, command: '', args: [''], env: {}, secretEnv: [''], url: '' }, path)
          if (typeof server.id !== 'string' || !server.id.trim() || ids.has(server.id) ||
            typeof server.name !== 'string' || typeof server.enabled !== 'boolean' ||
            typeof server.command !== 'string' || !Array.isArray(server.args)) bad()
          ids.add(server.id)
          if (server.url !== undefined && server.url !== '') {
            try { if (!['http:', 'https:'].includes(new URL(server.url).protocol)) bad() }
            catch { bad() }
          }
          if (server.secretEnv?.some((name: string) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) bad()
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
    brainProvider: ['gemini', 'ollama', 'openrouter', 'openai', 'anthropic', 'chatgpt', 'lmstudio'],
    'speech.provider': ['gemini', 'elevenlabs', 'piper', 'vibevoice', 'openai'],
    'speech.thinkProvider': ['gemini', 'ollama', 'chatgpt', 'hermes'],
    'speech.hearProvider': ['gemini', 'whisper'],
    'piper.backend': ['auto', 'exe', 'python']
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
    'speech.port': [1, 65535], 'whisper.port': [1, 65535],
    'music.spotifyRedirectPort': [1, 65535]
  }
  for (const [path, [min, max]] of Object.entries(ranges)) {
    const value = get(path)
    if (value !== undefined && (typeof value !== 'number' || value < min || value > max ||
        ((path.endsWith('.port') || path.endsWith('Port')) && !Number.isInteger(value)))) throw new Error(`Wert außerhalb des gültigen Bereichs: ${path}.`)
  }
  const wakeModel = get('wake.modelName')
  if (wakeModel !== undefined && (typeof wakeModel !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.onnx$/.test(wakeModel))) {
    throw new Error('Weckwort-Modell muss ein ONNX-Dateiname ohne Pfad sein.')
  }
  const hermesModel = get('hermes.model')
  if (hermesModel !== undefined && (typeof hermesModel !== 'string' || !hermesModel.trim() || hermesModel.length > 256)) {
    throw new Error('Hermes-Modellroute fehlt oder ist zu lang.')
  }
  const hermesUrl = get('hermes.baseUrl')
  if (hermesUrl !== undefined) {
    try {
      const url = new URL(String(hermesUrl))
      if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash) throw new Error()
    } catch { throw new Error('Hermes braucht eine gültige lokale HTTP-Adresse.') }
  }
}
