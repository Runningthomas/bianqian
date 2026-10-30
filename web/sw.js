'use strict';
// Service Worker：让网页版可离线打开、可安装到桌面/主屏。
// 更新策略：核心代码走 network-first（拿到新版本），静态资源走 cache-first + 后台更新。

const VERSION = 'bq-v2.0.0';
const CACHE = 'bianqian-' + VERSION;

const CORE = ['./', './index.html', './style.css', './core.js', './api.js', './app.js', './register-sw.js', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(CORE).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 只接管同源请求（Gist API 直连，不缓存）
  if (url.origin !== self.location.origin) return;

  // 页面与代码：network-first —— 有网就拿最新，掉线回落缓存
  if (/\.(html|js|css)$/.test(url.pathname) || url.pathname.endsWith('/')) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  // 其余静态资源：cache-first
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
