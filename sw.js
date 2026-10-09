// Trade Desk app shell. Always tries the network first so a new version shows straight away; the saved copy is only
// used when the phone is offline. Calls to Supabase and Dhan are never cached.
const CACHE = "trade-desk-v1";
self.addEventListener("install", (e) => { self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(fetch(req).then((res) => {
    if (res.ok && (req.mode === "navigate" || /\.(js|png|webmanifest)$/.test(url.pathname))) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
  }).catch(() => caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match("/") : Response.error()))));
});
