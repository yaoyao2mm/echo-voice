self.ECHO_CACHE = "echo-codex-v94";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(self.ECHO_CACHE).then((cache) =>
      cache.addAll(["/", "/styles.css?v=94", "/app.js?v=94", "/manifest.webmanifest?v=94"])
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((name) => name !== self.ECHO_CACHE).map((name) => caches.delete(name)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request).then((response) => response || caches.match("/")))
  );
});
