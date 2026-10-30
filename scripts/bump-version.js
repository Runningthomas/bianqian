'use strict';
// 发布前处理：为 web/ 里的资源引用加上版本号查询串，
// 绕过 GitHub Pages 的 CDN 缓存（Cache-Control: max-age=600），
// 让"推送即生效"真正成立。
//
// 用法：node scripts/bump-version.js <版本号>
// 在 deploy.yml 中于上传前执行。

const fs = require('fs');
const path = require('path');

const WEB_DIR = path.join(__dirname, '..', 'web');
const version = process.argv[2];
if (!version) {
  console.error('用法：node scripts/bump-version.js <版本号>');
  process.exit(1);
}

const htmlPath = path.join(WEB_DIR, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');

// 把 ?v=旧版本 替换成 ?v=新版本；没有的补上
const stamp = (url) => {
  const clean = url.replace(/\?v=[^"']*/, '');
  return `${clean}?v=${version}`;
};

html = html.replace(/(src|href)="((?:style|core|api|app|register-sw)[^"]*?)(?:\?v=[^"']*)?"/g,
  (m, attr, url) => {
    if (url.startsWith('data:') || url.startsWith('#')) return m;
    return `${attr}="${stamp(url)}"`;
  });

fs.writeFileSync(htmlPath, html, 'utf8');

// Service Worker 的预缓存清单也要带版本号，否则缓存旧文件
const swPath = path.join(WEB_DIR, 'sw.js');
let sw = fs.readFileSync(swPath, 'utf8');
sw = sw.replace(/const VERSION = '[^']*'/, `const VERSION = 'bq-${version}'`);
sw = sw.replace(/const CORE = \[[^\]]*\]/,
  `const CORE = ['./', './index.html', './style.css?v=${version}', './core.js?v=${version}', './api.js?v=${version}', './app.js?v=${version}', './register-sw.js?v=${version}', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png']`);
fs.writeFileSync(swPath, sw, 'utf8');

// 注意：manifest.json 本身不加版本参数 —— 部分浏览器对带查询串的 manifest 兼容性不佳，
// 且 manifest 内容变化不频繁，CDN 缓存 10 分钟可接受。

console.log(`已为 web/ 资源注入版本号 v=${version}`);
