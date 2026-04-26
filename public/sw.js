self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open("echo-voice-v1").then((cache) =>
      cache.addAll(["/", "/styles.css", "/app.js", "/manifest.webmanifest"])
    )
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request).then((response) => response || caches.match("/")))
  );
});
