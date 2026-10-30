'use strict';
// 本地数据存储：JSON 文件 + 原子写入 + 防抖保存。
// data 形态: { notes: {id: note}, tombstones: {id: 删除时间戳} }

const fs = require('fs');
const path = require('path');

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { notes: {}, tombstones: {} };
    this._timer = null;
    this._saving = Promise.resolve();
    this._dirty = false;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const d = JSON.parse(raw);
      this.data = {
        notes: d && d.notes && typeof d.notes === 'object' ? d.notes : {},
        tombstones: d && d.tombstones && typeof d.tombstones === 'object' ? d.tombstones : {},
      };
    } catch (e) {
      if (fs.existsSync(this.filePath)) {
        // 文件损坏时留个备份，避免直接覆盖丢失
        try { fs.copyFileSync(this.filePath, this.filePath + '.bad-' + Date.now()); } catch (_) {}
      }
    }
    return this.data;
  }

  save(delay = 400) {
    this._dirty = true;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), delay);
  }

  flush() {
    clearTimeout(this._timer);
    this._timer = null;
    if (!this._dirty) return this._saving;
    this._dirty = false;
    const snapshot = JSON.stringify(this.data);
    const tmp = this.filePath + '.tmp';
    this._saving = this._saving.then(
      () =>
        new Promise((resolve) => {
          fs.writeFile(tmp, snapshot, 'utf8', (e1) => {
            if (e1) return resolve();
            fs.rename(tmp, this.filePath, () => resolve());
          });
        })
    );
    return this._saving;
  }

  // 同步落盘（退出前用）
  flushSync() {
    clearTimeout(this._timer);
    this._timer = null;
    try {
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
      fs.renameSync(tmp, this.filePath);
      this._dirty = false;
    } catch (_) {}
  }

  // 用云端合并结果整体替换（同步拉取时）
  applyCloud(cloud) {
    this.data.notes = cloud.notes || {};
    this.data.tombstones = cloud.tombstones || {};
    return this.flush();
  }
}

module.exports = { Store, defaultDataPath: (dir) => path.join(dir, 'data.json') };
