// Minimaler Service Worker: macht die Zentrale als App installierbar.
// Kein Caching von API-Daten – die Zentrale ist immer live.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
