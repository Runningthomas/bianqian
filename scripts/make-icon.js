'use strict';
// 纯 Node 生成应用图标（不依赖任何图像库）：
//   assets/icon.png  256x256（窗口/通知用）
//   assets/tray.png  32x32（托盘用）
//   assets/icon.ico  16/32/48/256（exe 图标，electron-builder 用）
// 画的是一个黄便签 + 右下折角 + 几行"字"。
// 运行：node scripts/make-icon.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------- PNG ----------------
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------- 画便签 ----------------
function drawNote(size) {
  const px = Buffer.alloc(size * size * 4);
  const s = size / 256; // 以 256 为基准的缩放
  const L = 28 * s, T = 20 * s, R = 228 * s, B = 236 * s, RAD = 30 * s, FOLD = 56 * s;

  // 圆角矩形：dx/dy 只在超出内缩范围的边缘带里为正，角落区域做距离判断
  const inNote = (x, y) => {
    if (x < L || x > R || y < T || y > B) return false;
    const dx = Math.max(L + RAD - x, 0, x - (R - RAD));
    const dy = Math.max(T + RAD - y, 0, y - (B - RAD));
    return dx * dx + dy * dy <= RAD * RAD;
  };
  const inFold = (x, y) => x >= R - FOLD && y >= B - FOLD && (x - (R - FOLD)) + (y - (B - FOLD)) >= FOLD;

  const put = (x, y, r, g, b, a = 1) => {
    const i = (y * size + x) * 4;
    const da = px[i + 3] / 255;
    const oa = a + da * (1 - a);
    if (oa <= 0) return;
    px[i] = Math.round((r * a + px[i] * da * (1 - a)) / oa);
    px[i + 1] = Math.round((g * a + px[i + 1] * da * (1 - a)) / oa);
    px[i + 2] = Math.round((b * a + px[i + 2] * da * (1 - a)) / oa);
    px[i + 3] = Math.round(oa * 255);
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inNote(x, y)) continue;
      // 便签主体：上浅下深的柔和渐变
      const t = (y - T) / (B - T);
      const r = Math.round(255 - 8 * t);
      const g = Math.round(216 - 26 * t);
      const b = Math.round(94 - 22 * t);
      let a = 1;
      if (inFold(x, y)) {
        // 右下折角：更深一档的纸色
        put(x, y, 224, 176, 60, 1);
      } else {
        put(x, y, r, g, b, a);
      }
      // 折角斜线高光
      const d = (x - (R - FOLD)) + (y - (B - FOLD));
      if (inFold(x, y) && Math.abs(d - FOLD) < 2.2 * s) put(x, y, 255, 240, 190, 0.85);
      // 细描边
      const edge =
        x - L < 2.4 * s || R - x < 2.4 * s || y - T < 2.4 * s || B - y < 2.4 * s ||
        inFold(x, y) && Math.abs(d - FOLD) < 2.4 * s;
      void edge;
    }
  }

  // 顶部高光（左上到右下的浅色渐隐）
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      if (inNote(x, y) && !inFold(x, y) && y - T < 26 * s)
        put(x, y, 255, 255, 240, 0.18 * (1 - (y - T) / (26 * s)));
    }

  // 四条"字行"
  const lines = [
    [58, 72, 140],
    [58, 108, 140],
    [58, 144, 140],
    [58, 180, 86],
  ];
  for (const [lx, ly, lw] of lines) {
    const x0 = Math.round(lx * s), x1 = Math.round((lx + lw) * s);
    const y0 = Math.round(ly * s), y1 = Math.round((ly + 13) * s);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        if (!inNote(x, y) || inFold(x, y)) continue;
        const rr = Math.min(x1 - x, x - x0, y1 - y, y - y0);
        const aa = Math.min(1, Math.max(0, rr / (2.5 * s))) * 0.5;
        put(x, y, 146, 104, 26, aa);
      }
  }

  return px;
}

// 简单盒式降采样 256 -> target
function downsample(src, srcSize, target) {
  const out = Buffer.alloc(target * target * 4);
  const f = srcSize / target;
  for (let y = 0; y < target; y++) {
    for (let x = 0; x < target; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const xa = Math.floor(x * f), xb = Math.min(srcSize, Math.ceil((x + 1) * f));
      const ya = Math.floor(y * f), yb = Math.min(srcSize, Math.ceil((y + 1) * f));
      for (let yy = ya; yy < yb; yy++)
        for (let xx = xa; xx < xb; xx++) {
          const i = (yy * srcSize + xx) * 4;
          const al = src[i + 3] / 255;
          r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al; a += al; n++;
        }
      const o = (y * target + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return out;
}

// ---------------- ICO ----------------
function bmpEntry(rgba, w) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(w, 4);
  header.writeInt32LE(w * 2, 8); // XOR + AND
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const xor = Buffer.alloc(w * w * 4);
  // 自底向上、BGRA
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      const di = ((w - 1 - y) * w + x) * 4;
      xor[di] = rgba[si + 2];
      xor[di + 1] = rgba[si + 1];
      xor[di + 2] = rgba[si];
      xor[di + 3] = rgba[si + 3];
    }
  }
  const andRow = Math.ceil(w / 32) * 4;
  const and = Buffer.alloc(andRow * w); // 全 0：不透明度交给 alpha 通道
  return Buffer.concat([header, xor, and]);
}

function buildIco(png256) {
  const sizes = [16, 32, 48];
  const entries = [];
  for (const w of sizes) entries.push({ w, data: bmpEntry(downsample(base256, 256, w), w) });
  entries.push({ w: 256, data: png256 });

  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(count, 4);

  let offset = 6 + 16 * count;
  const dirParts = [];
  const dataParts = [];
  for (const e of entries) {
    const d = Buffer.alloc(16);
    d[0] = e.w === 256 ? 0 : e.w;
    d[1] = e.w === 256 ? 0 : e.w;
    d.writeUInt16LE(1, 4); // planes
    d.writeUInt16LE(32, 6); // bpp
    d.writeUInt32LE(e.data.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += e.data.length;
    dirParts.push(d);
    dataParts.push(e.data);
  }
  return Buffer.concat([header, ...dirParts, ...dataParts]);
}

// ---------------- 输出 ----------------
const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
const base256 = drawNote(256);
const png256 = encodePNG(base256, 256, 256);
fs.writeFileSync(path.join(outDir, 'icon.png'), png256);
fs.writeFileSync(path.join(outDir, 'tray.png'), encodePNG(downsample(base256, 256, 32), 32, 32));
fs.writeFileSync(path.join(outDir, 'icon.ico'), buildIco(png256));
console.log('图标已生成: assets/icon.png, assets/tray.png, assets/icon.ico');
