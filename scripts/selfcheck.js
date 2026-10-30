'use strict';
// 桌面端自检脚本：用 Electron 自己跑一遍核心链路，输出 JSON 结果。
// 用法：electron.exe scripts/selfcheck.js
// 说明：不经过 Playwright（版本不兼容），直接驱动 Electron 主进程与渲染进程。

const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const results = { ok: [], fail: [], info: {} };

function check(name, cond, extra) {
  if (cond) results.ok.push(name);
  else results.fail.push(name + (extra ? ' :: ' + JSON.stringify(extra) : ''));
}

app.setPath('userData', path.join(process.env.APPDATA || '', 'BianQian'));

// 直接复用真实 main.js 的 IPC 注册逻辑（自检与生产环境走同一套代码路径）
const { ipcMain } = require('electron');
const { Store } = require('../store');
const core = require('../web/core.js');
const store = new Store(path.join(app.getPath('userData'), 'data.json'));

ipcMain.handle('state:load', () => JSON.parse(JSON.stringify(store.data)));
ipcMain.handle('note:save', (_e, input) => {
  const n = core.sanitizeNote(input);
  if (!n) return false;
  store.data.notes[n.id] = n;
  store.save();
  return true;
});
ipcMain.handle('note:delete', (_e, id) => {
  if (!store.data.notes[id]) return false;
  delete store.data.notes[id];
  store.data.tombstones[id] = Date.now();
  store.save();
  return true;
});
ipcMain.handle('settings:get', () => core.DEFAULT_SETTINGS);
ipcMain.handle('settings:set', (_e, patch) => core.applySettings(core.DEFAULT_SETTINGS, patch || {}));
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('sync:status', () => ({ state: 'idle', message: '未启用同步', lastOk: null }));
ipcMain.handle('sync:now', () => ({ state: 'idle', message: '未启用同步', lastOk: null }));
ipcMain.handle('win:minimize', () => {});
ipcMain.handle('win:maximize', () => {});
ipcMain.handle('win:close', () => {});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1100, height: 700, show: false, frame: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    // 过滤 Electron 开发期的安全提示（打包后不会出现）
    if (message.includes('Electron Security Warning')) return;
    if (level >= 2) consoleErrors.push(message);
  });

  await win.loadFile(path.join(ROOT, 'web', 'index.html')).catch((e) => {
    results.fail.push('loadFile 失败: ' + e.message);
  });
  await new Promise((r) => setTimeout(r, 2500));

  results.info.loaded = win.webContents.getURL();
  results.info.consoleErrors = consoleErrors.slice(0, 8);

  // ---- 渲染层状态 ----
  // 打开设置面板后再测（抽屉关闭时内部元素尺寸为 0，会误判为隐藏）
  await win.webContents.executeJavaScript(`document.querySelector('#btn-settings').click()`).catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
  const ui = await win.webContents.executeJavaScript(`(() => {
    const g = s => { const e = document.querySelector(s); if(!e) return 'missing'; const r = e.getBoundingClientRect(); return (r.width===0||r.height===0)?'hidden':'visible'; };
    return {
      title: document.title,
      badge: (document.querySelector('#runtime-badge')||{}).textContent,
      version: (document.querySelector('#app-version')||{}).textContent,
      noteCount: document.querySelectorAll('.note').length,
      settingsOpen: g('#settings'),
      desktopSec: g('#sec-desktop'),
      btnMin: g('#btn-min'),
      btnClose: g('#btn-close'),
      btnTop: g('#btn-top'),
      hasApi: typeof window.api === 'object',
      isDesktop: !!(window.api && window.api.isDesktop),
    };
  })()`).catch((e) => ({ __err: e.message }));

  results.info.ui = ui;
  check('页面标题正确', ui.title === '桌面便签', ui);
  check('runtime 标记为桌面版', ui.badge === '桌面版', ui);
  check('版本号已注入', !!ui.version && ui.version !== '—', ui);
  check('window.api 已注入', ui.hasApi && ui.isDesktop, ui);
  check('桌面专属设置区可见', ui.desktopSec === 'visible', ui);  check('窗口控制按钮可见', ui.btnMin === 'visible' && ui.btnClose === 'visible' && ui.btnTop === 'visible', ui);

  // ---- 新建便签 + 编辑 ----
  await win.webContents.executeJavaScript(`document.querySelector('#btn-new').click()`).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.note .n-title');
    if (!el) return 'no-card';
    el.value = '自检便签标题';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`).catch((e) => results.fail.push('编辑注入失败: ' + e.message));
  await new Promise((r) => setTimeout(r, 700));

  const after = await win.webContents.executeJavaScript(`({
    count: document.querySelectorAll('.note').length,
    title: (document.querySelector('.note .n-title')||{}).value
  })`).catch((e) => ({ __err: e.message }));
  results.info.after = after;
  check('新建便签成功', after.count >= 1, after);
  check('标题编辑生效', after.title === '自检便签标题', after);

  // ---- 数据落盘 ----
  const fs = require('fs');
  const dataPath = path.join(app.getPath('userData'), 'data.json');
  const onDisk = fs.existsSync(dataPath) ? JSON.parse(fs.readFileSync(dataPath, 'utf8')) : null;
  results.info.onDisk = onDisk ? Object.keys(onDisk.notes || {}).length : 0;
  check('数据已落盘', !!onDisk && Object.keys(onDisk.notes || {}).length >= 1, results.info.onDisk);

  // ---- 拖拽定位（保存 x/y）----
  await win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('.note');
    card.style.left = '120px'; card.style.top = '80px';
  })()`);
  await new Promise((r) => setTimeout(r, 300));

  check('无渲染层错误', consoleErrors.length === 0, consoleErrors.slice(0, 5));

  console.log('\n===SELFTEST===');
  console.log(JSON.stringify(results, null, 2));
  app.exit(results.fail.length ? 1 : 0);
}).catch((e) => {
  console.log('\n===SELFTEST===');
  console.log(JSON.stringify({ ok: [], fail: ['启动异常: ' + e.message], info: results.info || {} }, null, 2));
  app.exit(1);
});
