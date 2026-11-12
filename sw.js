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
// 12 Nov 2026 (Papa chose A + B + C + D): live trades (kind "live_trade") look and feel different — a trade-slip title,
// a picture of the position (stop · entry · now · target, or the exit's P&L), their own strong vibration, and they stay
// until tapped; one notification per trade is updated in place (same tag; meta.quiet = no new sound). Paper trades
// (kind "trade") arrive silently. An open, visible app also gets the alert to show full screen with a sound.
const LIVE_BUZZ = [90, 50, 90, 50, 380, 140, 90, 50, 90, 50, 380];
const fmtR = (v) => { const n = Math.trunc(Math.abs(Number(v) || 0)); let t = String(n); if (t.length > 3) t = t.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + t.slice(-3); return (Number(v) < 0 ? "−₹" : "₹") + t; };
async function tradeImage(m) {
  if (typeof OffscreenCanvas === "undefined" || !m) return undefined;
  const W = 720, H = 300, c = new OffscreenCanvas(W, H), g = c.getContext("2d");
  const closed = m.stage === "closed" || m.stage === "confirmed";
  const up = closed ? Number(m.net) >= 0 : m.side !== "SELL";
  const bg = g.createLinearGradient(0, 0, W, H); bg.addColorStop(0, "#0b1020"); bg.addColorStop(1, up ? "#0d2a1e" : "#2a0d14"); g.fillStyle = bg; g.fillRect(0, 0, W, H);
  g.fillStyle = up ? "#22c55e" : "#ef4444"; g.fillRect(0, 0, 10, H);
  g.font = "700 30px sans-serif"; g.fillStyle = "#e5e7eb"; g.fillText(`${m.test ? "TEST · " : ""}LIVE ${closed ? "EXIT" : m.side || ""} · ${m.asset || ""}`, 34, 52);
  if (closed) {
    g.font = "800 84px sans-serif"; g.fillStyle = up ? "#facc15" : "#f87171"; g.fillText((Number(m.net) >= 0 ? "+" : "") + fmtR(m.net), 34, 160);
    g.font = "500 26px sans-serif"; g.fillStyle = "#cbd5e1";
    g.fillText([m.pct != null ? `${Number(m.pct) >= 0 ? "+" : ""}${Number(m.pct).toFixed(1)}%` : "", m.held ? `held ${m.held}` : "", m.today != null ? `today ${Number(m.today) >= 0 ? "+" : ""}${fmtR(m.today)}` : ""].filter(Boolean).join("  ·  "), 34, 220);
  } else {
    const entry = Number(m.fill || m.px), stop = Number(m.stop), tgt = Number(m.tgt), now = Number(m.now || entry);
    const pts = [entry, stop, tgt, now].filter((v) => v > 0), lo = Math.min(...pts), hi = Math.max(...pts), pad = (hi - lo) * 0.08 || entry * 0.01;
    const X = (v) => 50 + (W - 100) * (v - (lo - pad)) / ((hi + pad) - (lo - pad)), y = 170;
    g.strokeStyle = "#334155"; g.lineWidth = 8; g.lineCap = "round"; g.beginPath(); g.moveTo(50, y); g.lineTo(W - 50, y); g.stroke();
    if (now > 0 && entry > 0) { g.strokeStyle = (now - entry) * (m.dir || 1) >= 0 ? "#22c55e" : "#ef4444"; g.beginPath(); g.moveTo(X(entry), y); g.lineTo(X(now), y); g.stroke(); }
    const mark = (v, col, label, below) => { if (!(v > 0)) return; g.fillStyle = col; g.fillRect(X(v) - 3, y - 22, 6, 44); g.font = "600 22px sans-serif"; const t = `${label} ${fmtR(v)}`, w = g.measureText(t).width; g.fillText(t, Math.max(20, Math.min(W - 20 - w, X(v) - w / 2)), below ? y + 56 : y - 32); };
    mark(stop, "#ef4444", "Stop", false); mark(tgt, "#22c55e", "Target", false); mark(entry, "#e5e7eb", "Entry", true);
    if (now > 0) { g.fillStyle = "#fff"; g.beginPath(); g.arc(X(now), y, 11, 0, 7); g.fill(); }
    g.font = "500 24px sans-serif"; g.fillStyle = "#cbd5e1";
    g.fillText([m.lots ? `${m.lots} lot${m.lots == 1 ? "" : "s"}` : "", m.risk != null ? `at risk ${fmtR(m.risk)}` : "", m.margin != null ? `margin ${fmtR(m.margin)}` : ""].filter(Boolean).join("  ·  "), 34, 270);
  }
  const buf = new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
  let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return "data:image/png;base64," + btoa(bin);
}
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "AnkGenie", body: e.data ? e.data.text() : "" }; }
  const kind = d.kind || "", m = d.meta || null, live = kind === "live_trade", quiet = !!(m && m.quiet);
  e.waitUntil((async () => {
    // The open app shows its own full-screen alert (with a sound) for live trades.
    if (live) {
      const ws = await self.clients.matchAll({ type: "window", includeUncontrolled: true }).catch(() => []);
      for (const w of ws) w.postMessage({ liveTrade: { id: d.id, title: d.title, body: d.body, url: d.url, tag: d.tag, meta: m } });
    }
    let image;
    if (live && m && m.stage !== "note" && m.stage !== "failed") image = await tradeImage(m).catch(() => undefined);
    const silent = kind === "trade" || (live && quiet);
    const opts = { body: d.body || "", tag: d.tag || undefined, renotify: !quiet && !!d.tag, icon: "icons/icon-192.png", badge: "icons/icon-192.png",
      requireInteraction: live || kind === "error" || kind === "account", data: { url: d.url || "/" } };
    if (image) opts.image = image;
    // Chrome refuses a silent notification that also has a vibration pattern (found 12 Nov 2026: quiet live updates and
    // paper trades never appeared), so silent ones get none.
    if (silent) opts.silent = true;
    else opts.vibrate = live ? LIVE_BUZZ : kind === "error" || kind === "account" ? [200, 100, 200, 100, 200] : [120, 60, 120];
    // Whatever goes wrong with the extras, the notification itself must still appear.
    try { await self.registration.showNotification(d.title || "AnkGenie", opts); }
    catch { await self.registration.showNotification(d.title || "AnkGenie", { body: d.body || "", tag: d.tag || undefined, icon: "icons/icon-192.png", data: { url: d.url || "/" } }); }
  })());
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  // Only this site's own pages open from a notification (an outside link falls back to the home page).
  let url;
  try { url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin); } catch { url = null; }
  if (!url || url.origin !== self.location.origin) url = new URL("/", self.location.origin);
  url = url.href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((ws) => {
    for (const w of ws) { if (w.url.startsWith(self.location.origin)) { w.focus(); w.postMessage({ open: url }); return; } }
    return self.clients.openWindow(url);
  }));
});
