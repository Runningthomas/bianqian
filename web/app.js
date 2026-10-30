'use strict';
/**
 * 应用主逻辑：贴纸式便签墙。
 * 双端共用；所有持久化经 window.api（api.js 按环境注入）。
 */
(function () {
  const C = window.BQCore;
  const api = window.api;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const IS_DESKTOP = !!api.isDesktop;
  const NOTE_W = 232;
  const GAP = 18;

  let state = C.emptyCloud();
  let settings = null;
  let status = { state: 'idle', message: '', lastOk: null };
  const saveTimers = {};
  let dragState = null;

  /* ================= 初始化 ================= */
  const isQuick = location.hash === '#quick';

  async function init() {
    if (isQuick) return setupQuick();
    [state, settings] = await Promise.all([api.loadState(), api.getSettings()]);
    applyTheme(settings.theme);
    bindTopbar();
    bindCanvas();
    bindSettings();
    bindShortcuts();
    api.onStateChanged((incoming) => { mergeIncoming(incoming); renderAll(); });
    api.onSettingsChanged((s) => { settings = s; applyTheme(s.theme); fillSettingsUI(); updateTopUI(); });
    api.onSyncStatus(updateSyncUI);
    api.onReminder(({ id }) => {
      toast('⏰ 便签提醒时间到');
      const n = state.notes[id];
      if (n) { n.reminded = true; saveNow(n); }
    });
    status = await api.getSyncStatus();
    updateSyncUI(status);
    renderAll();
    api.getVersion().then((v) => { const el = $('#app-version'); if (el) el.textContent = v; });
    const badge = $('#runtime-badge');
    if (badge) badge.textContent = IS_DESKTOP ? '桌面版' : '网页版';
    setupInstall();
  }

  // PWA 安装提示：捕获浏览器事件，展示"安装到桌面"按钮
  let deferredInstallPrompt = null;
  function setupInstall() {
    if (IS_DESKTOP) return;
    const row = $('#install-row');
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      if (row) row.style.display = '';
    });
    const btn = $('#btn-install');
    if (btn) {
      btn.onclick = async () => {
        if (!deferredInstallPrompt) {
          toast('请用浏览器菜单里的「安装 / 添加到主屏幕」');
          return;
        }
        deferredInstallPrompt.prompt();
        const r = await deferredInstallPrompt.userChoice;
        if (r && r.outcome === 'accepted') toast('✅ 已安装到桌面');
        deferredInstallPrompt = null;
        if (row) row.style.display = 'none';
      };
    }
  }

  /* ================= 速记小窗 ================= */
  async function setupQuick() {
    document.body.classList.add('quick');
    settings = await api.getSettings();
    applyTheme(settings.theme);
    const ta = $('#quick-text');
    ta.focus();
    $('#quick-save').onclick = save;
    $('#quick-close').onclick = () => window.close();
    ta.onkeydown = (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
      if (e.key === 'Escape') window.close();
    };
    async function save() {
      const t = ta.value.trim();
      if (!t) return window.close();
      await api.quickSave(t);
      window.close();
    }
  }

  /* ================= 主题 ================= */
  const media = matchMedia('(prefers-color-scheme: dark)');
  function applyTheme(t) {
    document.documentElement.dataset.theme = t === 'system' ? (media.matches ? 'dark' : 'light') : t;
  }
  media.addEventListener('change', () => { if (settings && settings.theme === 'system') applyTheme('system'); });

  /* ================= 数据 ================= */
  function scheduleSave(note) {
    clearTimeout(saveTimers[note.id]);
    saveTimers[note.id] = setTimeout(() => {
      note.updatedAt = Date.now();
      api.saveNote(JSON.parse(JSON.stringify(note)));
    }, 400);
  }

  function saveNow(note) {
    clearTimeout(saveTimers[note.id]);
    note.updatedAt = Date.now();
    return api.saveNote(JSON.parse(JSON.stringify(note)));
  }

  async function deleteNote(id) {
    if (!confirm('删除这张便签？（同步后其他设备也会删除）')) return;
    clearTimeout(saveTimers[id]);
    delete state.notes[id];
    state.tombstones[id] = Date.now();
    await api.deleteNote(id);
    renderAll();
  }

  // 云端推送来的状态合并进本地（LWW；正在编辑的便签不动）
  function mergeIncoming(remote) {
    const active = document.activeElement;
    const activeId = active && active.closest ? (active.closest('.note') || {}).dataset?.id : null;
    const tombs = remote.tombstones || {};
    for (const [id, ts] of Object.entries(tombs)) {
      const local = state.notes[id];
      if (!local || ts >= (local.updatedAt || 0)) {
        delete state.notes[id];
        state.tombstones[id] = Math.max(ts, state.tombstones[id] || 0);
      }
    }
    for (const [id, rn] of Object.entries(remote.notes || {})) {
      if (id === activeId) continue;
      const ln = state.notes[id];
      if (!ln || (rn.updatedAt || 0) > (ln.updatedAt || 0)) state.notes[id] = rn;
    }
  }

  function visibleNotes() {
    return Object.values(state.notes).sort(
      (a, b) => (b.pinned - a.pinned) || ((a.order || 0) - (b.order || 0)) || ((a.createdAt || 0) - (b.createdAt || 0))
    );
  }

  function createNote(patch = {}) {
    const note = C.newNote({
      color: (settings && settings.defaultColor) || 'yellow',
      ...patch,
    }, state);
    state.notes[note.id] = note;
    saveNow(note);
    renderAll();
    const el = $(`.note[data-id="${note.id}"]`);
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      const t = el.querySelector('.n-title');
      if (t) t.focus();
    }
    return note;
  }

  /* ================= 渲染 ================= */
  // 便签是否已设置有效坐标：老数据没有 x/y 字段，或为 null / (0,0) 都算未设置
  function hasPosition(n) {
    return Number.isFinite(n.x) && Number.isFinite(n.y) && !(n.x === 0 && n.y === 0);
  }

  // 重新排布所有"未定位置"的便签（按真实高度逐列往下摆），
  // 内容自动增高完成后调用，避免压盖。
  function relayoutFreeNotes(canvas, originX, originY, cols) {
    const free = $$('.note', canvas).filter((el) => {
      const n = state.notes[el.dataset.id];
      return n && !hasPosition(n);
    });
    if (!free.length) return;

    // 第一步：把自由便签统一挪到同一列，逐个读取真实高度（此时不重叠，测高准确）
    // 用 offsetHeight 而非 getBoundingClientRect：便签有随机旋转，
    // 后者含旋转外扩会导致测高偏大。
    const heights = [];
    for (const el of free) {
      el.style.left = originX + 'px';
      el.style.top = '0px';
      heights.push((el.offsetHeight || 180) + 10); // 留旋转与边框余量
    }

    // 第二步：按列分配。已定位的便签占用空间也计入，避免压到它们
    const colBottom = new Array(Math.max(1, cols)).fill(originY);
    for (const el of $$('.note', canvas)) {
      if (free.includes(el)) continue;
      const x = parseFloat(el.style.left) || 0;
      const y = parseFloat(el.style.top) || 0;
      const col = Math.max(0, Math.min(cols - 1, Math.round((x - originX) / (NOTE_W + GAP))));
      const bottom = y + (el.offsetHeight || 180) + 20;
      if (bottom > colBottom[col]) colBottom[col] = bottom;
    }

    // 第三步：依次放入当前最空的一列，用真实高度推进该列底部
    for (let i = 0; i < free.length; i++) {
      const el = free[i];
      let col = 0;
      for (let c = 1; c < colBottom.length; c++) {
        if (colBottom[c] < colBottom[col]) col = c;
      }
      el.style.left = originX + col * (NOTE_W + GAP) + 'px';
      el.style.top = colBottom[col] + 'px';
      colBottom[col] = colBottom[col] + heights[i] + 8;
    }

    // 第四步：复核。放到最终位置后高度可能与测高时不同（如内容自动增高），
    // 逐列检查并把被压住的便签往下推。
    const byCol = new Map();
    for (const el of free) {
      const x = parseFloat(el.style.left) || 0;
      if (!byCol.has(x)) byCol.set(x, []);
      byCol.get(x).push(el);
    }
    for (const group of byCol.values()) {
      group.sort((a, b) => (parseFloat(a.style.top) || 0) - (parseFloat(b.style.top) || 0));
      let bottom = -Infinity;
      for (const el of group) {
        const y = parseFloat(el.style.top) || 0;
        if (y < bottom) el.style.top = bottom + 'px';
        const realY = parseFloat(el.style.top) || 0;
        bottom = realY + (el.offsetHeight || 180) + 10;
      }
    }

    // 第五步：便签内容增高后尺寸会变，用 ResizeObserver 持续纠正压盖
    if (typeof ResizeObserver !== 'undefined' && !canvas.__bqRO) {
      canvas.__bqRO = new ResizeObserver(() => {
        clearTimeout(canvas.__bqROTimer);
        canvas.__bqROTimer = setTimeout(() => {
          const c = $('#canvas');
          if (c) relayoutFreeNotes(c, 26, 26, Math.max(1, Math.floor((c.parentElement.clientWidth - 52 + GAP) / (NOTE_W + GAP))));
        }, 60);
      });
      canvas.__bqRO.observe(canvas);
    }
    for (const el of free) {
      if (canvas.__bqRO && !el.__bqObs) {
        el.__bqObs = true;
        canvas.__bqRO.observe(el);
      }
    }
  }
  function renderAll() {
    renderCanvas();
    updateTopUI();
  }

  function renderCanvas() {
    const canvas = $('#canvas');
    const notes = visibleNotes();
    const count = $('#note-count');
    if (count) count.textContent = notes.length ? `${notes.length} 张` : '';

    // 记住现有便签位置，避免重绘后跳动（仅对已设置坐标的便签有效）
    const prev = {};
    for (const el of $$('.note', canvas)) {
      const n = state.notes[el.dataset.id];
      if (n && hasPosition(n)) prev[el.dataset.id] = { x: n.x + 'px', y: n.y + 'px' };
    }

    canvas.innerHTML = '';
    const cols = Math.max(1, Math.floor((canvas.parentElement.clientWidth - 52 + GAP) / (NOTE_W + GAP)));
    const originX = 26;
    const originY = 26;

    // 没有有效位置的便签（老数据 / 别的设备新建）按列依次往下排，避免互相重叠
    const maxX = Math.max(0, (canvas.parentElement.clientWidth || 1200) - NOTE_W - 26);
    notes.forEach((n) => {
      const el = buildCard(n);
      const pos = prev[n.id];
      if (pos) {
        el.style.left = pos.x;
        el.style.top = pos.y;
      } else if (hasPosition(n)) {
        // 别的设备保存的位置可能超出当前窗口宽度，钳制回可视范围
        el.style.left = Math.max(0, Math.min(n.x, maxX)) + 'px';
        el.style.top = Math.max(0, n.y) + 'px';
      } else {
        el.style.left = originX + 'px';
        el.style.top = originY + 'px';
      }
      canvas.appendChild(el);
    });

    // 第二阶段：拿到便签实际高度后，逐列往下排，保证互不重叠
    relayoutFreeNotes(canvas, originX, originY, cols);

    // 内容稳定（textarea 自动增高完成）后再排一次，避免高度变化导致压盖
    requestAnimationFrame(() => requestAnimationFrame(() => relayoutFreeNotes(canvas, originX, originY, cols)));

    // 画布高度撑到能容纳所有便签
    let maxBottom = 0;
    for (const el of $$('.note', canvas)) {
      const bottom = parseFloat(el.style.top || '0') + el.offsetHeight;
      if (bottom > maxBottom) maxBottom = bottom;
    }
    canvas.style.height = Math.max(maxBottom + 40, canvas.parentElement.clientHeight) + 'px';

    const hint = $('#empty-hint');
    if (hint) hint.hidden = notes.length > 0;
  }

  function buildCard(n) {
    const el = document.createElement('article');
    el.className = `note c-${n.color}${n.done ? ' done-note' : ''}${n.pinned ? ' pinned' : ''}`;
    el.dataset.id = n.id;
    // 轻微随机旋转，营造贴纸手感（按 id 稳定，不会每次重绘乱跳）
    const seed = hashCode(n.id);
    el.style.setProperty('--rot', ((seed % 7) - 3) * 0.35 + 'deg');

    el.innerHTML = `
      <div class="n-grip" title="拖动便签"></div>
      <div class="n-head">
        <span class="n-mascot">${C.MASQUOTS[n.color] || '🗒️'}</span>
        <div class="n-dots">${C.COLORS.map((c) => `<button class="dot d-${c}${c === n.color ? ' sel' : ''}" data-c="${c}" title="换便签纸"></button>`).join('')}</div>
        <span class="n-sp"></span>
        <button class="n-act a-pin${n.pinned ? ' on' : ''}" title="置顶">📌</button>
        <button class="n-act a-remind${n.reminderAt ? ' on' : ''}" title="提醒">🔔</button>
        <button class="n-act a-del" title="删除">🗑</button>
      </div>
      <textarea class="n-title" rows="1" placeholder="标题"></textarea>
      <textarea class="n-body" rows="1" placeholder="记点什么…"></textarea>
      <div class="n-items"></div>
      <button class="n-additem">＋ 清单项</button>
      <div class="n-foot">
        <label class="n-done-lab"><input type="checkbox" class="n-done">完成</label>
      </div>
      <div class="n-remind-row" hidden>
        <input type="datetime-local" class="n-remind-at">
        <button class="n-act a-remind-clear" title="清除提醒">🔕</button>
      </div>`;

    const titleEl = el.querySelector('.n-title');
    titleEl.value = n.title || '';
    const growTitle = () => {
      titleEl.style.height = 'auto';
      titleEl.style.height = titleEl.scrollHeight + 'px';
    };
    growTitle();
    requestAnimationFrame(growTitle);
    const body = el.querySelector('.n-body');
    body.value = n.body || '';
    el.querySelector('.n-done').checked = !!n.done;
    growBody(body);

    const itemsBox = el.querySelector('.n-items');
    (n.items || []).forEach((it) => itemsBox.appendChild(buildItem(n, it)));

    const remindRow = el.querySelector('.n-remind-row');
    if (n.reminderAt) {
      remindRow.hidden = false;
      remindRow.querySelector('.n-remind-at').value = tsToLocalInput(n.reminderAt);
      const t = el.querySelector('.a-remind');
      t.title = '提醒：' + new Date(n.reminderAt).toLocaleString('zh-CN');
    }

    /* --- 事件 --- */
    $$('.dot', el).forEach((d) => (d.onclick = (e) => {
      e.stopPropagation();
      n.color = d.dataset.c;
      saveNow(n);
      renderAll();
    }));    el.querySelector('.a-pin').onclick = (e) => { e.stopPropagation(); n.pinned = !n.pinned; saveNow(n); renderAll(); };
    el.querySelector('.a-del').onclick = (e) => { e.stopPropagation(); deleteNote(n.id); };
    el.querySelector('.n-title').addEventListener('input', (e) => { n.title = e.target.value; growTitle(); scheduleSave(n); });
    body.addEventListener('input', (e) => { n.body = e.target.value; growBody(e.target); scheduleSave(n); });
    el.querySelector('.n-done').onchange = (e) => { n.done = e.target.checked; saveNow(n); renderAll(); };
    el.querySelector('.n-additem').onclick = (e) => {
      e.stopPropagation();
      n.items.push({ id: 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text: '', done: false });
      saveNow(n); renderAll();
      const box = $(`.note[data-id="${n.id}"] .n-items`);
      if (box) { const last = box.lastElementChild; if (last) last.querySelector('.i-text').focus(); }
    };
    el.querySelector('.a-remind').onclick = (e) => {
      e.stopPropagation();
      remindRow.hidden = !remindRow.hidden;
      if (!remindRow.hidden) remindRow.querySelector('.n-remind-at').focus();
    };
    el.querySelector('.a-remind-clear').onclick = (e) => {
      e.stopPropagation();
      n.reminderAt = null; n.reminded = false;
      saveNow(n); renderAll(); toast('已清除提醒');
    };
    remindRow.querySelector('.n-remind-at').onchange = (e) => {
      const ts = e.target.value ? new Date(e.target.value).getTime() : null;
      if (ts) { n.reminderAt = ts; n.reminded = false; saveNow(n); renderAll(); toast('⏰ 会在到点时提醒你'); }
    };

    return el;
  }

  function buildItem(n, it) {
    const div = document.createElement('div');
    div.className = 'n-item' + (it.done ? ' done' : '');
    div.innerHTML = `
      <input type="checkbox">
      <textarea class="i-text" rows="1" placeholder="清单项"></textarea>
      <button class="i-del" title="删除">✕</button>`;
    div.querySelector('input[type="checkbox"]').checked = !!it.done;
    const txt = div.querySelector('.i-text');
    txt.value = it.text || '';
    // textarea 随内容自动增高，长文本完整换行显示（不设上限，避免裁掉内容）
    const autoGrow = () => {
      txt.style.height = 'auto';
      txt.style.height = txt.scrollHeight + 'px';
    };
    autoGrow();
    requestAnimationFrame(autoGrow);
    div.querySelector('input[type="checkbox"]').onchange = (e) => {
      it.done = e.target.checked;
      div.classList.toggle('done', it.done);
      scheduleSave(n);
    };
    txt.addEventListener('input', () => { it.text = txt.value; autoGrow(); scheduleSave(n); });
    txt.addEventListener('keydown', (e) => {
      // 单行清单项：回车提交新项；Shift+回车换行
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const idx = n.items.indexOf(it);
        n.items.splice(idx + 1, 0, { id: 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text: '', done: false });
        saveNow(n); renderAll();
        const box = $(`.note[data-id="${n.id}"] .n-items`);
        if (box && box.children[idx + 1]) box.children[idx + 1].querySelector('.i-text').focus();
      }
    });
    div.querySelector('.i-del').onclick = () => {
      n.items.splice(n.items.indexOf(it), 1);
      saveNow(n); renderAll();
    };
    return div;
  }

  function growBody(ta) {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  function tsToLocalInput(ts) {
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function hashCode(s) {
    let h = 0;
    for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  /* ================= 拖拽定位 ================= */
  // 拖动时若与其它便签重叠，在周围找一处不重叠的位置（就近优先）
  function avoidOverlap(card, x, y) {
    const w = card.offsetWidth || NOTE_W;
    const h = card.offsetHeight || 180;
    const others = $$('.note', $('#canvas')).filter((el) => el !== card);
    const hits = (px, py) => others.some((el) => {
      const ox = el.offsetLeft, oy = el.offsetTop;
      const ow = el.offsetWidth, oh = el.offsetHeight;
      return px < ox + ow && px + w > ox && py < oy + oh && py + h > oy;
    });
    if (!hits(x, y)) return { x, y };
    // 由近到远尝试若干偏移
    const step = 24;
    for (let r = 1; r <= 12; r++) {
      const cand = [
        [x, y - r * step], [x, y + r * step],
        [x - r * step, y], [x + r * step, y],
        [x + r * step, y + r * step], [x - r * step, y + r * step],
        [x + r * step, y - r * step], [x - r * step, y - r * step],
      ];
      for (const [cx, cy] of cand) {
        if (cx < 0 || cy < 0) continue;
        if (!hits(cx, cy)) return { x: cx, y: cy };
      }
    }
    return { x, y };
  }

  function bindCanvas() {
    const canvas = $('#canvas');
    const wrap = $('#canvas-wrap');

    // 便签顶部把手拖动
    canvas.addEventListener('mousedown', (e) => {
      const grip = e.target.closest('.n-grip');
      if (!grip) return;
      const card = grip.closest('.note');
      if (!card) return;
      e.preventDefault();
      const n = state.notes[card.dataset.id];
      if (!n) return;
      dragState = {
        card, note: n,
        startX: e.clientX, startY: e.clientY,
        originLeft: parseFloat(card.style.left) || 0,
        originTop: parseFloat(card.style.top) || 0,
      };
      card.classList.add('dragging');
      document.body.style.cursor = 'grabbing';
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragState) return;
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;
      let x = Math.max(0, dragState.originLeft + dx);
      let y = Math.max(0, dragState.originTop + dy);
      // 实时避让：与其他便签重叠时自动找最近的空位
      const fixed = avoidOverlap(dragState.card, x, y);
      dragState.card.style.left = fixed.x + 'px';
      dragState.card.style.top = fixed.y + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!dragState) return;
      const { card, note } = dragState;
      card.classList.remove('dragging');
      document.body.style.cursor = '';
      note.x = parseFloat(card.style.left) || 0;
      note.y = parseFloat(card.style.top) || 0;
      saveNow(note);
      dragState = null;
      // 画布可能需要撑高
      const canvas = $('#canvas');
      let maxBottom = 0;
      for (const el of $$('.note', canvas)) {
        const bottom = parseFloat(el.style.top || '0') + el.offsetHeight;
        if (bottom > maxBottom) maxBottom = bottom;
      }
      canvas.style.height = Math.max(maxBottom + 40, canvas.parentElement.clientHeight) + 'px';
    });
    // 双击空白处新建
    wrap.addEventListener('dblclick', (e) => {
      if (e.target.closest('.note') || e.target.closest('#fab-add')) return;
      const rect = wrap.getBoundingClientRect();
      const x = e.clientX - rect.left + wrap.scrollLeft - NOTE_W / 2;
      const y = e.clientY - rect.top + wrap.scrollTop - 20;
      createNote({ x: Math.max(0, x), y: Math.max(0, y) });
    });

    $('#fab-add').onclick = () => createNote();
    $('#btn-new').onclick = () => createNote();
  }

  /* ================= 顶栏 ================= */
  function bindTopbar() {
    $('#btn-sync').onclick = async () => {
      if (!settings.sync || settings.sync.provider === 'none') { openSettings(); return; }
      updateSyncUI({ ...status, state: 'syncing', message: '同步中…' });
      const s = await api.syncNow();
      updateSyncUI(s);
      toast(s.state === 'ok' ? '✅ ' + s.message : '⚠️ ' + s.message);
    };
    if (IS_DESKTOP) {
      $('#btn-top').onclick = () => updateSettings({ alwaysOnTop: !settings.alwaysOnTop });
      $('#btn-min').onclick = () => api.winMinimize();
      $('#btn-max').onclick = () => api.winMaximize();
      $('#btn-close').onclick = () => api.winClose();
    } else {
      // 网页版没有窗口控制，隐藏对应按钮
      ['#btn-top', '#btn-min', '#btn-max', '#btn-close', '.tb-sep'].forEach((sel) => {
        const el = $(sel);
        if (el) el.style.display = 'none';
      });
    }
    $('#btn-settings').onclick = openSettings;
    $('#titlebar').addEventListener('dblclick', (e) => {
      if (!IS_DESKTOP) return;
      if (e.target.closest('button, input, select')) return;
      api.winMaximize();
    });
  }

  function updateTopUI() {
    const b = $('#btn-top');
    if (b && IS_DESKTOP) b.classList.toggle('active', !!settings.alwaysOnTop);
  }

  /* ================= 同步状态 ================= */
  function updateSyncUI(s) {
    if (!s) return;
    status = s;
    const btn = $('#btn-sync');
    if (!btn) return;
    btn.classList.remove('syncing', 'ok', 'error');
    if (s.state === 'syncing') btn.classList.add('syncing');
    else if (s.state === 'ok') btn.classList.add('ok');
    else if (s.state === 'error') btn.classList.add('error');
    const time = s.lastOk ? new Date(s.lastOk).toLocaleTimeString('zh-CN') : '';
    btn.title = s.state === 'idle' ? '未启用云同步（点这里去设置）' : `云同步：${s.message}${time ? '（' + time + '）' : ''}`;
    const st = $('#sync-status');
    if (st) st.textContent = s.state === 'idle' ? '未启用' : `${s.message}${time ? ' · ' + time : ''}`;
  }

  /* ================= 设置 ================= */
  function openSettings() { $('#settings').hidden = false; }
  function closeSettings() { $('#settings').hidden = true; }

  function bindSettings() {
    $('#btn-settings-close').onclick = closeSettings;
    $$('input[name="provider"]').forEach((r) => (r.onchange = () => { pushSettings(); toggleSyncFieldsets(); }));
    ['#g-token', '#g-id', '#wd-url', '#wd-user', '#wd-pass', '#wd-dir', '#folder-path']
      .forEach((sel) => $(sel).addEventListener('change', pushSettings));
    $$('.open-link').forEach((b) => (b.onclick = () => api.openExternal(b.dataset.url)));
    if (IS_DESKTOP) {
      $('#btn-pick-folder').onclick = async () => {
        const p = await api.pickFolder();
        if (!p) return;
        $('#folder-path').value = p;
        await pushSettings();
        toast('✅ 同步文件夹已设置，点「立即同步」开始');
      };
    }
    $('#sync-minutes').onchange = pushSettings;
    $('#sync-onlaunch').onchange = pushSettings;
    $('#set-theme').onchange = pushSettings;
    $('#set-top').onchange = pushSettings;
    $('#set-edgehide').onchange = pushSettings;
    $('#set-autoretract').onchange = pushSettings;
    $('#set-closetotray').onchange = pushSettings;
    $('#set-autologin').onchange = pushSettings;
    $('#set-quickhotkey').onchange = pushSettings;
    $('#btn-sync-now').onclick = async () => {
      await pushSettings();
      updateSyncUI({ ...status, state: 'syncing', message: '同步中…' });
      const s = await api.syncNow();
      updateSyncUI(s);
      toast(s.state === 'ok' ? '✅ ' + s.message : '⚠️ ' + s.message);
    };
    $('#btn-gist-create').onclick = async () => {
      const token = $('#g-token').value.trim();
      if (!token) return toast('请先填 GitHub Token');
      try {
        const id = await api.createGist(token);
        $('#g-id').value = id;
        await pushSettings();
        toast('✅ Gist 已创建，同步已就绪');
      } catch (e) {
        toast('⚠️ ' + (e.message || e));
      }
    };
    $('#btn-copy-code').onclick = async () => {
      const code = C.buildSyncCode(settings);
      if (!code) return toast('请先启用同步');
      await api.clipboardWrite(code);
      toast('✅ 同步设置码已复制，可粘贴给另一台设备');
    };
    $('#btn-paste-code').onclick = () => {
      $('#sync-code').hidden = false;
      $('#code-actions').hidden = false;
      $('#code-tip').textContent = '';
      $('#sync-code').focus();
    };
    $('#btn-code-cancel').onclick = hideCodeUI;
    $('#btn-code-apply').onclick = async () => {
      const obj = C.parseSyncCode($('#sync-code').value);
      if (!obj) { $('#code-tip').textContent = '⚠️ 设置码无效或已损坏，请重新复制。'; return; }
      const sy = settings.sync || {};
      await updateSettings({
        sync: {
          provider: obj.provider,
          preset: obj.preset || 'jianguoyun',
          autoMinutes: Number(obj.autoMinutes) || 5,
          syncOnLaunch: obj.syncOnLaunch !== false,
          webdav: { ...(sy.webdav || {}), ...(obj.webdav || {}) },
          gist: { ...(sy.gist || {}), ...(obj.gist || {}) },
          folder: { path: sy.folder?.path || '', fileName: sy.folder?.fileName || C.DATA_FILE },
        },
      });
      fillSettingsUI();
      hideCodeUI();
      toast('✅ 同步设置已恢复，可点「立即同步」验证');
    };
    $('#btn-export').onclick = async () => {
      const p = await api.exportData();
      if (p) toast('已导出：' + p);
    };
    $('#btn-import').onclick = async () => {
      const r = await api.importData();
      if (!r) return;
      if (r.ok) { $('#import-result').textContent = `导入完成，当前共 ${r.count} 张便签`; toast('✅ 导入完成'); }
      else $('#import-result').textContent = '导入失败：' + (r.error || '未知错误');
    };

    // 默认便签纸
    const box = $('#set-color');
    box.innerHTML = C.COLORS.map((c) => `<button class="dot d-${c}" data-c="${c}" title="${c}"></button>`).join('');
    $$('.dot', box).forEach((d) => (d.onclick = () => { updateSettings({ defaultColor: d.dataset.c }); fillSettingsUI(); }));

    fillSettingsUI();
    toggleSyncFieldsets();
  }

  function hideCodeUI() {
    $('#sync-code').hidden = true;
    $('#code-actions').hidden = true;
    $('#code-tip').textContent = '';
    $('#sync-code').value = '';
  }

  function toggleSyncFieldsets() {
    const p = ($('input[name="provider"]:checked') || {}).value || 'none';
    $('#sf-gist').hidden = p !== 'gist';
    $('#sf-folder').hidden = p !== 'folder';
    $('#sf-webdav').hidden = p !== 'webdav';
    // 桌面专属选项在网页版隐藏
    if (!IS_DESKTOP) {
      const sec = $('#sec-desktop');
      if (sec) sec.style.display = 'none';
      ['folder', 'webdav'].forEach((v) => {
        const inp = $(`input[name="provider"][value="${v}"]`);
        if (inp && inp.parentElement) inp.parentElement.style.display = 'none';
      });
    }
  }

  function fillSettingsUI() {
    const sy = settings.sync || {};
    const wd = sy.webdav || {};
    const g = sy.gist || {};
    const fo = sy.folder || {};
    let pv = sy.provider || 'none';
    if (pv === 'webdav') pv = 'webdav';
    const radio = $(`input[name="provider"][value="${pv}"]`);
    if (radio) radio.checked = true;
    $('#g-token').value = g.token || '';
    $('#g-id').value = g.id || '';
    $('#wd-url').value = wd.url || 'https://dav.jianguoyun.com/dav/';
    $('#wd-user').value = wd.user || '';
    $('#wd-pass').value = wd.pass || '';
    $('#wd-dir').value = wd.dir || 'BianQian';
    $('#folder-path').value = fo.path || '';
    $('#sync-minutes').value = String(sy.autoMinutes ?? 5);
    $('#sync-onlaunch').checked = sy.syncOnLaunch !== false;
    $('#set-theme').value = settings.theme || 'system';
    $('#set-top').checked = !!settings.alwaysOnTop;
    $('#set-edgehide').checked = !!settings.edgeHide;
    $('#set-autoretract').checked = !!settings.autoRetract;
    $('#set-closetotray').checked = !!settings.closeToTray;
    $('#set-autologin').checked = !!settings.launchAtLogin;
    $('#set-quickhotkey').checked = !!settings.quickShortcut;
    $$('#set-color .dot').forEach((d) => d.classList.toggle('sel', d.dataset.c === (settings.defaultColor || 'yellow')));
    toggleSyncFieldsets();
  }

  async function pushSettings() {
    const pv = ($('input[name="provider"]:checked') || {}).value || 'none';
    const provider = pv === 'gist' ? 'gist' : pv === 'folder' ? 'folder' : pv === 'webdav' ? 'webdav' : 'none';
    const sy = settings.sync || {};
    const prevWd = sy.webdav || {};
    const prevGist = sy.gist || {};
    const prevFolder = sy.folder || {};
    const webdav = provider !== 'webdav' ? prevWd : {
      url: $('#wd-url').value.trim() || 'https://dav.jianguoyun.com/dav/',
      user: $('#wd-user').value.trim(),
      pass: $('#wd-pass').value,
      dir: $('#wd-dir').value.trim() || 'BianQian',
    };
    const gist = provider === 'gist'
      ? { token: $('#g-token').value.trim(), id: $('#g-id').value.trim() }
      : prevGist;
    const folder = provider === 'folder'
      ? { path: $('#folder-path').value.trim(), fileName: prevFolder.fileName || C.DATA_FILE }
      : prevFolder;
    const patch = {
      theme: $('#set-theme').value,
      defaultColor: settings.defaultColor || 'yellow',
      alwaysOnTop: $('#set-top').checked,
      edgeHide: $('#set-edgehide').checked,
      autoRetract: $('#set-autoretract').checked,
      closeToTray: $('#set-closetotray').checked,
      launchAtLogin: $('#set-autologin').checked,
      quickShortcut: $('#set-quickhotkey').checked,
      sync: {
        provider,
        preset: provider === 'webdav' ? 'custom' : 'jianguoyun',
        autoMinutes: Number($('#sync-minutes').value),
        syncOnLaunch: $('#sync-onlaunch').checked,
        webdav, gist, folder,
      },
    };
    settings = await api.setSettings(patch);
    applyTheme(settings.theme);
    updateTopUI();
    return settings;
  }

  function updateSettings(patch) {
    return api.setSettings(patch).then((s) => {
      settings = s;
      applyTheme(s.theme);
      updateTopUI();
      return s;
    });
  }

  /* ================= 快捷键 / Toast ================= */
  function bindShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); createNote(); }
      if (e.key === 'Escape' && !$('#settings').hidden) closeSettings();
    });
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // 窗口尺寸变化时重排（保存过位置的不动）
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderCanvas, 200);
  });

  init();
})();
