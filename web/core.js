'use strict';
/**
 * 共享核心：数据模型 + 合并算法（LWW）+ 设置默认值 + 同步设置码编解码。
 *
 * 这份文件被两端同时加载：
 *   - Node 端：sync.js / main.js 用 require('./web/core.js')
 *   - 浏览器端：web/index.html 用 <script src="core.js"> 加载
 * 所以必须是 UMD 风格，且不依赖任何运行环境特有的 API。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BQCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DATA_FILE = 'bianqian-data.json';

  // 便签字段白名单。quadrant 是历史字段（老版本四象限），保留以兼容历史数据，新界面不再使用。
  const NOTE_FIELDS = [
    'id', 'title', 'body', 'items', 'color', 'quadrant',
    'pinned', 'done', 'reminderAt', 'reminded',
    'order', 'x', 'y', 'createdAt', 'updatedAt',
  ];

  // 便签纸配色 + 对应的小 mascot（灵感来自「小孩桌面便签」的皮肤：小奶牛/小黄鸡/红狐狸/粉红小兔）
  const COLORS = ['yellow', 'blue', 'green', 'purple', 'pink', 'gray'];
  const MASQUOTS = {
    yellow: '🐤', blue: '📘', green: '🐮', purple: '🦊', pink: '🐰', gray: '🗒️',
  };

  const DEFAULT_SETTINGS = {
    theme: 'system',
    defaultColor: 'yellow',
    alwaysOnTop: true,
    edgeHide: true,
    autoRetract: true,
    closeToTray: true,
    launchAtLogin: false,
    quickShortcut: true,
    autoUpdate: true,
    sync: {
      provider: 'none', // none | folder | webdav | gist
      preset: 'jianguoyun',
      autoMinutes: 5,
      syncOnLaunch: true,
      webdav: { url: 'https://dav.jianguoyun.com/dav/', user: '', pass: '', dir: 'BianQian' },
      gist: { token: '', id: '' },
      folder: { path: '', fileName: DATA_FILE },
    },
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function emptyCloud() {
    return { ver: 1, notes: {}, tombstones: {} };
  }

  function normalizeCloud(raw) {
    const c = emptyCloud();
    if (raw && typeof raw === 'object') {
      if (raw.notes && typeof raw.notes === 'object') c.notes = raw.notes;
      if (raw.tombstones && typeof raw.tombstones === 'object') c.tombstones = raw.tombstones;
    }
    return c;
  }

  function canon(c) {
    return JSON.stringify({ notes: (c && c.notes) || {}, tombstones: (c && c.tombstones) || {} });
  }

  /**
   * 合并：逐条 LWW（updatedAt 新者胜）；墓碑时间 >= 便签 updatedAt 时按已删除处理。
   * 同一便签在两台设备上同时被改，保留 updatedAt 较新的那份。
   */
  function mergeCloud(local, remote) {
    local = normalizeCloud(local);
    remote = normalizeCloud(remote);
    const ids = new Set([
      ...Object.keys(local.notes),
      ...Object.keys(remote.notes),
      ...Object.keys(local.tombstones),
      ...Object.keys(remote.tombstones),
    ]);
    const notes = {};
    const tombstones = {};
    for (const id of ids) {
      const ln = local.notes[id];
      const rn = remote.notes[id];
      const lt = local.tombstones[id] || 0;
      const rt = remote.tombstones[id] || 0;
      const tomb = Math.max(lt, rt);
      const live = Math.max(ln ? ln.updatedAt || 0 : 0, rn ? rn.updatedAt || 0 : 0);
      if (tomb > 0 && tomb >= live) {
        tombstones[id] = tomb;
        continue;
      }
      if (ln && rn) notes[id] = (ln.updatedAt || 0) >= (rn.updatedAt || 0) ? ln : rn;
      else if (ln || rn) notes[id] = ln || rn;
    }
    return { notes, tombstones };
  }

  /** 规整一条便签，剔除未知字段并做类型收敛。updatedAt 统一由本地时钟刷新。 */
  function sanitizeNote(input) {
    const n = {};
    for (const k of NOTE_FIELDS) if (input[k] !== undefined) n[k] = input[k];
    n.id = String(n.id || '');
    if (!n.id) return null;
    n.title = String(n.title || '');
    n.body = String(n.body || '');
    n.items = Array.isArray(n.items)
      ? n.items
        .filter((it) => it && typeof it === 'object')
        .map((it) => ({ id: String(it.id || ''), text: String(it.text || ''), done: !!it.done }))
        .filter((it) => it.id)
      : [];
    n.color = COLORS.includes(n.color) ? n.color : 'yellow';
    n.quadrant = [1, 2, 3, 4].includes(n.quadrant) ? n.quadrant : null;
    n.pinned = !!n.pinned;
    n.done = !!n.done;
    n.reminderAt = Number(n.reminderAt) || null;
    n.reminded = !!n.reminded;
    n.order = Number(n.order) || 0;
    n.x = Number.isFinite(Number(n.x)) ? Number(n.x) : null;
    n.y = Number.isFinite(Number(n.y)) ? Number(n.y) : null;
    n.updatedAt = Date.now();
    n.createdAt = Number(n.createdAt) || n.updatedAt;
    return n;
  }

  /** 新建一条便签。maxOrder 取现有便签的最大 order，保证追加到末尾。 */
  function newNote(patch, existing) {
    const now = Date.now();
    const notes = (existing && existing.notes) || {};
    const maxOrder = Math.max(0, ...Object.values(notes).map((n) => n.order || 0));
    return {
      id: 'n' + now.toString(36) + Math.random().toString(36).slice(2, 7),
      title: '', body: '', items: [],
      color: 'yellow',
      quadrant: null,
      pinned: false,
      done: false,
      reminderAt: null,
      reminded: false,
      order: maxOrder + 1,
      x: null,
      y: null,
      createdAt: now,
      updatedAt: now,
      ...(patch || {}),
    };
  }

  /** 合并设置补丁（浅层 + sync 子对象深一层）。 */
  function applySettings(base, patch) {
    const out = clone(base);
    if (!patch || typeof patch !== 'object') return out;
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
        out[k] = Object.assign({}, out[k], v);
      } else if (v !== undefined) {
        out[k] = v;
      }
    }
    return out;
  }

  /**
   * 同步设置码：base64(JSON)，只含账号类配置，不含便签正文。
   * 桌面端「复制本机同步设置」与网页端「粘贴设置码」共用这一格式。
   */
  function buildSyncCode(settings) {
    const sc = (settings && settings.sync) || {};
    const payload = {
      v: 1,
      provider: sc.provider || 'gist',
      preset: sc.preset || 'jianguoyun',
      autoMinutes: sc.autoMinutes || 5,
      syncOnLaunch: sc.syncOnLaunch !== false,
      webdav: sc.webdav || {},
      gist: sc.gist || {},
    };
    return btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  }

  function parseSyncCode(raw) {
    try {
      const obj = JSON.parse(decodeURIComponent(escape(atob(String(raw || '').trim()))));
      if (!obj || obj.v !== 1) return null;
      if (!['none', 'folder', 'webdav', 'gist'].includes(obj.provider)) return null;
      return obj;
    } catch (_) {
      return null;
    }
  }

  return {
    DATA_FILE,
    NOTE_FIELDS,
    COLORS,
    MASQUOTS,
    DEFAULT_SETTINGS,
    emptyCloud,
    normalizeCloud,
    canon,
    mergeCloud,
    sanitizeNote,
    newNote,
    applySettings,
    buildSyncCode,
    parseSyncCode,
  };
});
