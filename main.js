'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, globalShortcut, Notification, dialog, shell, clipboard, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./store');
const sync = require('./sync');
const core = require('./web/core.js');

// ---------------- 基础环境 ----------------
app.setName('BianQian');
app.setPath('userData', path.join(app.getPath('appData'), 'BianQian'));

const ASSETS = path.join(__dirname, 'assets');
const WEB_DIR = path.join(__dirname, 'web');
const ICON_PNG = path.join(ASSETS, 'icon.png');
const TRAY_PNG = path.join(ASSETS, 'tray.png');
const USER_DATA = app.getPath('userData');
const DATA_PATH = path.join(USER_DATA, 'data.json');
const SETTINGS_PATH = path.join(USER_DATA, 'settings.json');

// 桌面端在共享默认设置之上，补充仅桌面版存在的窗口状态字段
const DEFAULT_SETTINGS = Object.assign({}, core.DEFAULT_SETTINGS, {
  winBounds: null,
  snapped: null, // 'left' | 'right' | 'top' | null
  hidden: false, // 是否处于贴边隐藏状态
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let quickWin = null;
let tray = null;
let store = null;
let settings = loadSettings();
let quitting = false;

// ---------------- 设置 ----------------
function loadSettings() {
  let s = {};
  try {
    s = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch (_) {}
  return deepMerge(structuredClone(DEFAULT_SETTINGS), s);
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      deepMerge(base[k], v);
    } else if (v !== undefined) {
      base[k] = v;
    }
  }
  return base;
}

function saveSettings() {
  try {
    fs.mkdirSync(USER_DATA, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) {
    console.error('保存设置失败:', e);
  }
}

// 设置副作用：置顶/快捷键/自启/主题下发
function applySettingsEffects(changed) {
  if (win && !win.isDestroyed()) {
    applyTopState();
    win.webContents.send('settings:changed', publicSettings());
  }
  if (quickWin && !quickWin.isDestroyed()) {
    quickWin.webContents.send('settings:changed', publicSettings());
  }
  if (changed.has('quickShortcut')) registerShortcut();
  if (changed.has('launchAtLogin')) applyLoginItem();
  if (changed.has('sync.autoMinutes') || changed.has('sync.provider')) restartSyncTimer();
  if (changed.has('sync.provider') || changed.has('sync.folder.path')) restartFolderWatcher();
  if (changed.has('sync.provider')) {
    if (settings.sync.provider === 'none') broadcastStatus({ state: 'idle', message: '未启用同步' });
    else setTimeout(() => runSync(), 300);
  }
  if (changed.has('edgeHide') && !settings.edgeHide && settings.hidden && win) {
    showFromEdge();
  }
  rebuildTrayMenu();
}

function changedKeys(prev, next, out = new Set(), prefix = '') {
  for (const k of Object.keys(next)) {
    const a = prev ? prev[k] : undefined;
    const b = next[k];
    if (a && b && typeof a === 'object' && typeof b === 'object') changedKeys(a, b, out, prefix + k + '.');
    else if (a !== b) out.add(prefix + k);
  }
  return out;
}

function publicSettings() {
  return JSON.parse(JSON.stringify(settings));
}

// ---------------- 主窗口 ----------------
function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workArea;
  let bounds = { x: Math.round(sw - 1060 > 0 ? sw - 1060 : 40), y: 60, width: 1020, height: 700 };
  const saved = settings.winBounds;
  if (saved && onSomeDisplay(saved)) bounds = saved;

  win = new BrowserWindow({
    ...bounds,
    minWidth: 700,
    minHeight: 500,
    frame: false,
    show: false,
    backgroundColor: settings.theme === 'dark' ? '#1b1d21' : '#f3efe4',
    icon: ICON_PNG,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(WEB_DIR, 'index.html'));

  win.once('ready-to-show', () => {
    edge.lastMoveAt = Date.now();
    // 恢复上次的贴边隐藏状态
    if (settings.hidden && settings.snapped && settings.edgeHide) {
      const wa = workAreaFor(win.getBounds());
      applyHiddenBounds(settings.snapped, wa);
      win.setMovable(false);
      win.show();
      applyTopState();
    } else {
      if (settings.hidden && !settings.edgeHide) {
        settings.hidden = false;
        settings.snapped = null;
        saveSettings();
      }
      win.show();
    }
  });

  win.on('move', onUserMove);
  win.on('resize', () => scheduleBoundsSave());
  win.on('close', (e) => {
    if (!quitting && settings.closeToTray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { win = null; });
}

function onSomeDisplay(b) {
  return screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    return b.x < wa.x + wa.width - 20 && b.x + b.width > wa.x + 20 && b.y < wa.y + wa.height - 20 && b.y + b.height > wa.y + 20;
  });
}

let boundsSaveTimer = null;
function scheduleBoundsSave() {
  clearTimeout(boundsSaveTimer);
  boundsSaveTimer = setTimeout(() => {
    if (win && !win.isDestroyed() && !settings.hidden) {
      settings.winBounds = win.getBounds();
      saveSettings();
    }
  }, 600);
}

function onUserMove() {
  if (!win || win.isDestroyed() || edge.animating) return;
  edge.lastMoveAt = Date.now();
  edge.userMoved = true;
  edge.pendingRetract = false; // 用户主动拖动 = 重新武装贴边隐藏
  scheduleBoundsSave();
  tickEdge();
}

// ---------------- 贴边隐藏 ----------------
const PEEK = 6;          // 隐藏后露出的细边宽度
const SNAP_PX = 14;      // 距边缘多少像素算"贴边"
const HIDE_DELAY = 320;  // 在边缘停留多久后滑出
const RETRACT_MS = 2000; // 鼠标离开多久后自动收回
const POLL_MS = 130;

const edge = {
  animating: false,
  pendingRetract: false, // 刚被唤出、还没被用户拖动过
  lastMoveAt: 0,
  retractArm: 0,
  userMoved: false, // 用户是否拖动过窗口（避免启动时恰好压在边缘就误隐藏）
};

function workAreaFor(bounds) {
  return screen.getDisplayMatching(bounds).workArea;
}

function inSnapZone(b) {
  const wa = workAreaFor(b);
  if (b.x <= wa.x + SNAP_PX) return 'left';
  if (b.x + b.width >= wa.x + wa.width - SNAP_PX) return 'right';
  if (b.y <= wa.y + SNAP_PX) return 'top';
  return null;
}

function hiddenTarget(side, wa, b) {
  if (side === 'top') return { x: b.x, y: wa.y - b.height + PEEK, width: b.width, height: b.height };
  return side === 'left'
    ? { x: wa.x - b.width + PEEK, y: b.y, width: b.width, height: b.height }
    : { x: wa.x + wa.width - PEEK, y: b.y, width: b.width, height: b.height };
}

function shownTarget(side, wa, b) {
  if (side === 'top') return { x: b.x, y: wa.y, width: b.width, height: b.height };
  return side === 'left'
    ? { x: wa.x, y: b.y, width: b.width, height: b.height }
    : { x: wa.x + wa.width - b.width, y: b.y, width: b.width, height: b.height };
}

function applyHiddenBounds(side, wa) {
  const b = win.getBounds();
  win.setBounds(hiddenTarget(side, wa, b));
}

function tickEdge() {
  if (!win || win.isDestroyed() || edge.animating) return;
  const b = win.getBounds();

  // 隐藏状态：光标靠近细边 → 滑出
  if (settings.hidden) {
    if (!settings.edgeHide) return;
    const wa = workAreaFor(b);
    const c = screen.getCursorScreenPoint();
    let hit;
    if (settings.snapped === 'left') {
      hit = c.x >= wa.x - 6 && c.x <= wa.x + PEEK + 6 && c.y >= b.y - 4 && c.y <= b.y + b.height + 4;
    } else if (settings.snapped === 'right') {
      hit = c.x >= wa.x + wa.width - PEEK - 6 && c.x <= wa.x + wa.width + 6 && c.y >= b.y - 4 && c.y <= b.y + b.height + 4;
    } else { // top
      hit = c.y >= wa.y - 6 && c.y <= wa.y + PEEK + 6 && c.x >= b.x - 4 && c.x <= b.x + b.width + 4;
    }
    if (hit) showFromEdge();
    return;
  }

  if (win.isMaximized() || win.isMinimized()) return;

  // 唤出后的自动收回：鼠标离开窗口一段时间
  if (edge.pendingRetract) {
    const c = screen.getCursorScreenPoint();
    const inside = c.x >= b.x - 6 && c.x <= b.x + b.width + 6 && c.y >= b.y - 6 && c.y <= b.y + b.height + 6;
    if (inside) {
      edge.retractArm = 0;
    } else if (settings.autoRetract) {
      if (!edge.retractArm) edge.retractArm = Date.now();
      else if (Date.now() - edge.retractArm > RETRACT_MS && settings.snapped) {
        hideToEdge(settings.snapped);
        return;
      }
    }
    return; // 未被拖动过，不做贴边判定
  }

  // 贴边判定：窗口停在边缘区域一小段时间后滑出
  if (!settings.edgeHide || !edge.userMoved) return;
  const zone = inSnapZone(b);
  if (zone && Date.now() - edge.lastMoveAt > HIDE_DELAY) {
    hideToEdge(zone);
  }
}

async function hideToEdge(side) {
  if (!win || win.isDestroyed() || edge.animating || settings.hidden) return;
  const b = win.getBounds();
  const wa = workAreaFor(b);
  edge.animating = true;
  settings.snapped = side;
  settings.hidden = true;
  saveSettings();
  win.setMovable(false);
  win.setAlwaysOnTop(true, 'screen-saver'); // 细边必须可见
  await animateTo(hiddenTarget(side, wa, b));
  edge.pendingRetract = false;
  edge.retractArm = 0;
  rebuildTrayMenu();
}

async function showFromEdge() {
  if (!win || win.isDestroyed() || edge.animating || !settings.hidden) return;
  const b = win.getBounds();
  const wa = workAreaFor(b);
  edge.animating = true;
  settings.hidden = false;
  saveSettings();
  win.setMovable(true);
  await animateTo(shownTarget(settings.snapped || 'left', wa, b));
  applyTopState();
  edge.pendingRetract = true;
  edge.retractArm = 0;
  edge.lastMoveAt = Date.now();
  rebuildTrayMenu();
}

function animateTo(target, dur = 200) {
  return new Promise((resolve) => {
    const from = win.getBounds();
    const steps = Math.max(6, Math.round(dur / 16));
    let i = 0;
    const timer = setInterval(() => {
      if (!win || win.isDestroyed()) {
        clearInterval(timer);
        return resolve();
      }
      i++;
      const k = 1 - Math.pow(1 - i / steps, 3); // easeOutCubic
      win.setBounds({
        x: Math.round(from.x + (target.x - from.x) * k),
        y: Math.round(from.y + (target.y - from.y) * k),
        width: from.width,
        height: from.height,
      });
      if (i >= steps) {
        clearInterval(timer);
        edge.animating = false;
        win.setBounds(target);
        resolve();
      }
    }, 16);
  });
}

function applyTopState() {
  if (!win || win.isDestroyed()) return;
  if (settings.hidden) {
    win.setAlwaysOnTop(true, 'screen-saver');
  } else {
    win.setAlwaysOnTop(!!settings.alwaysOnTop, 'screen-saver');
  }
}

// ---------------- 速记小窗 ----------------
function toggleQuickWindow() {
  if (quickWin && !quickWin.isDestroyed()) {
    if (quickWin.isVisible()) quickWin.close();
    else quickWin.show();
    return;
  }
  quickWin = new BrowserWindow({
    width: 360,
    height: 260,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    icon: ICON_PNG,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  quickWin.loadFile(path.join(WEB_DIR, 'index.html'), { hash: 'quick' });
  quickWin.on('closed', () => { quickWin = null; });
}

// ---------------- 全局快捷键 ----------------
function registerShortcut() {
  try { globalShortcut.unregister('Control+Alt+B'); } catch (_) {}
  if (settings.quickShortcut) {
    try {
      globalShortcut.register('Control+Alt+B', toggleQuickWindow);
    } catch (e) {
      console.error('全局快捷键注册失败:', e.message);
    }
  }
}

function applyLoginItem() {
  try {
    const exePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    app.setLoginItemSettings({
      openAtLogin: !!settings.launchAtLogin,
      path: exePath,
      args: app.isPackaged ? [] : [path.resolve(__dirname)],
    });
  } catch (e) {
    console.error('设置开机自启失败:', e.message);
  }
}

// ---------------- 托盘 ----------------
function createTray() {
  tray = new Tray(TRAY_PNG);
  tray.setToolTip('桌面便签');
  tray.on('click', () => showMainWindow());
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: '显示 / 隐藏主窗口', click: () => toggleMainWindow() },
    { label: '新建便签', click: () => { showMainWindow(); win && win.webContents.send('action:new-note'); } },
    { label: '速记小窗', click: () => toggleQuickWindow() },
    { label: '设置…', click: () => { showMainWindow(); win && win.webContents.send('action:open-settings'); } },
    { type: 'separator' },
    { label: '置顶显示', type: 'checkbox', checked: !!settings.alwaysOnTop, click: (i) => setSettingPatch({ alwaysOnTop: i.checked }) },
    { label: '贴边隐藏', type: 'checkbox', checked: !!settings.edgeHide, click: (i) => setSettingPatch({ edgeHide: i.checked }) },
    { label: '开机自启', type: 'checkbox', checked: !!settings.launchAtLogin, click: (i) => setSettingPatch({ launchAtLogin: i.checked }) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function showMainWindow() {
  if (!win || win.isDestroyed()) return createWindow();
  if (settings.hidden) return showFromEdge();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleMainWindow() {
  if (!win || win.isDestroyed()) return createWindow();
  if (win.isVisible() && !settings.hidden) win.hide();
  else showMainWindow();
}

function setSettingPatch(patch) {
  const prev = publicSettings();
  deepMerge(settings, patch);
  saveSettings();
  applySettingsEffects(changedKeys(prev, settings));
}

// ---------------- 同步 ----------------
let lastStatus = { state: 'idle', message: '未启用同步', lastOk: null };
let syncing = false;
let syncQueued = false;
let syncTimer = null;
let changeSyncTimer = null;

function broadcastStatus(patch) {
  lastStatus = { ...lastStatus, ...patch };
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('sync:status', lastStatus);
  }
}

// 换电脑场景：云端已有便签时，把本地从未编辑过的示例便签（欢迎/示例）清掉，
// 免得它们跟着同步混进真实数据。改过的（updatedAt != createdAt）不动。
const SEED_IDS = ['n-welcome', 'n-sample'];
function dropUntouchedSeeds(remoteRaw) {
  const remoteNotes = remoteRaw && remoteRaw.notes && typeof remoteRaw.notes === 'object'
    ? Object.keys(remoteRaw.notes).length : 0;
  if (!remoteNotes) return;
  let changed = false;
  for (const id of SEED_IDS) {
    const sn = store.data.notes[id];
    if (sn && sn.createdAt && sn.updatedAt === sn.createdAt) {
      delete store.data.notes[id];
      store.data.tombstones[id] = Date.now();
      changed = true;
    }
  }
  if (changed) store.save();
}

async function runSync() {
  const sc = settings.sync;
  if (!sc || sc.provider === 'none') {
    broadcastStatus({ state: 'idle', message: '未启用同步' });
    return;
  }
  if (syncing) {
    syncQueued = true;
    return;
  }
  syncing = true;
  broadcastStatus({ state: 'syncing', message: '同步中…' });
  try {
    const io = sync.makeIO(sc);
    const remoteRaw = await io.download();
    dropUntouchedSeeds(remoteRaw);
    const localCloud = { notes: store.data.notes, tombstones: store.data.tombstones };
    const { merged, pulled, pushed } = await sync.syncRun(sc, localCloud, io, remoteRaw);
    if (pulled) {
      await store.applyCloud(merged);
      pushState();
    }
    broadcastStatus({
      state: 'ok',
      message: pulled ? '同步成功，已更新' : '已是最新',
      lastOk: Date.now(),
    });
  } catch (e) {
    broadcastStatus({ state: 'error', message: e.message || String(e) });
  } finally {
    syncing = false;
    if (syncQueued) {
      syncQueued = false;
      setTimeout(() => runSync(), 800);
    }
  }
}

function restartSyncTimer() {
  clearInterval(syncTimer);
  syncTimer = null;
  const m = Number(settings.sync.autoMinutes) || 0;
  if (settings.sync.provider !== 'none' && m > 0) {
    syncTimer = setInterval(() => runSync(), m * 60000);
  }
}

function scheduleChangeSync() {
  if (settings.sync.provider === 'none') return;
  clearTimeout(changeSyncTimer);
  changeSyncTimer = setTimeout(() => runSync(), 15000);
}

// ---------------- 同步文件夹的本地文件监听 ----------------
// 另一台电脑通过云盘更新了同一个数据文件时，本机也能及时感知并合并。
let folderWatcher = null;
let folderWatchTimer = null;

function restartFolderWatcher() {
  if (folderWatcher) {
    try { folderWatcher.close(); } catch (_) {}
    folderWatcher = null;
  }
  clearTimeout(folderWatchTimer);
  folderWatchTimer = null;
  const sc = settings.sync || {};
  if (sc.provider !== 'folder' || !sc.folder || !sc.folder.path) return;
  const dir = String(sc.folder.path).trim();
  if (!dir) return;
  try {
    folderWatcher = fs.watch(dir, { persistent: false }, (_ev, fileName) => {
      if (folderWatcher === null) return; // 已关闭
      const target = String(fileName || '');
      const dataFile = sc.folder.fileName || sync.DATA_FILE;
      if (target && target !== dataFile && !target.endsWith('.tmp')) return;
      clearTimeout(folderWatchTimer);
      folderWatchTimer = setTimeout(() => runSync(), 1500);
    });
  } catch (_) {
    // 目录暂时不存在等情况：下次同步/设置变更时会重试
  }
}

function pushState() {
  const payload = JSON.parse(JSON.stringify(store.data));
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('state:changed', payload);
  }
}

// ---------------- 提醒 ----------------
function checkReminders() {
  if (!store) return;
  const now = Date.now();
  let changed = false;
  for (const n of Object.values(store.data.notes)) {
    if (n.reminderAt && !n.reminded && !n.done && n.reminderAt <= now) {
      n.reminded = true;
      changed = true;
      if (Notification.isSupported()) {
        const notice = new Notification({
          title: '便签提醒',
          body: (n.title || n.body || '（无标题）').slice(0, 120),
          icon: ICON_PNG,
        });
        notice.on('click', () => showMainWindow());
        notice.show();
      }
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('note:reminder', { id: n.id });
      }
    }
  }
  if (changed) store.save();
}

// ---------------- IPC ----------------
// 便签字段规整统一走共享核心，保证网页版与桌面版对同一条便签的处理结果一致
const sanitizeNote = core.sanitizeNote;

function registerIpc() {
  ipcMain.handle('state:load', () => JSON.parse(JSON.stringify(store.data)));

  ipcMain.handle('note:save', (e, input) => {
    const n = sanitizeNote(input);
    if (!n) return false;
    store.data.notes[n.id] = n;
    store.save();
    scheduleChangeSync();
    return true;
  });

  ipcMain.handle('note:delete', (e, id) => {
    if (!store.data.notes[id]) return false;
    delete store.data.notes[id];
    store.data.tombstones[id] = Date.now();
    store.save();
    scheduleChangeSync();
    return true;
  });

  ipcMain.handle('settings:get', () => publicSettings());

  ipcMain.handle('settings:set', (e, patch) => {
    setSettingPatch(patch || {});
    return publicSettings();
  });

  ipcMain.handle('win:minimize', () => win && win.minimize());
  ipcMain.handle('win:maximize', () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle('win:close', () => {
    if (!win) return;
    if (settings.closeToTray && !quitting) win.hide();
    else app.quit();
  });

  ipcMain.handle('sync:now', async () => {
    await runSync();
    return lastStatus;
  });
  ipcMain.handle('sync:status', () => lastStatus);

  ipcMain.handle('gist:create', async (e, token) => {
    const id = await sync.gistCreate(String(token || '').trim());
    setSettingPatch({ sync: { gist: { id } } });
    return id;
  });

  ipcMain.handle('shell:openExternal', (e, url) => {
    if (typeof url === 'string' && /^https:/i.test(url)) shell.openExternal(url);
    return true;
  });

  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择同步文件夹（放进云盘同步目录即可跨电脑同步）',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('clipboard:writeText', (e, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });
  ipcMain.handle('clipboard:readText', () => clipboard.readText());

  ipcMain.handle('quick:save', (e, text) => {
    const body = String(text || '').trim();
    if (!body) return null;
    const note = core.newNote({ body, color: settings.defaultColor || 'yellow' }, store.data);
    store.data.notes[note.id] = note;
    store.save();
    scheduleChangeSync();
    pushState();
    return note.id;
  });

  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:check-update', () => checkForUpdate(true));

  ipcMain.handle('data:export', async () => {
    const r = await dialog.showSaveDialog(win, {
      title: '导出便签数据',
      defaultPath: `bianqian-backup-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, JSON.stringify({ ...JSON.parse(JSON.stringify(store.data)), exportedAt: new Date().toISOString() }, null, 2), 'utf8');
    return r.filePath;
  });

  ipcMain.handle('data:import', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '导入便签数据（与现有内容合并）',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const raw = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    const local = JSON.parse(JSON.stringify(store.data));
    const merged = sync.mergeCloud(local, raw);
    await store.applyCloud(merged);
    pushState();
    scheduleChangeSync();
    return { ok: true, count: Object.keys(merged.notes).length };
  });
}

// ---------------- 自动更新 ----------------
// 便签数据本身通过云同步跨电脑；程序版本则从 GitHub Releases 检查新版本，
// 发现后提示用户下载替换（便携版无需安装，覆盖 exe 即可）。
const RELEASES_API = 'https://api.github.com/repos/Runningthomas/bianqian/releases/latest';
const RELEASES_PAGE = 'https://github.com/Runningthomas/bianqian/releases';

function compareVersion(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function checkForUpdate(manual) {
  try {
    const res = await fetch(RELEASES_API, {
      headers: { 'User-Agent': 'BianQian/2.0', Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const rel = await res.json();
    const latest = (rel.tag_name || '').replace(/^v/, '');
    const current = app.getVersion();
    if (!latest || compareVersion(latest, current) <= 0) {
      return { state: 'ok', upToDate: true, current, latest: latest || current, message: '已是最新版本' };
    }
    if (manual) {
      const choice = await dialog.showMessageBox(win, {
        type: 'info',
        buttons: ['去下载', '稍后'],
        defaultId: 0,
        cancelId: 1,
        title: '发现新版本',
        message: `发现新版本 v${latest}（当前 v${current}）`,
        detail: '点击「去下载」打开下载页面，下载后直接替换旧的 exe 即可。',
      });
      if (choice.response === 0) shell.openExternal(RELEASES_PAGE);
    }
    return { state: 'ok', upToDate: false, current, latest, url: RELEASES_PAGE, message: `发现新版本 v${latest}` };
  } catch (e) {
    return { state: 'error', message: '检查更新失败：' + (e.message || e) };
  }
}

// ---------------- 首次运行的示例数据 ----------------
function seedIfFirstRun() {
  if (fs.existsSync(DATA_PATH)) return;
  const now = Date.now();
  store.data.notes['n-welcome'] = {
    id: 'n-welcome',
    title: '欢迎使用桌面便签 👋',
    body: '几点小技巧：\n· 把窗口拖到屏幕左/右/顶部边缘，会自动滑出只留一条细边，鼠标移过去即可唤出\n· 顶栏 📌 可以让便签始终置顶\n· 切换到「四象限」视图，把便签拖进对应象限分类\n· ⚙ 设置里可以开启云同步，换电脑数据不丢',
    items: [],
    color: 'yellow',
    quadrant: null,
    pinned: false,
    done: false,
    reminderAt: null,
    reminded: false,
    order: 1,
    createdAt: now,
    updatedAt: now,
  };
  store.data.notes['n-sample'] = {
    id: 'n-sample',
    title: '示例：今天要交的周报',
    body: '',
    items: [
      { id: 'i1', text: '整理本周进展', done: false },
      { id: 'i2', text: '写下周计划', done: false },
    ],
    color: 'blue',
    quadrant: 1,
    pinned: false,
    done: false,
    reminderAt: null,
    reminded: false,
    order: 2,
    createdAt: now,
    updatedAt: now,
  };
  store.save();
}

// ---------------- 启动 ----------------
app.on('second-instance', () => showMainWindow());

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  fs.mkdirSync(USER_DATA, { recursive: true });
  store = new Store(DATA_PATH);
  seedIfFirstRun();
  registerIpc();
  createWindow();
  createTray();
  registerShortcut();
  applyLoginItem();
  restartSyncTimer();
  restartFolderWatcher();
  setInterval(checkReminders, 20000);
  setInterval(tickEdge, POLL_MS);
  if (settings.sync.provider !== 'none' && settings.sync.syncOnLaunch !== false) {
    setTimeout(() => runSync(), 2000);
  }
  if (settings.sync.provider === 'none') broadcastStatus({ state: 'idle', message: '未启用同步' });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showMainWindow();
  });
});

app.on('before-quit', () => {
  quitting = true;
  try { globalShortcut.unregisterAll(); } catch (_) {}
  try { store && store.flushSync(); } catch (_) {}
  saveSettings();
});

app.on('window-all-closed', () => {
  // 有托盘常驻，不退出
  if (quitting) app.quit();
});
