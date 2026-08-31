/* -*- coding: utf-8 -*-
 * Video Lab — 前端逻辑
 */
(function () {
  'use strict';

  // 图标统一来自 icons.js 全局库（硬约束：不在业务文件维护 ICONS/icon 副本）
  function icon(name, size, cls) { return window.VL_icon ? window.VL_icon(name, size, cls) : ''; }
  function hydrateIcons(root) { if (window.VL_hydrateIcons) window.VL_hydrateIcons(root); }
  // 局部替换图标：元素内可能已有插入的 svg，直接重建（私有，不污染全局图标库）
  function hydIcon(el, name) {
    if (!el) return;
    var i = el.querySelector('i[data-icon]');
    if (i) hydIcon(i, name);
    else {
      el.innerHTML = icon(name, 14);
      var svg = el.firstChild;
      if (svg && svg.setAttribute) { svg.setAttribute('class', 'preview-collapse__icon'); }
    }
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // 路径 → 文件名（不含扩展名）；用于水印栏简洁展示
  function baseNameNoExt(p) {
    var s = String(p || '').replace(/[\\/]+$/, '');
    var name = s.replace(/^.*[\\/]/, '');
    return name.replace(/\.[^.]+$/, '');
  }
  // 水印栏行内结构：点击文件名更换水印 + 右侧两个图标按钮（打开文件 / 打开文件夹）
  function wmRowHtml(wm) {
    var p = wm ? String(wm) : '';
    var h = '<div class="config-watermark__row">';
    if (p) h += '<div class="config-watermark__path" title="' + escapeHtml(p) + '">' + escapeHtml(baseNameNoExt(p)) + '</div>';
    else h += '<div class="config-watermark__path config-watermark__path--empty" title="点击更换水印">未设置水印</div>';
    h += '<button type="button" class="config-watermark__btn" data-wm="open" title="打开文件"' + (p ? '' : ' disabled') + '>' + icon('image', 15) + '</button>';
    h += '<button type="button" class="config-watermark__btn" data-wm="folder" title="打开文件夹"' + (p ? '' : ' disabled') + '>' + icon('folder-open', 15) + '</button>';
    return h + '</div>';
  }
  function showDialog(opts) {
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      var card = document.createElement('div');
      card.className = 'modal-card' + (opts.cssClass ? ' ' + opts.cssClass : '');
      var html = '<button type="button" class="modal-close" title="关闭">✕</button><div class="modal__title">' + escapeHtml(opts.title) + '</div>';
      if (opts.message) html += '<div class="modal__message">' + escapeHtml(opts.message) + '</div>';
      html += '<div class="modal__actions">';
      (opts.buttons || []).forEach(function (b) {
        var cls = 'modal-btn' + (b.danger ? ' modal-btn--danger' : '') + (b.primary ? ' modal-btn--primary' : '') + (b.cls ? ' ' + b.cls : '');
        var ics = b.icon ? icon(b.icon, 14) : '';
        html += '<button type="button" class="' + cls + '">' + ics + escapeHtml(b.label) + '</button>';
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
  // 保存归属选择弹窗：每行左侧提示"保存到 XX 项目：<项目名>"，右侧统一「保存」按钮（右对齐、样式一致）
  function showSaveDestDialog(opts) {
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      var card = document.createElement('div');
      card.className = 'modal-card modal-card--dest';
      var html = '<button type="button" class="modal-close" title="关闭">✕</button><div class="modal__title">' + escapeHtml(opts.title) + '</div>';
      if (opts.message) html += '<div class="modal__message">' + escapeHtml(opts.message) + '</div>';
      html += '<div class="modal__dest-list">';
      (opts.rows || []).forEach(function (r) {
        html += '<div class="modal__dest-row"><span class="modal__dest-hint">' + escapeHtml(r.hint) + '</span>';
        html += '<button type="button" class="modal-btn modal__dest-save">' + escapeHtml(opts.btnLabel || '保存') + '</button></div>';
      });
      html += '</div>';
      card.innerHTML = html;
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      var done = function (result) { overlay.remove(); resolve(result); };
      overlay.addEventListener('click', function (e) { if (e.target === overlay) done(null); });
      var closeBtn = card.querySelector('.modal-close');
      if (closeBtn) closeBtn.addEventListener('click', function () { done(null); });
      var btns = card.querySelectorAll('.modal__dest-row .modal-btn');
      (opts.rows || []).forEach(function (r, i) { btns[i].addEventListener('click', function () { done(r.value); }); });
    });
  }
  // 主流水印设置弹窗：启用判定复选框 + 主流水印行（样式照搬水印 PNG 行）+ 保存/保存并更改/取消
  function openProjectWatermarkDialog(project) {
    call('get_project_watermark', project).then(function (r) {
      if (!r || !r.ok) { alertDialog('读取主流水印失败：' + ((r && r.error) || '未知错误')); return; }
      var curWm = String(r.main || '').trim();
      var overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      var card = document.createElement('div');
      card.className = 'modal-card modal-card--wm';
      card.innerHTML =
        '<button type="button" class="modal-close" title="关闭">✕</button>' +
        '<div class="modal__title">主流水印设置</div>' +
        '<div class="modal__wm-body">' +
        '<div class="wm-row"><span class="wm-row__label">启用主流水印判定</span><div class="wm-row__ops"><label class="wm-check"><input type="checkbox" id="wmToggle"' + (r.enabled ? ' checked' : '') + '><span class="wm-check__box"></span></label></div></div>' +
        '<div class="wm-row"><span class="wm-row__label">主流水印设置</span><div class="wm-row__ops"><div class="config-watermark__row config-watermark__row--inline" id="wmMainRow"></div></div></div>' +
        '</div>' +
        '<div class="modal__actions">' +
        '<button type="button" class="modal-btn" data-wm-act="cancel">取消</button>' +
        '<button type="button" class="modal-btn modal-btn--primary" data-wm-act="save">仅保存</button>' +
        '<button type="button" class="modal-btn modal-btn--primary" data-wm-act="saveAll">保存并替换</button>' +
        '</div>';
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      var row = card.querySelector('#wmMainRow');
      function bindWmRow(root) {
        var pathEl = root.querySelector('.config-watermark__path');
        if (pathEl) pathEl.addEventListener('click', function () {
          call('pick_watermark', curWm).then(function (p) { if (p) { curWm = p; renderRow(); } });
        });
        var bOpen = root.querySelector('[data-wm="open"]');
        if (bOpen) bOpen.addEventListener('click', function () { if (curWm) call('open_path', curWm); });
        var bFold = root.querySelector('[data-wm="folder"]');
        if (bFold) bFold.addEventListener('click', function () { if (curWm) call('open_parent', curWm); });
      }
      function renderRow() { row.innerHTML = wmRowHtml(curWm); bindWmRow(row); }
      renderRow();
      var closed = false;
      function closeDialog() { overlay.remove(); closed = true; }
      function afterSave() { closeDialog(); if (state.activeProject === project) assertWatermark(); }
      overlay.addEventListener('click', function (e) { if (e.target === overlay) closeDialog(); });
      card.querySelector('.modal-close').addEventListener('click', closeDialog);
      card.querySelector('[data-wm-act="cancel"]').addEventListener('click', closeDialog);
      card.querySelector('[data-wm-act="save"]').addEventListener('click', function () {
        var en = card.querySelector('#wmToggle').checked;
        call('set_project_watermark', project, curWm, en, false).then(function (res) {
          if (res && res.ok) { setStatus('已保存项目主流水印设置'); afterSave(); }
          else alertDialog('保存失败：' + ((res && res.error) || '未知错误'));
        }).catch(function (err) { alertDialog('保存失败：' + err.message); });
      });
      card.querySelector('[data-wm-act="saveAll"]').addEventListener('click', function () {
        var en = card.querySelector('#wmToggle').checked;
        showDialog({
          title: '确认批量更改水印',
          message: '将把本项目全部 TXT（含日志）中的水印行更换为：\n' + curWm + '\n\n确定继续吗？',
          buttons: [ { label: '取消', value: false }, { label: '确认更改', value: true, danger: true, primary: true } ]
        }).then(function (ok) {
          if (!ok) return;
          // 预检测式遮罩：滤镜模糊 + 可缩小至状态栏
          showBusyProgress('正在更改本项目全部 TXT 的水印行…');
          var cb = $('busyCancelBtn'); if (cb) cb.style.display = 'none'; // 此过程无需取消
          call('set_project_watermark', project, curWm, en, true).then(function (res) {
            hideBusy(); hideProbeMini();
            if (res && res.ok) {
              setStatus('已保存主流水印，并将 ' + (res.replaced || 0) + ' 个 TXT 的水印行更改为新水印');
              refreshData();
              afterSave();
            } else alertDialog('保存失败：' + ((res && res.error) || '未知错误'));
          }).catch(function (err) { hideBusy(); hideProbeMini(); alertDialog('保存失败：' + err.message); });
        });
      });
    }).catch(function (err) { alertDialog('读取主流水印失败：' + err.message); });
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
    logViewMode: 'simple', // 日志预览模式：simple=简化（片段仅显示最后一段文件名）/ raw=完整原始
    focusVideo: null, _searchTimer: null, _fromConfig: false, envMissing: [],
    isPortable: null, // 运行时形态：null=未知（按便携处理）/ true=便携 zip / false=setup 安装版
    previewCollapsed: true, // 右侧预览面板默认折叠（仅留拖拽条上的竖条按钮提示展开）
    previewLastWidth: 320, // 展开时恢复的预览宽度（记忆折叠前的宽度）
    _sideBeforeLog: false, // 进入日志模式前预览面板是否原本折叠（退出时恢复）
    precheckBackground: false, // 预检测是否已缩到后台（状态栏 probe-mini 显示进度）
    _probeActive: false        // 当前是否有一次预检测在进行（防止误点「缩到后台」）
  };
  // 复刻虚拟项目：仅含日志无配置，配置名对应复刻模式；REPLICA_MARK 为路由标记，透传回后端
  var REPLICA_PROJECT = '复刻';
  var REPLICA_MARK = 'REPLICA:';
  function $(id) { return document.getElementById(id); }

  // 时间排序键：取标签前 4 位 MMdd 作主键 + 后缀序号（-1/-2/* 等）作细分，0802 与 0802-1 同组但后者排前面
  function branchNum(s) {
    var m = /^(\d{2})(\d{2})/.exec(s || '');
    var main = m ? parseInt(m[1], 10) * 100 + parseInt(m[2], 10) : 0;
    var n = /[-*](\d+)$/.exec(s || '');
    var sub = n ? parseInt(n[1], 10) : 0;
    return main * 100 + sub;
  }
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
  function buildSidebar(forceAz, noBadgeAnim) {
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
      // 切换配置场景（noBadgeAnim）：徽章加 --static 静止类，不重播滑入动画，与本行其他内容保持一致
      if (proj.name !== REPLICA_PROJECT && expanded) {
        html += '<span class="tree-project__badge' + (noBadgeAnim ? ' tree-project__badge--static' : '') + '">共 ' + proj.txts.length + ' 个配置</span>';
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
  function buildDateBranches(silent) {
    var c = $('dateBranches');
    if (state.activeProject === REPLICA_PROJECT) {
      // 复刻项目按日志日期分支展示（每个日期=一份复刻日志），便于按天定位成片来源
      buildLogDateBranches(c, silent);
      return;
    }
    if (state.mode === 'log') { buildLogDateBranches(c, silent); return; }
    if (!state.activeTxt || state.versions.length === 0) {
      c.innerHTML = '<div class="center-empty" style="padding:var(--spacer-16)">' + icon('arrow-left', 24, 'center-empty__icon') + '<span style="font-size:var(--body-sm-font-size)">从左侧选择一个 TXT</span></div>';
      updateModeToggle();
      return;
    }
    var html = '';
    state.versions.forEach(function (v) {
      var active = v.label === state.activeVersion.label;
      html += '<button class="date-branch-btn' + (active ? ' date-branch-btn--active' : '') + (silent ? ' date-branch-btn--static' : '') + '" data-label="' + escapeHtml(v.label) + '" title="' + escapeHtml(v.path) + '">' + escapeHtml(v.label);
      html += '</button>';
    });
    c.innerHTML = html;
    updateModeToggle();
  }
  // 日志模式下：顶部展示该配置的日志文件日期分支（每日期一个），按钮带 data-date 与 data-file
  function buildLogDateBranches(c, silent) {
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
      // 复刻项目无配置可定位：默认选中最新一天的日志；其余场景回退首个
      if (!active) active = (state.activeProject === REPLICA_PROJECT && files.length) ? files[files.length - 1] : files[0];
      var had = state.activeLogPath === active.path;
      state.activeLogDate = active.date;
      state.activeLogPath = active.path;
      var html = '';
      files.forEach(function (f) {
        var isActive = f.path === active.path;
        var txt = f.label || f.date;
        html += '<button class="date-branch-btn' + (isActive ? ' date-branch-btn--active' : '') + (silent ? ' date-branch-btn--static' : '') + '" data-date="' + escapeHtml(f.date) + '" data-file="' + escapeHtml(f.path) + '" title="' + escapeHtml(f.path) + '">' + escapeHtml(txt) + '</button>';
      });
      c.innerHTML = html;
      updateModeToggle();
      if (!had && state.mode === 'log' && state.activeTxt) buildCenterBottom();
    }).catch(function () { c.innerHTML = '<span class="date-branch-btn">无日志</span>'; updateModeToggle(); });
  }
  function buildCenterBottom(silent) {
    if (!state.activeTxt || !state.activeVersion) {
      $('centerBottom').innerHTML = '<div class="center-empty">' + icon('file-text', 24, 'center-empty__icon') + '<span style="font-size:var(--body-sm-font-size)">请选择一个日期分支查看内容</span></div>';
      return;
    }
    if (state.mode === 'log') { buildLogConfigBar(); buildLogList(); return; }
    var container = $('centerBottom');
    var data = state.configData;
    if (!data) { container.innerHTML = '<div class="center-empty">' + icon('file-text', 24, 'center-empty__icon') + '<span style="font-size:var(--body-sm-font-size)">正在加载配置…</span></div>'; return; }
    var folders = data.folders || [];
    var excludes = data.excludes || [];
    var watermark = data.watermark || '';
    // 配置间切换（silent）时不给进场动画：与徽章 --static 同思路，避免重建页面时的滑入感
    var html = '<div class="config-editor' + (silent ? ' config-editor--static' : '') + '">';
    html += '<div class="config-editor__col config-editor__col--paths">';
    html += '<div class="config-path-subheader"><span class="config-path-subheader__sort">排序</span><span class="config-path-subheader__nopoll">取消轮询</span><span class="config-path-subheader__path">路径</span><span class="config-path-subheader__check">预检测结果</span><span class="config-path-subheader__open"></span><span class="config-path-subheader__remove"></span></div>';
    html += '<div class="config-editor__path-list" id="pathList">';
    folders.forEach(function (f, idx) {
      html += '<div class="config-path-row" data-index="' + idx + '" data-orig="' + escapeHtml(f.path) + '" data-orig-idx="' + idx + '">';
      html += '<span class="config-path-row__drag" draggable="true" title="按住拖动排序">' + icon('grip-vertical', 14) + '</span>';
      html += '<label class="config-path-row__checkbox" title="勾选 = 不轮询（添加 = 前缀）"><input type="checkbox" class="config-path-row__check" ' + (f.nonround ? 'checked' : '') + '><span class="config-path-row__check-mark"></span></label>';
      html += '<input type="text" class="config-path-row__input" value="' + escapeHtml(f.path) + '" title="' + escapeHtml(f.path) + '">';
      html += '<span class="config-path-row__precheck" data-index="' + idx + '"><span class="config-path-row__badge precheck--pending">检测中…</span></span>';
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
    html += '<div class="config-editor__wm-section">';
    html += '<div class="config-editor__col-header">水印 PNG</div>';
    html += '<div class="config-editor__watermark-content">';
    html += wmRowHtml(watermark);
    html += '</div></div>';
    // 框体下半：配置名（标题行 + 内容栏，与其他框体一致）
    html += '<div class="config-editor__wm-section">';
    html += '<div class="config-editor__col-header">配置名</div>';
    html += '<div class="config-editor__wm-field"><input type="text" class="config-bottombar__input config-bottombar__input--name" id="inputConfigName" value="' + escapeHtml((data && data.name) || '') + '"></div></div>';
    html += '</div></div>';
    container.innerHTML = html;
    bindWatermarkPreview(container);
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
  // 水印文件名悬浮预览：hover 时经主进程打开独立置顶小窗显示 PNG（可越出主窗口、按图比例自适应），透明 PNG 直接透底显示
  function bindWatermarkPreview(container) {
    var shown = false;
    var lastMove = 0;
    container.addEventListener('mouseover', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('.config-watermark__path') : null;
      if (!t) { if (shown) { call('watermark_preview_hide'); shown = false; } return; }
      var wm = state.configData && state.configData.watermark ? String(state.configData.watermark) : '';
      if (!wm) return;
      call('watermark_preview_move', e.clientX, e.clientY); // 先定位再显示，避免窗口先在默认位置闪现
      call('watermark_preview_show', wm);
      shown = true;
    });
    container.addEventListener('mousemove', function (e) {
      if (!shown) return;
      var now = Date.now();
      if (now - lastMove < 16) return; // 约 60fps：平滑跟随（位置由主进程按真实光标计算，尺寸有 resizeGuard 兜底）
      lastMove = now;
      call('watermark_preview_move', e.clientX, e.clientY);
    });
    container.addEventListener('mouseleave', function () {
      if (shown) { call('watermark_preview_hide'); shown = false; }
    });
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
    html += '<span class="config-bottombar__error config-bottombar__error--inline" id="watermarkFlagError" style="display:none">水印错误</span>';
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
      if (row.dataset.deleted === '1') { row.classList.remove('is-modified-row', 'config-path-row--invalid-moved'); return; } // 软删除行不参与修改检测
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
      if (row.dataset.deleted === '1') return; // 软删除行不计入，保存时视为硬删除
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
    assertWatermark(); // 选中配置进行预检测时联动水印归属判定
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
      var anyWarn = false;
      rows.forEach(function (row, i) {
        if (row.dataset.deleted === '1') return; // 软删除行不参与预检测判定
        var r = results[i] || { status: 'pending', text: '未检测' };
        row.classList.toggle('config-path-row--invalid', r.status === 'warn');
        if (r.status === 'warn') anyWarn = true;
        var span = row.querySelector('.config-path-row__precheck');
        var badge = span ? span.querySelector('.config-path-row__badge') : null;
        var cls = 'precheck--pending';
        if (r.status === 'ok') cls = 'precheck--ok';
        else if (r.status === 'warn') cls = 'precheck--warn';
        else if (r.status === 'group') cls = 'precheck--group';
        if (badge) { badge.className = 'config-path-row__badge ' + cls; badge.textContent = r.text || ''; }
        else { span.className = 'config-path-row__precheck ' + cls; span.textContent = r.text || ''; }
      });
      var def = (results.length && results[0] && results[0].total) ? String(results[0].total) : '';
      var filmInput = $('inputFilmCount');
      if (filmInput) filmInput.value = def;
      state.precheckInvalid = anyWarn;
      applyPrecheckValidity();
    }).catch(function () {
      rows.forEach(function (row) {
        if (row.dataset.deleted === '1') return;
        var span = row.querySelector('.config-path-row__precheck');
        var badge = span ? span.querySelector('.config-path-row__badge') : null;
        if (badge) { badge.className = 'config-path-row__badge precheck--warn'; badge.textContent = '检测失败'; }
        else { span.className = 'config-path-row__precheck precheck--warn'; span.textContent = '检测失败'; }
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
      var t = e.target.closest('button, .config-path-row__open, .config-path-row__remove, .config-watermark__path');
      if (!t) return;
      if (t.classList.contains('config-path-row__remove')) {
        // 软删除：第一次点击标记删除（按钮变恢复），再次点击取消删除；保存配置后视为硬删除
        var pRow = t.closest('.config-path-row');
        if (pRow.dataset.deleted === '1') {
          delete pRow.dataset.deleted;
          pRow.classList.remove('is-path-deleted');
          t.innerHTML = icon('x', 14);
          t.title = '移除路径';
        } else {
          pRow.dataset.deleted = '1';
          pRow.classList.add('is-path-deleted');
          t.innerHTML = icon('repeat', 14);
          t.title = '恢复该路径';
        }
        updatePathCount(); runPrecheck(); refreshPreviewIfModified(); refreshConfigModified();
      }
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
      else if (t.classList.contains('config-watermark__path')) { changeWatermark(); } // 点击水印文件名 = 更换水印
      else if (t.classList.contains('config-watermark__btn')) {
        var wmV = state.configData && state.configData.watermark ? String(state.configData.watermark) : '';
        if (t.dataset.wm === 'open' && wmV) call('open_path', wmV);
        else if (t.dataset.wm === 'folder' && wmV) call('open_parent', wmV);
      }
    }
    container.removeEventListener('click', container._delegatedClick);
    container._delegatedClick = onContainerClick;
    container.addEventListener('click', container._delegatedClick);
    // 排除字段/路径行右键菜单：移除（硬删除）；（水印栏右键菜单已移除，改由行内按钮承担）
    container.removeEventListener('contextmenu', container._delegatedCtx);
    container._delegatedCtx = function (e) {
      var exRow = e.target.closest('.config-exclude-row');
      var pRow = e.target.closest('.config-path-row');
      if (!exRow && !pRow) return;
      e.preventDefault();
      if (exRow) {
        showMenu(e.clientX, e.clientY, [{
          label: '移除',
          action: function () {
            exRow.remove();
            updateExcludeCount(); runPrecheck(); refreshPreviewIfModified(); refreshConfigModified();
          }
        }]);
      } else {
        showMenu(e.clientX, e.clientY, [{
          label: '移除',
          action: function () {
            pRow.remove();
            updatePathCount(); runPrecheck(); refreshPreviewIfModified(); refreshConfigModified();
          }
        }]);
      }
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
    row.innerHTML = '<span class="config-path-row__drag" draggable="true" title="按住拖动排序">' + icon('grip-vertical', 14) + '</span><label class="config-path-row__checkbox" title="勾选 = 不轮询（添加 = 前缀）"><input type="checkbox" class="config-path-row__check"><span class="config-path-row__check-mark"></span></label><input type="text" class="config-path-row__input" value="' + escapeHtml(p) + '" title="' + escapeHtml(p) + '"><span class="config-path-row__precheck"><span class="config-path-row__badge precheck--pending">检测中…</span></span><button class="config-path-row__open" title="打开路径">' + icon('folder-open', 14) + '</button><button class="config-path-row__remove" title="移除路径">' + icon('x', 14) + '</button>';
    $('pathList').appendChild(row);
    updatePathCount(); runPrecheck(); refreshPreviewIfModified();
  }
  function addPathField() {
    call('pick_paths').then(function (paths) {
      (paths || []).forEach(function (p) { addPathRow(p); });
    }).catch(function (e) { setStatus('添加路径失败：' + e.message); });
  }
  // 水印归属警告开关（红字 + 水印上半区浅红底一并控制，下半配置名框不受影响）
  function setWatermarkError(on) {
    var flag = $('watermarkFlagError'); if (flag) flag.style.display = on ? '' : 'none';
    var sec = document.querySelector('.config-editor__col--watermark .config-editor__wm-section');
    if (sec) sec.classList.toggle('is-watermark-error', !!on);
  }
  // 水印归属判定（可传路径；不传则读当前配置），token 防竞态：仅应用最新一次判定结果
  var _wmCheckToken = 0;
  function assertWatermark(wm) {
    var w = (wm !== undefined) ? wm : (state.configData ? (state.configData.watermark || '') : '');
    if (!state.activeProject || !w) { setWatermarkError(false); return; }
    var token = ++_wmCheckToken;
    call('check_watermark_project', state.activeProject, w).then(function (res) {
      if (token !== _wmCheckToken) return;
      setWatermarkError(res && res.inProject === false);
    }).catch(function () { if (token === _wmCheckToken) setWatermarkError(false); });
  }
  function changeWatermark() {
      // 选择框默认定位到上一个水印所在位置，便于就近选新水印
      var prev = state.configData && state.configData.watermark ? String(state.configData.watermark) : '';
      call('pick_watermark', prev).then(function (p) {
        if (!p) return;
        state.configData.watermark = p;
        // 更换后立刻用新水印重新判定：项目内移除警告，仍出界则保留
        assertWatermark(p);
        // 局部更新水印区内容（点击更换按钮后整体重绘行结构）
        var wc = document.querySelector('.config-editor__col--watermark .config-editor__watermark-content');
        if (wc) { wc.innerHTML = wmRowHtml(p); }
        refreshPreviewIfModified();
        refreshConfigModified();
      });
    }
  // 归属确认：当前水印命中其他项目主流时，弹窗让用户选择保存到的目标项目；未命中/取消 → 留在当前项目
  function resolveDestProject() {
    var wmV = state.configData && state.configData.watermark ? String(state.configData.watermark) : '';
    if (!wmV || !state.activeProject) return Promise.resolve(state.activeProject);
    return call('find_watermark_project', state.activeProject, wmV).then(function (r) {
      r = r || {};
      var hits = (r.hits || []).filter(function (h) { return h !== state.activeProject; });
      if (!hits.length) return state.activeProject; // 无其他项目命中：现状
      // 行式选择：每行左侧提示"保存到 XX 项目：<项目名>"，右侧统一「保存」按钮
      var rows = [{ hint: '保存到原始项目：' + state.activeProject, value: state.activeProject }];
      hits.forEach(function (h) { rows.push({ hint: '保存到新项目：' + h, value: h }); });
      var message = hits.length === 1
        ? '当前水印与项目「' + hits[0] + '」的主流水印一致。\n保存的内容将归属到哪个项目？'
        : '该水印在多个项目中均为主流水印，请选择归属项目：';
      return showSaveDestDialog({ title: '水印归属提示', message: message, rows: rows }).then(function (v) { return v == null ? state.activeProject : v; });
    }).catch(function () { return state.activeProject; });
  }
  // 另存到其他项目：目标项目已有同名配置 → 覆盖其最新版本；无 → 保存为当日配置（原文件保留）
  function saveAsToProject(dest, ed) {
    var nm = ($('inputConfigName') ? $('inputConfigName').value.trim() : '') || state.activeTxt;
    return call('list_versions', dest, nm).then(function (vs) {
      if (vs && vs.length) {
        return call('save_config', vs[0].path, ed.folders, ed.excludes, ed.watermark).then(function (r) {
          return { ok: !!(r && r.ok), path: vs[0].path };
        });
      }
      return call('save_config_today', dest, nm, nm, ed.folders, ed.excludes, ed.watermark).then(function (r) {
        return { ok: !!(r && r.ok), path: r.path };
      });
    });
  }
  function saveConfig(noConfirm) {
    if (!state.configData) return Promise.resolve(false);
    var ed = getEditorState();
    var path = state.configData.path;
    return resolveDestProject().then(function (dest) {
      if (dest !== state.activeProject) {
        // 另存到其他项目：原文件保留
        return saveAsToProject(dest, ed).then(function (r) {
          if (r.ok) { setStatus('已另存到项目「' + dest + '」：' + r.path); refreshData(); return true; }
          setStatus('保存失败：' + ((r && r.error) || '未知错误')); return false;
        }).catch(function (e) { setStatus('保存失败：' + e.message); return false; });
      }
      var go = function () {
        return call('save_config', path, ed.folders, ed.excludes, ed.watermark).then(function (r) {
          if (r && r.ok) {
            setStatus('已保存：' + path); refreshData();
            document.querySelectorAll('.config-exclude-row[data-deleted="1"]').forEach(function (rr) { rr.remove(); });
            document.querySelectorAll('.config-path-row[data-deleted="1"]').forEach(function (rr) { rr.remove(); });
            state._configOrigSnapshot = configSnapshot(); refreshConfigModified();
            return true;
          }
          setStatus('保存失败：' + ((r && r.error) || '未知错误')); return false;
        }).catch(function (e) { setStatus('保存失败：' + e.message); return false; });
      };
      // noConfirm（切换/关闭前确认弹窗场景）：已确认过，跳过「确认覆盖」二次弹窗
      if (noConfirm) return go();
      return showDialog({ title: '确认覆盖', message: '将覆盖原文件：\n' + path + '\n是否继续？', buttons: [ { label: '取消', value: false }, { label: '确认覆盖', value: true, danger: true, primary: true } ] }).then(function (ok) {
        if (!ok) { setStatus('已取消保存'); return false; }
        return go();
      });
    }).catch(function (e) { setStatus('保存失败：' + e.message); return false; });
  }
  function saveConfigToday() {
    if (!state.activeProject || !state.activeTxt) return Promise.resolve(false);
    var ed = getEditorState();
    var configName = $('inputConfigName').value.trim() || state.activeTxt;
    return resolveDestProject().then(function (dest) {
      return call('save_config_today', dest, state.activeTxt, configName, ed.folders, ed.excludes, ed.watermark).then(function (r) {
        if (r && r.ok) { setStatus('已保存为当日配置：' + r.path); jumpToVersionPath(r.path, dest); return true; }
        setStatus('保存失败：' + ((r && r.error) || '未知错误')); return false;
      }).catch(function (e) { setStatus('保存失败：' + e.message); return false; });
    }).catch(function (e) { setStatus('保存失败：' + e.message); return false; });
  }
  function normalizePath(p) { return String(p || '').replace(/[\\/]+/g, '\\').toLowerCase(); }
  function jumpToVersionPath(targetPath, proj) {
    var targetKey = normalizePath(targetPath);
    var name = String(targetPath).replace(/[\\/]+/g, '\\').split('\\').pop().replace(/\.txt$/i, '');
    var pr = proj || state.activeProject;
    if (!pr || !name) return;
    call('list_projects').then(function (projects) {
      state.projects = projects || []; state.activeTxt = name; state.activeProject = pr; buildSidebar(false, true);
      return call('list_versions', pr, name);
    }).then(function (versions) {
      state.versions = versions || [];
      var t = null;
      for (var i = 0; i < state.versions.length; i++) { if (normalizePath(state.versions[i].path) === targetKey) { t = state.versions[i]; break; } }
      state.activeVersion = t || (state.versions.length ? state.versions[0] : null);
      if (pruneEmptyTxt(pr, name, state.versions)) return;
      syncTxtCount(pr, name, state.versions);
      state.expandedProject = pr; buildDateBranches(); buildSidebar(false, true);
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
    resolveDestProject().then(function (dest) {
      call('save_config_today', dest, state.activeTxt, configName, ed.folders, ed.excludes, ed.watermark).then(function (saved) {
        if (!saved || !saved.ok) { setStatus('保存失败：' + ((saved && saved.error) || '未知错误')); return; }
        setStatus('已保存并启动脚本：' + saved.path);
        // 水印归属在选中配置预检测时已判定并提示，此处不再阻断启动
        call('run_batch', saved.path, count, group).then(function (r) { if (!(r && r.ok)) setStatus('启动失败：' + ((r && r.error) || '未知错误')); });
        jumpToVersionPath(saved.path, dest);
      }).catch(function (e) { setStatus('启动失败：' + e.message); });
    });
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
      if (found) highlightLogBlock(logRowFor(found.getAttribute('data-video'), found.getAttribute('data-log-path')) || 0, found.getAttribute('data-video'), found.getAttribute('data-log-path'));
    };
  }
  function buildLogList() {
    var container = $('centerBottom');
    container.innerHTML = '<div class="center-empty">' + icon('scroll-text', 24, 'center-empty__icon') + '<span style="font-size:var(--body-sm-font-size)">正在加载日志…</span></div>';
    // 按当前选中的日志分支（精确到日志文件）定位查询目录，切换分支后取对应日志成片
    var probeLog = null;
    if (state.activeProject === REPLICA_PROJECT) {
      // 复刻：聚合全部复刻日志，所属日期在下文按分支日志文件过滤
      probeLog = state.activeVersion.path;
    } else if (state.activeLogPath) probeLog = state.activeLogPath;
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
        // 成片级右键：打开成片 / 打开文件夹；优先定位复刻输出目录（右侧复刻产物），无复刻目录退回原日志目录
        e.preventDefault();
        var videoNm = entryItem.getAttribute('data-video') || '';
        var lpItem = entryItem.getAttribute('data-log-path');
        if (!lpItem) { setStatus('无法定位该成片对应的日志文件'); return; }
        var fname = videoNm.trim();
        if (!fname) return;
        if (!/\.mp4$/i.test(fname)) fname += '.mp4';
        var dirItem = String(lpItem).replace(/[\\/]+/g, '\\').replace(/\\[^\\]*$/, '');
        var clipFile = dirItem + '\\' + fname;
        var smenu = function (missingFile, rep) {
          var openFile = (rep && rep.replicaFile) || clipFile;
          var openDir = (rep && rep.replicaDir) || dirItem;
          var items2 = [
            { label: '打开成片', disableIfMissing: true, action: function () { call('open_path', openFile); } },
            { label: '打开文件夹', disableIfMissing: true, action: function () { call('open_path', openDir); } }
          ];
          if (missingFile) items2.forEach(function (it) { if (it.disableIfMissing) it.disabled = true; it.title = '成片文件不存在'; });
          showMenu(e.clientX, e.clientY, items2);
        };
        call('find_replica_output', lpItem, videoNm).then(function (rep) {
          rep = rep || {};
          var openFile = rep.replicaFile || clipFile;
          call('check_exists', [openFile]).then(function (map) {
            map = map || {};
            smenu(map[openFile] === false, rep);
          }).catch(function () { smenu(false, rep); });
        }).catch(function () { smenu(false, null); });
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
  // ── 项目列表配置搜索下拉框（与日志搜索同款交互：弹出匹配项，点击直达配置） ──
  function closeProjDropdown() {
    var d = $('projDropdown');
    if (d) {
      if (typeof d.__outside === 'function') document.removeEventListener('mousedown', d.__outside);
      if (typeof d.__esc === 'function') document.removeEventListener('keydown', d.__esc);
      d.remove();
    }
  }
  function renderProjDropdown(items, q) {
    closeProjDropdown();
    var input = $('searchInput');
    if (!input) return;
    var rect = input.getBoundingClientRect();
    var d = document.createElement('div');
    d.id = 'projDropdown'; d.className = 'search-dropdown';
    if (!items || items.length === 0) {
      d.innerHTML = '<div class="search-dropdown__empty">未找到包含「' + escapeHtml(q) + '」的配置</div>';
    } else {
      var html = '';
      items.slice(0, 200).forEach(function (r) {
        html += '<div class="search-dropdown__item" data-project="' + escapeHtml(r.project) + '" data-name="' + escapeHtml(r.name) + '">';
        html += '<div class="search-dropdown__title">' + escapeHtml(r.name) + '</div>';
        html += '<div class="search-dropdown__meta">' + escapeHtml(r.project) + (r.latest ? ' / ' + escapeHtml(r.latest) : '') + '</div>';
        html += '</div>';
      });
      d.innerHTML = html;
    }
    document.body.appendChild(d);
    d.style.left = rect.left + 'px';
    d.style.top = (rect.bottom + 4) + 'px';
    d.style.width = Math.max(260, Math.min(rect.width, 420)) + 'px';
    d.querySelectorAll('.search-dropdown__item').forEach(function (it) {
      it.addEventListener('click', function () {
        var proj = it.getAttribute('data-project');
        var name = it.getAttribute('data-name');
        closeProjDropdown();
        // 清空搜索并展开/选中目标配置
        state.searchQuery = '';
        var inp = $('searchInput'); if (inp) inp.value = '';
        selectTxt(proj, name);
      });
    });
    setTimeout(function () {
      var outside = function (e) { if (!d.contains(e.target)) closeProjDropdown(); };
      var esc = function (e) { if (e.key === 'Escape') closeProjDropdown(); };
      d.__outside = outside; d.__esc = esc;
      document.addEventListener('mousedown', outside);
      document.addEventListener('keydown', esc);
    }, 0);
  }
  function onProjectSearchInput() {
    var input = $('searchInput');
    var q = input ? input.value.trim() : '';
    if (!q) {
      closeProjDropdown();
      state.searchQuery = ''; buildSidebar();
      return;
    }
    state.searchQuery = q;
    buildSidebar();
    // 本地遍历项目树收集匹配配置（复刻虚拟项目除外），点击下拉项直达配置
    var items = [];
    var k = q.toLowerCase();
    sortedProjects().forEach(function (proj) {
      if (proj.name === REPLICA_PROJECT) return;
      (proj.txts || []).forEach(function (txt) {
        var hits = String(txt.name || '').toLowerCase().indexOf(k) >= 0;
        if (!hits) return;
        if (items.length >= 200) return;
        items.push({ project: proj.name, name: txt.name, latest: txt.latest || '' });
      });
    });
    renderProjDropdown(items, q);
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
  // 右侧预览栏模式切换按钮组：配置模式显示「实时/原始」，日志模式显示「简化/原始」，与当前模式同步
  function syncRightToggle() {
    var isLog = state.mode === 'log';
    ['btnPreviewModified', 'btnPreviewRaw'].forEach(function (id) { var el = $(id); if (el) { el.style.display = isLog ? 'none' : ''; el.classList.toggle('preview-toggle--active', id === 'btnPreviewModified' ? !!state.rightPreview : !state.rightPreview); } });
    ['btnLogSimple', 'btnLogRaw'].forEach(function (id) { var el = $(id); if (el) { el.style.display = isLog ? '' : 'none'; el.classList.toggle('preview-toggle--active', id === 'btnLogSimple' ? state.logViewMode === 'simple' : state.logViewMode === 'raw'); } });
  }
  // 退出日志模式时恢复预览面板折叠（仅当进入日志前本就折叠）
  function restorePreviewFromLog() {
    if (!state._sideBeforeLog) return;
    state._sideBeforeLog = false;
    var rp1 = $('rightPanel');
    if (rp1) state.previewLastWidth = rp1.clientWidth || state.previewLastWidth;
    document.body.setAttribute('data-preview-collapsed', '');
    state.previewCollapsed = true;
    var rb1 = $('previewCollapseRound'); if (rb1) rb1.setAttribute('title', '展开预览面板');
  }
  // 强制折叠右侧预览面板（点击品牌名片复位时使用，回到启动态）
  function collapsePreviewPanel() {
    var rp = $('rightPanel');
    if (rp) state.previewLastWidth = rp.clientWidth || state.previewLastWidth;
    document.body.setAttribute('data-preview-collapsed', '');
    state.previewCollapsed = true;
    state._sideBeforeLog = false;
    var rb = $('previewCollapseRound'); if (rb) rb.setAttribute('title', '展开预览面板');
  }
  function buildRightPanel() {
    var lineNumbers = $('rightLineNumbers');
    var code = $('rightCode');
    var subtitle = $('rightPanelSubtitle');
    syncRightToggle();
    // 进入日志模式自动展开右侧预览面板；退出日志模式恢复到进入前状态
    if (state.mode === 'log') {
      if (document.body.hasAttribute('data-preview-collapsed')) {
        state._sideBeforeLog = true;
        var rp0 = $('rightPanel');
        document.body.removeAttribute('data-preview-collapsed');
        if (rp0) { rp0.style.display = ''; rp0.style.width = Math.max(240, state.previewLastWidth || 320) + 'px'; }
        state.previewCollapsed = false;
        var rb0 = $('previewCollapseRound'); if (rb0) rb0.setAttribute('title', '折叠预览面板');
      }
    } else if (state._sideBeforeLog) {
      restorePreviewFromLog();
    }
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
    syncRightToggle();
    var simple = state.logViewMode === 'simple';
    if (nums) nums.style.display = simple ? 'none' : ''; // 简化模式不显示行号
    var content = $('rightPanelContent');
    if (content) content.classList.toggle('log-simple', simple); // 简化模式：成片块间分隔
    var logPath = state.activeLogPath || (files[0] && files[0].path) || state.activeVersion.path;
    subtitle.textContent = '日志:"' + relToProject(logPath) + '"';
    subtitle.title = subtitle.textContent;
    if (files.length === 0) { nums.innerHTML = ''; code.innerHTML = '<div style="padding:8px 12px;color:var(--text-tertiary)">暂无日志文件</div>'; return; }
    var numHtml = ''; var codeHtml = ''; var row = 0;
    var inBlock = false; // 简化模式：当前是否处于成片块容器内
    files.forEach(function (f) {
      f.lines.forEach(function (line, li) {
        row++;
        numHtml += '<span class="right-panel__line-num" data-row="' + row + '">' + row + '</span>';
        var t = line == null ? '' : line;
        var tt = String(t).trim();
        // 简化模式：去掉原始 txt 自带的分割线行（==== / ---- 等）
        if (state.logViewMode === 'simple' && /^[\-=_—\.\*]{2,}$/.test(tt)) return;
        var cls = 'right-panel__code-line';
        // 成片名行："使用片段列表："的上一行（该行下方紧跟"使用片段列表："）
        var isVideoHeader = li + 1 < f.lines.length && f.lines[li + 1] != null && String(f.lines[li + 1]).trim() === '使用片段列表：';
        if (state.logViewMode === 'simple' && /[\\/]/.test(tt)) t = tt.split(/[\\/]+/).pop(); // 简化模式：路径仅保留最后一段文件名（带后缀）
        if (state.logViewMode === 'simple' && isVideoHeader) {
          if (inBlock) codeHtml += '</div>'; // 闭合上一个成片块
          codeHtml += '<div class="log-block" data-start="' + row + '">';
          inBlock = true;
        }
        if (isVideoHeader) cls += ' code-line--log-video';
        else if (tt === '') cls += ' code-line--empty';
        else cls += ' code-line--path';
        codeHtml += '<span class="' + cls + '" data-row="' + row + '">' + escapeHtml(t === '' ? ' ' : t) + '</span>';
      });
    });
    if (inBlock) codeHtml += '</div>';
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
  // 高亮整个成片块：从成片名行（"使用片段列表："上一行）到块内末尾水印png行；
  // 跳过分隔线/空行；仅高亮行号列，不高亮文字
  function highlightLogBlock(line, video, logPath) {
    var d = state.logContent;
    if (!d) return;
    var entries = d.entries || [];
    var files = d.files || [];
    var l = Number(line);
    if (!l || l < 1) return;
    var idx = -1;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].video === video && (entries[i].logPath === logPath || normalizePath(entries[i].logPath) === normalizePath(logPath))) { idx = i; break; }
    }
    if (idx < 0) { for (var j = 0; j < entries.length; j++) { if (entries[j].video === video) { idx = j; break; } } }
    var startRow = l - 1; // 成片名行
    var endRow = idx >= 0 && entries[idx + 1] ? Number(entries[idx + 1].lineStart) - 2 : null;
    // 行号 → 行内容（不含后端行尾截断误差）
    function rowText(r) {
      var acc = 1;
      for (var k = 0; k < files.length; k++) {
        if (r >= acc && r < acc + files[k].lines.length) return files[k].lines[r - acc] == null ? '' : String(files[k].lines[r - acc]);
        acc += files[k].lines.length;
      }
      return '';
    }
    // 最后一个成片块无 next：以所属文件末行为终点
    if (endRow == null) {
      var run = 1;
      for (var fi = 0; fi < files.length; fi++) {
        if (l >= run && l < run + files[fi].lines.length) { endRow = run + files[fi].lines.length - 1; break; }
        run += files[fi].lines.length;
      }
    }
    if (!endRow || endRow < startRow) endRow = startRow;
    // 排除分割线行（纯分隔符行）；空行保持高亮，使成片块在两个分隔线之间完整覆盖
    var skip = {};
    for (var r2 = startRow; r2 <= endRow; r2++) {
      var t2 = rowText(r2).trim();
      if (t2 !== '' && /^[\-=_—\.\*]{2,}$/.test(t2)) skip[r2] = true;
    }
    scrollLogRightTo(startRow, endRow, skip);
  }
  function scrollLogRightTo(line, endLine, skipRows) {
    var content = $('rightPanelContent');
    if (!content) return;
    var n = Number(line);
    if (!n || n < 1) return;
    var end = Number(endLine);
    if (!end || end < n) end = n;
    content.querySelectorAll('.right-panel__line-num.log-target, .right-panel__code-line.log-target, .log-block--active').forEach(function (el) { el.classList.remove('log-target', 'log-block--active'); });
    if (state.logViewMode === 'simple') {
      // 简化模式：以成片块为高亮单元（圆角金边浅蓝方块）
      content.querySelectorAll('.log-block').forEach(function (blk) {
        var s = Number(blk.getAttribute('data-start'));
        var sp = blk.querySelectorAll('.right-panel__code-line');
        var en = sp.length ? Number(sp[sp.length - 1].getAttribute('data-row')) : s;
        if (s <= end && en >= n) blk.classList.add('log-block--active');
      });
    } else {
      var skip = skipRows || {};
      for (var r = n; r <= end; r++) {
        if (skip[r]) continue;
        var num = content.querySelector('.right-panel__line-num[data-row="' + r + '"]');
        if (num) num.classList.add('log-target'); // 原始模式：仅高亮行号列
      }
    }
    // 高亮块提至首行：按 DOM 实际位置滚动到预览顶部（行高估算会因简化模式成片块的
    // 内边距/间距随前置块数量累计漂移，导致高亮块逐渐下移）
    var lineEl = content.querySelector('.right-panel__code-line[data-row="' + n + '"]');
    if (lineEl) {
      var rEl = lineEl.getBoundingClientRect();
      var rC = content.getBoundingClientRect();
      content.scrollTop = Math.max(0, rEl.top - rC.top + content.scrollTop - 8);
    } else {
      var lineHeight = 18;
      var targetTop = 8 + (n - 1) * lineHeight;
      content.scrollTop = Math.max(0, targetTop - 8);
    }
  }
  function setStatus(msg) { var el = $('statusLeft'); if (!el) return; el.classList.remove('status-bar__success'); el.textContent = msg; }
  function setStatusDone(msg) { var el = $('statusLeft'); if (!el) return; el.classList.add('status-bar__success'); el.textContent = msg; }

  // 载入遮罩：工作路径扫描时提示用户
  function showBusy(text) { var o = $('busyOverlay'); if (!o) return; var p = $('busyProgress'); if (p) p.style.display = 'none'; var mb = $('busyMinBtn'); if (mb) mb.style.display = 'none'; var cb = $('busyCancelBtn'); if (cb) cb.style.display = 'none'; $('busyText').textContent = text || '正在检测…'; o.style.display = 'flex'; }
  function hideBusy() { var o = $('busyOverlay'); if (o) o.style.display = 'none'; var mb = $('busyMinBtn'); if (mb) mb.style.display = 'none'; var cb = $('busyCancelBtn'); if (cb) cb.style.display = 'none'; }
  // 设置窗口开/关时的主窗口模糊遮罩
  function showSettingsDim() { var o = $('settingsDim'); if (o) { hideBusy(); o.style.display = 'block'; } }
  function hideSettingsDim() { var o = $('settingsDim'); if (o) o.style.display = 'none'; }
  // 带进度条的等待窗口：重置预检测全量检测期间使用；提供「缩到后台」入口
  function showBusyProgress(text) {
    var o = $('busyOverlay'); if (!o) return;
    $('busyText').textContent = text || '正在检测…';
    var fill = $('busyProgressFill'), pt = $('busyProgressText'), p = $('busyProgress');
    if (p) p.style.display = 'flex';
    if (fill) fill.style.width = '0%';
    if (pt) pt.textContent = '正在收集视频…';
    var mb = $('busyMinBtn'); if (mb) mb.style.display = '';
    var cb = $('busyCancelBtn'); if (cb) cb.style.display = '';
    o.style.display = 'flex';
  }
  // 预检测后台化：遮罩「缩到后台」后，进度转入状态栏右侧 probe-mini（排版配色参考更新条）
  function hideProbeMini() {
    state.precheckBackground = false;
    var el = $('probeMini'); if (el) el.style.display = 'none';
    var fl = $('probeMiniFill'); if (fl) fl.style.width = '0%';
  }
  function showProbeMini() {
    var el = $('probeMini'); if (!el) return;
    var lb = $('probeMiniLabel'); if (lb) lb.textContent = '预检测 0/0';
    var fl = $('probeMiniFill'); if (fl) fl.style.width = '0%';
    el.style.display = '';
  }
  function updateProbeMini(s) {
    var el = $('probeMini'); if (!el || el.style.display === 'none') return;
    var total = (s && s.total) || 0, done = (s && s.done) || 0;
    var pct = total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0;
    var lb = $('probeMiniLabel'); if (lb) lb.textContent = '预检测 ' + done + '/' + total;
    var fl = $('probeMiniFill'); if (fl) fl.style.width = pct + '%';
    if (s && s.finished) {
      hideProbeMini();
      setStatus(s.cancelled ? '后台预检测已取消（已保存 ' + done + ' 个探测结果）' : '后台预检测完成：共检测 ' + total + ' 个视频');
    }
  }
  function enterProbeBackground() {
    if (state.precheckBackground) return;
    if (!state._probeActive) { setStatus('当前没有进行中的预检测'); return; }
    state.precheckBackground = true;
    hideBusy();
    showProbeMini();
    setStatus('预检测已转入后台，请在右下角查看进度');
  }
  // 取消预检测：二次确认后终止当前探测（已检测结果保留，物理缓存按原子替换策略处理）
  function cancelProbeFlow() {
    if (!state._probeActive) { setStatus('当前没有进行中的预检测'); return; }
    showDialog({
      title: '取消预检测',
      message: '确定要取消当前预检测吗？已检测到的结果会保留，未完成的部分不会写入缓存。',
      buttons: [ { label: '继续检测', value: false, primary: true }, { label: '取消预检测', value: true, danger: true } ]
    }).then(function (ok) {
      if (!ok) return;
      setStatus('正在取消预检测…');
      call('cancel_precheck');
    });
  }
  function onResetProgress(s) {
    if (!s) return;
    if (state.precheckBackground) { updateProbeMini(s); return; }
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
    var cleanup = function () { state._probeActive = false; if (dismiss) { try { dismiss(); } catch (e) {} dismiss = null; } };
    state._probeActive = true;
    state.precheckBackground = false;
    call('reset_precheck').then(function (r) {
      if (state.precheckBackground) hideProbeMini(); else hideBusy();
      cleanup();
      setStatus('预检测已重置：共检测 ' + (r && r.total || 0) + ' 个视频，合规 ' + (r && r.valid || 0) + ' 个' + ((r && r.cancelled) ? '（已中断）' : ''));
      if (state.activeTxt && state.activeVersion) runPrecheck();
    }).catch(function (e) {
      hideBusy();
      cleanup();
      hideProbeMini();
      setStatus('重置预检测失败：' + e.message);
    });
  }
  function resetPrecheckFlow() {
    showDialog({
      title: '重置预检测',
      message: '将重置预检测物理缓存，并对所有配置指向的路径重新预检测（重复文件自动跳过）。视频数量较多时可能耗时较长，是否继续？',
      buttons: [ { label: '取消', value: null }, { label: '确认重置', value: 1, danger: true } ]
    }).then(function (v) {
      if (!v) { setStatus('已取消重置预检测'); return; }
      showBusyProgress('正在重置预检测缓存并全量检测，请耐心等待…');
      resetPrecheckAll();
    });
  }
  // 刷新预缓存菜单：点击后弹窗二选一；「全部重置」走原流程（内部仍保留二次确认）
  function refreshPrecacheMenu() {
    showDialog({
      title: '刷新预缓存',
      message: '仅刷新：更新缺失或已变化的视频，不重置缓存；\n全部重置：清空缓存后重新检测（视频较多时较耗时）。',
      buttons: [
        { label: '仅刷新', value: 'refresh', primary: true },
        { label: '全部重置', value: 'reset', danger: true }
      ]
    }).then(function (v) {
      if (!v) { setStatus('已取消刷新预缓存'); return; }
      if (v === 'refresh') refreshPrecacheFlow();
      else resetPrecheckFlow(); // 内部含「确认重置」二次确认
    });
  }
  // 仅刷新预缓存：不删缓存、不重置，只对缺失/变化的视频增量更新（进度与取消/缩后台同「重置预检测」）
  function refreshPrecacheFlow() {
    var dismiss = null;
    var api = getApi();
    if (api && typeof api.on_reset_progress === 'function') {
      try { dismiss = api.on_reset_progress(onResetProgress); } catch (e) { dismiss = null; }
    }
    var cleanup = function () { state._probeActive = false; if (dismiss) { try { dismiss(); } catch (e) {} dismiss = null; } };
    state._probeActive = true;
    state.precheckBackground = false;
    showBusyProgress('正在刷新预缓存（增量更新，不重置）…');
    call('refresh_precache').then(function (r) {
      if (state.precheckBackground) hideProbeMini(); else hideBusy();
      cleanup();
      setStatus('预缓存已刷新：更新 ' + ((r && r.updated) || 0) + ' / ' + ((r && r.total) || 0) + ' 个视频' + ((r && r.cancelled) ? '（已中断）' : ''));
      if (state.activeTxt && state.activeVersion) runPrecheck();
    }).catch(function (e) {
      hideBusy();
      cleanup();
      hideProbeMini();
      setStatus('刷新预缓存失败：' + e.message);
    });
  }
  // 刷新配置列表：先扫描历史遗留的重复外部 * 配置（与成片正本内容一致的副本），
  // 确认后物理删除再刷新列表；无重复则直接刷新
  function refreshConfigsFlow() {
    // 刷新会重拉列表并重载当前配置：未保存修改先弹窗确认
    checkConfigModifiedBeforeLeave(function () {
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
        buttons: [ { label: '取消', value: null }, { label: '删除并刷新', value: 1, danger: true } ]
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
    });
  }

  // ── 皮肤切换 ──
  // 皮肤列表按下拉名拼音升序：白蓝 < 黑橙
  var SKINS = [
    { id: 'white_blue', label: '白蓝', bg: '#F5F5F5', theme: '#4B3FE3' },
    { id: 'Black_Orange', label: '黑橙', bg: '#111113', theme: '#FF6600' },
    { id: 'Maid_Atelier', label: '深海女仆', bg: '#0e1d49', theme: '#c5a468' }
  ];
  function applySkin(id, persist) {
    var target = SKINS.some(function (s) { return s.id === id; }) ? id : SKINS[0].id;
    document.documentElement.setAttribute('data-skin', target);
    // 皮肤行为层热切换：先 dispose 上一皮肤装饰，再 apply 当前皮肤行为（若有）
    if (window.VL_SkinRuntime) window.VL_SkinRuntime.sync(target);
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

  // 扫描/重建环节 → 中文提示（后端 listProjects/索引重建按环节上报，前端一一对应显示）
  var SCAN_PHASE_TEXT = {
    clear: '清空缓存', walk: '扫描配置', log: '收集日志', list: '汇总项目',
    clip: '重建成片索引', mark: '统计水印归属', done: '检测完成'
  };
  function refreshData(force, busyText, done, skipReflow) {
    var dismissScan = null;
    if (busyText) {
      showBusy(busyText);
      var api0 = getApi();
      if (api0 && typeof api0.on_scan_progress === 'function') {
        try {
          dismissScan = api0.on_scan_progress(function (p) {
            var o = $('busyOverlay'), bt = $('busyText');
            if (!o || o.style.display === 'none' || !bt) return;
            var label = (p && SCAN_PHASE_TEXT[p.phase]) ? SCAN_PHASE_TEXT[p.phase] : '';
            if (label) {
              if (p.phase === 'clip' && p.total > 0) label += ' ' + p.done + '/' + p.total;
              bt.textContent = busyText + '（' + label + '）';
            }
          });
        } catch (e) { dismissScan = null; }
      }
    }
    call('list_projects', force).then(function (projects) {
      state.projects = projects || []; buildSidebar(false, true);
      // 刷新后始终校验当前选中配置是否仍存在：已删/迁移则清空重建视图，仍存在则重拉版本重建日期分支
      if (state.activeProject && state.activeTxt) {
        var foundProj = state.projects.find(function (p) { return p.name === state.activeProject; });
        var foundTxt = foundProj && foundProj.txts.find(function (t) { return t.name === state.activeTxt; });
        if (!foundTxt) { state.activeProject = null; state.activeTxt = null; state.versions = []; state.activeVersion = null; state.configData = null; buildDateBranches(); buildCenterBottom(); buildRightPanel(); setStatus('就绪'); }
        else selectTxt(state.activeProject, state.activeTxt, true, true);
      }
      if (busyText) hideBusy();
      if (dismissScan) { try { dismissScan(); } catch (e) {} dismissScan = null; }
      if (done) done();
    }).catch(function (e) { setStatus('数据加载失败：' + e.message); if (busyText) hideBusy(); if (dismissScan) { try { dismissScan(); } catch (e) {} dismissScan = null; } });
  }
  function selectTxt(project, name, keepVersion, silent) {
    function doSelect() {
      state.activeLogDate = null;
      // 本次是否为"已选中后再次切换"（决定重建配置页时是否静止，参考徽章 --static）
      var switchingTxt = !!state.activeTxt;
      // 复刻虚拟项目：仅含日志无配置，点击直接进入日志视图
      if (project === REPLICA_PROJECT) {
        state.activeProject = project; state.activeTxt = name;
        state.versions = [{ label: '全部日志', path: REPLICA_MARK + name, is_latest: true }];
        state.activeVersion = state.versions[0];
        state.activeLogDate = null; state.activeLogPath = null; state.logFiles = [];
        state.configData = null; state.logContent = null;
        state.mode = 'log';
        var ml = $('modeLog'), mf = $('modeFilelist');
        if (ml) ml.classList.add('mode-toggle--active');
        if (mf) mf.classList.remove('mode-toggle--active');
        state.expandedProject = project;
        buildSidebar(false, true);
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
        if (pruneEmptyTxt(project, name, state.versions)) return;
        syncTxtCount(project, name, state.versions);
        buildSidebar(false, true);
        // 点击配置＝用户交互：重建动画中则动画结束再判定，无动画直接判定
        var azB3 = $('azIndexBar');
        if (azB3 && azB3.classList.contains('az-bar--enter')) _azPending = true;
        else syncAzHighlight();
        buildDateBranches(switchingTxt);
        if (state.activeVersion) loadConfig(state.activeVersion.path, switchingTxt);
        else { state.configData = null; buildCenterBottom(); buildRightPanel(); setStatus('该配置无可用版本'); }
      }).catch(function (e) { setStatus('加载版本失败：' + e.message); });
    }
    // 用户主动切换配置：配置未保存时先弹窗确认（覆盖当前配置 / 保存为当日配置 / 取消）
    if (silent) { doSelect(); return; }
    checkConfigModifiedBeforeLeave(doSelect);
  }
  // 用最新版本列表同步侧栏该配置徽章：计数 + 最新日期（日期分支实时刷新时徽章跟随）
  function syncTxtCount(project, name, versions) {
    var p = (state.projects || []).find(function (x) { return x.name === project; });
    if (!p) return;
    var t = p.txts.find(function (x) { return x.name === name; });
    if (!t) return;
    var vs = versions || [];
    t.count = vs.length;
    t.latest = vs.length ? String(vs[0].label || '') : '';
  }
  // 配置全部版本已删除/迁移：从侧栏移除该配置项，避免遗留"0 版本"空壳；若为当前选中配置则一并复位视图
  function pruneEmptyTxt(project, name, versions) {
    if ((versions || []).length > 0) return false;
    var p = (state.projects || []).find(function (x) { return x.name === project; });
    if (p) {
      var i = p.txts.findIndex(function (x) { return x.name === name; });
      if (i >= 0) p.txts.splice(i, 1);
    }
    buildSidebar(false, true);
    if (state.activeProject === project && state.activeTxt === name) {
      resetCenterToLaunch();
      setStatus('该配置已无可用版本，已从列表移除');
    }
    return true;
  }
  // ── 配置未保存离开（切换配置、切换项目、复位视图）检查：脏配置弹窗提示 ──
  // 回调在确认动作后执行；右上角 ✕ / 遮罩关闭视为取消（中止原动作、返回编辑页面）；
  // 三个按钮行为与配置栏同名按钮一致，「不保存」直接丢弃修改继续原动作。
  function checkConfigModifiedBeforeLeave(afterConfirm, onCancel) {
    // 日志模式为只读浏览：退出日志（折叠项目/品牌名片/复位视图）不弹未保存拦截，
    // 配置编辑状态仍保留在内存，切回配置模式后未保存标记照常显示、可继续保存
    if (state.mode === 'log') { afterConfirm(); return; }
    if (!state.configModified || !state.configData) { afterConfirm(); return; }
    showDialog({
      title: '配置已修改未保存',
      message: '当前配置已发生修改，丢失修改将无法恢复。',
      buttons: [
        { label: '覆盖当前配置', value: 'overwrite', cls: 'modal-btn--cfg-save' },
        { label: '保存为当日配置', value: 'today', cls: 'modal-btn--cfg-save-today' },
        { label: '不保存', value: 'discard', cls: 'modal-btn--cfg-discard' }
      ],
      // 宽弹窗保证按钮文字不换行
      cssClass: 'modal-card--wide'
    }).then(function (choice) {
      // ✕ / 遮罩关闭 = 取消：中止原动作，返回编辑页面
      if (choice == null) { if (onCancel) onCancel(); return; }
      // 不保存：丢弃修改，继续原动作
      if (choice === 'discard') { afterConfirm(); return; }
      // 复用配置栏同名按钮逻辑：覆盖当前配置（已确认，跳过覆盖确认二次弹窗）/ 保存为当日配置
      var go = choice === 'overwrite' ? function () { return saveConfig(true); } : (choice === 'today' ? saveConfigToday : null);
      if (!go) { afterConfirm(); return; }
      go().then(function (ok) {
        if (ok) afterConfirm();
        else if (onCancel) onCancel();
      });
    });
  }
  // 主进程关闭/退出前询问"配置是否有未保存修改"：无修改立即放行；有修改弹三按钮，处理后再回传
  function handleDiscardConfigRequest() {
    var respond = function (action) { var ap = getApi(); if (ap && ap.respond_discard_config) ap.respond_discard_config(action); };
    if (!state.configModified || !state.configData) { respond('ok'); return; }
    checkConfigModifiedBeforeLeave(function () { respond('ok'); }, function () { respond('cancel'); });
  }
  // ── 配置自愈统一入口：静默重取当前选中配置，保持日期分支/徽章/侧栏与磁盘一致 ──
  // 触发源：① 主进程广播 versions_changed（软件内保存/清理配置，后端已清缓存，重取即最新）
  //         ② 定时轮询（外部删除/任务迁移等改盘动作，靠 listVersions 目录指纹自动失效重扫）
  // 归一比较无变化时不重渲染，避免打断编辑与日志跟随；有变化才同步视图。
  function refreshActiveVersions() {
    if (!getApi()) return;
    if (!state.activeProject || !state.activeTxt || state.activeProject === REPLICA_PROJECT) return; // 复刻为虚拟项目，不走配置自愈
    call('list_projects', false).then(function (projects) {
      state.projects = projects || [];
      var foundProj = state.projects.find(function (p) { return p.name === state.activeProject; });
      var foundTxt = foundProj && foundProj.txts.find(function (t) { return t.name === state.activeTxt; });
      if (!foundTxt) { // 当前配置已被整体删除/迁移：即时复位视图，无需等手动刷新
        state.activeProject = null; state.activeTxt = null;
        resetCenterToLaunch();
        return;
      }
      var keepLabel = state.activeVersion ? state.activeVersion.label : null;
      call('list_versions', state.activeProject, state.activeTxt).then(function (versions) {
        var vs = versions || [];
        var cur = state.versions || [];
        var same = vs.length === cur.length && vs.every(function (v, i) {
          var c = cur[i];
          return c && v.label === c.label && v.path === c.path && !!v.hasLog === !!c.hasLog;
        });
        if (same) return;
        state.versions = vs; state.activeVersion = null;
        if (vs.length > 0) {
          var target = keepLabel ? vs.find(function (v) { return v.label === keepLabel; }) : null;
          state.activeVersion = target || vs[0];
        }
        if (pruneEmptyTxt(state.activeProject, state.activeTxt, vs)) return;
        syncTxtCount(state.activeProject, state.activeTxt, vs);
        buildSidebar(false, true);
        buildDateBranches();
        if (state.activeVersion) {
          // 当前选中版本路径变化（迁移/另存/已被删则回退最新）才重载配置；路径未变保持编辑状态不打断
          if (!state.configData || state.configData.path !== state.activeVersion.path) loadConfig(state.activeVersion.path, true);
        } else { state.configData = null; buildCenterBottom(); buildRightPanel(); setStatus('该配置无可用版本'); }
      }).catch(function () {});
    }).catch(function () {});
  }
  function selectVersion(label) {
    var v = state.versions.find(function (x) { return x.label === label; });
    if (!v) return;
    var switching = !!state.activeVersion;
    // 切换日期分支会重载配置：未保存修改先弹窗确认
    checkConfigModifiedBeforeLeave(function () {
      state.activeVersion = v; buildDateBranches(switching); loadConfig(v.path, true);
    });
  }
  function loadConfig(path, silent) {
    state.logContent = null;
    call('read_config', path).then(function (data) {
      state.configData = data;
      state._configOrig = null; // 新配置加载：重建修改基线
      buildCenterBottom(silent); buildRightPanel();
      setStatus('已选择:"' + (state.activeVersion && state.activeVersion.path || path) + '"');
    }).catch(function (e) { setStatus('读取配置失败：' + e.message); });
  }
  // ── 中间配置栏复位到"刚启动"样式 ──
  // 触发点：点击侧栏品牌名片、或选中配置后收回项目名；无选中时调用为无害空操作。
  function resetCenterToLaunch() {
    state.activeProject = null; state.activeTxt = null;
    state.versions = []; state.activeVersion = null; state.configData = null;
    state.logContent = null; state.logFiles = []; state.logSearchQuery = '';
    state.activeLogDate = null; state.activeLogPath = null;
    state.selectMode = false; state.selectedLogPaths = {};
    state.mode = 'filelist';
    state._configOrig = null; state._configOrigSnapshot = null;
    state._logBranchToken = null;
    var bar = $('configBar'); if (bar) bar.innerHTML = '';
    var act = $('sidebarTree').querySelector('.tree-txt-item--active');
    if (act) act.classList.remove('tree-txt-item--active');
    // 收回项目/品牌名片视为退出日志模式：进入日志时若折叠，此处恢复折叠
    restorePreviewFromLog();
    buildDateBranches(); buildCenterBottom(); buildRightPanel();
    setStatus('就绪');
  }
  function bindStaticEvents() {
    // 预检测后台化：遮罩「缩到后台」与状态栏取消按钮
    var busyMin = $('busyMinBtn'), probeCancel = $('probeMiniCancel');
    if (busyMin) busyMin.addEventListener('click', enterProbeBackground);
    var busyCancel = $('busyCancelBtn');
    if (busyCancel) busyCancel.addEventListener('click', cancelProbeFlow);
    if (probeCancel) probeCancel.addEventListener('click', function () { setStatus('正在取消后台预检测…'); call('cancel_precheck'); });
    document.addEventListener('vl:reset-center', function () { collapsePreviewPanel(); checkConfigModifiedBeforeLeave(resetCenterToLaunch); });
    $('sidebarTree').addEventListener('scroll', syncAzHighlight);
    // 右键项目名：主流水印设置（复刻虚拟项目无配置水印，不提供）
    $('sidebarTree').addEventListener('contextmenu', function (e) {
      var ph = e.target.closest('.tree-project__name');
      if (!ph) return;
      var pname = ph.getAttribute('data-project');
      if (!pname || pname === REPLICA_PROJECT) return;
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [{ label: '主流水印设置', action: function () { openProjectWatermarkDialog(pname); } }]);
    });
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
          if (bdgFold) {
            // 摘除切换配置时加的 --static（animation:none 特异性高于 --leave 的滑出动画），
            // 让收回时的 az-badge-out 滑出动画正常播放
            bdgFold.classList.remove('tree-project__badge--static');
            bdgFold.classList.add('tree-project__badge--leave');
          }
          if (azBar) azBar.classList.remove('is-show');
          state.expandedProject = null;
          var itemWrap = $('sidebarTree').querySelector('.tree-project__items');
          if (itemWrap) itemWrap.classList.add('tree-project__items--leaving');
          // 收回项目名时若已选中配置：中间配置栏复位到刚启动样式（未保存修改先弹窗确认）
          checkConfigModifiedBeforeLeave(function () {
            if (state.activeTxt) resetCenterToLaunch();
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
          });
          return;
        }
        // 展开/切换：若有原展开项目，先播原项目收回（去底色）+ 配置区渐隐，随即重建展开新项目
        state.expandedProject = pname;
        var oldHeader = $('sidebarTree').querySelector('.tree-project__name.is-filled');
        var oldWrap = $('sidebarTree').querySelector('.tree-project__items');
        if (oldHeader) {
          oldHeader.classList.remove('is-filled');
          var bdgOld = oldHeader.querySelector('.tree-project__badge');
          if (bdgOld) {
            // 与折叠分支一致：先摘除 --static 再播 --leave 收回动画
            bdgOld.classList.remove('tree-project__badge--static');
            bdgOld.classList.add('tree-project__badge--leave');
          }
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
    $('dateBranches').addEventListener('click', function (e) { var btn = e.target.closest('.date-branch-btn'); if (!btn) return; if (btn.getAttribute('data-date') != null) { var switching = state.activeLogPath != null; state.activeLogDate = btn.getAttribute('data-date'); state.activeLogPath = btn.getAttribute('data-file') || null; buildDateBranches(switching); buildCenterBottom(); return; } selectVersion(btn.getAttribute('data-label')); });
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
    $('searchInput').addEventListener('input', onProjectSearchInput);
    $('logSearchInput').addEventListener('input', function () { state.logSearchQuery = this.value.trim(); if (state.mode === 'log') buildCenterBottom(); onLogSearchInput(); });
    // ── 左下角菜单按钮：刷新配置列表 / 选择路径 / 重置预检测缓存 / 设置 ──
    var menuBtn = $('sidebarMenuBtn');
    var menu = $('sidebarMenu');
    // ── 跳转至列表顶端按钮：平滑滚动到顶部（不打断展开状态） ──
    var toTopBtn = $('sidebarToTop');
    if (toTopBtn) toTopBtn.addEventListener('click', function () {
      var tree = $('sidebarTree');
      if (!tree) return;
      tree.scrollTo({ top: 0, behavior: 'smooth' });
    });
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
      // 「刷新预缓存」点击弹窗二选一：仅刷新（增量）/ 全部重置（原功能）
      var lmrp = $('menuResetPrecheck');
      if (lmrp) lmrp.addEventListener('click', function () { closeMenu(); refreshPrecacheMenu(); });
      $('menuSettings').addEventListener('click', function () { closeMenu(); call('open_settings_window').catch(function () { setStatus('打开设置窗口失败'); }); });
    }
    $('btnOpenTasks').addEventListener('click', function () { call('open_task_window').catch(function () { setStatus('打开任务窗口失败'); }); });
    $('btnPreviewRaw').addEventListener('click', function () { state.rightPreview = false; $('btnPreviewRaw').classList.add('preview-toggle--active'); $('btnPreviewModified').classList.remove('preview-toggle--active'); buildRightPanel(); });
    $('btnPreviewModified').addEventListener('click', function () { state.rightPreview = true; $('btnPreviewModified').classList.add('preview-toggle--active'); $('btnPreviewRaw').classList.remove('preview-toggle--active'); buildRightPanel(); });
    $('btnLogSimple').addEventListener('click', function () { state.logViewMode = 'simple'; syncRightToggle(); renderLogRightPanel(); });
    $('btnLogRaw').addEventListener('click', function () { state.logViewMode = 'raw'; syncRightToggle(); renderLogRightPanel(); });
    $('btnExternalEdit').addEventListener('click', function () { if (!state.activeVersion) return flashNeedSelect(); var p = state.activeVersion.path; if (String(p).indexOf(REPLICA_MARK) === 0) { var lf = state.logFiles || []; var cur = null; if (state.activeLogPath) cur = lf.find(function (f) { return f.path === state.activeLogPath; }); if (!cur && state.activeLogDate) cur = lf.find(function (f) { return f.date === state.activeLogDate; }); if (!cur && lf.length) cur = lf[lf.length - 1]; if (cur) p = cur.path; } call('external_edit', p); });
    var rz = $('sidebarResizeBtn');
    var sidebarEl = document.querySelector('.sidebar');
    if (rz && sidebarEl) {
      // 拖拽调宽交互只绑在按钮本体上；铆钉栏不可见、无功能（仅定位锚定）
      rz.addEventListener('mousedown', function (e) {
        e.preventDefault();
        var startX = e.clientX, startW = sidebarEl.clientWidth;
        function onMove(ev) { var w = Math.max(285, Math.min(520, startW + (ev.clientX - startX))); sidebarEl.style.width = w + 'px'; }
        function onUp() { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
        document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
      });
    }
    var rp = $('rightPanel');
    var resizerBar = $('previewResizer');
    var roundBtn = $('previewCollapseRound');
    if (rp && resizerBar) {
      // 右侧预览面板展开/折叠：默认折叠（body 标记 data-preview-collapsed，面板整体隐藏）
      if (state.previewCollapsed) document.body.setAttribute('data-preview-collapsed', '');
      // 折叠/展开动作（右上角圆形按钮入口）；尺寸栏为中间固定布局位，随面板宽度自然左移
      function togglePreviewCollapsed() {
        var isCollapsed = document.body.hasAttribute('data-preview-collapsed');
        if (isCollapsed) {
          // 展开：恢复记忆宽度
          document.body.removeAttribute('data-preview-collapsed');
          rp.style.display = '';
          var targetW = Math.max(240, state.previewLastWidth || 320);
          rp.style.width = targetW + 'px';
          state.previewCollapsed = false;
          if (roundBtn) roundBtn.setAttribute('title', '折叠预览面板');
        } else {
          // 折叠：记录当前宽度后隐藏
          state.previewLastWidth = rp.clientWidth || state.previewLastWidth;
          document.body.setAttribute('data-preview-collapsed', '');
          state.previewCollapsed = true;
          if (roundBtn) roundBtn.setAttribute('title', '展开预览面板');
        }
      }
      // 尺寸栏承载调宽：按住左右拖动调整预览宽度（仅展开态；折叠态由右上角圆形按钮控制）
      resizerBar.addEventListener('mousedown', function (e) {
        // 折叠态不响应拖拽（面板已隐藏）
        if (document.body.hasAttribute('data-preview-collapsed')) return;
        e.preventDefault();
        // 拖拽期间禁用面板 width 过渡：style.width 逐帧即时生效，避免 0.3s 过渡滞后
        rp.style.transition = 'none';
        var startX = e.clientX, startW = rp.clientWidth;
        function onVMove(ev) {
          var w = Math.max(240, Math.min(720, startW - (ev.clientX - startX)));
          rp.style.width = w + 'px'; state.previewLastWidth = w;
        }
        function onVUp() {
          document.removeEventListener('mousemove', onVMove);
          document.removeEventListener('mouseup', onVUp);
          rp.style.transition = ''; // 恢复宽度过渡（展开/折叠动画仍生效）
        }
        document.addEventListener('mousemove', onVMove);
        document.addEventListener('mouseup', onVUp);
      });
      if (roundBtn) roundBtn.addEventListener('click', togglePreviewCollapsed);
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
    var cleanup = function () { state._probeActive = false; if (dismiss) { try { dismiss(); } catch (e) {} dismiss = null; } };
    state._probeActive = true;
    state.precheckBackground = false;
    showBusyProgress('正在根据新路径重置预检测…');
    call('reset_precheck').then(function (r) {
      if (state.precheckBackground) hideProbeMini(); else hideBusy();
      cleanup();
      setStatusDone('重新检测完成：共检测 ' + ((r && r.total) || 0) + ' 个视频，合规 ' + ((r && r.valid) || 0) + ' 个' + ((r && r.cancelled) ? '（已中断）' : ''));
      if (state.activeTxt && state.activeVersion) runPrecheck();
    }).catch(function (e) {
      hideBusy();
      cleanup();
      hideProbeMini();
      setStatus('重置预检测失败：' + e.message);
    });
  }
  function flashNeedSelect() { setStatus('请先选择一个 TXT 和日期分支'); }
  // 关闭主窗口行为引导：弹窗选择 退出软件 / 最小化至系统托盘，左下角「不再提醒」复选框持久化
  var _closeAskShown = false;
  function showCloseBehaviorDialog(api0) {
    if (_closeAskShown) return;
    _closeAskShown = true;
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    var card = document.createElement('div');
    card.className = 'modal-card modal-card--close';
    card.innerHTML = '<button type="button" class="modal-close" title="关闭">✕</button>' +
      '<div class="modal__title">关闭主窗口</div>' +
      '<div class="modal__message">请选择关闭主窗口后的行为：</div>' +
      '<div class="modal__close-foot">' +
      '<label class="modal__close-remind"><input type="checkbox" id="closeRemindChk"><span>不再询问</span></label>' +
      '<div class="modal__actions">' +
      '<button type="button" class="modal-btn" id="cbCloseTray">最小化至系统托盘</button>' +
      '<button type="button" class="modal-btn modal-btn--danger" id="cbCloseExit">退出软件</button>' +
      '</div>' +
      '</div>';
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    var done = function (value) {
      var chk = document.getElementById('closeRemindChk');
      var remind = !!(chk && chk.checked);
      overlay.remove();
      _closeAskShown = false;
      if (api0 && api0.choose_close_behavior) api0.choose_close_behavior(value, remind).catch(function () {});
    };
    overlay.addEventListener('click', function (e) { if (e.target === overlay) done('tray'); });
    card.querySelector('.modal-close').addEventListener('click', function () { done('tray'); });
    card.querySelector('#cbCloseTray').addEventListener('click', function () { done('tray'); });
    card.querySelector('#cbCloseExit').addEventListener('click', function () { done('exit'); });
  }
  function bindCloseBehavior() {
    if (getApi().on_close_behavior_request) getApi().on_close_behavior_request(function () { showCloseBehaviorDialog(getApi()); });
  }
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
      // 下载进行中：提示条最小化到状态栏，任务按钮左侧显示文字与进度条；
      // 左下角状态栏同步更新，避免停留在「正在连接更新服务器」
      hideUpdateBanner();
      showUpdateMini(info);
      var p = Math.max(0, Math.min(100, (info && info.percent) || 0));
      var latest = (info && info.latest) || '';
      setStatus('正在下载更新' + (latest ? ' v' + latest : '') + ' ' + p + '%');
    });
    if (upd.on_update_status) upd.on_update_status(function (text) {
      // 连接/重试/校验等阶段状态同步到左下角状态栏
      if (text) setStatus(text);
    });
    if (upd.on_update_downloaded) upd.on_update_downloaded(function (info) {
      hideUpdateMini();
      showUpdateBanner(info, 'downloaded');
      setStatus('更新包下载完成');
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

  // 轻量 Markdown 渲染（标题 / 有序无序列表 / 表格 / 引用 / 行内链接与粗体 / 代码块 / 空行）
  function renderMdMd(text) {
    var esc = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
    function inline(s) {
      s = String(s == null ? '' : s).replace(/<img[^>]*>/gi, '');
      s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ''); // 剥离 markdown 图片语法（badge 图等）
      s = esc(s);
      s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      // [text](url)：仅文字非空才渲染链接；剥图残留的空 [](url) 直接移除不显示
      s = s.replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, function (m, txt, u) {
        if (!txt) return '';
        return '<a href="' + u + '">' + txt + '</a>';
      });
      // 尖括号裸链：< > 已转义为实体，需按实体匹配
      s = s.replace(/&lt;((?:https?:\/\/)[^>&\s]+)&gt;/g, '<a href="$1">$1</a>');
      return s;
    }
    var lines = String(text || '').split(/\r?\n/);
    var html = '', inList = false, inCode = false, inBlock = false;
    var flushList = function () { if (inList) { html += '</ul>'; inList = false; } };
    var flushBlock = function () { if (inBlock) { html += '</blockquote>'; inBlock = false; } };
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i];
      if (/^\s*```/.test(t)) { flushList(); flushBlock(); html += inCode ? '</pre>' : '<pre>'; inCode = !inCode; continue; }
      if (inCode) { html += esc(t) + '\n'; continue; }
      if (/^\s*\|/.test(t)) {
        var rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i++; }
        i--;
        flushList(); flushBlock();
        var header = rows[0].replace(/^\s*\|\s*/, '').replace(/\s*\|\s*$/, '').split(/\s*\|\s*/);
        var bodyStart = 1;
        if (rows[1] && /^\s*\|?\s*:?-{2,}/.test(rows[1])) bodyStart = 2;
        html += '<table><thead><tr><th>' + header.map(inline).join('</th><th>') + '</th></tr></thead><tbody>';
        for (var r = bodyStart; r < rows.length; r++) {
          var cells = rows[r].replace(/^\s*\|\s*/, '').replace(/\s*\|\s*$/, '').split(/\s*\|\s*/);
          html += '<tr><td>' + cells.map(inline).join('</td><td>') + '</td></tr>';
        }
        html += '</tbody></table>';
        continue;
      }
      var q = /^>\s?(.*)$/.exec(t);
      if (q) { flushList(); if (!inBlock) { html += '<blockquote>'; inBlock = true; } html += '<p>' + inline(q[1] || '') + '</p>'; continue; }
      if (inBlock) { flushBlock(); }
      var h = /^(#{1,6})\s+(.*)$/.exec(t);
      if (h) { flushList(); var lv = Math.min(h[1].length, 4); html += '<h' + lv + '>' + inline(h[2]) + '</h' + lv + '>'; continue; }
      var ul = /^\s*[-*]\s+(.*)$/.exec(t);
      if (ul) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(ul[1]) + '</li>'; continue; }
      flushList();
      if (/^\s*<(\/)?(div|br)[^>]*>\s*$/i.test(t)) { continue; }
      if (/^-{3,}\s*$/.test(t)) { flushList(); flushBlock(); html += '<hr>'; continue; }
      if (!t.trim()) { continue; } // 空行不输出，避免多余空隙
      var para = inline(t);
      if (para) html += '<p>' + para + '</p>';
    }
    flushList(); flushBlock();
    return html;
  }

  // 启动弹更新日志：仅版本更新后（或初次启动）首次弹出，之后不再打扰
  function showStartupChangelog() {
    call('get_changelog_popup').then(function (r) {
      if (r && r.ok && r.show && r.content) showChangelogPopup(r.content);
    }).catch(function () {});
  }

  // 更新日志弹窗：大卡片 + 可滚动正文，右上角圆X / 点击遮罩 / 底部按钮关闭
  function showChangelogPopup(content) {
    var old = document.getElementById('changelogModal');
    if (old) old.remove();
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'changelogModal';
    var card = document.createElement('div');
    card.className = 'modal-card changelog-card';
    card.innerHTML =
      '<button type="button" class="modal-close" title="关闭">✕</button>' +
      '<div class="changelog-card__body"></div>' +
      '<div class="changelog-card__actions"><button type="button" class="modal-btn modal-btn--primary">知道了</button></div>';
    var body = card.querySelector('.changelog-card__body');
    body.innerHTML = renderMdMd(content);
    var done = function () { overlay.remove(); };
    card.querySelector('.modal-close').addEventListener('click', done);
    card.querySelector('.modal-btn').addEventListener('click', done);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) done(); });
    overlay.appendChild(card);
    document.body.appendChild(overlay);
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
    // 启动弹更新日志（当前每次启动弹出以确认样式，后续改为更新后首次弹出）
    showStartupChangelog();
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
    bindCloseBehavior();
    if (getApi().on_task_update) getApi().on_task_update(updateTasksCount);
    // 配置自愈：软件内写配置（保存/清理）广播 → 即时静默刷新；外部删改/任务迁移 → 低频轮询兜底
    if (getApi().on_versions_changed) getApi().on_versions_changed(function () { refreshActiveVersions(); });
    setInterval(function () { refreshActiveVersions(); }, 4000);
    // 关闭/退出主窗口前：配置有未保存修改时弹三按钮确认（覆盖当前配置/保存为当日配置/取消）
    if (getApi().on_confirm_discard_config) getApi().on_confirm_discard_config(handleDiscardConfigRequest);
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
    // 文档内 http 链接统一用系统默认浏览器打开（更新日志弹窗等）
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href^="http"]') : null;
      if (!a) return;
      e.preventDefault();
      var ap = getApi();
      if (ap && ap.open_external) ap.open_external(a.getAttribute('href')).catch(function () {});
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
        if (miss.length) {
          mark.textContent = '缺少环境: ' + miss.join('、') + '（见 README 安装）';
          mark.className = 'status-bar__envwarn';
          mark.style.display = '';
        } else {
          mark.textContent = '';
          mark.style.display = 'none'; // 环境正常不显示相关内容
        }
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
