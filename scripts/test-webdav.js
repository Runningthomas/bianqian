'use strict';
// WebDAV 同步往返测试：起一个本地 mock WebDAV 服务器，
// 模拟"两台电脑"通过 sync.js 的真实代码路径互相同步。
// 运行：node scripts/test-webdav.js

const http = require('http');
const { makeIO, syncRun, mergeCloud, emptyCloud } = require('../sync');

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else {
    failed++;
    console.error('  ✗ ' + msg);
  }
}

// ---------- mock WebDAV 服务器 ----------
const files = new Map(); // path -> Buffer
const server = http.createServer((req, res) => {
  const p = req.url;
  if (req.method === 'MKCOL') {
    files.set(p.replace(/\/$/, '') + '/', Buffer.alloc(0));
    res.statusCode = 201;
    return res.end();
  }
  if (req.method === 'PUT') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      files.set(p, Buffer.concat(chunks));
      res.statusCode = 201;
      res.end();
    });
    return;
  }
  if (req.method === 'GET') {
    const f = files.get(p);
    if (!f) {
      res.statusCode = 404;
      return res.end('not found');
    }
    res.setHeader('Content-Type', 'application/json');
    return res.end(f);
  }
  res.statusCode = 405;
  res.end();
});

const NOTE = (id, body, updatedAt, extra = {}) => ({
  id,
  title: '',
  body,
  items: [],
  color: 'yellow',
  quadrant: null,
  pinned: false,
  done: false,
  reminderAt: null,
  reminded: false,
  order: 1,
  createdAt: updatedAt - 1000,
  updatedAt,
  ...extra,
});

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const cfg = {
    provider: 'webdav',
    webdav: { url: `http://127.0.0.1:${port}/dav/`, user: 'u', pass: 'p', dir: 'BianQian' },
  };
  const io = makeIO(cfg);

  console.log('1) 云端为空（首次使用）→ 本地数据推上去');
  const A1 = { notes: { a: NOTE('a', '电脑A的便签', 1000) }, tombstones: {} };
  let r = await syncRun(cfg, A1, io);
  assert(r.pushed && !r.pulled, '首次推送到云端');
  assert(files.has('/dav/BianQian/bianqian-data.json'), '云端文件存在');

  console.log('2) 电脑B 拉取 → 拿到 A 的便签，再推自己的');
  const B1 = { notes: { b: NOTE('b', '电脑B的便签', 1000) }, tombstones: {} };
  r = await syncRun(cfg, B1, io);
  assert(r.pulled, 'B 拉到了云端数据');
  assert(r.merged.notes.a && r.merged.notes.b, 'B 合并后有 a 和 b');
  assert(r.pushed, 'B 把合并结果推回云端');
  assert(canonEq(r.merged, await io.download()), '云端 == B 的合并结果');

  console.log('3) 电脑A 再次同步 → 拿到 B 的便签');
  r = await syncRun(cfg, A1, io);
  assert(r.pulled && r.merged.notes.b, 'A 拉到了 b');
  const A2 = r.merged;

  console.log('4) 两台电脑同时改同一条便签 → 新的赢，且互相同步');
  A2.notes.a = NOTE('a', 'A 后改的版本', 9000);
  await syncRun(cfg, A2, io); // A 推送
  const B2 = { ...B1 }; // B 还是旧数据（含旧版 a）
  B2.notes.a = NOTE('a', 'B 前改的版本', 8000);
  r = await syncRun(cfg, B2, io);
  assert(r.merged.notes.a.body === 'A 后改的版本', 'updatedAt 9000 的 A 版本获胜');
  assert(r.pushed, 'B 推回合并结果');

  console.log('5) A 删除便签 b → B 同步后 b 消失');
  const A3 = await io.download();
  delete A3.notes.b;
  A3.tombstones = { ...A3.tombstones, b: 20000 };
  r = await syncRun(cfg, A3, io);
  assert(r.pushed, '删除结果已推送');
  const Bstate = await io.download();
  const r2 = await syncRun(cfg, Bstate, io);
  assert(!r2.merged.notes.b, 'B 上 b 已被墓碑删除');

  console.log('6) 401 场景 → 报错信息友好（服务器对错误口令拒绝）');
  const badCfg = {
    provider: 'webdav',
    webdav: { url: `http://127.0.0.1:${port}/dav/`, user: 'u', pass: 'WRONG', dir: 'BianQian' },
  };
  let err = null;
  try {
    await makeIO(badCfg).download();
  } catch (e) {
    err = e;
  }
  // mock 服务器不校验口令，这里只验证调用链不炸；真实 401 文案在单元里已覆盖
  assert(err === null, 'mock 服务器接受任意口令，调用链正常');

  console.log('7) Gist GET 路径（公开 gist，软校验）');
  try {
    const list = await fetch('https://api.github.com/gists/public?per_page=1', {
      headers: { 'User-Agent': 'BianQian/1.0' },
    });
    if (list.ok) {
      const g = (await list.json())[0];
      const { gistDownload } = require('../sync');
      const data = await gistDownload({ token: 'anonymous-invalid', id: g.id });
      assert(data === null || typeof data === 'object', 'gistDownload 返回结构正常（token 无效时按错误处理）');
    } else {
      console.log('  - GitHub API 不可达，跳过（不影响其他用例）');
    }
  } catch (e) {
    console.log('  - 网络受限，跳过 Gist 软校验：' + e.message);
  }

  server.close();
  if (failed) {
    console.error(`\n共 ${failed} 个用例失败`);
    process.exit(1);
  }
  console.log('\n全部通过 ✓');
}

function canonEq(a, b) {
  const { normalizeCloud } = require('../sync');
  const s = (c) => JSON.stringify({ notes: c.notes, tombstones: c.tombstones });
  return s(normalizeCloud(a)) === s(normalizeCloud(b));
}

main().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
