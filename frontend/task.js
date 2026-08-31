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

  // 图标统一来自 icons.js 全局库（硬约束：不在业务文件维护 ICONS/icon 副本）
  function icon(name, size, cls) { return window.VL_icon ? window.VL_icon(name, size, cls) : ''; }
  function hydrateIcons(root) { if (window.VL_hydrateIcons) window.VL_hydrateIcons(root); }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // 主窗口同款模态弹窗（按钮样式复用 styles.css 的 .modal-btn / .modal-card）
  function showDialog(opts) {
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      var card = document.createElement('div');
      card.className = 'modal-card' + (opts.cardClass ? ' ' + opts.cardClass : '');
      var html = '<button type="button" class="modal-close" title="关闭">✕</button><div class="modal__title">' + escapeHtml(opts.title) + '</div>';
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
      var closeBtn = card.querySelector('.modal-close');
      if (closeBtn) closeBtn.addEventListener('click', function () { done(null); });
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

  // 任务日志展示过滤：仅影响展示，后端日志数据保持完整。
  // 1) 内部机制/冗余行（互斥锁、索引加载与自动修正、TXT已同步、预检测计数、
  //    生成/分组数确认、创建输出目录标题）用户无需关注，直接隐去；
  // 2) 复刻模式2每次重试尝试的片段替换详情，被"替换后总时长…重试替换"覆盖的前一轮丢弃，
  //    仅保留最终采用的那一轮（重试次数行保留）
  function filterTaskLogLines(lines) {
    var out = [];
    var block = null;
    function flush() { if (block) { out.push.apply(out, block); block = null; } }
    var ignore = [
      /^(🔒 已获取互斥锁|🔓 互斥锁已释放|📇 已加载索引|🔎 索引自动修正|✅ TXT文件已同步更新|预检测视频文件|设置生成数量|设置分组数|等待获取互斥锁|创建输出目录|✅ 输出目录)/,
      /^已通过 BATCH_(COUNT|GROUP) 指定/,
      /^✅ 已通过 REPLICA_TXT 指定TXT文件/,
      /：\s*\d+\s*个视频/
    ];
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (ignore.some(function (re) { return re.test(ln); })) continue;
      if (/^🔀 模式2：尾部新增替换/.test(ln)) { flush(); block = []; block.push(ln); continue; }
      if (block && /^\s*第\s*\d+\s*段:/.test(ln)) { block.push(ln); continue; }
      if (block && /替换后总时长.*重试替换（/.test(ln)) {
        block = null; // 前一轮替换详情将被重试覆盖，丢弃
        out.push(ln);
        continue;
      }
      flush();
      out.push(ln);
    }
    flush();
    return out;
  }
  var state = { tab: 'running', _errCount: 0, _viewedErr: 0 };
  // 已完成列表按日期分组的展开状态：dayKey -> true(展开)/false(折叠)；未记录时首组展开、其余折叠
  var doneGroupsExpanded = {};

  // 控制台日志滚动辅助：logAtBottom 判断是否停在最新一行（底部），
  // scrollLogBottom 直接滚到底。
  // 跟随语义：following=true 表示「该跟随最新」——初始为 true；每次滚动实时
  // 同步（在底部→ true，上滚看历史→ false）；日志不可见时（折叠卡片 / 切换 tab
  // / 关闭列表重开后）一律重置为 true，保证再次展开即最新一行
  function logAtBottom(el) { return el.scrollHeight - (el.scrollTop + el.clientHeight) <= 2; }
  function scrollLogBottom(el) { el.scrollTop = el.scrollHeight; }
  // 时间格式跟随实际用时：几十秒只显秒；1m1s / 10m10s / 1h0m10s（分秒含 0 亦保留）
  function humanDuration(sec) {
    var s = Math.max(0, Math.round(sec));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    if (h > 0) return h + 'h' + m + 'm' + x + 's';
    if (m > 0) return m + 'm' + x + 's';
    return x + 's';
  }
  // ffmpeg 状态行 elapsed：HH:MM:SS.mmm 或纯秒数 float，统一解析成秒
  function parseElapsedSec(v) {
    var s = String(v).trim(), p = s.split(':');
    if (p.length === 3) {
      var sec = parseFloat(p[2]);
      return (parseInt(p[0], 10) || 0) * 3600 + (parseInt(p[1], 10) || 0) * 60 + (isNaN(sec) ? 0 : sec);
    }
    var f = parseFloat(s);
    return isNaN(f) ? NaN : f;
  }
  // ffmpeg 实时进度行直译：顺序按原文，fps/重复帧不显示，质量字段保留 q 标签，
  // 体积换算 MB（KiB/1024，1 位小数）；丢帧字段缺失时补 0 不留空；elapsed（秒）格式化为时分秒
  function mbText(v) {
    var m = String(v).match(/^([\d.]+)\s*kib$/i);
    return m ? (parseFloat(m[1]) / 1024).toFixed(1) + 'MB' : v;
  }
  function liveLineText(o) {
    if (!o) return '';
    var order = [['frame', '总帧数'], ['q', 'q'], ['size', '大小'], ['time', '时间'], ['bitrate', '码率'], ['drop', '丢帧'], ['elapsed', '已用时'], ['speed', '速度']];
    var out = [];
    for (var i = 0; i < order.length; i++) {
      var k = order[i][0], label = order[i][1], v = o[k];
      if (k === 'drop') { if (!(parseFloat(v) > 0)) continue; } // 丢帧为 0（或缺省）不显示
      if (v === undefined || v === null || v === '') continue;
      if (k === 'size') v = mbText(v);
      if (k === 'elapsed') { var sec = parseElapsedSec(v); v = isNaN(sec) ? v : humanDuration(sec); }
      out.push(label + '=' + v);
    }
    return out.join(' ');
  }

  function bindLogFollow(rec) {
    rec.following = true;
    rec.logEl.addEventListener('scroll', function () {
      // 程序性滚动（重绘/跟随滚底触发）不改变跟随意图，仅响应用户滚动
      if (rec._progScroll) { rec._progScroll = false; return; }
      rec.following = logAtBottom(rec.logEl);
    });
  }

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
      '<button class="task-card__rerun" title="使用开始任务时的配置重新制作，删除上次失败的成片与日志">' + icon('rotate-ccw', 12) + '重新开始</button>' +
      '<button class="task-card__del" title="从列表中移除该任务">' + icon('x', 12) + '</button>';
    card.appendChild(header);
    header.querySelector('.task-card__handle').innerHTML = icon('grip-vertical', 14);

    var progress = document.createElement('div');
    progress.className = 'task-card__progress';
    progress.innerHTML =
      '<div class="task-card__progress-text"><span class="task-card__progress-label"></span><span class="task-card__progress-elapsed"></span><span class="task-card__progress-pct"></span></div>' +
      '<div class="task-card__progress-track"><div class="task-card__progress-fill"></div></div>';
    card.appendChild(progress);

    var body = document.createElement('div');
    body.className = 'task-card__body';
    body.style.display = 'none';
    var log = document.createElement('div');
    log.className = 'task-card__log';
    body.appendChild(log);
    card.appendChild(body);

    var record = { el: card, header: header, logEl: log, body: body, logCount: 0, expanded: false, progressEl: progress, progressLabel: progress.querySelector('.task-card__progress-label'), progressElapsed: progress.querySelector('.task-card__progress-elapsed'), progressPct: progress.querySelector('.task-card__progress-pct'), progressFill: progress.querySelector('.task-card__progress-fill') };
    bindLogFollow(record);
    header.addEventListener('click', function (e) {
      if (e.target.closest('.task-card__stop')) return;
      if (e.target.closest('.task-card__rerun')) return;
      if (e.target.closest('.task-card__pause')) return;
      if (e.target.closest('.task-card__handle')) return;
      // 排队中任务尚未开始，日志无有用信息，点击不展开
      var curT = card.__task || t;
      if (curT.status === 'queued') return;
      record.expanded = !record.expanded;
      body.style.display = record.expanded ? '' : 'none';
      if (record.expanded) { record.following = true; record._progScroll = true; scrollLogBottom(log); requestAnimationFrame(function () { record._progScroll = true; scrollLogBottom(log); }); }
      // 折叠（日志不可见）时重置跟随：下次展开直接到最新一行
      else record.following = true;
    });
    header.querySelector('.task-card__stop').addEventListener('click', function (e) {
      e.stopPropagation();
      confirmStop(card.__task || t);
    });
    header.querySelector('.task-card__rerun').addEventListener('click', function (e) {
      e.stopPropagation();
      confirmRerun(card.__task || t);
    });
    header.querySelector('.task-card__pause').addEventListener('click', function (e) {
      e.stopPropagation();
      var cur = card.__task || t;
      if (cur.status === 'paused') confirmResume(cur);
      else confirmPause(cur);
    });
    // 已结束任务单行删除：已完成/已停止任务弹出与清除按钮同款的清除方式弹窗
    header.querySelector('.task-card__del').addEventListener('click', function (e) {
      e.stopPropagation();
      var cur = card.__task || t;
      if (cur.status === 'stopped' || cur.status === 'error' || cur.status === 'interrupted') {
        openClearDialog(null, { ids: [cur.id], statuses: ['stopped', 'error', 'interrupted'] });
        return;
      }
      // 已完成任务：与清除按钮同款弹窗（+成片 / 全部清除可选）
      if (cur.status === 'done') { openClearDialog(null, { ids: [cur.id], statuses: ['done'] }); return; }
      call('clear_task', cur.id).then(function (r) {
        if (!r || !r.ok) alertDialog('删除失败：' + ((r && r.error) || '未知错误'));
      }).catch(function (err) { alertDialog('删除失败：' + err.message); });
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
    var tagEl = rec.header.querySelector('.task-card__tag');
    tagEl.textContent = TYPE_TEXT[t.type] || t.type || '';
    tagEl.className = 'task-card__tag' + ((t.type === 'batch' || t.type === 'replica') ? ' task-card__tag--' + t.type : '');
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
    // 重新开始按钮：仅失败/中断/停止任务（已停止 tab）显示，点击按原配置重制
    var rerunBtn = rec.header.querySelector('.task-card__rerun');
    var canRerun = t.status === 'error' || t.status === 'interrupted' || t.status === 'stopped';
    rerunBtn.style.display = (canRerun && state.tab !== 'running') ? '' : 'none';
    // 进度条：数字行（当前/总）+ 下方进度条，仅解析到总进度后显示；
    // 排队任务也显示预计成片数（后端创建时预填 total）；分组数>0 时追加「分 N 组」
    var prog = t.progress || {};
    var total = prog.total || 0;
    var groupCount = parseInt(prog.groupCount || '0', 10) || 0;
    var clipTarget = prog.clipTarget || 0;
    var clip = Math.max(0, prog.clip || 0);
    var groupText = groupCount > 0 ? ' · 分' + groupCount + '组' : '';
    if (clipTarget > 0) {
      var pct = Math.max(0, Math.min(clip / clipTarget, 1));
      var curClip = prog.current || 0;
      rec.progressLabel.textContent = (curClip > 0 ? '成片 ' + curClip + '/' + total : '预计成片 ' + total) + groupText;
      rec.progressPct.textContent = Math.round(pct * 100) + '%';
      rec.progressFill.style.width = (pct * 100) + '%';
      rec.progressEl.style.display = 'flex';
    } else if (total > 0) {
      var cur = Math.max(0, Math.min(prog.current || 0, total));
      rec.progressLabel.textContent = (cur > 0 ? '成片 ' + cur + '/' + total : '预计成片 ' + total) + groupText;
      rec.progressPct.textContent = Math.round(cur / total * 100) + '%';
      rec.progressFill.style.width = (cur / total * 100) + '%';
      rec.progressEl.style.display = 'flex';
    } else {
      rec.progressEl.style.display = 'none';
    }
    // 任务总用时：进度条文字行内、百分比左侧（动态时分秒格式）；
    // 宽度由 CSS min-width 固定，未开始时内容留空保持占位，避免 % 位数变化/用时出现造成跳变
    var es = parseInt(t.elapsedSec || '0', 10) || 0;
    if (rec.progressElapsed) rec.progressElapsed.textContent = es > 0 ? '总用时 ' + humanDuration(es) : '';
    // 日志重绘：后端下发的 log 是最近 500 行窗口（slice(-500)），行数不会一直增长，
    // 按行数增量追加会在追平窗口后永不更新（重开/切 tab 才见一次最新）。
    // 改为窗口内容整体重绘 + 滚动保持：跟随状态滚到底，查看历史时保持相对阅读位置。
    // 末尾追加实时进度行（liveLine）：ffmpeg 折叠单行，中文标签按序直译
    var lines = t.log || [];
    var joined = filterTaskLogLines(lines).join('\n');
    // 已结束任务：实时进度行已由"成片完成"固化进日志，不再叠加显示，避免与固化行内容重复
    var ended = t.status === 'done' || t.status === 'stopped' || t.status === 'error' || t.status === 'interrupted';
    var live = ended ? '' : liveLineText((t.progress || {}).liveLine);
    var logChanged = joined !== rec._lastLog;
    var liveChanged = live !== rec._lastLive;
    if (logChanged) {
      var rel = rec.logEl.scrollHeight - rec.logEl.scrollTop;
      rec.logEl.textContent = joined;
      rec._lastLog = joined;
    }
    // 实时进度行：textContent 覆盖会清掉它，统一在此重建/挂回日志末尾
    if (live) {
      if (!rec._liveNode) rec._liveNode = document.createElement('div');
      rec._liveNode.className = 'task-card__live';
      rec._liveNode.textContent = live;
      if (rec._liveNode.parentNode !== rec.logEl) rec.logEl.appendChild(rec._liveNode);
    } else if (rec._liveNode) {
      if (rec._liveNode.parentNode) rec._liveNode.parentNode.removeChild(rec._liveNode);
      rec._liveNode = null;
    }
    rec._lastLive = live;
    // 滚动：跟随状态滚到底（日志或进度行任一变化）；上滚看历史时保持相对阅读位
    if (logChanged || liveChanged) {
      if (rec.expanded && rec.following) { rec._progScroll = true; scrollLogBottom(rec.logEl); }
      else if (logChanged && rec.expanded) { rec._progScroll = true; rec.logEl.scrollTop = Math.max(0, rec.logEl.scrollHeight - rel); }
    }
  }

  // 任务右键菜单：置顶（仅排队）/ 暂停（排队）/ 继续（暂停）/ 打开成片文件夹
  // 已完成批量任务重分组：修复分组数错误 / 忘记分组；规则与批量脚本一致（均匀分 N 组，后缀 A/B/C…，已有分组可替换）
  function openRegroupDialog(t) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    var card = document.createElement('div');
    card.className = 'modal-card modal-card--wide';
    card.innerHTML =
      '<button type="button" class="modal-close" title="关闭">✕</button>' +
      '<div class="modal__title">重分组</div>' +
      '<div class="modal__message">为任务「' + escapeHtml(t.title || '') + '」的成片重新分组（已有分组字母会被替换）。请输入分组数：</div>' +
      '<div class="modal__input-row"><input type="number" class="modal-input" id="rgInput" min="1" max="99" value="1"></div>' +
      '<div class="modal__actions"><button type="button" class="modal-btn" data-v="cancel">取消</button><button type="button" class="modal-btn modal-btn--primary" data-v="go">开始分组</button></div>';
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    var close = function () { overlay.remove(); };
    var submit = function () {
      var inp = document.getElementById('rgInput');
      var v = parseInt(inp ? inp.value : '', 10);
      if (!(v > 0)) { alertDialog('请输入大于 0 的分组数'); return; }
      close();
      call('regroup_task', t.id, v).then(function (r) {
        if (!r || !r.ok) { alertDialog('重分组失败：' + ((r && r.error) || '未知错误')); return; }
        var msg = '重分组完成：' + (r.regrouped || 0) + ' / ' + (r.total || 0) + ' 个成片已重新分组，拼接日志已同步修改';
        if (r.errors && r.errors.length) msg += '\n\n部分未处理：\n' + r.errors.slice(0, 5).join('\n');
        alertDialog(msg);
      }).catch(function (e) { alertDialog('重分组失败：' + e.message); });
    };
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    card.querySelector('.modal-close').addEventListener('click', close);
    card.querySelector('[data-v="cancel"]').addEventListener('click', close);
    card.querySelector('[data-v="go"]').addEventListener('click', submit);
    var inp = document.getElementById('rgInput');
    if (inp) {
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
      inp.focus(); inp.select();
    }
  }
  function showTaskMenu(x, y, t) {
    var items = [];
    function openFolder() {
      call('open_path', t.outDir).then(function (r) {
        if (r && !r.ok) alertDialog('打开失败：' + (r.error || '成片文件夹不存在'));
      }).catch(function () {});
    }
    // 已结束任务（完成/停止/失败/中断）只读：已完成批量任务可重分组，其余仅提供打开成片文件夹
    if (t.status === 'done' || t.status === 'stopped' || t.status === 'error' || t.status === 'interrupted') {
      var mItems = [];
      if (t.status === 'done' && t.type === 'batch') {
        mItems.push({ label: '重分组', action: function () { openRegroupDialog(t); } });
      }
      var it = { label: '打开成片文件夹', action: openFolder };
      if (!t.outDir) { it.disabled = true; it.title = '该任务没有成片文件夹信息'; }
      mItems.push(it);
      showMenu(x, y, mItems);
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

  function confirmRerun(t) {
    var msg = '确定要重新开始这个任务吗？\n\n本次重开将使用与最初一致的配置（包括日期、输出目录等），并删除上次执行失败产生的成片和日志文件。';
    confirmDialog(msg).then(function (ok) {
      if (!ok) return;
      call('rerun_task', t.id).then(function (r) {
        if (!r || !r.ok) alertDialog('重新开始失败：' + ((r && r.error) || '未知错误'));
      }).catch(function (err) { alertDialog('重新开始失败：' + err.message); });
    });
  }

  function renderTasks(tasks) {
    var list = $('taskList');
    if (!list) return;
    tasks = tasks || [];
    // 顶部三个 tab 计数 + 已停止 tab 报错提醒
    updateTabCounts(tasks);
    // 按当前 tab 过滤出列表内容
    var cur;
    if (state.tab === 'done') {
      cur = tasks.filter(function (t) { return t.status === 'done'; });
      // 已完成列表：分组头按完成日期降序；组内跨日凌晨(0-4时)完成的任务（业务日收官产出）置顶，
      // 其余按结束时刻降序——两层排序保证组序与组内顺序都稳定
      var isDawn = function (t) { var e = Number(t.endedAt) || 0; return e > 0 && new Date(e).getHours() < 4; };
      cur.sort(function (a, b) {
        var da = dayKey(a.endedAt), db = dayKey(b.endedAt);
        if (da !== db) return da < db ? 1 : -1; // 日期降序
        var ad = isDawn(a) ? 0 : 1, bd = isDawn(b) ? 0 : 1;
        if (ad !== bd) return ad - bd;          // 同日组内凌晨任务置顶
        return (b.endedAt || 0) - (a.endedAt || 0);
      });
    }
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
    if (state.tab !== 'done') {
      // 非已完成列表不用日期分组：清掉切换 tab 时可能残留的分组头
      Array.prototype.slice.call(list.querySelectorAll('.task-day-group')).forEach(function (h) { h.parentNode.removeChild(h); });
      cur.forEach(function (t) {
        var rec = rendered[t.id];
        if (!rec) { rec = buildCard(t); rendered[t.id] = rec; }
        updateCard(rec, t);
        // 清理在已完成 tab 可能残留的分组标记与隐藏
        delete rec.el.dataset.day;
        rec.el.style.display = '';
        // 已在列表中的节点不移动：移动会 detach/attach 导致卡片内部
        // 日志滚动位置被重置（每秒轮询时控制台会被强行拉回顶部）
        if (rec.el.parentNode !== list) list.appendChild(rec.el);
      });
      return;
    }
    // 已完成列表：按日期降序分组渲染（分组头严格按日期降序，不受组内置顶顺序影响）
    var dayOrder = [];
    var dayCount = {};
    cur.forEach(function (t) {
      var d = dayKey(t.endedAt);
      if (!dayCount[d]) { dayCount[d] = 0; dayOrder.push(d); }
      // 视频数 = 该任务生成的成片数（progress.total），无进度数据时按 1 个任务计 1
      var n = (t.progress && t.progress.total > 0) ? t.progress.total : 1;
      dayCount[d] += n;
    });
    // 分组头按日期字符串降序（yy.mm.dd 零填充可直接比较）：凌晨置顶不影响组序
    dayOrder.sort().reverse();
    var firstDay = dayOrder.length ? dayOrder[0] : null;
    // 清理已过期的日期分组头（该日已无任务）；仍在的头保留 DOM 原位，
    // 避免每轮整体删除重建导致头被追加到该组卡片之后、顺序错乱（首行分组头跳动）
    var keepDays = {};
    dayOrder.forEach(function (d) { keepDays[d] = 1; });
    Array.prototype.slice.call(list.querySelectorAll('.task-day-group')).forEach(function (h) {
      if (!keepDays[h.getAttribute('data-day')]) h.parentNode.removeChild(h);
    });
    dayOrder.forEach(function (day, di) {
      // 默认首组展开、其余折叠；记录过展开状态则保持
      if (!(day in doneGroupsExpanded)) doneGroupsExpanded[day] = (di === 0);
    });
    var lastDay = null;
    var curDay = null;
    cur.forEach(function (t) {
      var day = dayKey(t.endedAt);
      if (day !== lastDay) {
        lastDay = day; curDay = day;
        // 分组头复用：存在则保留原位仅更新计数（避免重建追加到卡片后被甩到组尾），
        // 不存在才创建；新组此刻没有卡片在列表，尾部追加即正确组序（头在卡片前）
        var hdr = list.querySelector('.task-day-group[data-day="' + day + '"]');
        if (!hdr) {
          hdr = document.createElement('div');
          hdr.className = 'task-day-group';
          hdr.dataset.day = day;
          hdr.innerHTML =
            '<span class="task-day-group__label">' + day + '</span>' +
            '<span class="task-day-group__line"></span>' +
            '<span class="task-day-group__count">共 ' + dayCount[day] + ' 个视频</span>';
          // 点击整个分组头即展开/折叠该日列表（按钮已移除）
          hdr.addEventListener('click', function () {
            doneGroupsExpanded[day] = !doneGroupsExpanded[day];
            applyDoneGroupState(day);
          });
          list.appendChild(hdr);
        } else {
          var cntEl = hdr.querySelector('.task-day-group__count');
          if (cntEl) cntEl.textContent = '共 ' + dayCount[day] + ' 个视频';
        }
        hdr.classList.toggle('is-collapsed', !doneGroupsExpanded[day]);
      }
      var rec = rendered[t.id];
      if (!rec) { rec = buildCard(t); rendered[t.id] = rec; }
      updateCard(rec, t);
      rec.el.dataset.day = day;
      if (rec.el.parentNode !== list) list.appendChild(rec.el);
    });
    // 应用各日期组隐显与分组头按钮状态
    dayOrder.forEach(function (day) { applyDoneGroupState(day); });
  }

  // 按展开状态更新某日期组：折叠时隐藏该组卡片、分组头打上折叠样式
  function applyDoneGroupState(day) {
    var list = $('taskList');
    if (!list) return;
    var expanded = !!doneGroupsExpanded[day];
    list.querySelectorAll('.task-card[data-day="' + day + '"]').forEach(function (el) {
      el.style.display = expanded ? '' : 'none';
    });
    var hdr = list.querySelector('.task-day-group[data-day="' + day + '"]');
    if (!hdr) return;
    hdr.classList.toggle('is-collapsed', !expanded);
  }

  // 完成时间 → yy.mm.dd 分组键
  function dayKey(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return String(d.getFullYear()).slice(2) + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate());
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
  // 右下角清除按钮：已完成/已停止均弹出三按钮清除弹窗（全部清除另有二次确认）
  function onFabClearClick() { openClearDialog(null); }

  // 清除弹窗：仅清除列表 / 清除列表和成片(仅mp4) / 全部清除；文件删除均由后端移入回收站
  function openClearDialog(day, opts) {
    var isDone = state.tab === 'done';
    var scopeName = isDone ? '已完成' : '已停止';
    var title = day ? '清除当日任务' : '清除全部' + scopeName + '任务';
    var msg = (day ? '将清除 ' + day + ' 这一天的' : '将清除全部' + scopeName) + '任务，请选择清除方式：\n\n' +
      '· 仅清除列表：移除任务记录，成片文件保留\n' +
      '· 清除列表和成片：另删除成片视频（mp4，移入回收站）\n' +
      '· 全部清除：连同成片文件夹一并移入回收站';
    var statuses = (opts && opts.statuses) || (isDone ? ['done'] : ['stopped', 'error', 'interrupted']);
    var ids = (opts && opts.ids) || null;
    if (ids) {
      title = '清除任务';
      msg = '将清除选中的任务记录与成片，请选择清除方式：\n\n' +
        '· 仅清除列表：移除任务记录，成片文件保留\n' +
        '· 清除列表和成片：另删除成片视频（mp4，移入回收站）\n' +
        '· 全部清除：连同成片文件夹一并移入回收站';
    }
    showDialog({
      title: title,
      message: msg,
      cardClass: 'modal-card--wide',
      buttons: [
        { label: '仅清除列表', value: 'list', primary: true },
        { label: '清除列表和成片', value: 'video', primary: true },
        { label: '全部清除', value: 'all', danger: true }
      ]
    }).then(function (v) {
      if (!v || v === 'cancel') return;
      if (v === 'all') {
        // 全部清除二次确认：删除后无法根据日志和配置恢复成片
        showDialog({
          title: '确认全部清除',
          message: '删除后无法根据日志和配置恢复成片，是否继续？',
          buttons: [
            { label: '继续删除', value: 'go', danger: true, primary: true }
          ]
        }).then(function (ok) {
          if (!ok || ok === 'cancel') return;
          doClearDone(day, 'all', statuses, ids);
        });
      } else doClearDone(day, v, statuses, ids);
    });
  }

  function doClearDone(day, scope, statuses, ids) {
    call('clear_done_tasks', { day: day || null, scope: scope, statuses: statuses, ids: ids || null }).then(function (r) {
      if (!r || !r.ok) { alertDialog('清除失败：' + ((r && r.error) || '未知错误')); return; }
      if (r.errors && r.errors.length) alertDialog('部分项目清除失败：\n' + r.errors.slice(0, 5).join('\n'));
      var api = getApi();
      if (api && api.list_tasks) api.list_tasks().then(renderTasks).catch(function () {});
    }).catch(function (e) { alertDialog('清除失败：' + e.message); });
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
    // 设置页切换皮肤时实时生效（无需关闭重开任务列表）
    if (api.on_settings_saved) api.on_settings_saved(function (cfg) {
      if (cfg && cfg.skin) document.documentElement.setAttribute('data-skin', cfg.skin);
    });
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
    // 已完成分组头右键：清除当日任务（后续三按钮弹窗二次确认）
    var taskListEl = $('taskList');
    if (taskListEl) taskListEl.addEventListener('contextmenu', function (e) {
      var hdr = e.target.closest('.task-day-group');
      if (!hdr) return;
      e.preventDefault();
      var day = hdr.getAttribute('data-day');
      showMenu(e.clientX, e.clientY, [{ label: '清除当日任务', action: function () { openClearDialog(day); } }]);
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