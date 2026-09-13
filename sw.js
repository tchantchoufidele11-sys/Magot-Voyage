/* Magot Voyage — Service Worker */
const VERSION = "v1172";
const CACHE = "magot-voyage-" + VERSION;
const SHELL = [
  "./","./index.html","./studio.html","./manifest.json","./icon-192.png","./icon-512.png","./icon-maskable-512.png","./apple-touch-icon.png"
];
/* D1 — libs runtime du Studio, auto-hébergées same-origin : analyse des temps (Essentia) et
   export MP4 image-exact (mp4-muxer) doivent fonctionner HORS-LIGNE. Le .web.js va chercher
   essentia-wasm.web.wasm en same-origin -> le .wasm DOIT être précaché lui aussi. */
const LIBS = [
  "./essentia-wasm.web.js","./essentia-wasm.web.wasm","./essentia.js-core.js","./mp4-muxer.js"
];
self.addEventListener("install", (e) => {
  self.skipWaiting();
  /* deux lots séparés : un échec sur une lib ne doit pas empêcher la mise en cache de la coquille HTML */
  e.waitUntil(caches.open(CACHE).then((c) =>
    Promise.all([
      c.addAll(SHELL).catch(() => {}),
      Promise.all(LIBS.map((u) => c.add(u).catch(() => {})))
    ])
  ));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== "mv-osm2").map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.hostname === "tiles.openfreemap.org" || url.hostname === "unpkg.com" || url.hostname === "server.arcgisonline.com") {
    e.respondWith(
      caches.open("mv-osm2").then((c) =>
        c.match(req).then((hit) =>
          hit ||
          fetch(req).then((r) => {
            if (r && (r.ok || r.type === "opaque")) { const copy = r.clone(); c.put(req, copy).catch(() => {}); }
            return r;
          }).catch(() => hit)
        )
      )
    );
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    const key = url.pathname.endsWith("studio.html") ? "./studio.html" : "./index.html";
    e.respondWith(
      fetch(req, { cache: "no-store" })
        .then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {}); return r; })
        .catch(() => caches.match(key).then((r) => r || caches.match("./index.html")).then((r) => r || caches.match("./")))
    );
    return;
  }
  e.respondWith(
    caches.match(req).then((cached) =>
      cached ||
      fetch(req).then((r) => {
        if (r && r.status === 200 && r.type === "basic") { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
        return r;
      }).catch(() => cached)
    )
  );
});
self.addEventListener("message", (e) => { if (e.data === "SKIP_WAITING") self.skipWaiting(); });
