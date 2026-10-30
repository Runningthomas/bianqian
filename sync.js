'use strict';
// 云同步模块：纯 JS，不依赖 Electron，可在 Node 里直接测试。
// 云端数据形态: { ver: 1, syncedAt, notes: {id: note}, tombstones: {id: 删除时间戳} }
// 支持三种后端：同步文件夹（云盘目录，最简单）、WebDAV（坚果云等）、GitHub Gist。
//
// 合并算法与数据模型统一放在 web/core.js，网页版与桌面版共用同一份实现，
// 保证两端同步行为完全一致（不会出现"网页版和桌面版合并不一样"的问题）。

const fs = require('fs');
const path = require('path');
const core = require('./web/core.js');

const DATA_FILE = core.DATA_FILE;
const emptyCloud = core.emptyCloud;
const normalizeCloud = core.normalizeCloud;
const mergeCloud = core.mergeCloud;
const canon = core.canon;
const GIST_API = 'https://api.github.com/gists';
const UA = 'BianQian/2.0';

async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ---------------- WebDAV ----------------
function webdavUrls(cfg) {
  let base = (cfg.url || '').trim();
  if (!base) throw new Error('WebDAV 服务器地址未填写');
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
  if (!base.endsWith('/')) base += '/';
  const dir = (cfg.dir || 'BianQian').trim().replace(/^\/+|\/+$/g, '');
  const dirUrl = dir ? base + dir + '/' : base;
  return { base, dirUrl, fileUrl: dirUrl + DATA_FILE };
}

function webdavHeaders(cfg, withBody) {
  const auth = 'Basic ' + Buffer.from((cfg.user || '') + ':' + (cfg.pass || '')).toString('base64');
  const h = { Authorization: auth, 'User-Agent': UA };
  if (withBody) h['Content-Type'] = 'application/json';
  return h;
}

async function webdavDownload(cfg) {
  const { fileUrl } = webdavUrls(cfg);
  const res = await fetchWithTimeout(fileUrl, { method: 'GET', headers: webdavHeaders(cfg, false) });
  if (res.status === 404) return null; // 首次使用，云端还没有数据
  if (res.status === 401) throw new Error('WebDAV 账号或密码错误（401）');
  if (!res.ok) throw new Error('云端下载失败：HTTP ' + res.status);
  const text = await res.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error('云端数据不是有效的 JSON（同步文件可能被其他软件改动）');
  }
}

async function webdavUpload(cfg, cloud) {
  const { dirUrl, fileUrl } = webdavUrls(cfg);
  const body = JSON.stringify({ ...cloud, syncedAt: new Date().toISOString() });
  let res = await fetchWithTimeout(fileUrl, {
    method: 'PUT',
    headers: webdavHeaders(cfg, true),
    body,
  });
  if (!res.ok) {
    // 目录可能不存在（坚果云新目录），先建目录再重试一次
    await fetchWithTimeout(dirUrl, { method: 'MKCOL', headers: webdavHeaders(cfg, false) }).catch(() => {});
    res = await fetchWithTimeout(fileUrl, {
      method: 'PUT',
      headers: webdavHeaders(cfg, true),
      body,
    });
  }
  if (res.status === 401) throw new Error('WebDAV 账号或密码错误（401）');
  if (!res.ok) throw new Error('云端上传失败：HTTP ' + res.status);
}

// ---------------- 同步文件夹 ----------------
// 数据文件放在用户指定的目录（例如 OneDrive / 坚果云同步盘 / WPS 云盘的子目录）。
// 该目录本身由云盘客户端负责跨电脑同步，因此软件内不需要任何账号/密码。
function folderInfo(cfg) {
  const dir = String((cfg && cfg.path) || '').trim();
  if (!dir) throw new Error('请先选择同步文件夹');
  const fileName = (cfg && cfg.fileName) || DATA_FILE;
  return { dir, filePath: path.join(dir, fileName) };
}

async function folderDownload(cfg) {
  const { filePath } = folderInfo(cfg);
  let raw = null;
  try {
    if (!fs.existsSync(filePath)) return null; // 首次使用，云端还没有数据
    raw = await fs.promises.readFile(filePath, 'utf8');
  } catch (e) {
    throw new Error('无法读取同步文件：' + e.message);
  }
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    throw new Error('同步文件不是有效的 JSON（可能正被云盘占用，或文件被其他软件改动）');
  }
}

async function folderUpload(cfg, cloud) {
  const { dir, filePath } = folderInfo(cfg);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const body = JSON.stringify({ ...cloud, syncedAt: new Date().toISOString() });
    const tmp = filePath + '.tmp-' + process.pid;
    await fs.promises.writeFile(tmp, body, 'utf8');
    await fs.promises.rename(tmp, filePath);
  } catch (e) {
    throw new Error('无法写入同步文件（云盘正在同步时请稍候重试）：' + e.message);
  }
}

// ---------------- GitHub Gist ----------------
function gistHeaders(token) {
  return {
    Authorization: 'Bearer ' + token,
    'User-Agent': UA,
    Accept: 'application/vnd.github+json',
  };
}

async function gistDownload(cfg) {
  if (!cfg.token || !cfg.id) throw new Error('请先在设置中填写 GitHub Token 和 Gist ID');
  const res = await fetchWithTimeout(`${GIST_API}/${cfg.id}`, { headers: gistHeaders(cfg.token) });
  if (res.status === 404) throw new Error('找不到该 Gist（ID 填错，或 Token 没有它的权限）');
  if (res.status === 401) throw new Error('GitHub Token 无效（401）');
  if (!res.ok) throw new Error('云端下载失败：HTTP ' + res.status);
  const data = await res.json();
  const files = (data && data.files) || {};
  const f = files[DATA_FILE] || Object.values(files)[0];
  if (!f || !f.content) return null;
  try {
    return JSON.parse(f.content);
  } catch (_) {
    throw new Error('云端数据不是有效的 JSON');
  }
}

async function gistUpload(cfg, cloud) {
  if (!cfg.token || !cfg.id) throw new Error('请先在设置中填写 GitHub Token 和 Gist ID');
  const content = JSON.stringify({ ...cloud, syncedAt: new Date().toISOString() });
  const res = await fetchWithTimeout(`${GIST_API}/${cfg.id}`, {
    method: 'PATCH',
    headers: gistHeaders(cfg.token),
    body: JSON.stringify({ files: { [DATA_FILE]: { content } } }),
  });
  if (res.status === 404) throw new Error('找不到该 Gist（ID 填错，或 Token 没有它的权限）');
  if (res.status === 401) throw new Error('GitHub Token 无效（401）');
  if (!res.ok) throw new Error('云端上传失败：HTTP ' + res.status);
}

// 用 Token 自动创建一个私有 Gist，返回 id
async function gistCreate(token) {
  if (!token) throw new Error('请先填写 GitHub Token');
  const res = await fetchWithTimeout(GIST_API, {
    method: 'POST',
    headers: gistHeaders(token),
    body: JSON.stringify({
      description: '桌面便签（BianQian）云同步数据',
      public: false,
      files: { [DATA_FILE]: { content: JSON.stringify(emptyCloud()) } },
    }),
  });
  if (res.status === 401) throw new Error('GitHub Token 无效（401）');
  if (!res.ok) throw new Error('创建 Gist 失败：HTTP ' + res.status);
  const data = await res.json();
  if (!data || !data.id) throw new Error('创建 Gist 失败：响应异常');
  return data.id;
}

// ---------------- 统一调度 ----------------
// 根据 settings.sync 生成 { download, upload }
function makeIO(syncCfg) {
  const p = syncCfg && syncCfg.provider;
  if (p === 'folder') {
    const cfg = syncCfg.folder || {};
    return { download: () => folderDownload(cfg), upload: (c) => folderUpload(cfg, c) };
  }
  if (p === 'webdav') {
    const cfg = syncCfg.webdav || {};
    return { download: () => webdavDownload(cfg), upload: (c) => webdavUpload(cfg, c) };
  }
  if (p === 'gist') {
    const cfg = syncCfg.gist || {};
    return { download: () => gistDownload(cfg), upload: (c) => gistUpload(cfg, c) };
  }
  throw new Error('未启用同步');
}

// 完整一次同步：拉云端 -> 合并 -> 有差异则推回。
// remoteRaw 可选：调用方已下载过云端数据时直接传入（null 表示云端为空），省一次下载。
// 返回 { merged, pulled, pushed }
async function syncRun(syncCfg, localCloud, io, remoteRaw) {
  const raw = remoteRaw === undefined ? await io.download() : remoteRaw;
  const remote = raw ? normalizeCloud(raw) : emptyCloud();
  const merged = mergeCloud(localCloud, remote);
  const pulled = canon(merged) !== canon(localCloud);
  const pushed = !remoteRaw || canon(merged) !== canon(remote);
  if (pushed) await io.upload(merged);
  return { merged, pulled, pushed };
}

module.exports = {
  DATA_FILE,
  emptyCloud,
  normalizeCloud,
  mergeCloud,
  makeIO,
  syncRun,
  folderDownload,
  folderUpload,
  webdavDownload,
  webdavUpload,
  gistDownload,
  gistUpload,
  gistCreate,
};
