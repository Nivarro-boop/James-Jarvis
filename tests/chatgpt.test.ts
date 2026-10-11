import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { app } from 'electron'
import { chatGptSignInEnabled } from '@main/providers/chatgptAuth'
import { readStream } from '@main/providers/chatgptResponses'

/** Ein SSE-Strom, in beliebig zerschnittenen Stücken, wie er aus dem Netz kommt. */
function stream(text: string, cut = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += cut) controller.enqueue(bytes.slice(i, i + cut))
      controller.close()
    }
  })
}

const event = (data: object): string => `event: x\ndata: ${JSON.stringify(data)}\n\n`

describe('ChatGPT-Antwortstrom lesen', () => {
  it('setzt die Textstücke zusammen, auch über Paketgrenzen', async () => {
    const body =
      event({ type: 'response.output_text.delta', delta: 'Hallo ' }) +
      event({ type: 'response.output_text.delta', delta: 'Welt' }) +
      event({ type: 'response.completed' })
    assert.equal(await readStream(stream(body)), 'Hallo Welt')
  })

  it('versteht Windows-Zeilenenden', async () => {
    const body = (
      event({ type: 'response.output_text.delta', delta: 'ok' }) + event({ type: 'response.completed' })
    ).replace(/\n/g, '\r\n')
    assert.equal(await readStream(stream(body)), 'ok')
  })

  it('meldet ein leeres Abo-Kontingent als Kontingent', async () => {
    const body = event({
      type: 'response.failed',
      response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } }
    })
    await assert.rejects(readStream(stream(body)), /Kontingent/)
  })

  it('wertet einen Strom ohne Abschluss als Fehler', async () => {
    const body = event({ type: 'response.output_text.delta', delta: 'halb' })
    await assert.rejects(readStream(stream(body)), /abgerissen/)
  })
})

describe('Freigabe', () => {
  it('erlaubt dynamische Registrierung in einer lokalen installierten App', () => {
    delete process.env.JARVIS_CHATGPT_SIGNIN
    delete process.env.JARVIS_CHATGPT_CLIENT_ID
    delete process.env.JARVIS_CHATGPT_DISTRIBUTION
    const packaged = app.isPackaged
    Object.defineProperty(app, 'isPackaged', { value: true, configurable: true })
    try {
      assert.equal(chatGptSignInEnabled(), true)
    } finally {
      Object.defineProperty(app, 'isPackaged', { value: packaged, configurable: true })
    }
  })
  it('deaktiviert kommerzielle Ausgaben ohne registrierten Client', () => {
    process.env.JARVIS_CHATGPT_DISTRIBUTION = 'commercial'
    try { assert.equal(chatGptSignInEnabled(), false) }
    finally { delete process.env.JARVIS_CHATGPT_DISTRIBUTION }
  })
})
