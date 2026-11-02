const CACHE = "ytp-shell-v1";
const SHELL = [
  "./",
  "index.html",
  "style.css",
  "manifest.webmanifest",
  "icon-180.png",
  "icon-512.png",
  "js/app.js",
  "js/engine.js",
  "js/store.js",
  "js/youtube.js",
  "vendor/SoundTouchNode.js",
  "vendor/constants.js",
  "vendor/soundtouch-processor.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first so updates show up immediately when online; cache is the offline fallback.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  event.respondWith(
    fetch(req, { cache: "no-cache" })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req))
  );
});
