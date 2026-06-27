/* Magot Voyage — Service Worker
   Stratégie :
   - Navigations (l'app) : network-first → met à jour index.html quand tu es en ligne,
     et bascule sur la version mise en cache quand tu es hors-ligne.
   - Fichiers locaux (icônes, manifest) : cache-first puis réseau.
   - Requêtes externes (Google Maps/Places/Routes, polices, jsPDF) : laissées au réseau,
     elles échouent proprement hors-ligne (l'app gère l'absence de données).
   Pour forcer une mise à jour du cache après un déploiement, change le numéro de version. */
const VERSION = "v8";
const CACHE = "magot-voyage-" + VERSION;
const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {}))
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // Laisse passer tout ce qui est externe (Google, polices, CDN) directement au réseau.
  if (url.origin !== self.location.origin) return;

  // Navigation vers l'app : réseau d'abord, cache en secours (offline).
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((r) => {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put("./index.html", copy)).catch(() => {});
          return r;
        })
        .catch(() => caches.match("./index.html").then((r) => r || caches.match("./")))
    );
    return;
  }

  // Fichiers locaux : cache d'abord, puis réseau (et on met en cache au passage).
  e.respondWith(
    caches.match(req).then((cached) =>
      cached ||
      fetch(req)
        .then((r) => {
          if (r && r.status === 200 && r.type === "basic") {
            const copy = r.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return r;
        })
        .catch(() => cached)
    )
  );
});

// Permet à l'app de demander une activation immédiate de la nouvelle version.
self.addEventListener("message", (e) => {
  if (e.data === "SKIP_WAITING") self.skipWaiting();
});
