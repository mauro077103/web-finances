// Service worker de web-finances: guarda la "carcasa" de la app para que abra rápido y sin red.
// Nunca guarda datos en vivo: /api, /mt5 y trader/ van siempre a la red.
const CACHE = 'web-finances-v1';
const SHELL = ['./', './index.html', './trading-desk.js', './mt5.js', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
    e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);
    if (e.request.method !== 'GET' || url.origin !== location.origin) return;
    if (/^\/(api|mt5|trader)\//.test(url.pathname) || url.search.includes('token=')) return;
    // Primero la red (para recibir actualizaciones); si no hay, la copia guardada.
    e.respondWith(
        fetch(e.request)
            .then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; })
            .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
    );
});
