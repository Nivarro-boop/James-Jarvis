/**
 * Der Service Worker existiert für genau eine Sache: Ohne ihn nimmt iOS die
 * Seite nicht als App auf den Startbildschirm — kein eigenes Symbol, kein
 * Vollbild, sondern nur ein Lesezeichen in Safari.
 *
 * Er hält deshalb bewusst wenig. Die Hülle wird zwischengespeichert, damit die
 * App auch dann bis zur Kopplungsseite hochkommt, wenn der Rechner schläft —
 * genau der Fall, in dem man den Weckknopf braucht. Alles Weitere läuft über
 * den WebSocket und hat mit dem Zwischenspeicher nichts zu tun.
 */

const CACHE = 'jarvis-phone-v2'
// Beide Symbole stehen mit drin: `addAll` bricht ab, sobald eine einzige
// Adresse fehlschlägt — dann läge gar nichts im Zwischenspeicher.
const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'mic-worklet.js',
  'icon.png',
  'icon-maskable.png',
  'manifest.webmanifest'
]

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('jarvis-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.search ||
      !SHELL.some(path => new URL(path, self.registration.scope).pathname === url.pathname)) return

  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    try {
      const response = await fetch(request)
      if (response.ok) await cache.put(request, response.clone())
      if (response.ok) return response
      return (await cache.match(request)) || response
    } catch {
      const hit = await cache.match(request)
      if (hit) return hit
      if (request.mode === 'navigate') return (await cache.match('index.html')) || Response.error()
      return Response.error()
    }
  })())
})
