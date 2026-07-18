// vitulus_ui — minimal service worker stub.
//
// Its only purpose is to make the PWA installable (manifest.json declares a
// fullscreen/standalone display, and most browsers require an active service
// worker with a fetch handler for the "add to home screen" / install prompt
// to appear). It is deliberately NOT a cache: this app shows live robot
// telemetry, so serving a cached response instead of hitting the network
// would show stale robot state. Every fetch is passed straight through to
// the network, uncached, unmodified.
//
// Must be served from the root scope (/sw.js), not /assets/sw.js — service
// worker scope defaults to the directory the script itself is served from,
// and a script under /assets/ could not control requests outside /assets/.
// See the '/sw.js' route in nodes/webnode.

self.addEventListener('install', function (event) {
    // Activate this version immediately instead of waiting for old tabs to close.
    self.skipWaiting();
});

self.addEventListener('activate', function (event) {
    // Take control of any already-open clients right away.
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (event) {
    // Network-only passthrough. No caches.open(), no cache.match() fallback —
    // robot state must always be fresh, never served stale from a cache.
    event.respondWith(fetch(event.request));
});
