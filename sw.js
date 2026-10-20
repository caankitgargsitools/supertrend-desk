// AnkGenie app shell. Always tries the network first so a new version shows straight away; the saved copy is only
// used when the phone is offline. Calls to Supabase and Dhan are never cached.
const CACHE = "ankgenie-v2";
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

// Phone notifications from the desk: new positions, exits with P&L, errors, going live, lab results, token problems.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "AnkGenie", body: e.data ? e.data.text() : "" }; }
  const kind = d.kind || "";
  e.waitUntil(self.registration.showNotification(d.title || "AnkGenie", {
    body: d.body || "", tag: d.tag || undefined, renotify: true, icon: "icons/icon-192.png", badge: "icons/icon-192.png",
    requireInteraction: kind === "error" || kind === "account", data: { url: d.url || "/" },
    vibrate: kind === "error" || kind === "account" ? [200, 100, 200, 100, 200] : [120, 60, 120],
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((ws) => {
    for (const w of ws) { if (w.url.startsWith(self.location.origin)) { w.focus(); w.postMessage({ open: url }); return; } }
    return self.clients.openWindow(url);
  }));
});
