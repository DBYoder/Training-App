/* Service worker: network-first for everything, falling back to cache when
 * offline. This preserves the app's freshness guarantees (a deploy is picked
 * up on the next online load) while making the shell work with no signal —
 * training data itself already lives in localStorage and re-syncs.
 * /api/ requests are never cached: the app handles offline API failures.
 */
"use strict";

const CACHE = "marathon-trainer-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin ||
      url.pathname.startsWith("/api/")) {
    return; // straight to network; the app copes with API failures
  }
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(event.request).then((hit) =>
          hit || (event.request.mode === "navigate" ? caches.match("/") : Response.error())
        )
      )
  );
});
