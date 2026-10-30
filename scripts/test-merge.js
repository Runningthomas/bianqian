'use strict';
// 合并算法测试：node scripts/test-merge.js
const { mergeCloud } = require('../sync');

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else {
    failed++;
    console.error('  ✗ ' + msg);
  }
}

const note = (id, body, updatedAt, extra = {}) => ({
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

console.log('1) 本地新增 + 云端新增 → 两边都在');
{
  const r = mergeCloud(
    { notes: { a: note('a', 'local-a', 1000) }, tombstones: {} },
    { notes: { b: note('b', 'remote-b', 1001) }, tombstones: {} }
  );
  assert(r.notes.a && r.notes.b, '合并后同时包含 a 和 b');
  assert(r.notes.a.body === 'local-a' && r.notes.b.body === 'remote-b', '内容各自保留');
}

console.log('2) 同一便签两边都改 → updatedAt 新者胜');
{
  const r = mergeCloud(
    { notes: { a: note('a', '本地较旧', 1000) }, tombstones: {} },
    { notes: { a: note('a', '云端较新', 2000) }, tombstones: {} }
  );
  assert(r.notes.a.body === '云端较新', '取云端较新版本');
  const r2 = mergeCloud(
    { notes: { a: note('a', '本地较新', 3000) }, tombstones: {} },
    { notes: { a: note('a', '云端较旧', 2000) }, tombstones: {} }
  );
  assert(r2.notes.a.body === '本地较新', '取本地较新版本');
}

console.log('3) 一边删除（墓碑）→ 另一边的便签被删掉');
{
  const r = mergeCloud(
    { notes: {}, tombstones: { a: 5000 } },
    { notes: { a: note('a', '还在', 2000) }, tombstones: {} }
  );
  assert(!r.notes.a && r.tombstones.a === 5000, '便签被墓碑删除');
}

console.log('4) 删除后另一边又改了（墓碑比修改旧）→ 修改复活');
{
  const r = mergeCloud(
    { notes: {}, tombstones: { a: 1500 } },
    { notes: { a: note('a', '删除后又被改过', 2000) }, tombstones: {} }
  );
  assert(r.notes.a && r.notes.a.body === '删除后又被改过', '较新的修改胜过较旧的墓碑');
}

console.log('5) 两边都有墓碑 → 保留较新的墓碑');
{
  const r = mergeCloud(
    { notes: {}, tombstones: { a: 3000 } },
    { notes: {}, tombstones: { a: 4000 } }
  );
  assert(r.tombstones.a === 4000, '墓碑取较新时间');
}

console.log('6) 空数据 + 脏数据归一化不抛错');
{
  const r = mergeCloud(null, undefined);
  assert(r && r.notes && !Object.keys(r.notes).length, 'null/undefined 安全');
  const r2 = mergeCloud({ notes: { a: note('a', 'x', 1) }, tombstones: null }, { hello: 1 });
  assert(r2.notes.a, '非法字段被忽略，正常合并');
}

console.log('7) 本地被删 + 云端被删，无复活');
{
  const r = mergeCloud(
    { notes: {}, tombstones: { a: 100 } },
    { notes: {}, tombstones: { a: 100 } }
  );
  assert(!r.notes.a, '没有复活');
}

if (failed) {
  console.error(`\n共 ${failed} 个用例失败`);
  process.exit(1);
}
console.log('\n全部通过 ✓');
