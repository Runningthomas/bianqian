'use strict';
/**
 * 平台适配层：把「数据存取 / 设置 / 同步」抽象成一组异步接口。
 *
 * 桌面版（Electron）：window.api 由 preload 注入，走 IPC → 本地文件 + Node 侧同步。
 * 网页版（浏览器）：这里的实现直接用 localStorage + fetch 走 GitHub Gist。
 *
 * 上层 app.js 只认这套接口，不关心自己跑在哪个环境。
 */
(function (global) {
  const C = global.BQCore;

  // ---------------- 网页版实现 ----------------
  const LS_DATA = 'bianqian.data.v2';
  const LS_SET = 'bianqian.settings.v2';

  function webStore() {
    let data = C.emptyCloud();
    try {
      const raw = localStorage.getItem(LS_DATA);
      if (raw) data = C.normalizeCloud(JSON.parse(raw));
    } catch (_) {}
    return data;
  }

  let _data = webStore();
  let _settings = (function () {
    try {
      const raw = localStorage.getItem(LS_SET);
      if (raw) return C.applySettings(C.DEFAULT_SETTINGS, JSON.parse(raw));
    } catch (_) {}
    return C.applySettings(C.DEFAULT_SETTINGS, {});
  })();

  const listeners = { state: [], settings: [], sync: [], reminder: [] };
  function emit(kind, payload) {
    for (const cb of listeners[kind] || []) {
      try { cb(payload); } catch (_) {}
    }
  }

  function persist() {
    try { localStorage.setItem(LS_DATA, JSON.stringify(_data)); } catch (_) {}
  }

  function persistSettings() {
    try { localStorage.setItem(LS_SET, JSON.stringify(_settings)); } catch (_) {}
  }

  // ---------- Gist 客户端（浏览器端）----------
  const GIST_API = 'https://api.github.com/gists';
  const UA = 'BianQian-Web/2.0';

  function gistHeaders(token) {
    return {
      Authorization: 'Bearer ' + token,
      'User-Agent': UA,
      Accept: 'application/vnd.github+json',
    };
  }

  async function gistDownload(cfg) {
    if (!cfg.token || !cfg.id) throw new Error('请先填写 GitHub Token 和 Gist ID');
    const res = await fetch(`${GIST_API}/${cfg.id}`, { headers: gistHeaders(cfg.token) });
    if (res.status === 401) throw new Error('GitHub Token 无效（401）');
    if (res.status === 404) throw new Error('找不到该 Gist（ID 填错，或 Token 没有它的权限）');
    if (!res.ok) throw new Error('云端下载失败：HTTP ' + res.status);
    const data = await res.json();
    const files = (data && data.files) || {};
    const f = files[C.DATA_FILE] || Object.values(files)[0];
    if (!f || !f.content) return null;
    try {
      return JSON.parse(f.content);
    } catch (_) {
      throw new Error('云端数据不是有效的 JSON');
    }
  }

  async function gistUpload(cfg, cloud) {
    if (!cfg.token || !cfg.id) throw new Error('请先填写 GitHub Token 和 Gist ID');
    const content = JSON.stringify({ ...cloud, syncedAt: new Date().toISOString() });
    const res = await fetch(`${GIST_API}/${cfg.id}`, {
      method: 'PATCH',
      headers: gistHeaders(cfg.token),
      body: JSON.stringify({ files: { [C.DATA_FILE]: { content } } }),
    });
    if (res.status === 401) throw new Error('GitHub Token 无效（401）');
    if (res.status === 404) throw new Error('找不到该 Gist');
    if (!res.ok) throw new Error('云端上传失败：HTTP ' + res.status);
  }

  async function gistCreate(token) {
    if (!token) throw new Error('请先填写 GitHub Token');
    const res = await fetch(GIST_API, {
      method: 'POST',
      headers: gistHeaders(token),
      body: JSON.stringify({
        description: '桌面便签（BianQian）云同步数据',
        public: false,
        files: { [C.DATA_FILE]: { content: JSON.stringify(C.emptyCloud()) } },
      }),
    });
    if (res.status === 401) throw new Error('GitHub Token 无效（401）');
    if (!res.ok) throw new Error('创建 Gist 失败：HTTP ' + res.status);
    const data = await res.json();
    if (!data || !data.id) throw new Error('创建 Gist 失败：响应异常');
    return data.id;
  }

  // ---------- 同步调度 ----------
  let syncStatus = { state: 'idle', message: '未启用同步', lastOk: null };
  let syncTimer = null;
  let syncBusy = false;

  function setStatus(patch) {
    syncStatus = { ...syncStatus, ...patch };
    emit('sync', syncStatus);
  }

  async function runSync() {
    const sc = _settings.sync || {};
    if (!sc.provider || sc.provider === 'none' || sc.provider === 'folder' || sc.provider === 'webdav') {
      // 网页版只支持 Gist；文件夹/WebDAV 属于桌面专属能力
      setStatus({ state: 'idle', message: sc.provider && sc.provider !== 'none' ? '网页版仅支持 GitHub 同步' : '未启用同步' });
      return syncStatus;
    }
    if (syncBusy) return syncStatus;
    syncBusy = true;
    setStatus({ state: 'syncing', message: '同步中…' });
    try {
      const cfg = sc.gist || {};
      const remoteRaw = await gistDownload(cfg);
      const localCloud = { notes: _data.notes, tombstones: _data.tombstones };
      const merged = C.mergeCloud(localCloud, remoteRaw);
      const pulled = C.canon(merged) !== C.canon(localCloud);
      if (pulled) {
        _data.notes = merged.notes;
        _data.tombstones = merged.tombstones;
        persist();
        emit('state', JSON.parse(JSON.stringify(_data)));
      }
      await gistUpload(cfg, merged);
      setStatus({
        state: 'ok',
        message: pulled ? '同步成功，已更新' : '已是最新',
        lastOk: Date.now(),
      });
    } catch (e) {
      setStatus({ state: 'error', message: e.message || String(e) });
    } finally {
      syncBusy = false;
    }
    return syncStatus;
  }

  function restartTimer() {
    clearInterval(syncTimer);
    syncTimer = null;
    const sc = _settings.sync || {};
    const m = Number(sc.autoMinutes) || 0;
    if (sc.provider === 'gist' && m > 0) syncTimer = setInterval(runSync, m * 60000);
  }

  let changeTimer = null;
  function scheduleChangeSync() {
    const sc = _settings.sync || {};
    if (sc.provider !== 'gist') return;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(runSync, 8000);
  }

  // ---------- 提醒 ----------
  function checkReminders() {
    const now = Date.now();
    let changed = false;
    for (const n of Object.values(_data.notes)) {
      if (n.reminderAt && !n.reminded && !n.done && n.reminderAt <= now) {
        n.reminded = true;
        changed = true;
        emit('reminder', { id: n.id });
        try {
          if (global.Notification && Notification.permission === 'granted') {
            new Notification('便签提醒', { body: (n.title || n.body || '（无标题）').slice(0, 120) });
          }
        } catch (_) {}
      }
    }
    if (changed) persist();
  }
  setInterval(checkReminders, 20000);

  // ---------------- 网页版 API ----------------
  const webApi = {
    isDesktop: false,
    runtime: 'web',

    loadState: async () => JSON.parse(JSON.stringify(_data)),
    saveNote: async (note) => {
      const n = C.sanitizeNote(note);
      if (!n) return false;
      _data.notes[n.id] = n;
      persist();
      scheduleChangeSync();
      return true;
    },
    deleteNote: async (id) => {
      if (!_data.notes[id]) return false;
      delete _data.notes[id];
      _data.tombstones[id] = Date.now();
      persist();
      scheduleChangeSync();
      return true;
    },

    getSettings: async () => JSON.parse(JSON.stringify(_settings)),
    setSettings: async (patch) => {
      _settings = C.applySettings(_settings, patch);
      persistSettings();
      restartTimer();
      emit('settings', JSON.parse(JSON.stringify(_settings)));
      return JSON.parse(JSON.stringify(_settings));
    },

    syncNow: runSync,
    getSyncStatus: async () => syncStatus,
    createGist: gistCreate,

    onStateChanged: (cb) => listeners.state.push(cb),
    onSettingsChanged: (cb) => listeners.settings.push(cb),
    onSyncStatus: (cb) => listeners.sync.push(cb),
    onReminder: (cb) => listeners.reminder.push(cb),

    exportData: async () => {
      const blob = new Blob([JSON.stringify({ ...JSON.parse(JSON.stringify(_data)), exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `bianqian-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return a.download;
    },
    importData: async () => {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.onchange = async () => {
          const f = input.files && input.files[0];
          if (!f) return resolve(null);
          try {
            const raw = JSON.parse(await f.text());
            const merged = C.mergeCloud({ notes: _data.notes, tombstones: _data.tombstones }, raw);
            _data.notes = merged.notes;
            _data.tombstones = merged.tombstones;
            persist();
            emit('state', JSON.parse(JSON.stringify(_data)));
            scheduleChangeSync();
            resolve({ ok: true, count: Object.keys(merged.notes).length });
          } catch (e) {
            resolve({ ok: false, error: e.message });
          }
        };
        input.click();
      });
    },

    clipboardWrite: async (text) => {
      try { await navigator.clipboard.writeText(String(text || '')); return true; } catch (_) { return false; }
    },
    openExternal: async (url) => {
      if (typeof url === 'string' && /^https:/i.test(url)) global.open(url, '_blank', 'noopener');
      return true;
    },
    notify: async (title, body) => {
      try {
        if (global.Notification && Notification.permission === 'granted') new Notification(title, { body });
        else if (global.Notification && Notification.permission === 'default') await Notification.requestPermission();
      } catch (_) {}
      return true;
    },
    getVersion: async () => 'web',
  };

  // ---------------- 选择实现 ----------------
  // 桌面版：preload 已注入 window.api（IPC 通道），直接用它。
  // 注意：contextBridge 暴露的对象是只读的，不能给 window.api 追加属性。
  // 桌面/网页的区分改用 preload 已提供的 isDesktop 字段；桌面端 preload 已内置该字段。
  if (global.api && typeof global.api.loadState === 'function') {
    return;
  }
  global.api = webApi;

  // 网页版启动即同步一次（若已配置）
  if (_settings.sync && _settings.sync.provider === 'gist' && _settings.sync.syncOnLaunch !== false) {
    setTimeout(runSync, 1200);
  }
  restartTimer();

  // 页面隐藏时落盘
  global.addEventListener('beforeunload', persist);
})(window);
