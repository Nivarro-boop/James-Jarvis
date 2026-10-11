import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isInternalNavigation, isSafeExternalUrl } from '@main/windows/external'

describe('Externe Links aus den App-Fenstern', () => {
  it('erlaubt gewöhnliche Webadressen', () => {
    assert.equal(isSafeExternalUrl('https://example.com/path?q=1'), true)
    assert.equal(isSafeExternalUrl('http://localhost:5173/help'), true)
    assert.equal(isSafeExternalUrl('HTTPS://example.com'), true)
  })

  it('blockiert Betriebssystem- und ausführbare Protokolle', () => {
    for (const url of [
      'file:///C:/Windows/System32/calc.exe',
      'ms-settings:privacy-microphone',
      'powershell:Start-Process calc',
      'javascript:alert(1)',
      'data:text/html,hello'
    ]) {
      assert.equal(isSafeExternalUrl(url), false, url)
    }
  })

  it('blockiert relative und ungültige Angaben', () => {
    assert.equal(isSafeExternalUrl('/hilfe'), false)
    assert.equal(isSafeExternalUrl('keine adresse'), false)
    assert.equal(isSafeExternalUrl(''), false)
  })
})

describe('Navigation innerhalb der eigenen Fenster', () => {
  const DEV = 'http://localhost:5173/crystal.html'
  const GEBAUT = 'file:///C:/Program%20Files/Void%20Jarvis/out/renderer/crystal.html'

  it('lässt das eigene Fenster sich selbst neu laden', () => {
    assert.equal(isInternalNavigation(DEV, DEV), true)
    assert.equal(isInternalNavigation(GEBAUT, GEBAUT), true)
  })

  it('lässt die Nachbarseite desselben Vite-Servers durch', () => {
    assert.equal(isInternalNavigation('http://localhost:5173/settings.html', DEV), true)
    assert.equal(isInternalNavigation('http://localhost:5173/', DEV), true)
  })

  it('schickt einen fremden Server nach draußen, auch auf demselben Rechner', () => {
    assert.equal(isInternalNavigation('http://localhost:5174/crystal.html', DEV), false)
    assert.equal(isInternalNavigation('https://example.com', DEV), false)
  })

  it('lässt in der gebauten Fassung nur den Ordner der Seite selbst durch', () => {
    const nachbar = 'file:///C:/Program%20Files/Void%20Jarvis/out/renderer/settings.html'
    const mittel = 'file:///C:/Program%20Files/Void%20Jarvis/out/renderer/assets/crystal.js'
    assert.equal(isInternalNavigation(nachbar, GEBAUT), true)
    assert.equal(isInternalNavigation(mittel, GEBAUT), true)
  })

  it('hält dieselbe Fassung von allem anderen auf der Platte fern', () => {
    // Ohne den Ordnervergleich stünde hier überall `true`: file:-Adressen
    // haben in Chromium samt und sonders den Ursprung `null`.
    for (const ziel of [
      'file:///C:/Windows/System32/calc.exe',
      'file:///C:/Program%20Files/Void%20Jarvis/out/main/index.js',
      'file:///C:/Program%20Files/Void%20Jarvis/out/renderer/../../secrets.bin',
      'file:///C:/'
    ]) {
      assert.equal(isInternalNavigation(ziel, GEBAUT), false, ziel)
    }
  })

  it('zählt einen Protokollwechsel nie als innen', () => {
    assert.equal(isInternalNavigation('https://example.com', GEBAUT), false)
    assert.equal(isInternalNavigation(GEBAUT, DEV), false)
  })

  it('bleibt außen, solange keine Seite geladen ist', () => {
    assert.equal(isInternalNavigation(DEV, ''), false)
    assert.equal(isInternalNavigation('', DEV), false)
  })
})
