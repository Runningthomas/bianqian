'use strict';
// 注册 Service Worker：让网页版可离线打开、可安装到桌面/主屏。
// 独立成文件是为了满足 CSP 的 script-src 'self'（不允许内联脚本）。
(function () {
  if (!('serviceWorker' in navigator)) return;
  if (!location.protocol.startsWith('http')) return; // file:// 下不注册
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  });
})();
