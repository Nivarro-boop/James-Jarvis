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

const CACHE = 'jarvis-hülle-v1'
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
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  // Netz zuerst, Zwischenspeicher als Rückfall. Andersherum säße man nach
  // jeder Änderung an der App auf einer alten Fassung, und der einzige Ausweg
  // wäre, das Symbol vom Startbildschirm zu werfen.
  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone()
        caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined)
        return response
      })
      .catch(() => caches.match(request).then((hit) => hit ?? caches.match('index.html')))
  )
})
