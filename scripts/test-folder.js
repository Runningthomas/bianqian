'use strict';
// 「同步文件夹」往返测试：模拟两台电脑各自把同一份数据文件放在云盘目录，
// 中间用 copyCloud() 模拟云盘在两次操作之间把文件传到另一台电脑。
// 运行：node scripts/test-folder.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeIO, syncRun, normalizeCloud } = require('../sync');

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else {
    failed++;
    console.error('  ✗ ' + msg);
  }
}

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

function canon(c) {
  const n = normalizeCloud(c);
  return JSON.stringify({ notes: n.notes, tombstones: n.tombstones });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bianqian-folder-'));
  const dirA = path.join(root, 'cloud', 'A');
  const dirB = path.join(root, 'cloud', 'B');
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  const cfgA = { provider: 'folder', folder: { path: dirA } };
  const cfgB = { provider: 'folder', folder: { path: dirB } };
  const ioA = makeIO(cfgA);
  const ioB = makeIO(cfgB);
  const copyCloud = () => {
    // 模拟云盘同步：把两台电脑目录里“最新修改”的那份文件传播到双方
    const candidates = [dirA, dirB]
      .map((dir) => path.join(dir, 'bianqian-data.json'))
      .filter((p) => fs.existsSync(p))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (!candidates.length) return;
    const latest = candidates[0];
    for (const dir of [dirA, dirB]) {
      fs.copyFileSync(latest, path.join(dir, 'bianqian-data.json'));
    }
  };

  console.log('1) 首次使用（两台电脑云端目录都为空）→ 各自数据合并互不覆盖');
  const A1 = { notes: { a: NOTE('a', '电脑A：待办事项', 1000) }, tombstones: {} };
  const B1 = { notes: { b: NOTE('b', '电脑B：会议记录', 1000) }, tombstones: {} };
  let r = await syncRun(cfgA, A1, ioA);
  assert(r.pushed && !r.pulled, 'A 首次推送成功');
  assert(fs.existsSync(path.join(dirA, 'bianqian-data.json')), 'A 目录已生成数据文件');
  copyCloud();
  r = await syncRun(cfgB, B1, ioB);
  assert(r.pulled && r.pushed, 'B 拉取合并后推回');
  assert(r.merged.notes.a && r.merged.notes.b, 'B 看到 A 的便签且保留自己的');
  copyCloud();
  r = await syncRun(cfgA, A1, ioA);
  assert(r.pulled && r.merged.notes.b, 'A 再次同步后拿到 B 的便签');

  console.log('2) 同一便签两边都改 → updatedAt 较新者胜');
  const A2 = r.merged;
  A2.notes.a = NOTE('a', 'A 后改版本', 9000);
  copyCloud();
  await syncRun(cfgA, A2, ioA);
  copyCloud();
  const B2 = { ...B1 };
  B2.notes.a = NOTE('a', 'B 先改版本', 8000);
  r = await syncRun(cfgB, B2, ioB);
  assert(r.merged.notes.a.body === 'A 后改版本', '9000 的 A 版本获胜');

  console.log('3) 删除同步（墓碑防复活）');
  copyCloud();
  const A3 = await ioA.download();
  delete A3.notes.b;
  A3.tombstones = { ...A3.tombstones, b: 20000 };
  await syncRun(cfgA, A3, ioA);
  copyCloud();
  const Bstate = await ioB.download();
  r = await syncRun(cfgB, Bstate, ioB);
  assert(!r.merged.notes.b, 'B 上 b 已删除且不会复活');

  console.log('4) 路径未填写 → 友好报错');
  let err = null;
  try {
    await makeIO({ provider: 'folder', folder: { path: '' } }).download();
  } catch (e) {
    err = e.message;
  }
  assert(err === '请先选择同步文件夹', '报错文案正确');

  fs.rmSync(root, { recursive: true, force: true });
  if (failed) {
    console.error(`\n共 ${failed} 个用例失败`);
    process.exit(1);
  }
  console.log('\n全部通过 ✓');
}

main().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
