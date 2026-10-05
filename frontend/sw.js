/* 厝內溝通板：Service Worker
 * 快取前端檔案，離線時也能開啟。採「先給快取、背景更新」：
 * 有網路時每次開啟都會在背景抓新版，下一次開啟就會用到。
 * 若要強制所有裝置丟掉舊快取，把 VERSION 加 1。 */
const VERSION = "v1";
const CACHE = "cuenei-" + VERSION;
const SHELL = ["./", "index.html", "styles.css", "app.js", "config.js", "manifest.json",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith("cuenei-") && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;                 // 後端 API 都是 POST，不經過快取
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !FONT_HOSTS.includes(url.hostname)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: sameOrigin });
    const fresh = fetch(req).then(res => {
      if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    e.waitUntil(fresh);
    if (cached) return cached;
    const res = await fresh;
    if (res) return res;
    // 離線又沒有快取：頁面導覽退回首頁
    if (req.mode === "navigate") { const home = await cache.match("./"); if (home) return home }
    return Response.error();
  })());
});
