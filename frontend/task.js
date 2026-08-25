/* -*- coding: utf-8 -*-
 * Video Lab — 任务列表窗口逻辑
 */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function getApi() { return window.txapi || null; }
  function call(method) {
    var args = Array.prototype.slice.call(arguments, 1);
    var api = getApi();
    if (!api || typeof api[method] !== 'function') return Promise.reject(new Error('后端接口不可用: ' + method));
    return Promise.resolve().then(function () { return api[method].apply(api, args); });
  }

  var STATUS_TEXT = { queued: '排队中', paused: '已暂停', running: '运行中', done: '已完成', error: '失败', stopped: '已停止', interrupted: '已中断' };
  var LOCK_TEXT = { unknown: '', waiting: '等待互斥锁', locked: '已获取锁', released: '' };
  var TYPE_TEXT = { batch: '批量拼接', replica: '视频复刻' };

  // 任务卡片右键菜单（置顶 / 暂停继续 / 打开成片文件夹），样式复用 styles.css 的 .ctx-menu
  function showMenu(x, y, items) {
    var old = document.getElementById('ctxMenu');
    if (old) old.remove();
    var m = document.createElement('div');
    m.id = 'ctxMenu'; m.className = 'ctx-menu';
    items.forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = it.label;
      m.appendChild(b);
      if (it.disabled) { b.disabled = true; if (it.title) b.title = it.title; return; }
      b.addEventListener('click', function () { close(); it.action(); });
    });
    document.body.appendChild(m);
    m.style.left = Math.max(4, Math.min(x, window.innerWidth - 200)) + 'px';
    m.style.top = Math.max(4, Math.min(y, window.innerHeight - items.length * 30 - 14)) + 'px';
    function close() {
      m.remove();
      document.removeEventListener('mousedown', onDocMd, true);
      document.removeEventListener('contextmenu', onCtx, true);
    }
    function onDocMd(e) { if (!m.contains(e.target)) close(); }
    function onCtx() { close(); }
    setTimeout(function () { document.addEventListener('mousedown', onDocMd, true); }, 0);
    document.addEventListener('contextmenu', onCtx, true);
  }

  var ICONS = {
    'play': '<polygon points="6 3 20 12 6 21 6 3"/>',
    'pause': '<rect width="4" height="16" x="8" y="4" rx="1"/><rect width="4" height="16" x="14" y="4" rx="1"/>',
    'stop': '<rect width="10" height="10" x="7" y="7" rx="1"/>',
    'check': '<path d="M20 6 9 17l-5-5"/>',
    'arrow-up': '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
    'trash-2': '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
    'grip-vertical': '<circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/>'
  };
  function icon(name, size, cls) {
    var inner = ICONS[name] || '';
    var c = cls ? ' class="' + cls + '"' : '';
    return '<svg' + c + ' viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="' + (size || 24) + '" height="' + (size || 24) + '">' + inner + '</svg>';
  }
  function hydrateIcons(root) {
    // 与主窗口 app.js 一致的图标注入：<i data-icon="名称" data-size="N"> 替换为 SVG
    (root || document).querySelectorAll('i[data-icon]').forEach(function (el) {
      var svg = document.createElement('span');
      svg.innerHTML = icon(el.getAttribute('data-icon'), el.getAttribute('data-size') || 24);
      var node = svg.firstChild;
      if (el.className) node.setAttribute('class', el.className);
      el.replaceWith(node);
    });
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // 主窗口同款模态弹窗（按钮样式复用 styles.css 的 .modal-btn / .modal-card）
  function showDialog(opts) {
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      var card = document.createElement('div');
      card.className = 'modal-card';
      var html = '<div class="modal__title">' + escapeHtml(opts.title) + '</div>';
      if (opts.message) html += '<div class="modal__message">' + escapeHtml(opts.message) + '</div>';
      html += '<div class="modal__actions">';
      (opts.buttons || []).forEach(function (b) {
        var cls = 'modal-btn' + (b.danger ? ' modal-btn--danger' : '') + (b.primary ? ' modal-btn--primary' : '');
        html += '<button type="button" class="' + cls + '">' + escapeHtml(b.label) + '</button>';
      });
      html += '</div>';
      card.innerHTML = html;
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      var done = function (result) { overlay.remove(); resolve(result); };
      overlay.addEventListener('click', function (e) { if (e.target === overlay) done(null); });
      var btns = card.querySelectorAll('.modal-btn');
      (opts.buttons || []).forEach(function (b, i) { btns[i].addEventListener('click', function () { done(b.value); }); });
    });
  }
  function confirmDialog(message) {
    return showDialog({
      title: '确认操作', message: message,
      buttons: [
        { label: '取消', value: false },
        { label: '确定', value: true, primary: true }
      ]
    });
  }
  function alertDialog(message) {
    return showDialog({ title: '提示', message: message, buttons: [{ label: '知道了', value: true, primary: true }] });
  }

  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  var rendered = {}; // taskId -> { el, header, logEl, body, logCount, expanded }
  var state = { tab: 'running', _errCount: 0, _viewedErr: 0 };

  function buildCard(t) {
    var card = document.createElement('div');
    card.className = 'task-card task-card--' + (t.lockState === 'waiting' ? 'waiting' : t.status);
    card.dataset.taskId = t.id;

    var header = document.createElement('div');
    header.className = 'task-card__header';
    header.innerHTML =
      '<span class="task-card__handle" title="拖动调整任务顺序"></span>' +
      '<span class="task-card__failreason"></span>' +
      '<span class="task-card__status-dot"></span>' +
      '<span class="task-card__status-text"></span>' +
      '<span class="task-card__title"></span>' +
      '<span class="task-card__tag"></span>' +
      '<span class="task-card__time"></span>' +
      '<span class="task-card__lock"></span>' +
      '<button class="task-card__pause">' + icon('pause', 12) + '暂停</button>' +
      '<button class="task-card__stop">' + icon('stop', 12) + '停止</button>' +
      '<button class="task-card__del" title="从列表中移除该任务">' + icon('x', 12) + '</button>';
    card.appendChild(header);
    header.querySelector('.task-card__handle').innerHTML = icon('grip-vertical', 14);

    var progress = document.createElement('div');
    progress.className = 'task-card__progress';
    progress.innerHTML =
      '<div class="task-card__progress-text"><span class="task-card__progress-label"></span><span class="task-card__progress-pct"></span></div>' +
      '<div class="task-card__progress-track"><div class="task-card__progress-fill"></div></div>';
    card.appendChild(progress);

    var body = document.createElement('div');
    body.className = 'task-card__body';
    body.style.display = 'none';
    var log = document.createElement('div');
    log.className = 'task-card__log';
    body.appendChild(log);
    card.appendChild(body);

    var record = { el: card, header: header, logEl: log, body: body, logCount: 0, expanded: false, progressEl: progress, progressLabel: progress.querySelector('.task-card__progress-label'), progressPct: progress.querySelector('.task-card__progress-pct'), progressFill: progress.querySelector('.task-card__progress-fill') };
    header.addEventListener('click', function (e) {
      if (e.target.closest('.task-card__stop')) return;
      if (e.target.closest('.task-card__pause')) return;
      if (e.target.closest('.task-card__handle')) return;
      record.expanded = !record.expanded;
      body.style.display = record.expanded ? '' : 'none';
      if (record.expanded) log.scrollTop = log.scrollHeight;
    });
    header.querySelector('.task-card__stop').addEventListener('click', function (e) {
      e.stopPropagation();
      confirmStop(card.__task || t);
    });
    header.querySelector('.task-card__pause').addEventListener('click', function (e) {
      e.stopPropagation();
      var cur = card.__task || t;
      if (cur.status === 'paused') confirmResume(cur);
      else confirmPause(cur);
    });
    // 已结束任务单行删除（已完成/已停止列表中的「×」）
    header.querySelector('.task-card__del').addEventListener('click', function (e) {
      e.stopPropagation();
      var cur = card.__task || t;
      confirmDialog('确定要从列表中移除任务「' + (cur.title || cur.id) + '」吗？（不影响已生成的成片文件）').then(function (ok) {
        if (!ok) return;
        call('clear_task', cur.id).then(function (r) {
          if (!r || !r.ok) alertDialog('删除失败：' + ((r && r.error) || '未知错误'));
        }).catch(function (err) { alertDialog('删除失败：' + err.message); });
      });
    });
    // 右键菜单：按任务状态提供 置顶/暂停/继续/打开文件夹
    card.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      showTaskMenu(e.clientX, e.clientY, card.__task || t);
    });
    // 左侧排序把手：运行中不允许拖拽/越过，其余任务可自由排序
    header.querySelector('.task-card__handle').addEventListener('mousedown', function (e) {
      if ((card.__task || t).status === 'running') return;
      startDrag(card, e);
    });
    return record;
  }

  // ── 拖拽调整顺序：移动 DOM，松手后把「排队+暂停」的新顺序提交后端重排执行队列 ──
  // 已停止/失败任务也可拖（纯 UI 排序），后端不认；运行中的任务不可被越过
  var dragState = null;
  function startDrag(card, e) {
    if (state.tab !== 'running') return;
    e.preventDefault();
    e.stopPropagation();
    dragState = { card: card };
    card.classList.add('task-card--dragging');
    card.style.opacity = '0.55';
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
  }
  function cardsInOrder() {
    var list = document.getElementById('taskList');
    if (!list) return [];
    return Array.prototype.slice.call(list.querySelectorAll('.task-card'));
  }
  function taskStatus(id) {
    var rec = rendered[id];
    return rec ? (rec.el.__task || { status: '' }).status : '';
  }
  function onDragMove(e) {
    if (!dragState) return;
    var under = document.elementFromPoint(e.clientX, e.clientY);
    var target = under && under.closest ? under.closest('.task-card') : null;
    if (!target || target === dragState.card) return;
    // 运行中的任务持续置顶：既不能拖动它，也不能被越过
    if (taskStatus(target.dataset.taskId) === 'running') return;
    if (taskStatus(dragState.card.dataset.taskId) === 'running') return;
    var list = dragState.card.parentNode;
    var dragMid = dragState.card.offsetTop + dragState.card.offsetHeight / 2;
    var tMid = target.offsetTop + target.offsetHeight / 2;
    if (dragMid < tMid) { if (target.nextSibling !== dragState.card) list.insertBefore(dragState.card, target.nextSibling); }
    else if (dragMid > tMid) { if (list.firstChild !== dragState.card) list.insertBefore(dragState.card, target); }
  }
  function onDragEnd() {
    if (!dragState) return;
    var card = dragState.card; dragState = null;
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
    card.classList.remove('task-card--dragging');
    card.style.opacity = '';
    // 提交新的待运行顺序（DOM 顺序中仅取 排队+暂停，已停止/失败不提交，纯 UI 排序）
    var waiting = cardsInOrder().map(function (c) { return c.dataset.taskId; }).filter(function (id) {
      var s = taskStatus(id); return s === 'queued' || s === 'paused';
    });
    if (waiting.length < 2) return;
    if (waiting.indexOf(card.dataset.taskId) < 0) return;
    call('reorder_tasks', waiting).then(function (r) {
      if (r && !r.ok) alertDialog('调整顺序失败：' + (r.error || '未知错误'));
    }).catch(function (err) { alertDialog('调整顺序失败：' + err.message); });
  }

  function updateCard(rec, t) {
    rec.el.__task = t;
    rec.el.className = 'task-card task-card--' + (t.lockState === 'waiting' ? 'waiting' : t.status);
    rec.header.querySelector('.task-card__status-text').textContent = STATUS_TEXT[t.status] || t.status;
    rec.header.querySelector('.task-card__title').textContent = t.title || '';
    rec.header.querySelector('.task-card__title').title = t.script || '';
    rec.header.querySelector('.task-card__tag').textContent = TYPE_TEXT[t.type] || t.type || '';
    var lockText = LOCK_TEXT[t.lockState] || '';
    var lockEl = rec.header.querySelector('.task-card__lock');
    lockEl.textContent = lockText;
    lockEl.className = 'task-card__lock' + (lockText ? ' task-card__lock--' + t.lockState : '');
    // 时间：已结束任务显示「开始 / 结束」，进行中仅显示开始时间
    var tEl = rec.header.querySelector('.task-card__time');
    var started = fmtTime(t.createdAt);
    var ended = t.endedAt ? fmtTime(t.endedAt) : '';
    if (t.status === 'done' || t.status === 'stopped' || t.status === 'error') {
      tEl.textContent = started + (ended ? ' / ' + ended : '');
      tEl.title = '开始时间 / 结束时间';
    } else {
      tEl.textContent = started;
      tEl.title = '开始时间';
    }
    // 最左侧状态圆点：排队显示序号，暂停显示橙色实心圆点，其余状态维持状态色点
    var dot = rec.header.querySelector('.task-card__status-dot');
    dot.removeAttribute('title');
    if (t.status === 'queued') {
      dot.textContent = String(t.displayPos || t.pos || '');
      dot.className = 'task-card__status-dot task-card__queue';
      dot.title = '排队中，前序任务完成后自动开始';
      dot.style.display = '';
    } else if (t.status === 'paused') {
      dot.textContent = '';
      dot.innerHTML = '<span class="task-card__pause-dot"></span>';
      dot.className = 'task-card__status-dot task-card__queue task-card__queue--paused';
      dot.title = '已暂停，可点击「继续」按当前位置插队';
      dot.style.display = '';
    } else {
      dot.textContent = '';
      dot.className = 'task-card__status-dot';
      dot.title = '';
    }
    // 左侧排序把手：运行中不可拖，其余灰显规则由状态决定
    var handleEl = rec.header.querySelector('.task-card__handle');
    handleEl.classList.toggle('task-card__handle--disabled', t.status === 'running');
    if (t.status === 'running') handleEl.title = '运行中的任务不能调整顺序';
    else handleEl.title = '拖动调整任务顺序';
    // 失败原因红字：显示在任务行左侧，仅失败且有原因时出现
    var failEl = rec.header.querySelector('.task-card__failreason');
    if (t.status === 'error' && t.failReason) {
      failEl.textContent = t.failReason;
      failEl.style.display = '';
      failEl.title = t.failReason;
    } else {
      failEl.textContent = '';
      failEl.style.display = 'none';
    }
    // 操作按钮（暂停/停止）仅在「正在运行」tab 显示；已完成/已停止 tab 只读
    var showOps = state.tab === 'running';
    // 暂停/继续按钮：运行中/已结束不显示暂停按钮；排队中=暂停（移出队列），暂停中=继续（插队）
    var pauseBtn = rec.header.querySelector('.task-card__pause');
    if (!showOps) {
      pauseBtn.style.display = 'none';
    } else if (t.status === 'queued') {
      pauseBtn.style.display = '';
      pauseBtn.className = 'task-card__pause';
      pauseBtn.disabled = false;
      pauseBtn.innerHTML = icon('pause', 12) + '暂停';
      pauseBtn.title = '移出执行队列（点击继续可插回原位置）';
    } else if (t.status === 'paused') {
      pauseBtn.style.display = '';
      pauseBtn.className = 'task-card__pause task-card__pause--resume';
      pauseBtn.disabled = false;
      pauseBtn.innerHTML = icon('play', 12) + '继续';
      pauseBtn.title = '按当前位置插回执行队列';
    } else {
      pauseBtn.style.display = 'none';
    }
    // 停止按钮：运行中=强停；排队/暂停中=取消任务；已结束禁用
    var stopBtn = rec.header.querySelector('.task-card__stop');
    var canStop = t.status === 'running' || t.status === 'queued' || t.status === 'paused';
    stopBtn.style.display = showOps ? '' : 'none';
    stopBtn.disabled = !canStop;
    stopBtn.title = t.status === 'running' ? '终止运行中的任务进程' : (canStop ? '取消该任务，不再执行' : '任务已结束');
    // 单行删除按钮：仅已结束任务（完成/停止/失败/已中断）且在已完成/已停止列表显示
    var delBtn = rec.header.querySelector('.task-card__del');
    var isEnded = t.status === 'done' || t.status === 'stopped' || t.status === 'error' || t.status === 'interrupted';
    delBtn.style.display = (isEnded && state.tab !== 'running') ? '' : 'none';
    // 进度条：数字行（当前/总）+ 下方进度条，仅解析到总进度后显示
    var prog = t.progress || {};
    var total = prog.total || 0;
    var clipTarget = prog.clipTarget || 0;
    var clip = Math.max(0, prog.clip || 0);
    if (clipTarget > 0) {
      var pct = Math.max(0, Math.min(clip / clipTarget, 1));
      rec.progressLabel.textContent = '成片 ' + (prog.current || 0) + '/' + total;
      rec.progressPct.textContent = Math.round(pct * 100) + '%';
      rec.progressFill.style.width = (pct * 100) + '%';
      rec.progressEl.style.display = 'flex';
    } else if (total > 0) {
      var cur = Math.max(0, Math.min(prog.current || 0, total));
      rec.progressLabel.textContent = cur + '/' + total;
      rec.progressPct.textContent = Math.round(cur / total * 100) + '%';
      rec.progressFill.style.width = (cur / total * 100) + '%';
      rec.progressEl.style.display = 'flex';
    } else {
      rec.progressEl.style.display = 'none';
    }
    // 追加新增日志（增量更新，避免整表重渲染）
    var lines = t.log || [];
    if (lines.length > rec.logCount) {
      var frag = document.createDocumentFragment();
      for (var i = rec.logCount; i < lines.length; i++) {
        frag.appendChild(document.createTextNode(lines[i]));
        frag.appendChild(document.createTextNode('\n'));
      }
      rec.logCount = lines.length;
      rec.logEl.appendChild(frag);
      if (rec.expanded) rec.logEl.scrollTop = rec.logEl.scrollHeight;
    }
  }

  // 任务右键菜单：置顶（仅排队）/ 暂停（排队）/ 继续（暂停）/ 打开成片文件夹
  function showTaskMenu(x, y, t) {
    var items = [];
    function openFolder() {
      call('open_path', t.outDir).then(function (r) {
        if (r && !r.ok) alertDialog('打开失败：' + (r.error || '成片文件夹不存在'));
      }).catch(function () {});
    }
    // 已结束任务（完成/停止/失败/中断）只读，仅提供打开成片文件夹
    if (t.status === 'done' || t.status === 'stopped' || t.status === 'error' || t.status === 'interrupted') {
      var it = { label: '打开成片文件夹', action: openFolder };
      if (!t.outDir) { it.disabled = true; it.title = '该任务没有成片文件夹信息'; }
      showMenu(x, y, [it]);
      return;
    }
    if (t.status === 'queued') {
      items.push({ label: '置顶任务', action: function () {
        call('pin_task', t.id).then(function (r) {
          if (r && !r.ok) alertDialog('置顶失败：' + (r.error || '未知错误'));
        }).catch(function (e) { alertDialog('置顶失败：' + e.message); });
      } });
      items.push({ label: '暂停任务', action: function () { confirmPause(t); } });
    } else if (t.status === 'paused') {
      items.push({ label: '继续任务', action: function () { confirmResume(t); } });
    } else if (t.status === 'running') {
      items.push({ label: '停止任务', action: function () { confirmStop(t); } });
    }
    items.push({ label: '打开成片文件夹', action: openFolder });
    var last = items[items.length - 1];
    if (!t.outDir) { last.disabled = true; last.title = '该任务没有成片文件夹信息'; }
    showMenu(x, y, items);
  }

  function confirmStop(t) {
    var warn = t.status === 'running' && t.lockState === 'locked'
      ? '\n\n注意：任务可能正在生成视频，停止将中断当前生成并可能留下不完整文件！'
      : '';
    var msg = (t.status === 'running' ? '确定要停止任务「' + (t.title || t.id) + '」吗？' : '确定要取消任务「' + (t.title || t.id) + '」吗？') + warn;
    confirmDialog(msg).then(function (ok) {
      if (!ok) return;
      call('stop_task', t.id).then(function (r) {
        if (!r || !r.ok) alertDialog('停止失败：' + ((r && r.error) || '未知错误'));
      }).catch(function (e) { alertDialog('停止失败：' + e.message); });
    });
  }

  function confirmPause(t) {
    call('pause_task', t.id).then(function (r) {
      if (!r || !r.ok) alertDialog('暂停失败：' + ((r && r.error) || '未知错误'));
    }).catch(function (e) { alertDialog('暂停失败：' + e.message); });
  }

  function confirmResume(t) {
    call('resume_task', t.id).then(function (r) {
      if (!r || !r.ok) alertDialog('恢复失败：' + ((r && r.error) || '未知错误'));
    }).catch(function (e) { alertDialog('恢复失败：' + e.message); });
  }

  function renderTasks(tasks) {
    var list = $('taskList');
    if (!list) return;
    tasks = tasks || [];
    // 顶部三个 tab 计数 + 已停止 tab 报错提醒
    updateTabCounts(tasks);
    // 按当前 tab 过滤出列表内容
    var cur;
    if (state.tab === 'done') cur = tasks.filter(function (t) { return t.status === 'done'; });
    else if (state.tab === 'stopped') cur = tasks.filter(function (t) { return t.status === 'stopped' || t.status === 'error' || t.status === 'interrupted'; });
    else cur = tasks.filter(function (t) { return t.status === 'running' || t.status === 'queued' || t.status === 'paused'; });
    if (!cur.length) { list.innerHTML = '<div class="task-empty">' + emptyText(state.tab) + '</div>'; rendered = {}; return; }
    var ids = {};
    cur.forEach(function (t) { ids[t.id] = true; });
    Object.keys(rendered).forEach(function (id) {
      if (!ids[id]) { var el = rendered[id].el; if (el.parentNode) el.parentNode.removeChild(el); delete rendered[id]; }
    });
    var emptyEl = list.querySelector('.task-empty');
    if (emptyEl) emptyEl.remove();
    cur.forEach(function (t) {
      var rec = rendered[t.id];
      if (!rec) { rec = buildCard(t); rendered[t.id] = rec; }
      updateCard(rec, t);
      if (rec.el.parentNode !== list) list.appendChild(rec.el);
    });
  }

  function emptyText(tab) {
    if (tab === 'done') return '暂无已完成任务';
    if (tab === 'stopped') return '暂未停止或出错的任务';
    return '暂无正在运行的任务，在主窗口点击「启动脚本」或「复刻」开始生成';
  }

  function setCnt(id, n) { var el = $(id); if (el) el.textContent = String(n); }
  function updateTabCounts(tasks) {
    var run = 0, done = 0, stop = 0, err = 0;
    tasks.forEach(function (t) {
      if (t.status === 'running' || t.status === 'queued' || t.status === 'paused') run++;
      else if (t.status === 'done') done++;
      else if (t.status === 'stopped' || t.status === 'error' || t.status === 'interrupted') { stop++; if (t.status === 'error' || t.status === 'interrupted') err++; }
    });
    setCnt('cntRunning', run);
    setCnt('cntDone', done);
    setCnt('cntStopped', stop);
    // 已停止 tab：新增因报错/中断进入的任务且尚未查看时，按钮标浅红底提醒
    state._errCount = err;
    var tabStop = $('tabStopped');
    if (!tabStop) return;
    if (err > state._viewedErr) tabStop.classList.add('task-tab--alert');
    else tabStop.classList.remove('task-tab--alert');
  }

  // 右下角悬浮按钮：正在运行=「全部继续（左）」+「全部暂停（右）」；已完成/已停止=清除列表
  function updateFab() {
    var actions = $('taskFabActions'), fab = $('taskFab');
    if (!actions || !fab) return;
    if (state.tab === 'running') { actions.style.display = ''; fab.style.display = 'none'; }
    else { actions.style.display = 'none'; fab.style.display = ''; }
  }
  function onFabClearClick() {
    var isDone = state.tab === 'done';
    var which = isDone ? '已完成' : '已停止';
    // 二次确认弹窗与主窗口样式一致
    confirmDialog('确定要清除「' + which + '」列表中的所有任务吗？此操作不可恢复。').then(function (ok) {
      if (!ok) return;
      var statuses = isDone ? ['done'] : ['stopped', 'error', 'interrupted'];
      call('clear_finished_tasks', statuses).then(function (r) {
        if (r && !r.ok) alertDialog('清除失败：' + (r.error || '未知错误'));
      }).catch(function (e) { alertDialog('清除失败：' + e.message); });
    });
  }

  function switchTab(tab) {
    if (state.tab === tab) return;
    state.tab = tab;
    Array.prototype.forEach.call(document.querySelectorAll('.task-tab'), function (b) {
      var active = b.getAttribute('data-tab') === tab;
      b.classList.toggle('task-tab--active', active);
    });
    if (tab === 'stopped') state._viewedErr = state._errCount; // 进入查看即消除红底
    updateFab();
    var api = getApi();
    if (api && api.list_tasks) api.list_tasks().then(renderTasks).catch(function () {});
  }

  function init() {
    var api = getApi();
    if (!api) return;
    if (api.get_skin) api.get_skin().then(function (skin) { document.documentElement.setAttribute('data-skin', skin || 'white_blue'); }).catch(function () {});
    hydrateIcons(document);
    Array.prototype.forEach.call(document.querySelectorAll('.task-tab'), function (b) {
      b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
    });
    var fabResume = $('fabResumeAll');
    if (fabResume) fabResume.addEventListener('click', function () {
      call('resume_all_tasks').then(function (r) {
        if (r && !r.ok) alertDialog('暂无暂停的任务');
      }).catch(function (e) { alertDialog('全部继续失败：' + e.message); });
    });
    var fabPause = $('fabPauseAll');
    if (fabPause) fabPause.addEventListener('click', function () {
      call('pause_all_tasks').then(function (r) {
        if (r && !r.ok) alertDialog('暂无排队中的任务');
      }).catch(function (e) { alertDialog('全部暂停失败：' + e.message); });
    });
    $('taskFab').addEventListener('click', onFabClearClick);
    updateFab();
    if (api.list_tasks) api.list_tasks().then(renderTasks).catch(function () {});
    if (api.on_task_update) api.on_task_update(renderTasks);
    // 1 秒轮询兜底刷新：解决 IPC 推送偶发丢失导致"有任务却显示暂无任务"，
    // 并保证控制台日志/状态每 1 秒刷新一次，而非仅在成片生成时才更新。
    setInterval(function () {
      if (api.list_tasks) api.list_tasks().then(renderTasks).catch(function () {});
    }, 1000);
  }
  document.addEventListener('DOMContentLoaded', init);
})();