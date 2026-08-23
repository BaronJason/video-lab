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

  var STATUS_TEXT = { running: '运行中', done: '已完成', error: '失败', stopped: '已停止' };
  var LOCK_TEXT = { unknown: '', waiting: '等待互斥锁', locked: '已获取锁', released: '已释放锁' };
  var TYPE_TEXT = { batch: '批量拼接', replica: '视频复刻' };

  function iconSvg(path, size) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="' + (size || 12) + '" height="' + (size || 12) + '">' + path + '</svg>';
  }
  var ICON_PAUSE = '<rect width="4" height="14" x="7" y="5" rx="1"/><rect width="4" height="14" x="13" y="5" rx="1"/>';
  var ICON_PLAY = '<polygon points="6 3 20 12 6 21 6 3"/>';
  var ICON_STOP = '<rect width="12" height="12" x="6" y="6" rx="1"/>';

  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  var rendered = {}; // taskId -> { el, header, logEl, body, logCount, expanded }

  function buildCard(t) {
    var card = document.createElement('div');
    card.className = 'task-card task-card--' + (t.lockState === 'waiting' ? 'waiting' : t.status);
    card.dataset.taskId = t.id;

    var header = document.createElement('div');
    header.className = 'task-card__header';
    header.innerHTML =
      '<span class="task-card__failreason"></span>' +
      '<span class="task-card__status-dot"></span>' +
      '<span class="task-card__status-text"></span>' +
      '<span class="task-card__title"></span>' +
      '<span class="task-card__tag"></span>' +
      '<span class="task-card__lock"></span>' +
      '<span class="task-card__time"></span>' +
      '<button class="task-card__pause">' + iconSvg(ICON_PAUSE, 12) + '暂停</button>' +
      '<button class="task-card__stop">' + iconSvg(ICON_STOP, 12) + '停止</button>';
    card.appendChild(header);

    var progress = document.createElement('div');
    progress.className = 'task-card__progress';
    progress.innerHTML =
      '<div class="task-card__progress-text"></div>' +
      '<div class="task-card__progress-track"><div class="task-card__progress-fill"></div></div>';
    card.appendChild(progress);

    var body = document.createElement('div');
    body.className = 'task-card__body';
    body.style.display = 'none';
    var log = document.createElement('div');
    log.className = 'task-card__log';
    body.appendChild(log);
    card.appendChild(body);

    var record = { el: card, header: header, logEl: log, body: body, logCount: 0, expanded: false, progressEl: progress, progressText: progress.querySelector('.task-card__progress-text'), progressFill: progress.querySelector('.task-card__progress-fill') };
    header.addEventListener('click', function (e) {
      if (e.target.closest('.task-card__stop')) return;
      if (e.target.closest('.task-card__pause')) return;
      record.expanded = !record.expanded;
      body.style.display = record.expanded ? '' : 'none';
      if (record.expanded) log.scrollTop = log.scrollHeight;
    });
    header.querySelector('.task-card__stop').addEventListener('click', function (e) {
      e.stopPropagation();
      confirmStop(t);
    });
    header.querySelector('.task-card__pause').addEventListener('click', function (e) {
      e.stopPropagation();
      confirmPause(t);
    });
    return record;
  }

  function updateCard(rec, t) {
    rec.el.className = 'task-card task-card--' + (t.paused ? 'paused' : (t.lockState === 'waiting' ? 'waiting' : t.status));
    rec.header.querySelector('.task-card__status-text').textContent = t.paused ? '已暂停' : (STATUS_TEXT[t.status] || t.status);
    rec.header.querySelector('.task-card__title').textContent = t.title || '';
    rec.header.querySelector('.task-card__title').title = t.script || '';
    rec.header.querySelector('.task-card__tag').textContent = TYPE_TEXT[t.type] || t.type || '';
    var lockText = LOCK_TEXT[t.lockState] || '';
    var lockEl = rec.header.querySelector('.task-card__lock');
    lockEl.textContent = lockText;
    lockEl.className = 'task-card__lock' + (lockText ? ' task-card__lock--' + t.lockState : '');
    rec.header.querySelector('.task-card__time').textContent = fmtTime(t.createdAt);
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
    // 暂停/继续按钮：颜色、文字、图标随状态切换；仅运行中可操作，已获取锁时禁用
    var pauseBtn = rec.header.querySelector('.task-card__pause');
    var running = t.status === 'running';
    var paused = !!t.paused;
    pauseBtn.disabled = !running || (!paused && t.lockState === 'locked');
    if (paused) {
      pauseBtn.className = 'task-card__pause task-card__pause--resume';
      pauseBtn.innerHTML = iconSvg(ICON_PLAY, 12) + '继续';
    } else {
      pauseBtn.className = 'task-card__pause';
      pauseBtn.innerHTML = iconSvg(ICON_PAUSE, 12) + '暂停';
    }
    var stopBtn = rec.header.querySelector('.task-card__stop');
    stopBtn.disabled = t.status !== 'running';
    // 进度条：数字行（当前/总）+ 下方进度条，仅解析到总进度后显示
    var prog = t.progress || {};
    var total = prog.total || 0;
    if (total > 0) {
      var cur = Math.max(0, Math.min(prog.current || 0, total));
      rec.progressText.textContent = cur + '/' + total;
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

  function renderTasks(tasks) {
    var list = $('taskList');
    if (!list) return;
    tasks = tasks || [];
    if (!tasks.length) { list.innerHTML = '<div class="task-empty">暂无任务，在主窗口点击「启动脚本」或「复刻」开始生成</div>'; rendered = {}; return; }
    var ids = {};
    tasks.forEach(function (t) { ids[t.id] = true; });
    Object.keys(rendered).forEach(function (id) {
      if (!ids[id]) { var el = rendered[id].el; if (el.parentNode) el.parentNode.removeChild(el); delete rendered[id]; }
    });
    var frag = document.createDocumentFragment();
    tasks.forEach(function (t) {
      var rec = rendered[t.id];
      if (!rec) { rec = buildCard(t); rendered[t.id] = rec; }
      updateCard(rec, t);
      if (!rec.el.parentNode) frag.appendChild(rec.el);
    });
    list.appendChild(frag);
    var running = 0, done = 0, err = 0;
    tasks.forEach(function (t) {
      if (t.status === 'running') running++;
      else if (t.status === 'done') done++;
      else err++;
    });
    $('taskStat').textContent = '共 ' + tasks.length + ' 个 · 运行中 ' + running + ' · 完成 ' + done + ' · 结束 ' + err;
  }

  function confirmStop(t) {
    var warn = t.lockState === 'locked'
      ? '\n\n注意：该任务已获取互斥锁，可能正在生成视频，停止将中断当前生成并可能留下不完整文件！'
      : '';
    var msg = '确定要停止任务「' + (t.title || t.id) + '」吗？' + warn;
    if (!window.confirm(msg)) return;
    call('stop_task', t.id).then(function (r) {
      if (!r || !r.ok) window.alert('停止失败：' + ((r && r.error) || '未知错误'));
    }).catch(function (e) { window.alert('停止失败：' + e.message); });
  }

  function confirmPause(t) {
    if (t.paused) {
      call('resume_task', t.id).then(function (r) {
        if (!r || !r.ok) window.alert('恢复失败：' + ((r && r.error) || '未知错误'));
      }).catch(function (e) { window.alert('恢复失败：' + e.message); });
      return;
    }
    var msg = '确定要暂停任务「' + (t.title || t.id) + '」吗？\n\n暂停后任务会挂起等待，不会获取互斥锁，方便其他排队任务先行处理。';
    if (!window.confirm(msg)) return;
    call('pause_task', t.id).then(function (r) {
      if (!r || !r.ok) window.alert('暂停失败：' + ((r && r.error) || '未知错误'));
    }).catch(function (e) { window.alert('暂停失败：' + e.message); });
  }

  function init() {
    var api = getApi();
    if (!api) return;
    if (api.get_skin) api.get_skin().then(function (skin) { document.documentElement.setAttribute('data-skin', skin || 'white_blue'); }).catch(function () {});
    if (api.list_tasks) api.list_tasks().then(renderTasks).catch(function () {});
    if (api.on_task_update) api.on_task_update(renderTasks);
    // 1 秒轮询兜底刷新：解决 IPC 推送偶发丢失导致"有任务却显示暂无任务"，
    // 并保证控制台日志/状态每 1 秒刷新一次，而非仅在成片生成时才更新。
    setInterval(function () {
      if (api.list_tasks) api.list_tasks().then(renderTasks).catch(function () {});
    }, 1000);
    $('btnClearFinished').addEventListener('click', function () { call('clear_finished_tasks').catch(function () {}); });
  }
  document.addEventListener('DOMContentLoaded', init);
})();
