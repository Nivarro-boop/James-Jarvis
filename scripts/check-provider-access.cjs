const { app, safeStorage } = require('electron')
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

// Read-only checks. Never print keys, tokens, account names, or response bodies.
app.whenReady().then(async () => {
  const checks = []
  for (const profile of ['Void Jarvis', 'void-jarvis']) {
    const root = join(app.getPath('appData'), profile)
    let secrets = {}
    const file = join(root, 'secure', 'secrets.bin')
    if (existsSync(file)) {
      try { secrets = JSON.parse(safeStorage.decryptString(readFileSync(file))) }
      catch { checks.push({ profile, check: 'keystore', result: 'unreadable' }) }
    }
    let settings = {}
    try { settings = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')) } catch {}
    for (const provider of ['gemini', 'openai']) {
      if (!secrets[provider]) { checks.push({ profile, check: provider, result: 'missing-credentials' }); continue }
      try {
        const response = await fetch(provider === 'gemini'
          ? 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000'
          : 'https://api.openai.com/v1/models', {
          headers: provider === 'gemini' ? { 'x-goog-api-key': secrets[provider] } : { Authorization: `Bearer ${secrets[provider]}` },
          signal: AbortSignal.timeout(15000)
        })
        const body = await response.json()
        const models = provider === 'gemini' ? (body.models ?? []).filter(m => m.supportedGenerationMethods?.includes('bidiGenerateContent')).map(m => m.name.replace(/^models\//, '')) : (body.data ?? []).filter(m => m.id.includes('realtime')).map(m => m.id)
        checks.push({ profile, check: provider, status: response.status, liveModels: models,
          selected: provider === 'gemini' ? settings.liveModel : settings.speech?.realtimeModel })
        if (provider === 'openai' && response.ok) {
          const token = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
            method: 'POST', headers: { Authorization: `Bearer ${secrets.openai}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ session: { type: 'realtime', model: settings.speech?.realtimeModel || 'gpt-realtime' } }),
            signal: AbortSignal.timeout(15000)
          })
          await token.body?.cancel()
          checks.push({ profile, check: 'realtime-token', status: token.status })
        }
      } catch { checks.push({ profile, check: provider, result: 'network-or-response-error' }) }
    }
    const login = join(root, 'secure', 'chatgpt-login.bin')
    if (!existsSync(login)) checks.push({ profile, check: 'chatgpt', result: 'not-signed-in' })
    else {
      try {
        const data = JSON.parse(safeStorage.decryptString(readFileSync(login)))
        const response = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${data.accessToken}` }, signal: AbortSignal.timeout(15000)
        })
        await response.body?.cancel()
        checks.push({ profile, check: 'chatgpt-models', status: response.status, expired: data.expiresAt <= Date.now() })
      } catch { checks.push({ profile, check: 'chatgpt', result: 'unreadable-or-network-error' }) }
    }
  }
  mkdirSync(join(__dirname, '../out/audit'), { recursive: true })
  writeFileSync(join(__dirname, '../out/audit/provider-check-1.2.8.json'), JSON.stringify(checks, null, 2))
  console.log(JSON.stringify(checks, null, 2))
  app.exit(0)
}).catch(() => app.exit(1))
