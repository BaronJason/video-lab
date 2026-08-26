/* -*- coding: utf-8 -*-
 * Video Lab — 前端逻辑
 */
(function () {
  'use strict';

  // 图标统一来自 icons.js 全局库（硬约束：不在业务文件维护 ICONS/icon 副本）
  function icon(name, size, cls) { return window.VL_icon ? window.VL_icon(name, size, cls) : ''; }
  function hydrateIcons(root) { if (window.VL_hydrateIcons) window.VL_hydrateIcons(root); }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
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
      if (it.disabled) { b.disabled = true; b.className = 'ctx-menu__btn--disabled'; if (it.title) b.title = it.title; return; }
      b.addEventListener('click', function () { m.remove(); it.action(); });
    });
    document.body.appendChild(m);
    m.style.left = x + 'px'; m.style.top = y + 'px';
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
  function getApi() {
    return window.txapi || (window.pywebview && window.pywebview.api) || null;
  }
  function call(method) {
    var args = Array.prototype.slice.call(arguments, 1);
    var api = getApi();
    if (!api || typeof api[method] !== 'function') return Promise.reject(new Error('后端接口不可用: ' + method));
    return Promise.resolve().then(function () { return api[method].apply(api, args); });
  }
  var state = {
    projects: [], activeProject: null, activeTxt: null, versions: [], activeVersion: null,
    configData: null, mode: 'filelist', highlightDup: false, searchQuery: '', logSearchQuery: '',
    expandedProject: null, sortMode: 'name', sortAsc: true, sortTimeDesc: true, rightPreview: true, precheckInvalid: false, logContent: null,
    logFiles: [], activeLogDate: null, activeLogPath: null, selectMode: false, selectedLogPaths: {},
    focusVideo: null, _searchTimer: null, _fromConfig: false, envMissing: [],
    isPortable: null // 运行时形态：null=未知（按便携处理）/ true=便携 zip / false=setup 安装版
  };
  // 复刻虚拟项目：仅含日志无配置，配置名对应复刻模式；REPLICA_MARK 为路由标记，透传回后端
  var REPLICA_PROJECT = '复刻';
  var REPLICA_MARK = 'REPLICA:';
  function $(id) { return document.getElementById(id); }

  function branchNum(s) { var m = /^(\d{2})(\d{2})$/.exec(s || ''); return m ? parseInt(m[1], 10) * 100 + parseInt(m[2], 10) : 0; }
  // 名称排序：按 azbar 的拼音首字母顺序（A→Z，兜底 # 最后），与 A-Z 索引条一致
  function azRank(name) {
    var L = azInitial(name);
    var i = AZ_KEYS.indexOf(L);
    return i >= 0 ? i : AZ_KEYS.length;
  }
  function sortByName(a, b) {
    var r = azRank(a.name) - azRank(b.name);
    if (r !== 0) return r;
    return String(a.name).localeCompare(String(b.name), 'zh');
  }
  function sortedProjects() {
    var list = state.projects.slice();
    // 项目名始终按名称升序（升降序仅作用于配置项），复刻虚拟项目固定放最下面
    list.sort(function (a, b) {
      if (a.name === REPLICA_PROJECT) return 1;
      if (b.name === REPLICA_PROJECT) return -1;
      return String(a.name).localeCompare(String(b.name), 'zh');
    });
    return list;
  }
  function updateSortButtons() {
    function render(id, active, arrow) { var b = $(id); if (!b) return; b.innerHTML = '<span class="sort-toggle__arrow">' + arrow + '</span>' + (id === 'btnSortName' ? '名称' : '时间'); b.classList.toggle('sort-toggle--active', active); }
    render('btnSortName', state.sortMode === 'name', state.sortAsc ? '▲' : '▼');
    render('btnSortTime', state.sortMode === 'time', state.sortTimeDesc ? '▼' : '▲');
  }
  function sortedTxts(txts) {
    var list = txts.slice();
    if (state.sortMode === 'time') {
      list.sort(function (a, b) { var d = branchNum(b.latest) - branchNum(a.latest); return state.sortTimeDesc ? d : -d; });
    } else {
      list.sort(function (a, b) { var r = sortByName(a, b); return state.sortAsc ? r : -r; });
    }
    return list;
  }
  // 时间排序按月份分组：取配置版本 label（如 0802、0802-1、0802*）开头的两位月份，忽略后缀
  function monthOf(label) {
    var m = /^(\d{2})/.exec(String(label || '').trim());
    return m ? parseInt(m[1], 10) : 0;
  }
  function buildSidebar(forceAz) {
    var tree = $('sidebarTree');
    var html = '';
    sortedProjects().forEach(function (proj) {
      var expanded = (proj.name === state.expandedProject);
      html += '<div class="tree-project">';
      html += '<div class="tree-project__name' + (expanded ? ' tree-project__name--sticky is-filled' : '') + '" data-project="' + escapeHtml(proj.name) + '">';
      html += '<span class="tree-arrow' + (expanded ? ' tree-arrow--open' : '') + '"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
      html += icon('folder', 16, 'tree-project__icon');
      html += escapeHtml(proj.name);
      // 项目名行右侧：展开时显示「共 N 个配置」徽章（复刻虚拟项目无配置则不显示）
      if (proj.name !== REPLICA_PROJECT && expanded) {
        html += '<span class="tree-project__badge">共 ' + proj.txts.length + ' 个配置</span>';
      }
      html += '</div>';
      if (expanded) {
        html += '<div class="tree-project__items">';
        var lastGroupKey = null;
        var isReplica = (proj.name === REPLICA_PROJECT);
        sortedTxts(proj.txts).forEach(function (txt) {
          var isActive = (proj.name === state.activeProject && txt.name === state.activeTxt);
          var matched = !state.searchQuery || txt.name.toLowerCase().indexOf(state.searchQuery.toLowerCase()) >= 0;
          if (!matched) return;
          // 名称排序按首字母分组、时间排序按月份分组：每个组的首个配置前插入分组标签行（含首组）；
          // 复刻虚拟项目的固定子项不参与分组
          if (!isReplica) {
            var groupKey = (state.sortMode === 'time')
              ? monthOf(txt.latest)
              : azInitial(txt.name);
            if (lastGroupKey === null || groupKey !== lastGroupKey) {
              var label = (state.sortMode === 'time') ? groupKey + '月' : groupKey;
              html += '<div class="tree-txt-group"><span class="tree-txt-group__label">' + escapeHtml(label) + '</span><span class="tree-txt-group__line"></span></div>';
            }
            lastGroupKey = groupKey;
          }
          var dupCls = (state.highlightDup && txt.dup) ? ' tree-txt-item--dup' : '';
          html += '<div class="tree-txt-item' + (isActive ? ' tree-txt-item--active' : '') + dupCls + '" data-project="' + escapeHtml(proj.name) + '" data-name="' + escapeHtml(txt.name) + '">';
          html += icon('file-text', 16, 'tree-txt-item__icon');
          html += '<span class="tree-txt-item__name">' + escapeHtml(txt.name) + '</span>';
          // 复刻子项无配置日期，不显示 latest；徽章显示其日志数
          if (!isReplica) html += '<span class="tree-txt-item__date">' + escapeHtml(txt.latest) + '</span>';
          html += '<span class="tree-txt-item__badge">' + txt.count + '</span></div>';
        });
        html += '</div>';
      }
      html += '</div>';
    });
    tree.innerHTML = html;
    buildAzIndex(forceAz);
    syncAzBar();
  }
  // ── 项目列表 A-Z 索引条（仅名称排序时显示） ──
  // 汉字拼音首字母（无 I/U/V，故 23 个 + "#" 兜底）
  var AZ_KEYS = 'ABCDEFGHJKLMNOPQRSTWXYZ'.split('');
  var AZ_BASE = '阿八嚓哒妸发旮哈讥咔垃痳拏噢妑七呥仨它穵夕丫帀'.split('');
  var AZ_BAR = AZ_KEYS.concat('#');
  function azInitial(name) {
    var s = String(name || '').trim();
    if (!s) return '#';
    var ch = s.charAt(0);
    if (/[A-Za-z]/.test(ch)) return ch.toUpperCase();
    if (!/[\u4e00-\u9fa5]/.test(ch)) return '#';
    for (var i = 0; i < AZ_KEYS.length; i++) {
      if (ch.localeCompare(AZ_BASE[i], 'zh') >= 0 && (i === AZ_KEYS.length - 1 || ch.localeCompare(AZ_BASE[i + 1], 'zh') < 0)) return AZ_KEYS[i];
    }
    return '#';
  }
  // 当前排序方向的字母顺序：升序 A→Z+# ，降序反向
  function azOrderArray() {
    var arr = AZ_KEYS.concat('#');
    return state.sortAsc ? arr : arr.slice().reverse();
  }
  // 当前展开项目（手风琴同一时刻仅一个）内配置项实际存在的首字母集合
  function currentExpandedTxts() {
    var proj = null;
    (state.projects || []).forEach(function (p) { if (p.name === state.expandedProject) proj = p; });
    return proj ? sortedTxts(proj.txts) : [];
  }
  function azAvailableLetters() {
    var set = {};
    currentExpandedTxts().forEach(function (t) { set[azInitial(t.name)] = 1; });
    return set;
  }
  // 已显示的字母：仅保留当前展开项目配置中实际存在的首字母（无对应配置的字母不显示）
  function displayedAzLetters() {
    var avail = azAvailableLetters();
    return azOrderArray().filter(function (L) { return avail[L]; });
  }
  function buildAzIndex(force) {
    var bar = $('azIndexBar');
    if (!bar) return;
    var letters = displayedAzLetters();
    var existing = Array.prototype.map.call(bar.children, function (c) { return String(c.dataset.letter || ''); });
    // 字母序列未变且非强制（如点击同一项目的配置）：复用现有字母 DOM，避免重放高亮/扫描动画
    if (!force && existing.length === letters.length && existing.every(function (L, i) { return L === letters[i]; })) {
      return;
    }
    bar.innerHTML = '';
    _lastAzActive = null; // 字母 DOM 重建后幂等基准失效，需重新判定高亮
    letters.forEach(function (L) {
      var b = document.createElement('span');
      b.className = 'az-letter';
      b.textContent = L;
      b.dataset.letter = L;
      bar.appendChild(b);
    });
    // 重建后整列字母作为整体从左到右渐显，动画期间不设高亮（保持初始排布）
    bar.classList.remove('az-bar--enter');
    void bar.offsetWidth;
    bar.classList.add('az-bar--enter');
    if (!bar.dataset.azAnimBound) {
      bar.dataset.azAnimBound = '1';
      bar.addEventListener('animationend', function (ev) {
        if (ev.animationName !== 'az-bar-enter') return;
        bar.classList.remove('az-bar--enter');
        // 仅当由点击/交互引起（_azPending）才执行突出判定，无交互保持初始排布
        if (_azPending) { _azPending = false; syncAzHighlight(); }
      });
    }
    if (bar.dataset.bound) return;
    bar.dataset.bound = '1';
    bar.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      function move(ev) { azJumpByPos(ev.clientY, true); }
      function up() {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        syncAzHighlight();
        var tree = $('sidebarTree');
        if (tree) {
          tree.querySelectorAll('.tree-txt-item--az').forEach(function (it) {
            it.classList.remove('tree-txt-item--az');
          });
        }
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
      azJumpByPos(e.clientY, true);
    });
  }
  var _lastAzActive = null;
  var _azPending = false; // 点击/交互后置位，动画结束才消费，避免无交互时自动高亮
  function setAzActive(letter) {
    var bar = $('azIndexBar');
    if (!bar) return;
    if (_lastAzActive === letter) return; // 首字母未变化：不重放高亮弹出动画
    _lastAzActive = letter;
    bar.querySelectorAll('.az-letter').forEach(function (b) { b.classList.toggle('az-letter--active', b.dataset.letter === letter); });
  }
  function azJumpByPos(clientY, highlightOnDrag) {
    var bar = $('azIndexBar');
    if (!bar) return;
    var order = displayedAzLetters();
    if (!order.length) return;
    var rect = bar.getBoundingClientRect();
    var h = rect.height / order.length;
    var idx = Math.min(order.length - 1, Math.max(0, Math.floor((clientY - rect.top) / h)));
    var letter = order[idx];
    if (highlightOnDrag) setAzActive(letter);
    azJumpTo(letter);
  }
  // 索引范围为当前展开项目内的配置项；将对应首字母组的第一个配置强制滚动到列表最顶
  function azJumpTo(letter) {
    letter = String(letter).toUpperCase();
    var tree = $('sidebarTree');
    if (!tree) return;
    var txts = currentExpandedTxts();
    var target = null;
    for (var j = 0; j < txts.length; j++) {
      if (azInitial(txts[j].name) === letter) { target = txts[j].name; break; }
    }
    if (!target) { syncAzHighlight(); return; }
    var items = tree.querySelectorAll('.tree-txt-item');
    // 展开项目名置顶会遮挡列表顶端，按被粘性头部高度偏移滚动，避免与 azbar 跳转冲突
    var header = tree.querySelector('.tree-project__name--sticky');
    var headerH = header ? header.offsetHeight : 0;
    for (var k = 0; k < items.length; k++) {
      items[k].classList.remove('tree-txt-item--az');
      if (items[k].getAttribute('data-name') === target) {
        items[k].classList.add('tree-txt-item--az');
        tree.scrollTop = items[k].offsetTop - headerH;
      }
    }
    syncAzHighlight();
  }
  function currentAzLetter() {
    var tree = $('sidebarTree');
    if (!tree) return null;
    // 置顶项目名会占据视口顶部，按粘性头部高度偏移，取其下作为「第一行配置」的判定基准
    var header = tree.querySelector('.tree-project__name--sticky');
    var topLimit = tree.getBoundingClientRect().top + (header ? header.offsetHeight : 0);
    var bottomLimit = tree.getBoundingClientRect().bottom;
    // 已选中配置且属于当前展开项目：选中行仍在列表可视区内则固定高亮其首字母；
    // 若被滚轮滑出可视区，则回退为视口首行配置的首字母（滚动回可见后自动恢复）
    if (state.activeProject && state.activeTxt && state.expandedProject === state.activeProject) {
      var items = tree.querySelectorAll('.tree-txt-item');
      var activeItem = null;
      for (var q = 0; q < items.length; q++) {
        if (items[q].getAttribute('data-name') === state.activeTxt) { activeItem = items[q]; break; }
      }
      if (activeItem) {
        var r = activeItem.getBoundingClientRect();
        if (r.top < bottomLimit && r.bottom > topLimit) return azInitial(state.activeTxt);
      }
    }
    var nodes = tree.querySelectorAll('.tree-txt-item');
    if (!nodes.length) return null;
    var first = null;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].getBoundingClientRect().bottom >= topLimit) { first = nodes[i]; break; }
    }
    if (!first) first = nodes[nodes.length - 1];
    return azInitial(first.getAttribute('data-name') || '');
  }
  function syncAzHighlight() {
    var cur = currentAzLetter();
    setAzActive(cur);
  }
  function syncAzBar() {
    var bar = $('azIndexBar');
    if (!bar) return;
    var tree = $('sidebarTree');
    var hasTxt = !!(tree && tree.querySelector('.tree-txt-item'));
    var show = state.sortMode === 'name' && hasTxt;
    bar.classList.toggle('is-show', show);
    // 不自动判定高亮：由点击/滚动/拖拽交互触发（无交互保持初始排布）
  }
  // 仅当配置分支名/日期为严格 4 位 MMdd 时返回该日期，否则返回空串
  function mmddOf(label) { var s = String(label || ''); return /^\d{4}$/.test(s.slice(0, 4)) ? s.slice(0, 4) : ''; }

  // 返回去除项目名后的展示相对路径（如 8月\0819\...\xxx.txt）
  function relToProject(p) {
    var s = String(p || '').replace(/[\\/]+/g, '\\');
    var proj = String(state.activeProject || '').replace(/[\\/]+/g, '\\');
    if (!proj) return s;
    var i = s.indexOf('\\' + proj + '\\');
    return (i === -1) ? s : s.slice(i + proj.length + 2);
  }
  function dirnamePath(p) {
    var s = String(p || '').replace(/[\\/]+/g, '\\').replace(/\\$/, '');
    var i = s.lastIndexOf('\\');
    return i === -1 ? s : s.slice(0, i);
  }
  // 某日志文件对应的可跳配置版本：优先「同一成片文件夹内的正本/序号」，否则回退「当日外部 * 配置」
  function versionForLogFile(f) {
    var versions = state.versions || [];
    var date = f.date;
    for (var i = 0; i < versions.length; i++) {
      var v = versions[i];
      if (v.isExternal) continue;
      if (mmddOf(v.label) !== date) continue;
      if (dirnamePath(v.path) === dirnamePath(f.path)) return v;
    }
    for (var j = 0; j < versions.length; j++) {
      var v2 = versions[j];
      if (mmddOf(v2.label) === date && v2.isExternal) return v2;
    }
    return null;
  }
  // 配置模式 → 日志：按当前配置文件版本 label 定位当日对应日志分支
  //   - 无后缀正本 / 序号化 -N → 精确匹配 label 完全一致的当日日志
  //   - 外部 * → 当日成片日志：多序号并存跳 -1(最旧)；单成片跳唯一正本；仅此一份跳当日任一
  function logTargetForVersion(files) {
    var v = state.activeVersion;
    if (!v) return null;
    var d = mmddOf(v.label);
    if (!d) return null;
    var sameDay = (files || []).filter(function (f) { return f.date === d; });
    if (!sameDay.length) return null;
    var st = String(v.label || '').slice(4); // '' | -N | *
    if (st === '*') {
      var numbered = sameDay.filter(function (f) { return /-\d+$/.test(f.label || ''); });
      if (numbered.length > 1) return numbered[0]; // 多成片并存 → -1(最旧)
      var plain = sameDay.find(function (f) { return /^\d{4}$/.test(f.label || ''); });
      if (plain) return plain; // 单成片 → 唯一正本日志
      return sameDay[0];
    }
    var exact = sameDay.find(function (f) { return f.label === v.label; });
    return exact || sameDay[0];
  }
  // 日志模式当下所选日期是否「有可跳配置」：任一该日期日志能在版本中找到正本/序号 或 外部 *
  function logDateHasConfig() {
    var logs = (state.logFiles || []).filter(function (f) { return f.date === state.activeLogDate; });
    if (!logs.length) return false;
    return logs.some(function (f) { return versionForLogFile(f) != null; });
  }
  // 依据当前所在视角与所选日期，启用/禁用「配置列表/日志」切换按钮并附带悬浮提示
  function updateModeToggle() {
    var ml = $('modeLog'), mf = $('modeFilelist');
    if (!ml || !mf) return;
    ml.disabled = false; ml.title = '';
    mf.disabled = false; mf.title = '';
    if (state.activeProject === REPLICA_PROJECT) {
      mf.disabled = true; mf.title = '复刻模式无配置文件';
      return;
    }
    if (state.mode === 'filelist') {
      if (!state.activeVersion) { ml.disabled = true; ml.title = '该配置文件没有对应日志'; return; }
      var d = mmddOf(state.activeVersion.label);
      if (!d || !state.activeVersion.hasLog) { ml.disabled = true; ml.title = '该配置文件没有对应日志'; }
    } else if (state.mode === 'log') {
      if (!state.activeLogDate) { mf.disabled = true; mf.title = '该日志没有对应日期的配置'; return; }
      if (!logDateHasConfig()) { mf.disabled = true; mf.title = '该日志没有对应日期的配置'; }
    }
  }
  function buildDateBranches() {
    var c = $('dateBranches');
    if (state.activeProject === REPLICA_PROJECT) {
      c.innerHTML = '<span class="date-branch-btn">全部日志</span>';
      updateModeToggle();
      return;
    }
    if (state.mode === 'log') { buildLogDateBranches(c); return; }
    if (!state.activeTxt || state.versions.length === 0) {
      c.innerHTML = '<div class="center-empty" style="padding:var(--spacer-16)">' + icon('arrow-left', 24, 'center-empty__icon') + '<span style="font-size:var(--body-sm-font-size)">从左侧选择一个 TXT</span></div>';
      updateModeToggle();
      return;
    }
    var html = '';
    state.versions.forEach(function (v) {
      var active = v.label === state.activeVersion.label;
      html += '<button class="date-branch-btn' + (active ? ' date-branch-btn--active' : '') + '" data-label="' + escapeHtml(v.label) + '" title="' + escapeHtml(v.path) + '">' + escapeHtml(v.label);
      html += '</button>';
    });
    c.innerHTML = html;
    updateModeToggle();
  }
  // 日志模式下：顶部展示该配置的日志文件日期分支（每日期一个），按钮带 data-date 与 data-file
  function buildLogDateBranches(c) {
    if (!state.activeTxt || !state.activeVersion) { c.innerHTML = ''; return; }
    c.innerHTML = '<span class="date-branch-btn">…</span>';
    var token = state.activeProject + '\u0000' + state.activeTxt;
    state._logBranchToken = token;
    call('list_log_files', state.activeVersion.path, state.activeTxt).then(function (files) {
      if (state._logBranchToken !== token) return;
      files = files || [];
      state.logFiles = files;
      if (!files.length) { state.activeLogDate = null; state.activeLogPath = null; c.innerHTML = '<span class="date-branch-btn">无日志</span>'; updateModeToggle(); return; }
      // 定位当前选中分支：从配置切入时按配置文件版本定位当日对应日志；否则按残留定位
      var fromConfig = state._fromConfig; state._fromConfig = false;
      var active = fromConfig ? logTargetForVersion(files) : null;
      if (!active && state.activeLogPath) { var hit = files.find(function (f) { return f.path === state.activeLogPath; }); if (hit) active = hit; }
      if (!active && state.activeLogDate) { var hit2 = files.find(function (f) { return f.date === state.activeLogDate; }); if (hit2) active = hit2; }
      if (!active) active = files[0];
      var had = state.activeLogPath === active.path;
      state.activeLogDate = active.date;
      state.activeLogPath = active.path;
      var html = '';
      files.forEach(function (f) {
        var isActive = f.path === active.path;
        var txt = f.label || f.date;
        html += '<button class="date-branch-btn' + (isActive ? ' date-branch-btn--active' : '') + '" data-date="' + escapeHtml(f.date) + '" data-file="' + escapeHtml(f.path) + '" title="' + escapeHtml(f.path) + '">' + escapeHtml(txt) + '</button>';
      });
      c.innerHTML = html;
      updateModeToggle();
      if (!had && state.mode === 'log' && state.activeTxt) buildCenterBottom();
    }).catch(function () { c.innerHTML = '<span class="date-branch-btn">无日志</span>'; updateModeToggle(); });
  }
  function buildCenterBottom() {
    if (!state.activeTxt || !state.activeVersion) {
      $('centerBottom').innerHTML = '<div class="center-empty">' + icon('file-text', 24, 'center-empty__icon') + '<span style="font-size:var(--body-sm-font-size)">请选择一个日期分支查看内容</span></div>';
      return;
    }
    if (state.mode === 'log') { buildLogConfigBar(); buildLogList(); }
    else { buildConfigEditor(); }
  }
  function buildConfigEditor() {
    var container = $('centerBottom');
    var data = state.configData;
    if (!data) { container.innerHTML = '<div class="center-empty">' + icon('file-text', 24, 'center-empty__icon') + '<span style="font-size:var(--body-sm-font-size)">正在加载配置…</span></div>'; return; }
    var folders = data.folders || [];
    var excludes = data.excludes || [];
    var watermark = data.watermark || '';
    var html = '<div class="config-editor">';
    html += '<div class="config-editor__col config-editor__col--paths">';
    html += '<div class="config-path-subheader"><span class="config-path-subheader__sort">排序</span><span class="config-path-subheader__nopoll">取消轮询</span><span class="config-path-subheader__path">路径</span><span class="config-path-subheader__check">预检测结果</span><span class="config-path-subheader__open"></span><span class="config-path-subheader__remove"></span></div>';
    html += '<div class="config-editor__path-list" id="pathList">';
    folders.forEach(function (f, idx) {
      html += '<div class="config-path-row" data-index="' + idx + '" data-orig="' + escapeHtml(f.path) + '" data-orig-idx="' + idx + '">';
      html += '<span class="config-path-row__drag" draggable="true" title="按住拖动排序">' + icon('grip-vertical', 14) + '</span>';
      html += '<label class="config-path-row__checkbox" title="勾选 = 不轮询（添加 = 前缀）"><input type="checkbox" class="config-path-row__check" ' + (f.nonround ? 'checked' : '') + '><span class="config-path-row__check-mark"></span></label>';
      html += '<input type="text" class="config-path-row__input" value="' + escapeHtml(f.path) + '" title="' + escapeHtml(f.path) + '">';
      html += '<span class="config-path-row__precheck precheck--pending" data-index="' + idx + '">检测中…</span>';
      html += '<button class="config-path-row__open" title="打开路径">' + icon('folder-open', 14) + '</button>';
      html += '<button class="config-path-row__remove" title="移除路径">' + icon('x', 14) + '</button></div>';
    });
    html += '</div>';
    html += '<button class="config-path-add" id="btnAddPath" title="添加路径">' + icon('plus', 14) + '添加路径</button></div>';
    html += '<div class="config-resizer"></div>';
    html += '<div class="config-editor__bottom">';
    html += '<div class="config-editor__col config-editor__col--exclude">';
    html += '<div class="config-editor__col-header">排除字段 <span class="config-editor__col-count">' + excludes.length + '</span></div>';
    html += '<div class="config-editor__exclude-list" id="excludeList">';
    excludes.forEach(function (ex) {
      html += '<div class="config-exclude-row" data-orig="' + escapeHtml(ex) + '"><span class="config-exclude-row__path" title="' + escapeHtml(ex) + '">' + escapeHtml(ex) + '</span><button class="config-exclude-row__remove" title="移除排除字段">' + icon('x', 12) + '</button></div>';
    });
    html += '</div>';
    html += '<input type="text" class="config-exclude-input" id="inputExclude" placeholder="输入排除字符串，回车添加" spellcheck="false"></div>';
    html += '<div class="config-editor__col config-editor__col--watermark">';
    html += '<div class="config-editor__col-header">水印 PNG</div>';
    html += '<div class="config-editor__watermark-content">';
    if (watermark) html += '<div class="config-watermark__path">' + escapeHtml(watermark) + '</div>';
    else html += '<div class="config-watermark__empty">未设置水印</div>';
    html += '<button class="config-watermark__change" id="btnChangeWatermark">更换水印</button></div></div>';
    html += '</div></div>';
    container.innerHTML = html;
    buildConfigBar(); bindEditorEvents(); bindResizers(container); bindModifiedWatchers(container); runPrecheck();
    // 仅真正加载配置时（_configOrig 为 null）建立修改基线；局部重建（如水印变更）不重置，保证各部分修改相互独立
    if (state._configOrig === null || state._configOrig === undefined) {
      state._configOrig = {
        folders: folders.map(function (f) { return String(f.path); }),
        excludes: excludes.map(function (e) { return String(e); }),
        watermark: watermark,
        name: data.name || ''
      };
      state._configOrigSnapshot = configSnapshot();
    }
    refreshConfigModified();
  }
  function buildConfigBar() {
    var bar = $('configBar');
    if (!bar) return;
    var data = state.configData;
    var name = data ? data.name : '';
    var html = '<div class="config-bar__left">';
    html += '<label class="config-bottombar__label">成片数量</label>';
    html += '<span class="config-bottombar__field"><input type="number" class="config-bottombar__input" id="inputFilmCount" value="" min="1" max="99" placeholder="必填"><span class="config-bottombar__error" id="filmCountError" style="display:none">请输入成片数量</span></span>';
    html += '<label class="config-bottombar__label">分组数</label>';
    html += '<input type="number" class="config-bottombar__input" id="inputGroupCount" value="" min="1" max="99" placeholder="不分组"></div>';
    html += '<div class="config-bar__right">';
    html += '<span class="config-bottombar__warn" id="configWarnMark" style="display:none">有不合格路径</span>';
    html += '<span class="config-bottombar__modified" id="configModifiedHint" style="display:none">配置发生改变</span>';
    html += '<label class="config-bottombar__label">配置名</label>';
    html += '<input type="text" class="config-bottombar__input config-bottombar__input--name" id="inputConfigName" value="' + escapeHtml(name) + '">';
    html += '<button class="config-btn config-btn--save" id="btnSaveConfig">' + icon('save', 14) + '覆盖当前配置</button>';
    html += '<button class="config-btn config-btn--save-today" id="btnSaveToday">' + icon('calendar-plus', 14) + '保存为当日配置</button>';
    html += '<button class="config-btn config-btn--run" id="btnRunScript">' + icon('play', 14) + '启动脚本</button></div>';
    bar.innerHTML = html;
    $('btnSaveConfig').addEventListener('click', saveConfig);
    $('btnSaveToday').addEventListener('click', saveConfigToday);
    $('btnRunScript').addEventListener('click', runScript);
    $('inputFilmCount').addEventListener('input', function () { var errEl = $('filmCountError'); if (errEl) errEl.style.display = 'none'; });
    bindModifiedWatchers(bar);
    applyPrecheckValidity();
    refreshConfigModified();
    applyEnvDisabled();
  }
  // ── 配置修改检测：未修改时两个保存按钮禁用；修改时编辑区红框 + 配置名左侧红字提示 ──
  function configSnapshot() {
    try {
      var ed = getEditorState();
      var nm = $('inputConfigName') ? $('inputConfigName').value.trim() : (state.activeTxt || '');
      return JSON.stringify({ f: ed.folders, e: ed.excludes, w: ed.watermark || '', n: nm });
    } catch (e) { return ''; }
  }
  function refreshConfigModified() {
    var modified = false;
    if (state.configData) {
      var t0 = state._configOrigSnapshot, t1 = configSnapshot();
      modified = t0 !== null && t0 !== undefined && t1 !== t0;
    }
    state.configModified = modified;
    var b1 = $('btnSaveConfig'), b2 = $('btnSaveToday');
    if (b1) { b1.disabled = state.precheckInvalid || !modified || _envBad(); setBtnHint(b1, _envBad() ? '运行环境缺失' : (state.precheckInvalid ? '存在不合格路径' : (modified ? null : '配置未发生改变'))); }
    if (b2) { b2.disabled = state.precheckInvalid || _envBad(); setBtnHint(b2, _envBad() ? '运行环境缺失' : (state.precheckInvalid ? '存在不合格路径' : null)); }
    var hint = $('configModifiedHint');
    if (hint) hint.style.display = modified ? '' : 'none';
    // ── 元素级红框提示 ──
    var orig = state._configOrig || {};
    // 路径行：文字变化 → 输入框边框红；仅被拖动的行且不在原位 → 该行整行红
    document.querySelectorAll('.config-path-row').forEach(function (row, i) {
      var inp = row.querySelector('.config-path-row__input');
      var origText = row.getAttribute('data-orig') || '';
      if (inp) inp.classList.toggle('is-modified-input', String(inp.value || '').trim() !== origText.trim());
      var origIdx = parseInt(row.getAttribute('data-orig-idx') || '-1', 10);
      var movedFlag = row.dataset.moved === '1';
      var moved = movedFlag && origIdx >= 0 && origIdx !== i;
      if (movedFlag && origIdx === i) row.removeAttribute('data-moved');
      row.classList.toggle('is-modified-row', moved);
      // 路径不存在 + 排序改变并存：显式组合类让橙框/橙条与排序红条同屏（避免类同步问题）
      var isInv = row.classList.contains('config-path-row--invalid');
      row.classList.toggle('config-path-row--invalid-moved', isInv && !!moved);
    });
    // 排除行：软删除行 → 删除线灰字（不参与红底）；新增/修改行 → 低透红底+左条
    document.querySelectorAll('.config-exclude-row').forEach(function (row) {
      if (row.dataset.deleted === '1') { row.classList.remove('is-modified-row'); return; }
      var origText = row.getAttribute('data-orig') || '';
      var txt = row.querySelector('.config-exclude-row__path');
      var changed = txt ? String(txt.textContent || '').trim() !== origText.trim() : false;
      row.classList.toggle('is-modified-row', changed);
    });
    // 相对初始集合存在缺失（软删除或硬删除初始字段）→ 排除框体红；纯新增/删除刚加的字段 → 不红
    var curSet = new Set();
    document.querySelectorAll('.config-exclude-row').forEach(function (r) {
      if (r.dataset.deleted === '1') return;
      var tt = r.querySelector('.config-exclude-row__path');
      if (tt) curSet.add(String(tt.textContent || '').trim());
    });
    var lost = (orig.excludes || []).some(function (e) { return !curSet.has(String(e).trim()); });
    var exCol = document.querySelector('.config-editor__col--exclude');
    if (exCol) exCol.classList.toggle('is-modified', lost);
    // 水印：整个水印框架边框红
    var wf = document.querySelector('.config-editor__col--watermark');
    if (wf) {
      var wCur = state.configData ? (state.configData.watermark || '') : '';
      wf.classList.toggle('is-modified', wCur !== (orig.watermark || ''));
    }
  }
  function bindModifiedWatchers(container) {
    ['input', 'change', 'click'].forEach(function (ev) {
      if (container && !container.dataset.mwBound) {
        container.dataset.mwBound = '1';
        container.addEventListener(ev, refreshConfigModified, true);
      }
    });
  }
  function applyPrecheckValidity() {
    var invalid = state.precheckInvalid;
    var run = $('btnRunScript');
    if (run) {
      run.disabled = invalid || _envBad();
      setBtnHint(run, _envBad() ? '运行环境缺失' : (invalid ? '存在不合格路径，无法启动脚本' : null));
    }
    var warn = $('configWarnMark');
    if (warn) warn.style.display = invalid ? '' : 'none';
    refreshConfigModified();
  }
  // ── 日志模式：底部批量复刻成片配置栏 ──
  function toggleLogSelect(entry, force) {
    var lp = entry.getAttribute('data-log-path');
    var key = normalizePath(lp);
    var val = { path: lp, video: entry.getAttribute('data-video') || '' };
    if (force === true) state.selectedLogPaths[key] = val;
    else if (force === false) delete state.selectedLogPaths[key];
    else { if (state.selectedLogPaths[key]) delete state.selectedLogPaths[key]; else state.selectedLogPaths[key] = val; }
    var cb = entry.querySelector('.log-entry__check');
    if (cb) cb.checked = !!state.selectedLogPaths[key];
    entry.classList.toggle('log-entry--selected', !!state.selectedLogPaths[key]);
    refreshLogConfigBar();
  }
  function selectedLogCount() {
    var n = 0; for (var k in (state.selectedLogPaths || {})) { if (state.selectedLogPaths[k]) n++; }
    return n;
  }
  function buildLogConfigBar() {
    var bar = $('configBar');
    if (!bar) return;
    var sel = !!state.selectMode;
    // 左侧：全选(复选框) + 已选计数 + 选择按钮(在已选文字右侧)；复刻模式按钮放最右侧(软件最右下角)
    var html = '<div class="config-bar__left config-bar__left--log">';
    html += '<label class="log-configbar__selall"><input type="checkbox" id="chkLogAll">全选</label>';
    html += '<span class="log-configbar__count" id="logSelCount">已选 0</span>';
    html += '<label class="log-configbar__switch" title="切换选择模式，选择成片进行批量复刻"><input type="checkbox" class="log-configbar__switch-input" id="btnLogSelect"' + (sel ? ' checked' : '') + '><span class="log-configbar__switch-track"><span class="log-configbar__switch-thumb"></span></span><span class="log-configbar__switch-text">选择</span></label>';
    html += '</div>';
    html += '<div class="config-bar__replica" id="logReplicaBtns">';
    html += '<button class="config-btn config-btn--replica-full" id="btnBatchReplica1" title="对所选成片执行完全复刻">' + icon('repeat', 14) + '完全复刻</button>';
    html += '<button class="config-btn config-btn--replica-dedup" id="btnBatchReplica2" title="对所选成片执行去重复刻">' + icon('copy', 14) + '去重复刻</button>';
    html += '</div>';
    bar.innerHTML = html;
    $('btnLogSelect').addEventListener('change', toggleLogSelectMode);
    var all = $('chkLogAll');
    if (all) all.addEventListener('change', function () { setLogAll(this.checked); });
    $('btnBatchReplica1').addEventListener('click', function () { batchReplica('1'); });
    $('btnBatchReplica2').addEventListener('click', function () { batchReplica('2'); });
    refreshLogConfigBar();
    applyEnvDisabled();
  }
  // 仅刷新批量栏的状态（计数/按钮可用性/全选框）而不重建
  function refreshLogConfigBar() {
    var n = selectedLogCount();
    var cnt = $('logSelCount');
    if (cnt) cnt.textContent = '已选 ' + n;
    var btn1 = $('btnBatchReplica1'), btn2 = $('btnBatchReplica2');
    var canRun = !!state.selectMode && n > 0;
    if (btn1) { btn1.disabled = !canRun || _envBad(); setBtnHint(btn1, _envBad() ? '运行环境缺失' : (canRun ? null : '请先勾选要复刻的成片')); }
    if (btn2) { btn2.disabled = !canRun || _envBad(); setBtnHint(btn2, _envBad() ? '运行环境缺失' : (canRun ? null : '请先勾选要复刻的成片')); }
    var all = $('chkLogAll');
    if (all) all.checked = !!state.selectMode && n > 0;
  }
  function toggleLogSelectMode() {
    state.selectMode = !state.selectMode;
    if (!state.selectMode) state.selectedLogPaths = {};
    buildLogConfigBar();
    buildLogList();
  }
  function setLogAll(checked) {
    // 任何情况下都可勾选：勾选全选自动进入选择模式并全选，取消则退出选择模式并清空
    if (checked && !state.selectMode) state.selectMode = true;
    else if (!checked) { state.selectMode = false; state.selectedLogPaths = {}; }
    if (state.selectMode) {
      state.selectedLogPaths = {};
      var container = $('centerBottom');
      if (container) container.querySelectorAll('.log-entry').forEach(function (en) {
        var og = en.getAttribute('data-log-path');
        if (og) state.selectedLogPaths[normalizePath(og)] = { path: og, video: en.getAttribute('data-video') || '' };
      });
    }
    buildLogList();
    var selBtn = $('btnLogSelect');
    if (selBtn) selBtn.checked = !!state.selectMode;
    refreshLogConfigBar();
  }
  function batchReplica(mode) {
    if (_envBad()) { setStatus('运行环境缺失'); return; }
    if (!state.selectMode) return;
    var items = [];
    for (var k in (state.selectedLogPaths || {})) { var v = state.selectedLogPaths[k]; if (v) items.push({ path: (v.path || v), video: v.video || '' }); }
    if (!items.length) { setStatus('请先勾选要复刻的成片'); return; }
    var cnt = items.length, done = 0;
    setStatus('已对 ' + cnt + ' 个成片启动批量' + (mode === '1' ? '完全' : '去重') + '复刻…');
    items.forEach(function (it) {
      // 按选中成片精确复刻（传入成片名，脚本仅处理该成片）
      call('run_replica', it.path, mode, it.video).then(function (r) {
        done++;
        if (!(r && r.ok)) setStatus('启动失败：' + ((r && r.error) || '未知错误'));
        else if (done === cnt) { setStatus('已全部启动 ' + cnt + ' 个批量复刻脚本'); }
      }).catch(function () { done++; });
    });
    // 批量启动完成后退出选择模式
    state.selectMode = false; state.selectedLogPaths = {};
    buildLogList();
  }
  function bindResizers(scope) {
    scope.querySelectorAll('.config-resizer').forEach(function (rz) {
      rz.addEventListener('mousedown', function (e) {
        e.preventDefault();
        var parent = rz.parentNode, above = rz.previousElementSibling, below = rz.nextElementSibling;
        if (!above || !below) return;
        var horizontal = getComputedStyle(parent).flexDirection === 'row';
        var sizeAbove = horizontal ? above.clientWidth : above.clientHeight;
        var sizeBelow = horizontal ? below.clientWidth : below.clientHeight;
        var startPos = horizontal ? e.clientX : e.clientY;
        var minSize = 48;
        rz.classList.add('config-resizer--active');
        function onMove(ev) {
          var pos = horizontal ? ev.clientX : ev.clientY;
          var delta = pos - startPos;
          above.style.flex = '0 0 ' + Math.max(minSize, sizeAbove + delta) + 'px';
          below.style.flex = '0 0 ' + Math.max(minSize, sizeBelow - delta) + 'px';
        }
        function onUp() { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); rz.classList.remove('config-resizer--active'); }
        document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
      });
    });
  }
  function getEditorState() {
    var folders = [];
    var list = $('pathList');
    if (list) list.querySelectorAll('.config-path-row').forEach(function (row) {
      var input = row.querySelector('.config-path-row__input');
      var chk = row.querySelector('.config-path-row__check');
      var p = input.value.trim();
      if (p) folders.push({ path: p, nonround: !!chk.checked });
    });
    var excludes = [];
    var exList = $('excludeList');
    if (exList) exList.querySelectorAll('.config-exclude-row').forEach(function (row) { if (row.dataset.deleted === '1') return; var t = row.querySelector('.config-exclude-row__path'); if (t) { var s = t.textContent.trim(); if (s) excludes.push(s); } });
    var watermark = state.configData ? (state.configData.watermark || '') : '';
    return { folders: folders, excludes: excludes, watermark: watermark };
  }
  // 预检测：输入防抖 + 宽限期弹窗，避免频繁触发闪烁，也避免长时间检测误以为卡死
  var precheckDebounceTimer = null;
  var precheckGraceTimer = null;
  var precheckOverlayCount = 0;
  var PRECHECK_DEBOUNCE_MS = 250; // 输入防抖窗口
  var PRECHECK_OVERLAY_MS = 350;  // 宽限期：超过才弹"正在预检测"遮罩
  function showPrecheckBusy() {
    precheckOverlayCount++;
    var o = $('busyOverlay');
    if (!o) return;
    $('busyText').textContent = '正在预检测，请稍候…';
    o.style.display = 'flex';
  }
  function hidePrecheckBusy() {
    precheckOverlayCount = Math.max(0, precheckOverlayCount - 1);
    if (precheckOverlayCount === 0) hideBusy();
  }
  function runPrecheck() {
    if (precheckDebounceTimer) clearTimeout(precheckDebounceTimer);
    precheckDebounceTimer = setTimeout(runPrecheckNow, PRECHECK_DEBOUNCE_MS);
  }
  function runPrecheckNow() {
    var list = $('pathList');
    if (!list) return;
    var rows = list.querySelectorAll('.config-path-row');
    var paths = [];
    rows.forEach(function (row) {
      var p = row.querySelector('.config-path-row__input').value.trim();
      var chk = row.querySelector('.config-path-row__check');
      paths.push({ path: p, nonround: !!chk.checked });
    });
    var excludes = [];
    var exList = $('excludeList');
    if (exList) exList.querySelectorAll('.config-exclude-row').forEach(function (row) { if (row.dataset.deleted === '1') return; var t = row.querySelector('.config-exclude-row__path'); if (t) { var s = t.textContent.trim(); if (s) excludes.push(s); } });
    if (paths.length === 0) return;
    call('precheck', paths, excludes).then(function (results) {
      results = results || [];
      rows.forEach(function (row, i) {
        var r = results[i] || { status: 'pending', text: '未检测' };
        row.classList.toggle('config-path-row--invalid', r.status === 'warn');
        var span = row.querySelector('.config-path-row__precheck');
        var cls = 'precheck--pending';
        if (r.status === 'ok') cls = 'precheck--ok';
        else if (r.status === 'warn') cls = 'precheck--warn';
        else if (r.status === 'group') cls = 'precheck--group';
        span.className = 'config-path-row__precheck ' + cls;
        span.textContent = r.text || '';
      });
      var def = (results.length && results[0] && results[0].total) ? String(results[0].total) : '';
      var filmInput = $('inputFilmCount');
      if (filmInput) filmInput.value = def;
      state.precheckInvalid = results.some(function (r) { return r && r.status === 'warn'; });
      applyPrecheckValidity();
    }).catch(function () {
      rows.forEach(function (row) {
        var span = row.querySelector('.config-path-row__precheck');
        span.className = 'config-path-row__precheck precheck--warn';
        span.textContent = '检测失败';
      });
      state.precheckInvalid = true;
      applyPrecheckValidity();
    }).finally(function () {
      if (precheckGraceTimer) { clearTimeout(precheckGraceTimer); precheckGraceTimer = null; }
      if (precheckOverlayCount > 0) hidePrecheckBusy();
    });
  }
  function refreshPreviewIfModified() { if (state.rightPreview) buildRightPanel(); }
  function bindEditorEvents() {
    var pathList = $('pathList');
    var dragged = null;
    var container = $('centerBottom');
    function onContainerClick(e) {
      var t = e.target.closest('button, .config-path-row__open, .config-path-row__remove');
      if (!t) return;
      if (t.classList.contains('config-path-row__remove')) { t.closest('.config-path-row').remove(); updatePathCount(); runPrecheck(); refreshPreviewIfModified(); }
      else if (t.classList.contains('config-path-row__open')) { var input = t.closest('.config-path-row').querySelector('.config-path-row__input'); call('open_path', input.value.trim()); }
      else if (t.classList.contains('config-exclude-row__remove')) {
        var exRow = t.closest('.config-exclude-row');
        if (exRow.dataset.deleted === '1') {
          // 恢复被软删除的排除字段
          delete exRow.dataset.deleted;
          exRow.classList.remove('is-ex-deleted');
          t.innerHTML = icon('x', 12);
          t.title = '移除排除字段';
        } else {
          // 软删除：文字删除线灰显，x 变恢复按钮
          exRow.dataset.deleted = '1';
          exRow.classList.add('is-ex-deleted');
          t.innerHTML = icon('repeat', 12);
          t.title = '恢复该排除字段';
        }
        updateExcludeCount(); runPrecheck(); refreshPreviewIfModified(); refreshConfigModified();
      }
      else if (t.id === 'btnAddPath') { addPathField(); }
      else if (t.id === 'btnChangeWatermark') { changeWatermark(); }
    }
    container.removeEventListener('click', container._delegatedClick);
    container._delegatedClick = onContainerClick;
    container.addEventListener('click', container._delegatedClick);
    // 排除字段右键菜单：硬删除该字段
    container.removeEventListener('contextmenu', container._delegatedCtx);
    container._delegatedCtx = function (e) {
      var exRow = e.target.closest('.config-exclude-row');
      if (!exRow) return;
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [{
        label: '移除',
        action: function () {
          exRow.remove();
          updateExcludeCount(); runPrecheck(); refreshPreviewIfModified(); refreshConfigModified();
        }
      }]);
    };
    container.addEventListener('contextmenu', container._delegatedCtx);
    var exInput = $('inputExclude');
    if (exInput) { var exKey = function (e) { if (e.key === 'Enter') { e.preventDefault(); addExcludeField(); } }; exInput.addEventListener('keydown', exKey); }
    pathList.addEventListener('dragstart', function (e) {
      var h = e.target.closest('.config-path-row__drag');
      if (!h) return;
      var row = h.closest('.config-path-row');
      if (!row) return;
      dragged = row; row.classList.add('config-path-row--dragging'); e.dataTransfer.effectAllowed = 'move';
    });
    pathList.addEventListener('dragend', function () { if (dragged) dragged.classList.remove('config-path-row--dragging'); dragged = null; pathList.querySelectorAll('.config-path-row').forEach(function (r) { r.classList.remove('config-path-row--over'); }); });
    pathList.addEventListener('dragover', function (e) {
      var row = e.target.closest('.config-path-row');
      if (!row || row === dragged) return;
      e.preventDefault();
      pathList.querySelectorAll('.config-path-row').forEach(function (r) { r.classList.remove('config-path-row--over'); });
      row.classList.add('config-path-row--over');
    });
    pathList.addEventListener('drop', function (e) {
      var row = e.target.closest('.config-path-row');
      if (!row || !dragged || row === dragged) return;
      e.preventDefault();
      var children = Array.from(pathList.children);
      var from = children.indexOf(dragged), to = children.indexOf(row);
      if (from < to) pathList.insertBefore(dragged, row.nextSibling); else pathList.insertBefore(dragged, row);
      reindexPathRows(); runPrecheck(); refreshPreviewIfModified(); dragged.dataset.moved = '1'; refreshConfigModified();
    });
    function onContainerChange(e) {
      if (e.target.classList && (e.target.classList.contains('config-path-row__input') || e.target.classList.contains('config-path-row__check'))) { runPrecheck(); refreshPreviewIfModified(); }
    }
    container.removeEventListener('change', container._delegatedChange);
    container._delegatedChange = onContainerChange;
    container.addEventListener('change', container._delegatedChange);
  }
  function reindexPathRows() { $('pathList').querySelectorAll('.config-path-row').forEach(function (r, i) { r.dataset.index = i; }); }
  function updatePathCount() { var n = $('pathList').querySelectorAll('.config-path-row').length; var col = document.querySelector('.config-editor__col--paths .config-editor__col-count'); if (col) col.textContent = n; }
  function updateExcludeCount() { var n = $('excludeList').querySelectorAll('.config-exclude-row').length; var col = document.querySelector('.config-editor__col--exclude .config-editor__col-count'); if (col) col.textContent = n; }
  function addExcludeRow(ex) {
    var list = $('excludeList');
    var existing = [];
    list.querySelectorAll('.config-exclude-row__path').forEach(function (sp) { existing.push(sp.textContent.trim()); });
    if (existing.indexOf(ex) >= 0) return false;
    var row = document.createElement('div');
    row.className = 'config-exclude-row';
    row.innerHTML = '<span class="config-exclude-row__path" title="' + escapeHtml(ex) + '">' + escapeHtml(ex) + '</span><button class="config-exclude-row__remove" title="移除排除字段">' + icon('x', 12) + '</button>';
    list.appendChild(row);
    return true;
  }
  function addExcludeField() {
    var input = $('inputExclude');
    if (!input) return;
    var v = input.value.trim();
    if (!v) { input.focus(); return; }
    if (addExcludeRow(v)) { input.value = ''; updateExcludeCount(); runPrecheck(); refreshPreviewIfModified(); }
  }
  function addPathRow(path) {
    var p = String(path == null ? '' : path).trim();
    if (!p) return;
    var idx = $('pathList').querySelectorAll('.config-path-row').length;
    var row = document.createElement('div');
    row.className = 'config-path-row'; row.dataset.index = idx;
    row.innerHTML = '<span class="config-path-row__drag" draggable="true" title="按住拖动排序">' + icon('grip-vertical', 14) + '</span><label class="config-path-row__checkbox" title="勾选 = 不轮询（添加 = 前缀）"><input type="checkbox" class="config-path-row__check"><span class="config-path-row__check-mark"></span></label><input type="text" class="config-path-row__input" value="' + escapeHtml(p) + '" title="' + escapeHtml(p) + '"><span class="config-path-row__precheck precheck--pending">检测中…</span><button class="config-path-row__open" title="打开路径">' + icon('folder-open', 14) + '</button><button class="config-path-row__remove" title="移除路径">' + icon('x', 14) + '</button>';
    $('pathList').appendChild(row);
    updatePathCount(); runPrecheck(); refreshPreviewIfModified();
  }
  function addPathField() {
    call('pick_paths').then(function (paths) {
      (paths || []).forEach(function (p) { addPathRow(p); });
    }).catch(function (e) { setStatus('添加路径失败：' + e.message); });
  }
  function changeWatermark() {
      call('pick_watermark').then(function (p) {
        if (!p) return;
        state.configData.watermark = p;
        // 局部更新水印区内容（按钮无需重绑：容器级 click 委托按 id 命中 changeWatermark，重复直接绑定会弹两次）
        var wc = document.querySelector('.config-editor__col--watermark .config-editor__watermark-content');
        if (wc) {
          wc.innerHTML = (p
            ? '<div class="config-watermark__path">' + escapeHtml(p) + '</div><button class="config-watermark__change" id="btnChangeWatermark">更换水印</button>'
            : '<div class="config-watermark__empty">未设置水印</div><button class="config-watermark__change" id="btnChangeWatermark">更换水印</button>');
        }
        refreshPreviewIfModified();
        refreshConfigModified();
      });
    }
  function saveConfig() {
    if (!state.configData) return;
    var ed = getEditorState();
    var path = state.configData.path;
    showDialog({ title: '确认覆盖', message: '将覆盖原文件：\n' + path + '\n是否继续？', buttons: [ { label: '取消', value: false }, { label: '确认覆盖', value: true, danger: true, primary: true } ] }).then(function (ok) {
      if (!ok) { setStatus('已取消保存'); return; }
      call('save_config', path, ed.folders, ed.excludes, ed.watermark).then(function (r) {
        if (r && r.ok) { setStatus('已保存：' + path); refreshData(); document.querySelectorAll('.config-exclude-row[data-deleted="1"]').forEach(function (rr) { rr.remove(); }); state._configOrigSnapshot = configSnapshot(); refreshConfigModified(); } else setStatus('保存失败：' + ((r && r.error) || '未知错误'));
      }).catch(function (e) { setStatus('保存失败：' + e.message); });
    });
  }
  function saveConfigToday() {
    if (!state.activeProject || !state.activeTxt) return;
    var ed = getEditorState();
    var configName = $('inputConfigName').value.trim() || state.activeTxt;
    call('save_config_today', state.activeProject, state.activeTxt, configName, ed.folders, ed.excludes, ed.watermark).then(function (r) {
      if (r && r.ok) { setStatus('已保存为当日配置：' + r.path); jumpToVersionPath(r.path); } else setStatus('保存失败：' + ((r && r.error) || '未知错误'));
    }).catch(function (e) { setStatus('保存失败：' + e.message); });
  }
  function normalizePath(p) { return String(p || '').replace(/[\\/]+/g, '\\').toLowerCase(); }
  function jumpToVersionPath(targetPath) {
    var targetKey = normalizePath(targetPath);
    var name = String(targetPath).replace(/[\\/]+/g, '\\').split('\\').pop().replace(/\.txt$/i, '');
    if (!state.activeProject || !name) return;
    call('list_projects').then(function (projects) {
      state.projects = projects || []; state.activeTxt = name; buildSidebar();
      return call('list_versions', state.activeProject, name);
    }).then(function (versions) {
      state.versions = versions || [];
      var t = null;
      for (var i = 0; i < state.versions.length; i++) { if (normalizePath(state.versions[i].path) === targetKey) { t = state.versions[i]; break; } }
      state.activeVersion = t || (state.versions.length ? state.versions[0] : null);
      state.expandedProject = state.activeProject; buildDateBranches(); buildSidebar();
      if (state.activeVersion) loadConfig(state.activeVersion.path); else { state.configData = null; buildCenterBottom(); buildRightPanel(); }
    }).catch(function (e) { setStatus('刷新版本失败：' + e.message); });
  }
  function runScript() {
    if (_envBad()) { setStatus('运行环境缺失'); return; }
    if (!state.activeVersion) return;
    var count = $('inputFilmCount').value.trim();
    var group = $('inputGroupCount').value.trim();
    var errEl = $('filmCountError');
    if (!count || !/^\d+$/.test(count) || parseInt(count, 10) < 1) { if (errEl) errEl.style.display = ''; $('inputFilmCount').focus(); return; }
    if (errEl) errEl.style.display = 'none';
    if (!state.activeProject || !state.activeTxt) return;
    var ed = getEditorState();
    var configName = $('inputConfigName').value.trim() || state.activeTxt;
    call('save_config_today', state.activeProject, state.activeTxt, configName, ed.folders, ed.excludes, ed.watermark).then(function (saved) {
      if (!saved || !saved.ok) { setStatus('保存失败：' + ((saved && saved.error) || '未知错误')); return; }
      setStatus('已保存并启动脚本：' + saved.path);
      call('run_batch', saved.path, count, group).then(function (r) { if (!(r && r.ok)) setStatus('启动失败：' + ((r && r.error) || '未知错误')); });
      jumpToVersionPath(saved.path);
    }).catch(function (e) { setStatus('启动失败：' + e.message); });
  }
  // 展开成片时对其片段列表做一次存在性预检测，不存在的片段标记变红
  function precheckClips(entry) {
    if (entry.getAttribute('data-checked') === '1') return;
    entry.setAttribute('data-checked', '1');
    var paths = [];
    entry.querySelectorAll('.log-entry__clip').forEach(function (c) { var p = c.getAttribute('data-path'); if (p) paths.push(p); });
    if (!paths.length) return;
    call('check_exists', paths).then(function (map) {
      map = map || {};
      entry.querySelectorAll('.log-entry__clip').forEach(function (c) {
        var p = c.getAttribute('data-path');
        if (map[p] === false) {
          c.classList.add('log-entry__clip--missing');
          c.setAttribute('data-exists', '0');
          if (!c.querySelector('.log-entry__clip-missing-hint')) {
            var h = document.createElement('span');
            h.className = 'log-entry__clip-missing-hint';
            h.textContent = '文件不存在';
            c.appendChild(h);
          }
        }
        else c.setAttribute('data-exists', '1');
      });
    }).catch(function () {});
  }
  // 滚动日志成片列表时，右侧同步跳转到第一个可见成片所在行
  function bindLogListScroll(container) {
    var list = container.querySelector('.log-list');
    if (!list) return;
    list.onscroll = function () {
      if (!state.logContent) return;
      var st = list.scrollTop;
      var viewH = list.clientHeight;
      var entries = list.querySelectorAll('.log-entry');
      var found = null;
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (e.offsetTop + e.offsetHeight >= st && e.offsetTop <= st + viewH) { found = e; break; }
      }
      if (found) scrollLogRightTo(logRowFor(found.getAttribute('data-video'), found.getAttribute('data-log-path')) || 0);
    };
  }
  function buildLogList() {
    var container = $('centerBottom');
    container.innerHTML = '<div class="center-empty">' + icon('scroll-text', 24, 'center-empty__icon') + '<span style="font-size:var(--body-sm-font-size)">正在加载日志…</span></div>';
    // 按当前选中的日志分支（精确到日志文件）定位查询目录，切换分支后取对应日志成片
    var probeLog = null;
    if (state.activeLogPath) probeLog = state.activeLogPath;
    else if (state.activeLogDate) {
      var pf = (state.logFiles || []).find(function (f) { return f.date === state.activeLogDate; });
      if (pf) probeLog = pf.path;
    }
    call('list_logs', state.activeProject, state.activeTxt, probeLog || state.activeVersion.path).then(function (entries) {
      entries = entries || [];
      // 按所选日志分支过滤：精确到日志文件，仅显示属于该分支的成片条目
      if (state.activeLogDate) {
        var fileSet = {};
        if (state.activeLogPath) { fileSet[normalizePath(state.activeLogPath)] = 1; }
        else { (state.logFiles || []).forEach(function (f) { if (f.date === state.activeLogDate) fileSet[normalizePath(f.path)] = 1; }); }
        entries = entries.filter(function (en) { return fileSet[normalizePath(en.log_path)]; });
      }
      var q = state.logSearchQuery.trim().toLowerCase();
      if (q) entries = entries.filter(function (en) { return (en.video || '').toLowerCase().indexOf(q) >= 0; });
      if (entries.length === 0) {
        container.innerHTML = '<div class="center-empty">' + icon('scroll-text', 24, 'center-empty__icon') + '<span style="font-size:var(--body-sm-font-size)">' + (q ? '未找到匹配 "' + escapeHtml(state.logSearchQuery) + '" 的成片' : '暂无日志数据') + '</span></div>';
        return;
      }
      var sel = !!state.selectMode;
      var curSel = state.selectedLogPaths || {};
      var html = '<div class="log-list' + (sel ? ' log-list--selecting' : '') + '">';
      entries.forEach(function (entry) {
        var clips = entry.clips || [];
        var lp = entry.log_path || '';
        var checked = sel && curSel[normalizePath(lp)];
        html += '<div class="log-entry' + (checked ? ' log-entry--selected' : '') + '" data-log-path="' + escapeHtml(lp) + '" data-video="' + escapeHtml(entry.video || '') + '">';
        html += '<div class="log-entry__header">';
        if (sel) html += '<input type="checkbox" class="log-entry__check"' + (checked ? ' checked' : '') + ' title="选择该成片进行批量复刻">';
        html += '<span class="log-entry__arrow">' + icon('chevron-right', 14) + '</span>' + icon('video', 14);
        html += '<span class="log-entry__video-name" title="' + escapeHtml(entry.video) + '">' + escapeHtml(entry.video || '（未命名成片）') + '</span>';
        html += '<span class="log-entry__clip-count">' + clips.length + ' 片段</span>';
        html += '<button class="log-entry__replica" title="调用复刻脚本处理该日志">' + icon('repeat', 13) + '复刻</button>';
        html += '</div>';
        html += '<div class="log-entry__clips" style="display:none">';
        clips.forEach(function (clip) { html += '<div class="log-entry__clip" data-path="' + escapeHtml(clip) + '">' + icon('video', 12) + '<span class="log-entry__clip-path" title="' + escapeHtml(clip) + '">' + escapeHtml(clip) + '</span></div>'; });
        html += '</div></div>';
      });
      html += '</div>';
      container.innerHTML = html;
      bindLogListScroll(container);
      highlightFocus(container);
    }).catch(function (e) { container.innerHTML = '<div class="center-empty">' + icon('search-x', 24, 'center-empty__icon') + '<span style="font-size:var(--body-sm-font-size)">加载日志失败：' + escapeHtml(e.message) + '</span></div>'; });
    container.oncontextmenu = function (e) {
      var clip = e.target.closest('.log-entry__clip');
      if (clip) {
        e.preventDefault();
        var p = clip.getAttribute('data-path');
        if (!p) return;
        var missing = clip.getAttribute('data-exists') === '0';
        var items = [
          { label: '打开文件', disableIfMissing: true, title: missing ? '文件不存在' : '', action: function () { call('open_path', p); } },
          { label: '打开路径', disableIfMissing: true, title: missing ? '文件不存在' : '', action: function () { call('open_parent', p); } }
        ];
        if (missing) items.forEach(function (it) { if (it.disableIfMissing) it.disabled = true; });
        showMenu(e.clientX, e.clientY, items);
        return;
      }
      var entryItem = e.target.closest('.log-entry');
      if (entryItem) {
        // 成片级右键：打开成片 / 打开文件夹；成片文件不存在时置灰禁用并悬浮提示
        e.preventDefault();
        var videoNm = entryItem.getAttribute('data-video') || '';
        var lpItem = entryItem.getAttribute('data-log-path');
        if (!lpItem) { setStatus('无法定位该成片对应的日志文件'); return; }
        var fname = videoNm.trim();
        if (!fname) return;
        if (!/\.mp4$/i.test(fname)) fname += '.mp4';
        var dirItem = String(lpItem).replace(/[\\/]+/g, '\\').replace(/\\[^\\]*$/, '');
        var clipFile = dirItem + '\\' + fname;
        var smenu = function (missingFile) {
          var items2 = [
            { label: '打开成片', disableIfMissing: true, action: function () { call('open_path', clipFile); } },
            { label: '打开文件夹', disableIfMissing: true, action: function () { call('open_parent', clipFile); } }
          ];
          if (missingFile) items2.forEach(function (it) { if (it.disableIfMissing) it.disabled = true; it.title = '成片文件不存在'; });
          showMenu(e.clientX, e.clientY, items2);
        };
        call('check_exists', [clipFile]).then(function (map) {
          map = map || {};
          smenu(map[clipFile] === false);
        }).catch(function () { smenu(false); });
      }
    };
    container.onclick = function (e) {
      var rep = e.target.closest('.log-entry__replica');
      if (rep) {
        e.stopPropagation();
        if (_envBad()) { setStatus('运行环境缺失'); return; }
        var entry = rep.closest('.log-entry');
        var logPath = entry.getAttribute('data-log-path');
        if (!logPath) { setStatus('无法定位该成片对应的日志文件'); return; }
        var entryVideo = entry.getAttribute('data-video') || '';
        showDialog({ title: '复刻', message: '请选择复刻方式', buttons: [ { label: '完全复刻', value: '1', primary: true }, { label: '去重复刻', value: '2', primary: true }, { label: '取消', value: null } ] }).then(function (mode) {
          if (!mode) { setStatus('已取消复刻'); return; }
          // 仅复刻该单个成片（传入成片名，脚本精确处理该成片）
          call('run_replica', logPath, mode, entryVideo).then(function (r) { setStatus(r && r.ok ? '已启动该成片复刻脚本' : '启动失败：' + ((r && r.error) || '')); });
        });
        return;
      }
      // 选择模式下点击成片行用于勾选/取消，不做展开
      if (state.selectMode) {
        var sEl = e.target.closest('.log-entry');
        if (sEl) {
          e.stopPropagation();
          if (e.target && e.target.classList && e.target.classList.contains('log-entry__check')) return; // 复选事件单独处理
          toggleLogSelect(sEl);
        }
        return;
      }
      var header = e.target.closest('.log-entry__header');
      if (header) {
        var entry = header.closest('.log-entry');
        var clips = entry.querySelector('.log-entry__clips');
        var arrow = entry.querySelector('.log-entry__arrow');
        if (clips.style.display === 'none') { clips.style.display = 'block'; if (arrow) arrow.style.transform = 'rotate(90deg)'; precheckClips(entry); }
        else { clips.style.display = 'none'; if (arrow) arrow.style.transform = 'rotate(0deg)'; }
        jumpLogRightByVideo(entry.getAttribute('data-video'), entry.getAttribute('data-log-path'));
        return;
      }
    };
    container.addEventListener('change', function (e) {
      var cb = e.target.closest('.log-entry__check');
      if (!cb) return;
      var entry = cb.closest('.log-entry');
      if (entry) toggleLogSelect(entry, cb.checked);
    });
    applyEnvDisabled(); // 新渲染的成片行复刻按钮应用环境拦截
  }
  // 全局成片名搜索：渲染受限高度的下拉列表，点击跳转到目标日期分支并高亮成片
  function closeLogDropdown() {
    var d = $('logDropdown');
    if (d) {
      if (typeof d.__outside === 'function') document.removeEventListener('mousedown', d.__outside);
      if (typeof d.__esc === 'function') document.removeEventListener('keydown', d.__esc);
      d.remove();
    }
  }
  function renderLogDropdown(items, q) {
    closeLogDropdown();
    var input = $('logSearchInput');
    if (!input) return;
    var rect = input.getBoundingClientRect();
    var d = document.createElement('div');
    d.id = 'logDropdown'; d.className = 'search-dropdown';
    if (!items || items.length === 0) {
      d.innerHTML = '<div class="search-dropdown__empty">未找到包含「' + escapeHtml(q) + '」的成片日志</div>';
    } else {
      var html = '';
      items.slice(0, 200).forEach(function (r) {
        html += '<div class="search-dropdown__item" data-txt="' + escapeHtml(r.txtPath) + '" data-project="' + escapeHtml(r.project) + '" data-video="' + escapeHtml(r.video) + '">';
        html += '<div class="search-dropdown__title">' + escapeHtml(r.video) + '</div>';
        html += '<div class="search-dropdown__meta">' + escapeHtml(r.project) + ' / ' + escapeHtml(r.txtName) + ' / ' + escapeHtml(r.label) + '</div>';
        html += '</div>';
      });
      d.innerHTML = html;
    }
    document.body.appendChild(d);
    d.style.left = rect.left + 'px';
    d.style.top = (rect.bottom + 4) + 'px';
    d.style.width = Math.max(320, Math.min(rect.width + 120, 520)) + 'px';
    d.querySelectorAll('.search-dropdown__item').forEach(function (it) {
      it.addEventListener('click', function () {
        var txt = it.getAttribute('data-txt');
        var proj = it.getAttribute('data-project');
        var video = it.getAttribute('data-video');
        closeLogDropdown();
        focusSearchResult(txt, proj, video);
      });
    });
    setTimeout(function () {
      var outside = function (e) { if (!d.contains(e.target)) closeLogDropdown(); };
      var esc = function (e) { if (e.key === 'Escape') closeLogDropdown(); };
      d.__outside = outside; d.__esc = esc;
      document.addEventListener('mousedown', outside);
      document.addEventListener('keydown', esc);
    }, 0);
  }
  function onLogSearchInput() {
    var input = $('logSearchInput');
    var q = input ? input.value.trim() : '';
    if (state._searchTimer) { clearTimeout(state._searchTimer); state._searchTimer = null; }
    if (!q) { closeLogDropdown(); state.logSearchQuery = ''; if (state.mode === 'log') buildCenterBottom(); return; }
    state._searchTimer = setTimeout(function () {
      call('search_logs', q).then(function (items) {
        items = items || [];
        renderLogDropdown(items, q);
      }).catch(function () { closeLogDropdown(); });
    }, 300);
  }
  function focusSearchResult(txtPath, project, video) {
    state.focusVideo = video;
    state.activeProject = project;
    state.mode = 'log';
    $('modeLog').classList.add('mode-toggle--active');
    $('modeFilelist').classList.remove('mode-toggle--active');
    state.logSearchQuery = '';
    var input = $('logSearchInput');
    if (input) input.value = video;
    jumpToVersionPath(txtPath);
  }
  function highlightFocus(container) {
    var fv = state.focusVideo;
    if (fv == null || !container) return;
    state.focusVideo = null;
    var el = null;
    container.querySelectorAll('.log-entry').forEach(function (e) { if (e.dataset.video === fv) el = e; });
    if (!el) return;
    el.classList.add('log-entry--highlight');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(function () { el.classList.remove('log-entry--highlight'); }, 2500);
    jumpLogRightByVideo(el.dataset.video, el.getAttribute('data-log-path'));
  }
  function buildModifiedLines() {
    var ed = getEditorState();
    var out = [];
    ed.folders.forEach(function (f) { var p = (f && f.path) ? f.path.trim() : ''; if (!p) return; out.push(f.nonround ? '=' + p : p); });
    ed.excludes.forEach(function (e) { var s = (e || '').trim(); if (s) out.push('-' + s); });
    if (ed.watermark && ed.watermark.trim()) { out.push(''); out.push(ed.watermark.trim()); }
    return out;
  }
  function buildRightPanel() {
    var lineNumbers = $('rightLineNumbers');
    var code = $('rightCode');
    var subtitle = $('rightPanelSubtitle');
    var toggle = document.querySelector('.right-panel__toggle');
    if (toggle) toggle.style.display = state.mode === 'log' ? 'none' : '';
    if (!state.activeTxt || !state.activeVersion) { lineNumbers.innerHTML = ''; code.innerHTML = ''; subtitle.textContent = '请选择一个日期分支'; return; }
    if (state.mode === 'log') { buildLogRightPanel(); return; }
    if (!state.configData) { lineNumbers.innerHTML = ''; code.innerHTML = ''; subtitle.textContent = '请选择一个日期分支'; return; }
    var lines = state.rightPreview ? buildModifiedLines() : (state.configData.lines || []);
    subtitle.textContent = (state.rightPreview ? '实时' : '原始') + ':"' + relToProject(state.activeVersion.path) + '"';
    subtitle.title = subtitle.textContent;
    var numHtml = ''; var codeHtml = '';
    lines.forEach(function (line, idx) {
      numHtml += '<span class="right-panel__line-num">' + (idx + 1) + '</span>';
      var cls = 'right-panel__code-line';
      var t = line == null ? '' : line;
      if (t === '') cls += ' code-line--empty';
      else if (/^=+$/.test(t.trim())) cls += ' code-line--separator';
      else if (t.charAt(0) === '=') cls += ' code-line--no-round';
      else if (t.charAt(0) === '-') cls += ' code-line--exclude';
      else if (t.trim().toLowerCase().endsWith('.png')) cls += ' code-line--watermark';
      else cls += ' code-line--path';
      codeHtml += '<span class="' + cls + '">' + escapeHtml(t === '' ? ' ' : t) + '</span>';
    });
    lineNumbers.innerHTML = numHtml; code.innerHTML = codeHtml;
  }
  // 日志模式：右侧显示当前配置目录下所有日志 txt 的内容，并支持定位到成片所在行
  function buildLogRightPanel() {
    var subtitle = $('rightPanelSubtitle');
    if (state.logContent) { renderLogRightPanel(); return; }
    subtitle.textContent = '正在加载日志…';
    call('get_log_content', state.activeVersion.path, state.activeTxt).then(function (d) {
      state.logContent = d; renderLogRightPanel();
    }).catch(function () {
      cleanLogRight(); subtitle.textContent = '加载日志失败 — ' + state.activeTxt + ' / ' + state.activeVersion.label;
    });
  }
  function cleanLogRight() {
    var nums = $('rightLineNumbers'); var code = $('rightCode');
    if (nums) nums.innerHTML = ''; if (code) code.innerHTML = '';
  }
  function renderLogRightPanel() {
    var nums = $('rightLineNumbers'); var code = $('rightCode'); var subtitle = $('rightPanelSubtitle');
    var d = state.logContent; var files = (d && d.files) || [];
    var logPath = state.activeLogPath || (files[0] && files[0].path) || state.activeVersion.path;
    subtitle.textContent = '日志:"' + relToProject(logPath) + '"';
    subtitle.title = subtitle.textContent;
    if (files.length === 0) { nums.innerHTML = ''; code.innerHTML = '<div style="padding:8px 12px;color:var(--text-tertiary)">暂无日志文件</div>'; return; }
    var numHtml = ''; var codeHtml = ''; var row = 0;
    files.forEach(function (f) {
      f.lines.forEach(function (line, li) {
        row++;
        numHtml += '<span class="right-panel__line-num" data-row="' + row + '">' + row + '</span>';
        var t = line == null ? '' : line;
        var cls = 'right-panel__code-line';
        var isVideoHeader = li > 0 && f.lines[li - 1] != null && String(f.lines[li - 1]).trim() === '使用片段列表：';
        if (isVideoHeader) cls += ' code-line--log-video';
        else if (t.trim() === '') cls += ' code-line--empty';
        else cls += ' code-line--path';
        codeHtml += '<span class="' + cls + '" data-row="' + row + '">' + escapeHtml(t === '' ? ' ' : t) + '</span>';
      });
    });
    nums.innerHTML = numHtml; code.innerHTML = codeHtml;
    if (state._pendingLogJump) { var p = state._pendingLogJump; state._pendingLogJump = null; jumpLogRightByVideo(p.video, p.logPath); }
  }
  function logRowFor(video, logPath) {
    if (!state.logContent) return null;
    var entries = state.logContent.entries || [];
    for (var i = 0; i < entries.length; i++) { var en = entries[i]; if (en.video === video && logPath && (en.logPath === logPath || normalizePath(en.logPath) === normalizePath(logPath))) return en.lineStart; }
    for (var j = 0; j < entries.length; j++) { if (entries[j].video === video) return entries[j].lineStart; }
    return null;
  }
  function jumpLogRightByVideo(video, logPath) {
    if (state.mode !== 'log' || !state.activeTxt || !state.activeVersion) return;
    if (!state.logContent) { state._pendingLogJump = { video: video, logPath: logPath }; return; }
    var line = logRowFor(video, logPath);
    if (line) highlightLogBlock(line, video, logPath);
  }
  // 高亮整个成片块：成片名行（lineStart-1）到下一个成片名行之前的所有行
  function highlightLogBlock(line, video, logPath) {
    var entries = (state.logContent && state.logContent.entries) || [];
    var idx = -1;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].video === video && (entries[i].logPath === logPath || normalizePath(entries[i].logPath) === normalizePath(logPath))) { idx = i; break; }
    }
    if (idx < 0) { for (var j = 0; j < entries.length; j++) { if (entries[j].video === video) { idx = j; break; } } }
    var startRow = Number(line) - 1; // 成片名行
    var endRow = null;
    if (idx >= 0 && entries[idx + 1]) endRow = Number(entries[idx + 1].lineStart) - 2; // 下一个成片名行之前
    scrollLogRightTo(startRow, endRow);
  }
  function scrollLogRightTo(line, endLine) {
    var content = $('rightPanelContent');
    if (!content) return;
    var n = Number(line);
    if (!n || n < 1) return;
    var end = Number(endLine);
    if (!end || end < n) end = n;
    content.querySelectorAll('.right-panel__line-num.log-target, .right-panel__code-line.log-target').forEach(function (el) { el.classList.remove('log-target'); });
    for (var r = n; r <= end; r++) {
      var num = content.querySelector('.right-panel__line-num[data-row="' + r + '"]');
      var cod = content.querySelector('.right-panel__code-line[data-row="' + r + '"]');
      if (num) num.classList.add('log-target');
      if (cod) cod.classList.add('log-target');
    }
    var lineHeight = 18;
    var targetTop = 8 + (n - 1) * lineHeight;
    content.scrollTop = Math.max(0, targetTop - Math.floor(content.clientHeight * 0.2));
  }
  function setStatus(msg) { var el = $('statusLeft'); if (!el) return; el.classList.remove('status-bar__success'); el.textContent = msg; }
  function setStatusDone(msg) { var el = $('statusLeft'); if (!el) return; el.classList.add('status-bar__success'); el.textContent = msg; }

  // 载入遮罩：工作路径扫描时提示用户
  function showBusy(text) { var o = $('busyOverlay'); if (!o) return; var p = $('busyProgress'); if (p) p.style.display = 'none'; $('busyText').textContent = text || '正在检测…'; o.style.display = 'flex'; }
  function hideBusy() { var o = $('busyOverlay'); if (o) o.style.display = 'none'; }
  // 设置窗口开/关时的主窗口模糊遮罩
  function showSettingsDim() { var o = $('settingsDim'); if (o) { hideBusy(); o.style.display = 'block'; } }
  function hideSettingsDim() { var o = $('settingsDim'); if (o) o.style.display = 'none'; }
  // 带进度条的等待窗口：重置预检测全量检测期间使用
  function showBusyProgress(text) {
    var o = $('busyOverlay'); if (!o) return;
    $('busyText').textContent = text || '正在检测…';
    var fill = $('busyProgressFill'), pt = $('busyProgressText'), p = $('busyProgress');
    if (p) p.style.display = 'flex';
    if (fill) fill.style.width = '0%';
    if (pt) pt.textContent = '正在收集视频…';
    o.style.display = 'flex';
  }
  function onResetProgress(s) {
    if (!s) return;
    var total = s.total || 0, done = s.done || 0;
    var pct = total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0;
    var fill = $('busyProgressFill'), pt = $('busyProgressText');
    if (fill) fill.style.width = pct + '%';
    if (pt) pt.textContent = s.finished
      ? '已完成 ' + done + ' / ' + total
      : (total > 0 ? '正在检测 ' + done + ' / ' + total + '（' + pct + '%）' : '正在收集视频…');
  }
  function resetPrecheckAll() {
    var dismiss = null;
    var api = getApi();
    if (api && typeof api.on_reset_progress === 'function') {
      try { dismiss = api.on_reset_progress(onResetProgress); } catch (e) { dismiss = null; }
    }
    var cleanup = function () { if (dismiss) { try { dismiss(); } catch (e) {} dismiss = null; } };
    call('reset_precheck').then(function (r) {
      hideBusy();
      cleanup();
      setStatus('预检测已重置：共检测 ' + (r && r.total || 0) + ' 个视频，合规 ' + (r && r.valid || 0) + ' 个');
      if (state.activeTxt && state.activeVersion) runPrecheck();
    }).catch(function (e) {
      hideBusy();
      cleanup();
      setStatus('重置预检测失败：' + e.message);
    });
  }
  function resetPrecheckFlow() {
    showDialog({
      title: '重置预检测',
      message: '将重置预检测物理缓存，并对所有配置指向的路径重新预检测（重复文件自动跳过）。视频数量较多时可能耗时较长，是否继续？',
      buttons: [ { label: '取消', value: null, primary: true }, { label: '确认重置', value: 1, danger: true } ]
    }).then(function (v) {
      if (!v) { setStatus('已取消重置预检测'); return; }
      showBusyProgress('正在重置预检测缓存并全量检测，请耐心等待…');
      resetPrecheckAll();
    });
  }
  // 刷新配置列表：先扫描历史遗留的重复外部 * 配置（与成片正本内容一致的副本），
  // 确认后物理删除再刷新列表；无重复则直接刷新
  function refreshConfigsFlow() {
    showBusy('正在扫描重复配置…');
    call('clean_duplicate_star', false).then(function (r) {
      hideBusy();
      var pending = (r && r.pending) ? r.pending : [];
      if (!pending.length) {
        setStatus('重新检测中…');
        refreshData(true, '正在重新扫描工作路径…', function () { setStatusDone('重新检测完成'); }, true);
        return;
      }
      showDialog({
        title: '发现重复配置',
        message: '发现 ' + pending.length + ' 个与成片文件夹正本内容完全一致的外部 * 配置（历史遗留副本）。删除它们不影响正本与其他日期分支，是否删除？',
        buttons: [ { label: '取消', value: null, primary: true }, { label: '删除并刷新', value: 1, danger: true } ]
      }).then(function (v) {
        if (!v) { setStatus('已取消清理，仅刷新列表'); refreshData(true, '正在重新扫描工作路径…', function () { setStatusDone('重新检测完成'); }, true); return; }
        showBusy('正在清理重复配置…');
        call('clean_duplicate_star', true).then(function (r2) {
          hideBusy();
          setStatus('已删除 ' + ((r2 && r2.deleted) ? r2.deleted.length : 0) + ' 个重复配置');
          refreshData(true, '正在重新扫描工作路径…', function () { setStatusDone('重新检测完成'); }, true);
        }).catch(function (e) { hideBusy(); setStatus('清理失败：' + e.message); refreshData(true); });
      });
    }).catch(function (e) { hideBusy(); setStatus('扫描失败：' + e.message); refreshData(true); });
  }

  // ── 皮肤切换 ──
  // 皮肤列表按下拉名拼音升序：白蓝 < 黑橙 < 灰橙
  var SKINS = [
    { id: 'white_blue', label: '白蓝', bg: '#F5F5F5', theme: '#4B3FE3' },
    { id: 'Black_Orange', label: '黑橙', bg: '#111113', theme: '#FF6600' },
    { id: 'Gray_Orange', label: '灰橙', bg: '#333336', theme: '#FF6600' }
  ];
  function applySkin(id, persist) {
    var target = SKINS.some(function (s) { return s.id === id; }) ? id : SKINS[0].id;
    document.documentElement.setAttribute('data-skin', target);
    if (persist) call('set_skin', target);
    return target;
  }
  function initSkin() {
    call('get_skin').then(function (id) { applySkin(id, false); }).catch(function () { applySkin(SKINS[0].id, false); });
    // 设置页修改主题后，主界面即时跟随
    if (window.txapi && window.txapi.on_settings_saved) {
      window.txapi.on_settings_saved(function (cfg) { if (cfg && typeof cfg === 'object') applySkin(cfg.skin, false); });
    }
    // 设置窗口打开/关闭时显示/隐藏主窗口模糊遮罩
    if (window.txapi && window.txapi.on_settings_window_opened) window.txapi.on_settings_window_opened(showSettingsDim);
    if (window.txapi && window.txapi.on_settings_window_closed) window.txapi.on_settings_window_closed(hideSettingsDim);
  }

  function refreshData(force, busyText, done, skipReflow) {
    if (busyText) showBusy(busyText);
    call('list_projects', force).then(function (projects) {
      state.projects = projects || []; buildSidebar();
      if (!skipReflow && state.activeProject && state.activeTxt) {
        var foundProj = state.projects.find(function (p) { return p.name === state.activeProject; });
        var foundTxt = foundProj && foundProj.txts.find(function (t) { return t.name === state.activeTxt; });
        if (!foundTxt) { state.activeProject = null; state.activeTxt = null; state.versions = []; state.activeVersion = null; state.configData = null; buildDateBranches(); buildCenterBottom(); buildRightPanel(); setStatus('就绪'); }
        else selectTxt(state.activeProject, state.activeTxt, true);
      }
      if (busyText) hideBusy();
      if (done) done();
    }).catch(function (e) { setStatus('数据加载失败：' + e.message); if (busyText) hideBusy(); });
  }
  function selectTxt(project, name, keepVersion) {
    state.activeLogDate = null;
    // 复刻虚拟项目：仅含日志无配置，点击直接进入日志视图
    if (project === REPLICA_PROJECT) {
      state.activeProject = project; state.activeTxt = name;
      state.versions = [{ label: '全部日志', path: REPLICA_MARK + name, is_latest: true }];
      state.activeVersion = state.versions[0];
      state.configData = null; state.logContent = null;
      state.mode = 'log';
      var ml = $('modeLog'), mf = $('modeFilelist');
      if (ml) ml.classList.add('mode-toggle--active');
      if (mf) mf.classList.remove('mode-toggle--active');
      state.expandedProject = project;
      buildSidebar();
      // 点击配置＝用户交互：重建动画中则动画结束再判定，无动画直接判定
      var azB2 = $('azIndexBar');
      if (azB2 && azB2.classList.contains('az-bar--enter')) _azPending = true;
      else syncAzHighlight();
      buildDateBranches(); buildCenterBottom(); buildRightPanel();
      setStatus('日志模式：' + name);
      return;
    }
    var prevLabel = keepVersion && state.activeVersion ? state.activeVersion.label : null;
    // 点击左侧配置名：即使当前在日志模式也切回配置模式，并跳转该配置最新日期分支
    state.selectMode = false; state.selectedLogPaths = {};
    state.mode = 'filelist';
    var mlT = $('modeLog'), mfT = $('modeFilelist');
    if (mfT) mfT.classList.add('mode-toggle--active');
    if (mlT) mlT.classList.remove('mode-toggle--active');
    state.activeProject = project; state.activeTxt = name;
    call('list_versions', project, name).then(function (versions) {
      state.versions = versions || []; state.activeVersion = null;
      if (state.versions.length > 0) { var target = prevLabel ? state.versions.find(function (v) { return v.label === prevLabel; }) : null; state.activeVersion = target || state.versions[0]; }
      buildSidebar();
      // 点击配置＝用户交互：重建动画中则动画结束再判定，无动画直接判定
      var azB3 = $('azIndexBar');
      if (azB3 && azB3.classList.contains('az-bar--enter')) _azPending = true;
      else syncAzHighlight();
      buildDateBranches();
      if (state.activeVersion) loadConfig(state.activeVersion.path);
      else { state.configData = null; buildCenterBottom(); buildRightPanel(); setStatus('该配置无可用版本'); }
    }).catch(function (e) { setStatus('加载版本失败：' + e.message); });
  }
  function selectVersion(label) { var v = state.versions.find(function (x) { return x.label === label; }); if (!v) return; state.activeVersion = v; buildDateBranches(); loadConfig(v.path); }
  function loadConfig(path) {
    state.logContent = null;
    call('read_config', path).then(function (data) {
      state.configData = data;
      state._configOrig = null; // 新配置加载：重建修改基线
      buildCenterBottom(); buildRightPanel();
      setStatus('已选择:"' + (state.activeVersion && state.activeVersion.path || path) + '"');
    }).catch(function (e) { setStatus('读取配置失败：' + e.message); });
  }
  function bindStaticEvents() {
    $('sidebarTree').addEventListener('scroll', syncAzHighlight);
    $('sidebarTree').addEventListener('click', function (e) {
      var projectHeader = e.target.closest('.tree-project__name');
      if (projectHeader) {
        var pname = projectHeader.getAttribute('data-project');
        var willExpand = state.expandedProject !== pname;
        var azBar = $('azIndexBar');
        if (!willExpand) {
          // 折叠：项目名反向收回 + azbar 收回；配置区整体从上到下渐隐，重建后仅展开项目下方的项目渐显
          projectHeader.classList.remove('is-filled');
          var bdgFold = projectHeader.querySelector('.tree-project__badge');
          if (bdgFold) bdgFold.classList.add('tree-project__badge--leave');
          if (azBar) azBar.classList.remove('is-show');
          state.expandedProject = null;
          var itemWrap = $('sidebarTree').querySelector('.tree-project__items');
          if (itemWrap) itemWrap.classList.add('tree-project__items--leaving');
          window.setTimeout(function () {
            buildSidebar();
            var headers = $('sidebarTree').querySelectorAll('.tree-project__name');
            var start = -1;
            for (var h = 0; h < headers.length; h++) {
              if (headers[h].getAttribute('data-project') === pname) { start = h; break; }
            }
            // 仅原展开项目下方的项目渐显（向上衔接收起位移），其余项目保持原样
            for (var g = start + 1; g < headers.length; g++) {
              headers[g].classList.add('az-project-enter');
              headers[g].style.animationDelay = String(Math.min((g - start - 1) * 40, 180)) + 'ms';
            }
          }, 200);
          return;
        }
        // 展开/切换：若有原展开项目，先播原项目收回（去底色）+ 配置区渐隐，随即重建展开新项目
        state.expandedProject = pname;
        var oldHeader = $('sidebarTree').querySelector('.tree-project__name.is-filled');
        var oldWrap = $('sidebarTree').querySelector('.tree-project__items');
        if (oldHeader) {
          oldHeader.classList.remove('is-filled');
          var bdgOld = oldHeader.querySelector('.tree-project__badge');
          if (bdgOld) bdgOld.classList.add('tree-project__badge--leave');
        }
        if (oldWrap) oldWrap.classList.add('tree-project__items--leaving');
        var applyExpand = function () {
          buildSidebar(true); // 项目展开：强制 azbar 扫描动画（即使字母集合相同）
          // 配置区整体淡入（仅在项目展开时触发，切换配置不重播）
          var itemWrap2 = $('sidebarTree').querySelector('.tree-project__items');
          if (itemWrap2) {
            itemWrap2.classList.remove('tree-project__items--enter');
            void itemWrap2.offsetWidth;
            itemWrap2.classList.add('tree-project__items--enter');
          }
          // 点击项目名仅展开列表，不触发高亮判定（高亮由点击配置名/滚动/拖拽触发）
          var newHeader = null;
          var hs = $('sidebarTree').querySelectorAll('.tree-project__name');
          for (var k = 0; k < hs.length; k++) {
            if (hs[k].getAttribute('data-project') === pname) { newHeader = hs[k]; break; }
          }
          if (newHeader) {
            // 一次性动画类驱动填充（remove 后重加即可重新播放），避免过渡触发时序导致部分项目直接变色
            newHeader.classList.add('is-filled');
            if (newHeader.classList.contains('is-filling')) newHeader.classList.remove('is-filling');
            void newHeader.offsetWidth;
            newHeader.classList.add('is-filling');
            window.setTimeout(function () { newHeader.classList.remove('is-filling'); }, 400);
          }
        };
        if (oldHeader || oldWrap) { window.setTimeout(applyExpand, 50); } else { applyExpand(); }
        return;
      }
      var item = e.target.closest('.tree-txt-item');
      if (item) selectTxt(item.getAttribute('data-project'), item.getAttribute('data-name'), false);
    });
    $('btnSortName').addEventListener('click', function () { if (state.sortMode === 'name') state.sortAsc = !state.sortAsc; else state.sortMode = 'name'; updateSortButtons(); buildSidebar(); });
    $('btnSortTime').addEventListener('click', function () { if (state.sortMode === 'time') state.sortTimeDesc = !state.sortTimeDesc; else state.sortMode = 'time'; updateSortButtons(); buildSidebar(); });
    $('dateBranches').addEventListener('click', function (e) { var btn = e.target.closest('.date-branch-btn'); if (!btn) return; if (btn.getAttribute('data-date') != null) { state.activeLogDate = btn.getAttribute('data-date'); state.activeLogPath = btn.getAttribute('data-file') || null; buildDateBranches(); buildCenterBottom(); return; } selectVersion(btn.getAttribute('data-label')); });
    $('dateBranches').addEventListener('dblclick', function (e) { var btn = e.target.closest('.date-branch-btn'); if (!btn) return; var fp = btn.getAttribute('data-file'); if (fp) { call('open_parent', fp); return; } var label = btn.getAttribute('data-label'); var v = state.versions.find(function (x) { return x.label === label; }); if (v) call('open_parent', v.path); });
    $('dateBranches').addEventListener('contextmenu', function (e) {
      var btn = e.target.closest('.date-branch-btn');
      if (!btn) return;
      e.preventDefault();
      var fp = btn.getAttribute('data-file');
      if (fp) {
        showMenu(e.clientX, e.clientY, [
          { label: '打开文件', action: function () { call('open_path', fp); } },
          { label: '打开路径', action: function () { call('open_parent', fp); } }
        ]);
        return;
      }
      var label = btn.getAttribute('data-label');
      var v = state.versions.find(function (x) { return x.label === label; });
      if (!v) return;
      showMenu(e.clientX, e.clientY, [
        { label: '打开文件', action: function () { call('open_path', v.path); } },
        { label: '打开路径', action: function () { call('open_parent', v.path); } }
      ]);
    });
    $('modeFilelist').addEventListener('click', function () {
      if (state.activeLogDate) {
        // 日志 → 配置：按当前选中日志重新定位到对应配置文件版本（正本/序号 或 当日外部 *）
        var f = (state.logFiles || []).find(function (x) { return x.path === state.activeLogPath; }) || (state.logFiles || []).find(function (x) { return x.date === state.activeLogDate; });
        if (f) { var ver = versionForLogFile(f); if (ver) state.activeVersion = ver; }
      }
      state.selectMode = false; state.selectedLogPaths = {}; state.mode = 'filelist'; $('modeFilelist').classList.add('mode-toggle--active'); $('modeLog').classList.remove('mode-toggle--active'); buildDateBranches(); buildCenterBottom(); buildRightPanel();
    });
    $('modeLog').addEventListener('click', function () { state.mode = 'log'; state._fromConfig = true; $('modeLog').classList.add('mode-toggle--active'); $('modeFilelist').classList.remove('mode-toggle--active'); buildDateBranches(); buildCenterBottom(); buildRightPanel(); });
    $('searchInput').addEventListener('input', function () { state.searchQuery = this.value.trim(); buildSidebar(); });
    $('logSearchInput').addEventListener('input', function () { state.logSearchQuery = this.value.trim(); if (state.mode === 'log') buildCenterBottom(); onLogSearchInput(); });
    // ── 左下角菜单按钮：刷新配置列表 / 选择路径 / 重置预检测缓存 / 设置 ──
    var menuBtn = $('sidebarMenuBtn');
    var menu = $('sidebarMenu');
    function closeMenu() { if (menu) menu.style.display = 'none'; }
    if (menuBtn && menu) {
      menuBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var show = menu.style.display === 'none';
        if (show) {
          // 菜单浮到按钮右侧、自下而上展开（fixed 定位，避免被 sidebar 的 overflow:hidden 裁剪）
          var br = menuBtn.getBoundingClientRect();
          menu.style.position = 'fixed';
          menu.style.left = (br.right + 8) + 'px';
          menu.style.margin = '0';
          menu.style.display = '';
          menu.style.visibility = 'hidden'; // 先显示以测量高度，再向上定位防止被底部遮挡
          var h = menu.offsetHeight;
          menu.style.top = Math.max(4, br.bottom - h) + 'px';
          menu.style.visibility = '';
          // 自下而上移动 + 淡入过渡动画（每次打开重新播放）
          menu.classList.remove('sidebar-menu--enter');
          void menu.offsetWidth;
          menu.classList.add('sidebar-menu--enter');
        } else {
          menu.style.display = 'none';
        }
      });
      document.addEventListener('mousedown', function (e) { if (!menu.contains(e.target) && e.target !== menuBtn) closeMenu(); });
      // 菜单项动作
      $('menuRefreshConfigs').addEventListener('click', function () { closeMenu(); refreshConfigsFlow(); });   // 刷新配置列表（含清理重复外部 *）
      $('menuChoosePath').addEventListener('click', function () { closeMenu(); choosePath(); });
      $('menuResetPrecheck').addEventListener('click', function () { closeMenu(); resetPrecheckFlow(); });
      $('menuSettings').addEventListener('click', function () { closeMenu(); call('open_settings_window').catch(function () { setStatus('打开设置窗口失败'); }); });
    }
    $('btnOpenTasks').addEventListener('click', function () { call('open_task_window').catch(function () { setStatus('打开任务窗口失败'); }); });
    $('btnPreviewRaw').addEventListener('click', function () { state.rightPreview = false; $('btnPreviewRaw').classList.add('preview-toggle--active'); $('btnPreviewModified').classList.remove('preview-toggle--active'); buildRightPanel(); });
    $('btnPreviewModified').addEventListener('click', function () { state.rightPreview = true; $('btnPreviewModified').classList.add('preview-toggle--active'); $('btnPreviewRaw').classList.remove('preview-toggle--active'); buildRightPanel(); });
    $('btnExternalEdit').addEventListener('click', function () { if (!state.activeVersion) return flashNeedSelect(); call('external_edit', state.activeVersion.path); });
    var rz = $('workspaceResizer');
    var sidebarEl = document.querySelector('.sidebar');
    if (rz && sidebarEl) {
      rz.addEventListener('mousedown', function (e) {
        e.preventDefault();
        var startX = e.clientX, startW = sidebarEl.clientWidth;
        function onMove(ev) { var w = Math.max(285, Math.min(520, startW + (ev.clientX - startX))); sidebarEl.style.width = w + 'px'; }
        function onUp() { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); rz.classList.remove('workspace-resizer--active'); }
        rz.classList.add('workspace-resizer--active'); document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
      });
    }
    var vr = $('workspaceVResizer');
    var rp = $('rightPanel');
    if (vr && rp) {
      vr.addEventListener('mousedown', function (e) {
        e.preventDefault();
        var startX = e.clientX, startW = rp.clientWidth;
        function onVMove(ev) { var w = Math.max(240, Math.min(720, startW - (ev.clientX - startX))); rp.style.width = w + 'px'; }
        function onVUp() { document.removeEventListener('mousemove', onVMove); document.removeEventListener('mouseup', onVUp); vr.classList.remove('workspace-resizer--active'); }
        vr.classList.add('workspace-resizer--active'); document.addEventListener('mousemove', onVMove); document.addEventListener('mouseup', onVUp);
      });
    }
  }
  function choosePath() {
    showBusy('正在检测工作路径文件，请稍候…');
    call('choose_workdir').then(function (r) {
      hideBusy();
      if (!r) { setStatus('选择路径失败'); return; }
      if (r.canceled) { setStatus('已取消选择路径'); return; }
      if (!r.ok) { setStatus('选择路径失败：' + ((r && r.error) || '未知错误')); return; }
      hideBootGuide();
      // 第一步：先扫描配置（force 重扫新路径下的配置列表）
      setStatus('工作路径已切换：' + r.root + '，正在扫描配置…');
      refreshData(true, '正在重新扫描工作路径…', function () {
        // 第二步：根据新路径下的配置重置预检测（清缓存全量探测，带进度条，参照「重置预检测」）
        resetPrecheckForPath();
      }, false);
    }).catch(function (e) { hideBusy(); setStatus('选择路径失败：' + e.message); });
  }
  // 选择路径后的第二步：根据已扫描的配置重置预检测（遮罩进度条实时回报 x/y）
  function resetPrecheckForPath() {
    var dismiss = null;
    var api = getApi();
    if (api && typeof api.on_reset_progress === 'function') {
      try { dismiss = api.on_reset_progress(onResetProgress); } catch (e) { dismiss = null; }
    }
    var cleanup = function () { if (dismiss) { try { dismiss(); } catch (e) {} dismiss = null; } };
    showBusyProgress('正在根据新路径重置预检测…');
    call('reset_precheck').then(function (r) {
      hideBusy();
      cleanup();
      setStatusDone('重新检测完成：共检测 ' + ((r && r.total) || 0) + ' 个视频，合规 ' + ((r && r.valid) || 0) + ' 个');
      if (state.activeTxt && state.activeVersion) runPrecheck();
    }).catch(function (e) {
      hideBusy();
      cleanup();
      setStatus('重置预检测失败：' + e.message);
    });
  }
  function flashNeedSelect() { setStatus('请先选择一个 TXT 和日期分支'); }
  function updateTasksCount(tasks) {
    // 主窗口按钮数字：统计运行中 + 排队（暂停任务无序号、不计入）
    var n = 0;
    (tasks || []).forEach(function (t) {
      if (t.status === 'running' || t.status === 'queued') n++;
    });
    var el = $('tasksCount');
    if (!el) return;
    if (n > 0) { el.textContent = String(n); el.style.display = ''; }
    else { el.style.display = 'none'; }
  }
  // 更新提示条（两步式）：发现版本 → 下载（提示条最小化到状态栏显示进度）→ 下载完成重新弹出询问是否重启
  var _bannerShown = false;
  var _bannerDismissed = false; // 本次提示条被忽略/取消；新事件到达时重置
  var _bannerState = 'available'; // available | downloaded
  function showUpdateBanner(info, mode) {
    _bannerDismissed = false; // 「忽略/取消」仅关闭本次提示条，下次检查到更新时仍会重新弹出
    var banner = $('updateBanner');
    if (!banner) return;
    var nextMode = mode === 'downloaded' ? 'downloaded' : 'available';
    // 已处于「下载完成」等待用户操作时，新到的「发现新版本」不覆盖提示条
    if (_bannerShown && _bannerState === 'downloaded' && nextMode === 'available') return;
    _bannerShown = true;
    _bannerState = nextMode;
    var title = $('updateBannerTitle');
    var desc = $('updateBannerDesc');
    var later = $('updateLaterBtn');
    var now = $('updateNowBtn');
    if (_bannerState === 'downloaded') {
      var setupMode = state.isPortable === false; // setup 安装版：重启并安装；便携版：打开更新文件
      if (title) title.textContent = '更新包下载完成';
      if (desc) desc.textContent = setupMode ? '是否立即重启并安装？' : '更新包已下载完成，请右键托盘图标退出应用后解压覆盖';
      if (later) later.textContent = '取消';
      if (now) now.textContent = setupMode ? '重启并安装' : '打开更新文件';
    } else {
      if (title) title.textContent = '发现新版本 v' + ((info && info.latest) || '');
      if (desc) desc.textContent = '当前版本 v' + ((info && info.current) || '') + ' · 点击立即更新获取最新功能';
      if (later) later.textContent = '忽略';
      if (now) now.textContent = '立即更新';
    }
    if (now) now.disabled = false;
    banner.style.display = 'flex'; // display:none → flex 会重新触发入场动画
  }
  function hideUpdateBanner() {
    var banner = $('updateBanner');
    if (banner) banner.style.display = 'none';
    _bannerShown = false;
  }
  // 状态栏下载进度（任务按钮左侧）：左侧「更新 vX」+ 中间细进度条 + 右侧百分比
  function showUpdateMini(info) {
    var el = $('updateMini');
    var fill = $('updateMiniFill');
    var lab = $('updateMiniLabel');
    var txt = $('updateMiniText');
    if (!el) return;
    var p = Math.max(0, Math.min(100, (info && info.percent) || 0));
    var latest = (info && info.latest) || '';
    if (fill) fill.style.width = p + '%';
    if (lab) lab.textContent = latest ? ('更新 v' + latest) : '更新中…';
    if (txt) txt.textContent = p + '%';
    el.style.display = 'inline-flex';
  }
  function hideUpdateMini() {
    var el = $('updateMini');
    if (el) el.style.display = 'none';
  }
  function initUpdateBanner() {
    var banner = $('updateBanner');
    if (!banner) return;
    banner.style.display = 'none'; // 默认隐藏，由后端事件驱动显示
    var later = $('updateLaterBtn');
    if (later) later.addEventListener('click', function () {
      _bannerDismissed = true; // 忽略/取消：本次会话不再提醒，下次启动仍会检查
      hideUpdateBanner();
    });
    var now = $('updateNowBtn');
    if (now) now.addEventListener('click', function () {
      var gp = getApi();
      if (!gp) { setStatus('更新功能不可用'); return; }
      now.disabled = true;
      if (_bannerState === 'downloaded') {
        if (state.isPortable === false) {
          // setup 安装版：electron-updater 静默升级安装并重启
          setStatus('正在重启并安装更新…');
          if (!gp.apply_update) { now.disabled = false; return; }
          gp.apply_update().catch(function () { now.disabled = false; setStatus('启动更新失败'); });
        } else {
          // 便携版：打开资源管理器并选中更新包，用户自行关闭应用后解压覆盖
          if (!gp.reveal_update_file) { now.disabled = false; return; }
          gp.reveal_update_file().catch(function () { now.disabled = false; setStatus('打开更新文件失败'); });
        }
      } else {
        // 第一步：仅下载更新包（连接服务器阶段先给提示，随后出现 0% 进度条）
        setStatus('正在连接更新服务器…');
        if (!gp.start_update) { now.disabled = false; return; }
        gp.start_update().then(function (r) {
          if (r && r.busy) { now.disabled = false; setStatus('已有更新操作进行中，请稍候'); }
        }).catch(function () { now.disabled = false; setStatus('下载更新失败'); });
      }
    });
    var upd = getApi();
    if (!upd) return;
    if (upd.on_update_available) upd.on_update_available(function (info) { showUpdateBanner(info, 'available'); });
    if (upd.on_update_progress) upd.on_update_progress(function (info) {
      // 下载进行中：提示条最小化到状态栏，任务按钮左侧显示文字与进度条
      hideUpdateBanner();
      showUpdateMini(info);
    });
    if (upd.on_update_downloaded) upd.on_update_downloaded(function (info) {
      hideUpdateMini();
      showUpdateBanner(info, 'downloaded');
    });
    if (upd.on_update_none) upd.on_update_none(function (info) {
      hideUpdateMini();
      if (info && info.message) setStatus(info.message);
      else setStatus('已是最新版本 v' + ((info && info.current) || ''));
    });
    if (upd.on_update_error) upd.on_update_error(function (info) {
      hideUpdateMini();
      if (info && info.busy) { setStatus('已有更新操作进行中，请稍候'); return; }
      setStatus('更新失败：' + ((info && (info.message || info.error)) || '未知错误'));
    });
    if (upd.on_update_ready) upd.on_update_ready(function () {
      hideUpdateMini();
      hideUpdateBanner();
      setStatus('更新包已就绪，正在重启应用…');
    });
  }

  // 未配置工作路径时的引导态：项目列表为空，中央「选择路径」指引
  function showBootGuide() { var el = $('bootGuide'); if (el) el.style.display = 'flex'; }
  function hideBootGuide() { var el = $('bootGuide'); if (el) el.style.display = 'none'; }
  function initBootGuide() {
    var btn = $('bootGuidePick');
    if (btn) btn.addEventListener('click', function () { choosePath(); });
    if (getApi().get_root) {
      getApi().get_root().then(function (r) { (r ? hideBootGuide() : showBootGuide()); }).catch(showBootGuide);
    }
  }
  function init() {
    hydrateIcons(document); bindStaticEvents(); initSkin(); buildAzIndex();
    updateSortButtons();
    initUpdateBanner();
    // 状态栏左下角常驻版本号
    if (getApi().get_app_version) {
      getApi().get_app_version().then(function (v) {
        var el = $('versionTag');
        if (el) el.textContent = v ? 'v' + v : '';
      }).catch(function () {});
    }
    // 运行时形态（便携/setup），决定「下载完成」后是打开更新文件还是重启并安装
    if (getApi().get_runtime) {
      getApi().get_runtime().then(function (r) { state.isPortable = !!(r && r.is_portable); }).catch(function () { state.isPortable = true; });
    }
    if (!getApi()) { $('statusLeft').textContent = '后端不可用（未检测到桥接 API）'; return; }
    checkEnv(); buildDateBranches(); buildCenterBottom(); buildRightPanel(); refreshData(false, '正在检测工作路径文件，请稍候…');
    initBootGuide();
    if (getApi().on_task_update) getApi().on_task_update(updateTasksCount);
    // 有运行中任务退出时：主进程请求二次确认（与界面同款弹窗），确认后才真正退出
    if (getApi().on_confirm_quit_request) getApi().on_confirm_quit_request(function () {
      showDialog({
        title: '确认退出',
        message: '有正在运行的任务，退出将中断当前生成，并将任务标记为已中断、排队任务转为暂停。确定要退出吗？',
        buttons: [
          { label: '取消', value: false },
          { label: '仍要退出', value: true, danger: true }
        ]
      }).then(function (ok) { if (ok && getApi().confirm_quit) getApi().confirm_quit(); });
    });
  }
  function checkEnv() {
    call('check_env').then(function (r) {
      r = r || {};
      var miss = [];
      if (!r.pwsh) miss.push('pwsh');
      if (!r.ffmpeg) miss.push('ffmpeg');
      if (!r.ffprobe) miss.push('ffprobe');
      state.envMissing = miss;
      var mark = $('envWarnMark');
      if (mark) {
        if (miss.length) { mark.textContent = '缺少环境: ' + miss.join('、') + '（见 README 安装）'; mark.className = 'status-bar__envwarn'; }
        else { mark.textContent = '环境正常'; mark.className = 'status-bar__envok'; }
      }
      applyEnvDisabled();
    }).catch(function () { state.envMissing = ['pwsh', 'ffmpeg', 'ffprobe']; applyEnvDisabled(); });
  }
  function _envBad() { return (state.envMissing || []).length > 0; }
  function setBtnHint(b, hint) {
    if (!b) return;
    if (hint) {
      if (!b.dataset.origTitle) b.dataset.origTitle = b.getAttribute('title') || '';
      b.setAttribute('title', hint);
    } else if (b.dataset.origTitle) {
      b.setAttribute('title', b.dataset.origTitle);
      delete b.dataset.origTitle;
    } else b.removeAttribute('title');
  }
  // 环境硬拦截：缺 pwsh/ffmpeg/ffprobe 时禁用所有调用脚本的入口，悬浮提示「运行环境缺失」
  function applyEnvDisabled() {
    var bad = _envBad();
    var targets = document.querySelectorAll('#btnRunScript, #btnBatchReplica1, #btnBatchReplica2, .log-entry__replica');
    Array.prototype.forEach.call(targets, function (b) {
      if (b.disabled === undefined) return;
      if (bad) {
        b.disabled = true;
        setBtnHint(b, '运行环境缺失');
      } else {
        setBtnHint(b, null);
      }
    });
    // 环境完整时按各自禁用条件重算提示
    if (!bad) { if (typeof refreshLogConfigBar === 'function') refreshLogConfigBar(); applyPrecheckValidity(); refreshConfigModified(); }
  }
  var booted = false;
  function boot() { if (booted) return; booted = true; init(); }
  window.addEventListener('pywebviewready', boot);
  document.addEventListener('DOMContentLoaded', boot);
})();
