// -*- coding: utf-8 -*-
// 视频处理工具窗口（第 4 个模块的前端）
//
// 表单**由引擎侧的步骤 schema 自动渲染** —— 新增处理能力 = 引擎加一个步骤文件，
// 本页不用改（这正是把 schema 放进注册表的原因）。
//
// 两条约定：
//   · 不向用户展示执行顺序（顺序是固定的内部逻辑，展示只会增加理解负担）
//   · 未勾选的步骤参数置灰不可用，从视觉上表达"不参与本次处理"
(function () {
  'use strict';

  var api = window.txapi;
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function icon(name, size) { return window.VL_icon ? window.VL_icon(name, size) : ''; }
  function iconEl(name, size) { return '<i data-icon="' + name + '" data-size="' + (size || 14) + '"></i>'; }

  var state = {
    info: null,
    sel: {},        // stepId → 是否勾选
    values: {},     // stepId → { key: value }
    root: '',
    files: [],      // 显式选中的视频文件（优先于目录）
    recursive: true,
    taskId: '',
    unsub: null,
  };

  // ── 状态栏 ──
  function setStatus(text, kind) {
    var el = $('status');
    el.textContent = text || '';
    el.className = 'tl-status' + (kind ? ' tl-status--' + kind : '');
  }

  // ── 大窗确认（与主窗口 showDialog 同一套样式类；高风险动作才用它，不用气泡）──
  function showDialog(opts) {
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      var card = document.createElement('div');
      card.className = 'modal-card' + (opts.cssClass ? ' ' + opts.cssClass : '');
      var html = '<button type="button" class="modal-close" title="关闭">✕</button>'
        + '<div class="modal__title">' + esc(opts.title) + '</div>';
      if (opts.message) html += '<div class="modal__message">' + opts.message + '</div>';
      html += '<div class="modal__actions">';
      (opts.buttons || []).forEach(function (b) {
        var cls = 'modal-btn' + (b.danger ? ' modal-btn--danger' : '') + (b.primary ? ' modal-btn--primary' : '');
        html += '<button type="button" class="' + cls + '">' + (b.icon ? icon(b.icon, 14) : '') + esc(b.label) + '</button>';
      });
      html += '</div>';
      card.innerHTML = html;
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      var done = function (v) { overlay.remove(); resolve(v); };
      overlay.addEventListener('click', function (e) { if (e.target === overlay) done(null); });
      var closeBtn = card.querySelector('.modal-close');
      if (closeBtn) closeBtn.addEventListener('click', function () { done(null); });
      var btns = card.querySelectorAll('.modal-btn');
      (opts.buttons || []).forEach(function (b, i) {
        btns[i].addEventListener('click', function () { done(b.value); });
      });
    });
  }

  // ── 表单渲染 ──
  // 单个字段：标签 + 输入 + 说明**并排一行**（纵向空间优先给内容，不堆成上下两行）
  function paramField(stepId, sc) {
    var v = state.values[stepId][sc.key];
    var label = '<span class="tl-field__label">' + esc(sc.label || sc.key) + '</span>';
    var hint = sc.hint ? '<span class="tl-field__hint" title="' + esc(sc.hint) + '">' + esc(sc.hint) + '</span>' : '';
    var input = '';
    var type = String(sc.type || 'text');
    if (type === 'number') {
      input = '<input class="tl-num" type="number" data-step="' + stepId + '" data-key="' + sc.key + '" value="' + esc(v) + '"'
        + (sc.min != null ? ' min="' + sc.min + '"' : '') + (sc.max != null ? ' max="' + sc.max + '"' : '')
        + (sc.step != null ? ' step="' + sc.step + '"' : '') + '>';
    } else if (type === 'select') {
      var opts = (sc.options || []).map(function (o) {
        return '<option value="' + esc(o) + '"' + (String(o) === String(v) ? ' selected' : '') + '>' + esc(o) + '</option>';
      }).join('');
      input = '<select class="tl-sel" data-step="' + stepId + '" data-key="' + sc.key + '">' + opts + '</select>';
    } else if (type === 'bool') {
      input = '<input type="checkbox" data-step="' + stepId + '" data-key="' + sc.key + '" data-bool="1"' + (v ? ' checked' : '') + '>';
    } else if (type === 'file') {
      input = '<span class="tl-field__row">'
        + '<input class="tl-path" type="text" data-step="' + stepId + '" data-key="' + sc.key + '" value="' + esc(v) + '" placeholder="选择文件…">'
        + '<button type="button" class="tl-mini" data-pick="' + stepId + ':' + sc.key + '">' + iconEl('image', 14) + '选择</button>'
        + '</span>';
    } else {
      input = '<input class="tl-path" type="text" data-step="' + stepId + '" data-key="' + sc.key + '" value="' + esc(v) + '">';
    }
    return '<label class="tl-field">' + label + input + hint + '</label>';
  }

  // 步骤默认**不勾选且折叠**；勾选后自动展开（「勾选了再展开」）
  function stepNode(step) {
    var on = !!state.sel[step.id];
    var div = document.createElement('div');
    div.className = 'tl-step' + (on ? ' tl-step--on tl-step--open' : '');
    div.setAttribute('data-step-id', step.id);
    var params = (step.schema || []).map(function (sc) { return paramField(step.id, sc); }).join('');
    div.innerHTML = '<div class="tl-step__head">'
      + '<input type="checkbox" data-check="' + step.id + '"' + (on ? ' checked' : '') + '>'
      + '<span class="tl-step__arrow" data-fold="' + step.id + '" title="展开/收起参数">' + iconEl('chevron-right', 13) + '</span>'
      + '<span class="tl-step__title">' + esc(step.title || step.id) + '</span>'
      + (step.danger === 'lossy' ? '<span class="tl-step__flag">会丢内容</span>' : '')
      + '</div>'
      + '<div class="tl-params">' + (params || '<span class="tl-field__hint">无需参数（勾选即可生效）</span>') + '</div>';
    return div;
  }

  function renderSteps() {
    var host = $('stepGroups');
    host.innerHTML = '';
    (state.info.groups || []).forEach(function (g) {
      var box = document.createElement('div');
      box.className = 'tl-group tl-group--open';
      box.innerHTML = '<div class="tl-group__head">'
        + '<span class="tl-group__arrow">' + iconEl('chevron-right', 14) + '</span>'
        + '<span>' + esc(g.group) + '</span>'
        + '<span class="tl-group__count">' + g.steps.length + ' 项</span>'
        + '</div>';
      var body = document.createElement('div');
      body.className = 'tl-group__body';
      g.steps.forEach(function (s) { body.appendChild(stepNode(s)); });
      box.appendChild(body);
      box.querySelector('.tl-group__head').addEventListener('click', function () {
        box.classList.toggle('tl-group--open');
      });
      host.appendChild(box);
    });
    if (window.VL_hydrateIcons) window.VL_hydrateIcons(host);
  }

  // ── 参数收集与回填 ──
  // 勾选状态的**唯一入口**：点标题行与点复选框都走这里。
  // ★ 不能靠「派发不指定 bubbles 的 change 事件」—— 那种事件不冒泡，
  //   委托在容器上的 change 收不到，就会出现「勾上了但参数还是灰的」（实测踩到）。
  function setStepOn(sid, on) {
    state.sel[sid] = !!on;
    var node = $('stepGroups').querySelector('[data-step-id="' + sid + '"]');
    if (node) {
      node.classList.toggle('tl-step--on', !!on);
      // 勾选即展开、取消即收起 —— 参数区只在需要时出现
      node.classList.toggle('tl-step--open', !!on);
    }
    var cb = node && node.querySelector('input[data-check]');
    if (cb) cb.checked = !!on;
  }

  /** 手动展开/收起（不改勾选状态） */
  function toggleStepOpen(sid) {
    var node = $('stepGroups').querySelector('[data-step-id="' + sid + '"]');
    if (node) node.classList.toggle('tl-step--open');
  }

  function bindFormEvents() {
    var host = $('stepGroups');
    host.addEventListener('click', function (e) {
      // 折叠箭头：只展开/收起，不改勾选
      var arrow = e.target.closest('[data-fold]');
      if (arrow) { toggleStepOpen(arrow.getAttribute('data-fold')); return; }
      var head = e.target.closest('.tl-step__head');
      if (head) {
        // 点标题行（复选框以外的区域）= 切换勾选；点复选框本身由原生 change 处理
        var cb = head.querySelector('input[data-check]');
        if (e.target !== cb) setStepOn(cb.getAttribute('data-check'), !cb.checked);
        return;
      }
      var pick = e.target.closest('button[data-pick]');
      if (pick) {
        var parts = pick.getAttribute('data-pick').split(':');
        var input = host.querySelector('input[data-step="' + parts[0] + '"][data-key="' + parts[1] + '"]');
        if (!api || !api.pick_image) return;
        api.pick_image(input ? input.value : '').then(function (p) {
          if (p && input) { input.value = p; }
        }).catch(function () {});
      }
    });
    host.addEventListener('change', function (e) {
      var t = e.target;
      if (!t || !t.getAttribute) return;
      var sid = t.getAttribute('data-check');
      if (sid) { setStepOn(sid, !!t.checked); return; }
      var step = t.getAttribute('data-step');
      var key = t.getAttribute('data-key');
      if (!step || !key) return;
      state.values[step][key] = t.getAttribute('data-bool') ? !!t.checked : t.value;
    });
    host.addEventListener('input', function (e) {
      var t = e.target;
      if (!t || !t.getAttribute) return;
      var step = t.getAttribute('data-step');
      var key = t.getAttribute('data-key');
      if (step && key && !t.getAttribute('data-bool')) state.values[step][key] = t.value;
    });
  }

  // ── 输入 / 输出区 ──
  function renderInputHint() {
    var hint = $('inputHint');
    if (state.files.length) {
      hint.className = 'tl-hint';
      hint.textContent = '已选 ' + state.files.length + ' 个视频文件（按文件清单处理，不再按目录扫描）';
    } else if (state.root) {
      hint.className = 'tl-hint';
      hint.textContent = '将' + (state.recursive ? '递归' : '仅在本层') + '扫描该目录下的视频'
        + '（自动跳过应用自身的输出与备份目录）';
    } else {
      hint.className = 'tl-hint';
      hint.textContent = '请选择目录，或直接选择若干视频文件';
    }
  }

  function syncOutputRows() {
    var dirMode = $('outMode').value === 'directory';
    $('outDirRow').classList.toggle('tl-out__row--hide', !dirMode);
    $('outNameRow').classList.toggle('tl-out__row--hide', !dirMode);
    $('outModeHint').textContent = dirMode
      ? '空目录 → 直接输出；已有文件 → 自动新建子目录'
      : '处理结果直接替换原文件（有备份可还原）';
    $('outHint').textContent = $('outBackup').checked
      ? '备份目录留空时落在应用数据目录下（源目录之外，不会被当成素材再次处理）'
      : '已关闭备份：覆盖后原文件不可恢复';
  }

  function bindOutputEvents() {
    $('outMode').addEventListener('change', syncOutputRows);
    $('outBackup').addEventListener('change', syncOutputRows);
    $('btnPickDir').addEventListener('click', function () {
      if (!api || !api.pick_paths_dirs) return;
      api.pick_paths_dirs().then(function (list) {
        if (list && list.length) { state.root = list[0]; state.files = []; $('inRoot').value = list[0]; renderInputHint(); }
      }).catch(function () {});
    });
    $('btnPickFiles').addEventListener('click', function () {
      if (!api || !api.pick_paths_files) return;
      api.pick_paths_files().then(function (list) {
        if (list && list.length) { state.files = list.slice(); state.root = ''; $('inRoot').value = list.join('；'); renderInputHint(); }
      }).catch(function () {});
    });
    $('btnClearInput').addEventListener('click', function () {
      state.root = ''; state.files = []; $('inRoot').value = ''; renderInputHint();
    });
    $('inRecursive').addEventListener('change', function () { state.recursive = !!$('inRecursive').checked; renderInputHint(); });
    $('btnPickOutDir').addEventListener('click', function () {
      if (!api || !api.pick_directory) return;
      api.pick_directory('选择输出目录', $('outDir').value || state.root || '').then(function (p) {
        if (p) $('outDir').value = p;
      }).catch(function () {});
    });
    $('btnPickBackupDir').addEventListener('click', function () {
      if (!api || !api.pick_directory) return;
      api.pick_directory('选择备份目录', $('outBackupDir').value || '').then(function (p) {
        if (p) $('outBackupDir').value = p;
      }).catch(function () {});
    });
    $('logHead').addEventListener('click', function () { $('logBox').classList.toggle('tl-log--open'); });
    $('btnRun').addEventListener('click', onSubmit);
  }

  // ── 参数记忆 ──
  function applyPrefs(prefs) {
    if (!prefs || typeof prefs !== 'object') return;
    if (Array.isArray(prefs.stepIds)) prefs.stepIds.forEach(function (id) { if (state.sel.hasOwnProperty(id)) state.sel[id] = true; });
    if (prefs.params && typeof prefs.params === 'object') {
      Object.keys(prefs.params).forEach(function (sid) {
        if (!state.values[sid] || !prefs.params[sid]) return;
        Object.keys(prefs.params[sid]).forEach(function (k) {
          if (state.values[sid].hasOwnProperty(k)) state.values[sid][k] = prefs.params[sid][k];
        });
      });
    }
    // 输入目录/文件不记忆：每次处理的对象不同，带出旧路径反而容易误操作
    var o = prefs.output || {};
    if (o.mode) $('outMode').value = o.mode;
    if (o.nameMode) $('outNameMode').value = o.nameMode;
    if (o.suffix != null) $('outSuffix').value = o.suffix;
    if (o.onConflict) $('outConflict').value = o.onConflict;
    if (o.backup === false) $('outBackup').checked = false;
    if (o.backupDir) $('outBackupDir').value = o.backupDir;
  }

  function collectSpec() {
    var stepIds = Object.keys(state.sel).filter(function (k) { return state.sel[k]; });
    if (!stepIds.length) return { error: '请至少勾选一个处理步骤' };
    if (!state.root && !state.files.length) return { error: '请选择要处理的目录或视频文件' };
    if ($('outMode').value === 'directory' && !$('outDir').value.trim()) return { error: '请选择输出目录' };
    // 数字型参数在表单里是字符串，提交前统一还原成数字（引擎侧按数字判断阈值）
    var coerce = function (v) {
      if (v == null || v === '' || typeof v === 'number' || typeof v === 'boolean') return v;
      var s = String(v).trim();
      return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : v;
    };
    // 只提交勾选步骤的参数（未勾选的不参与，避免引擎拿到无关参数）
    var params = {};
    stepIds.forEach(function (id) {
      var src = state.values[id] || {};
      var dst = {};
      Object.keys(src).forEach(function (k) { dst[k] = coerce(src[k]); });
      params[id] = dst;
    });
    return {
      spec: {
        root: state.files.length ? '' : state.root,
        files: state.files,
        recursive: state.recursive,
        stepIds: stepIds,
        params: params,
        output: {
          mode: $('outMode').value,
          dir: $('outDir').value.trim(),
          nameMode: $('outNameMode').value,
          suffix: $('outSuffix').value,
          onConflict: $('outConflict').value,
          backup: !!$('outBackup').checked,
          backupDir: $('outBackupDir').value.trim(),
        },
      },
    };
  }

  function stepTitles(ids) {
    var map = {};
    (state.info.steps || []).forEach(function (s) { map[s.id] = s.title || s.id; });
    return ids.map(function (id) { return map[id] || id; });
  }

  function onSubmit() {
    var c = collectSpec();
    if (c.error) { setStatus(c.error, 'err'); return; }
    var spec = c.spec;
    var overwrite = spec.output.mode === 'overwrite';
    var titles = stepTitles(spec.stepIds);
    var scope = spec.files.length ? (spec.files.length + ' 个文件') : spec.root;
    if (overwrite) {
      // 高风险：可能覆盖原文件 → 大窗警告（不用气泡），要素：数量 / 备份状态 / 步骤清单
      var backupOn = spec.output.backup;
      var msg = '<b>将处理：</b>' + esc(scope) + '<br>'
        + '<b>本次启用：</b>' + esc(titles.join(' + ')) + '<br>'
        + '<b>处理前备份：</b>' + (backupOn ? '已开启' : '<span style="color:var(--status-error-default);font-weight:600">未开启 —— 覆盖后原文件不可恢复</span>')
        + (spec.files.length ? '' : '<br><b>扫描范围：</b>' + (spec.recursive ? '含子目录' : '仅本层'));
      showDialog({
        title: '将覆盖原视频',
        cssClass: 'modal-card--wide',
        message: msg,
        buttons: [{ label: '取消', value: false }, { label: '确认开始', value: true, primary: true, danger: true, icon: 'play' }],
      }).then(function (ok) { if (ok) doRun(spec); });
      return;
    }
    doRun(spec);
  }

  function doRun(spec) {
    $('btnRun').disabled = true;
    setStatus('正在创建任务…');
    api.run_tool(spec).then(function (r) {
      $('btnRun').disabled = false;
      if (!r || !r.ok) { setStatus((r && r.error) || '创建任务失败', 'err'); return; }
      state.taskId = r.taskId;
      showLogBox('任务已加入队列 · ' + r.taskId);
      setStatus('已加入执行队列（在任务列表中查看进度与结果）', 'ok');
      api.save_tool_prefs({
        stepIds: spec.stepIds, params: spec.params,
        output: {
          mode: spec.output.mode, nameMode: spec.output.nameMode, suffix: spec.output.suffix,
          onConflict: spec.output.onConflict, backup: spec.output.backup, backupDir: spec.output.backupDir,
        },
      }).catch(function () {});
      watchTask(r.taskId);
    }).catch(function (e) {
      $('btnRun').disabled = false;
      setStatus('创建任务失败：' + ((e && e.message) || e), 'err');
    });
  }

  // ── 任务进度（复用任务窗口同一份广播）──
  function showLogBox(title) {
    $('logBox').hidden = false;
    $('logBox').classList.add('tl-log--open');
    $('logTitle').textContent = title;
  }

  function watchTask(taskId) {
    if (!api || !api.on_task_update) return;
    if (state.unsub) { try { state.unsub(); } catch (e) {} }
    state.unsub = api.on_task_update(function (tasks) {
      if (!Array.isArray(tasks)) return;
      var t = null;
      for (var i = 0; i < tasks.length; i++) if (tasks[i].id === taskId) { t = tasks[i]; break; }
      if (!t) return;
      var lines = t.log || [];
      $('logBody').textContent = lines.slice(-300).join('\n');
      $('logCount').textContent = lines.length ? (lines.length + ' 行') : '';
      var body = $('logBody');
      body.scrollTop = body.scrollHeight;
      var total = (t.progress && t.progress.total) || 0;
      var cur = (t.progress && t.progress.current) || 0;
      var pct = total > 0 ? Math.min(100, Math.round((cur / total) * 100)) : 0;
      $('progBar').style.width = pct + '%';
      var label = { queued: '排队中', running: '处理中', done: '已完成', error: '失败', stopped: '已停止', paused: '已暂停', interrupted: '已中断' }[t.status] || t.status;
      var detail = total > 0 ? ('　' + cur + ' / ' + total) : '';
      var live = t.progress && t.progress.liveLine;
      if (t.status === 'running' && live && live.time) detail += '　' + live.time;
      setStatus('任务' + label + detail, t.status === 'error' ? 'err' : (t.status === 'done' ? 'ok' : ''));
      if (t.status === 'done' || t.status === 'error' || t.status === 'stopped' || t.status === 'interrupted') {
        if (state.unsub) { try { state.unsub(); } catch (e) {} state.unsub = null; }
      }
    });
  }

  // ── Tab 切换（后处理 / 画布合成）──
  function bindTabs() {
    var tabs = document.querySelectorAll('.tl-tab');
    Array.prototype.forEach.call(tabs, function (btn) {
      btn.addEventListener('click', function () {
        var name = btn.getAttribute('data-tab');
        Array.prototype.forEach.call(tabs, function (b) { b.classList.toggle('tl-tab--active', b === btn); });
        $('panePost').hidden = name !== 'post';
        $('paneCanvas').hidden = name !== 'canvas';
      });
    });
  }

  // ── 皮肤跟随（与任务窗口同一套：读当前皮肤 + 设置页切换时即时生效）──
  function initSkin() {
    if (!api || !api.get_skin) return;
    api.get_skin().then(function (skin) {
      document.documentElement.setAttribute('data-skin', skin || 'white_blue');
    }).catch(function () {});
    if (api.on_settings_saved) {
      api.on_settings_saved(function (cfg) {
        if (cfg && cfg.skin) document.documentElement.setAttribute('data-skin', cfg.skin);
      });
    }
  }

  // ── 启动 ──
  function boot() {
    initSkin();
    if (window.VL_hydrateIcons) window.VL_hydrateIcons(document);
    $('inRecursive').checked = state.recursive;
    renderInputHint();
    syncOutputRows();
    bindTabs();
    bindFormEvents();
    bindOutputEvents();
    if (!api || !api.list_tools) { setStatus('后端接口不可用', 'err'); return; }
    api.list_tools().then(function (info) {
      if (!info || !info.ok) { setStatus((info && info.error) || '读取处理能力失败', 'err'); return; }
      state.info = info;
      (info.steps || []).forEach(function (s) {
        state.sel[s.id] = false;
        state.values[s.id] = {};
        (s.schema || []).forEach(function (sc) {
          state.values[s.id][sc.key] = (sc.default === undefined ? (sc.type === 'bool' ? false : '') : sc.default);
        });
      });
      applyPrefs(info.prefs);
      var e = info.prefs && info.prefs.output;
      if (e && e.mode) $('outMode').value = e.mode;
      renderSteps();
      $('inRecursive').checked = state.recursive;
      renderInputHint();
      syncOutputRows();
      var n = (info.steps || []).length;
      if (!info.engine) {
        var w = $('envWarn');
        w.hidden = false;
        w.textContent = '内置引擎不可用（resources\\Engines 缺失），无法执行处理，请重新安装或校验程序文件。';
        $('btnRun').disabled = true;
        setStatus('内置引擎不可用', 'err');
      } else {
        setStatus('就绪 · 共 ' + n + ' 项可组合能力');
      }
    }).catch(function (e) { setStatus('读取处理能力失败：' + ((e && e.message) || e), 'err'); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
