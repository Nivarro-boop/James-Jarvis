import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest, createServer as createHttpServer } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import { tmpdir, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { companionStatus, startCompanion, stopCompanion } from '@main/companion/server'

const opensslAvailable = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0

async function availablePort(): Promise<number> {
  // Companion binds public, bridge (+1) and optional CA (+2). Probing only one
  // ephemeral port races with unrelated Windows client sockets on its neighbors.
  for (let attempt = 0; attempt < 30; attempt++) {
    const port = randomInt(20_000, 30_000)
    const reservations: ReturnType<typeof createHttpServer>[] = []
    try {
      for (const offset of [0, 1, 2]) {
        const server = createHttpServer()
        reservations.push(server)
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(port + offset, '0.0.0.0', () => resolve())
        })
      }
      return port
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    } finally {
      await Promise.all(reservations.filter(server => server.listening).map(server =>
        new Promise<void>(resolve => server.close(() => resolve()))))
    }
  }
  throw new Error('No free contiguous three-port range for Companion test')
}

function requestStatus(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest({ host, port, path: '/', method: 'GET' }, (res) => {
      res.resume()
      resolve(false)
    })
    req.setTimeout(500, () => req.destroy(new Error('timeout')))
    req.once('error', () => resolve(true))
    req.end()
  })
}

function websocketHandshake(port: number, requestPath: string, origin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false, servername: 'localhost' })
    let response = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`WebSocket handshake timed out: ${requestPath}`))
    }, 1500)
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.on('data', (chunk) => {
      response += chunk.toString('latin1')
      if (response.includes('\r\n\r\n')) {
        clearTimeout(timer)
        socket.destroy()
        resolve(response)
      }
    })
    socket.once('connect', () => {
      socket.write(
        `GET ${requestPath} HTTP/1.1\r\n` +
          `Host: localhost:${port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          `Origin: ${origin}\r\n\r\n`
      )
    })
  })
}

describe('Companion transport security (local loopback integration)', () => {
  it('binds plaintext mode to loopback only and reports only the loopback URL', async () => {
    const port = await availablePort()
    try {
      await startCompanion(port, null)
      const status = companionStatus()
      assert.equal(status.secure, false)
      assert.deepEqual(status.urls, [`http://127.0.0.1:${port}/`])

      const localResponse = await new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path: '/' }, (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        })
        req.once('error', reject)
        req.end()
      })
      assert.ok(localResponse === 200 || localResponse === 404)

      const externalIp = Object.values(networkInterfaces()).flat().find(
        (entry) => entry && !entry.internal && entry.family === 'IPv4'
      )?.address
      if (externalIp) assert.equal(await requestStatus(port, externalIp), true)
    } finally {
      await stopCompanion()
    }
  })

  it('serves TLS locally, rejects plaintext and enforces WebSocket token plus Origin', { skip: !opensslAvailable }, async () => {
    const port = await availablePort()
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-companion-tls-test-'))
    const certFile = join(dir, 'cert.pem')
    const keyFile = join(dir, 'key.pem')
    try {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile,
        '-out', certFile, '-days', '1', '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost'
      ], { stdio: 'ignore' })
      await startCompanion(port, {
        hostname: 'localhost',
        pem: { certFile, keyFile }
      })

      const status = companionStatus()
      assert.equal(status.secure, true)
      assert.deepEqual(status.urls, [`https://localhost:${port}/`])
      const secureResponse = await new Promise<number>((resolve, reject) => {
        const req = httpsRequest({ host: '127.0.0.1', port, path: '/', rejectUnauthorized: false }, (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        })
        req.once('error', reject)
        req.end()
      })
      assert.ok(secureResponse === 200 || secureResponse === 404)

      const cleartextAccepted = await new Promise<boolean>((resolve) => {
        const req = httpRequest({ host: '127.0.0.1', port, path: '/' }, (res) => {
          res.resume()
          resolve(true)
        })
        req.setTimeout(700, () => req.destroy(new Error('timeout')))
        req.once('error', () => resolve(false))
        req.end()
      })
      assert.equal(cleartextAccepted, false, 'TLS listener must not accept HTTP or expose static content in cleartext')

      const origin = `https://localhost:${port}`
      const missingToken = await websocketHandshake(port, '/ws/phone?token=wrong', origin)
      assert.match(missingToken, /^HTTP\/1\.1 401/)
      const token = companionStatus().token
      assert.ok(token)
      const wrongOrigin = await websocketHandshake(
        port,
        `/ws/phone?token=${encodeURIComponent(token)}`,
        'https://attacker.invalid'
      )
      assert.match(wrongOrigin, /^HTTP\/1\.1 403/)
      const accepted = await websocketHandshake(
        port,
        `/ws/phone?token=${encodeURIComponent(token)}`,
        origin
      )
      assert.match(accepted, /^HTTP\/1\.1 101/)
    } finally {
      await stopCompanion()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
