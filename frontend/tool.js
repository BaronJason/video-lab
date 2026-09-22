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
    link: { resize: true },  // 转分辨率：比例锁链是否锁定（纯前端交互，不提交）
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

  // 轻提示（与主窗口/任务窗口同一套样式与行为）：错误与失败类提示不再走状态栏小字
  function toast(message, type) {
    var host = document.getElementById('toastHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toastHost';
      host.className = 'toast-host';
      document.body.appendChild(host);
    }
    var el = document.createElement('div');
    var t = type === true ? 'error' : (String(type || 'info'));
    var ic = t === 'ok' ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
      : t === 'error' ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>'
      : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="16" y2="12"/><line x1="12" x2="12.01" y1="8" y2="8"/></svg>';
    el.className = 'toast toast--' + t;
    el.innerHTML = '<span class="toast__icon">' + ic + '</span><span class="toast__text"></span>';
    el.querySelector('.toast__text').textContent = message || '';
    host.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('toast--show'); });
    setTimeout(function () {
      el.classList.remove('toast--show');
      setTimeout(function () { el.remove(); }, 200);
    }, t === 'error' ? 4200 : 2600);
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
  // ── 转分辨率专用交互：常用比例 + 宽高联动 + 锁链（用户定案 2026-09-21）──
  // resize 是表单自动渲染的**唯一特例**：比例/锁链是纯前端交互，引擎只收最终 width/height。
  const RESIZE_RATIOS = { '9:16': [9, 16], '16:9': [16, 9], '4:3': [4, 3], '3:4': [3, 4], '1:1': [1, 1] };
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);   // 编码要求宽高为偶数

  function resizeLinked() {
    return !!state.link.resize && state.values.resize.ratio !== '自定义';
  }
  /** 锁定状态下按比例联动（改宽算高 / 改高算宽），结果取偶 */
  function resizePairByWidth(w) {
    const a = RESIZE_RATIOS[state.values.resize.ratio] || [9, 16];
    return even((w * a[1]) / a[0]);
  }
  function resizePairByHeight(h) {
    const a = RESIZE_RATIOS[state.values.resize.ratio] || [9, 16];
    return even((h * a[0]) / a[1]);
  }
  /**
   * 字段当前是否显示：schema 可声明 showWhen: { key, in } ——
   * 依赖的其它参数不满足条件时**直接不渲染**（而不是置灰）。
   * 例：码率控制的 CQ 只在「恒定质量」模式下出现（用户定案 2026-09-21）。
   */
  function fieldVisible(stepId, sc) {
    var w = sc.showWhen;
    if (!w) return true;
    var v = state.values[stepId] ? state.values[stepId][w.key] : undefined;
    return w.in.indexOf(v) >= 0;
  }

  /** 重新渲染某步骤的参数区（模式切换导致显隐变化时调用；值以 state 为准不丢失） */
  function rerenderStepParams(stepId) {
    var node = $('stepGroups').querySelector('[data-step-id="' + stepId + '"]');
    if (!node) return;
    var body = node.querySelector('.tl-params');
    var step = null;
    (state.info.steps || []).forEach(function (x) { if (x.id === stepId) step = x; });
    if (!body || !step) return;
    var html = (stepId === 'resize') ? resizeFieldsHtml()
      : (step.schema || []).filter(function (sc) { return fieldVisible(stepId, sc); })
        .map(function (sc) { return paramField(stepId, sc); }).join('');
    body.innerHTML = html || '<span class="tl-field__hint">无需参数（勾选即可生效）</span>';
    if (window.VL_hydrateIcons) window.VL_hydrateIcons(body);
    refreshResizeLink();
  }

  /**
   * 解绑状态下，按当前宽高**反推**比例下拉的显示。
   * 匹配判定**严格相等**（交叉相乘的整数比较，无任何容差）：
   * 1080×1920 = 9:16，但 1081×1920 就是「自定义」（用户定案 2026-09-21）。
   */
  function syncResizeRatioDisplay() {
    if (resizeLinked()) return;                     // 锁定时下拉由用户选择，不反推
    var w = parseInt(state.values.resize.width, 10);
    var h = parseInt(state.values.resize.height, 10);
    if (!(w > 0) || !(h > 0)) return;
    var match = '自定义';
    for (var k in RESIZE_RATIOS) {
      var a = RESIZE_RATIOS[k][0], b = RESIZE_RATIOS[k][1];
      if (w * b === h * a) { match = k; break; }    // 交叉相乘相等才算该比例
    }
    if (state.values.resize.ratio !== match) {
      state.values.resize.ratio = match;
      var sel = $('stepGroups').querySelector('select[data-step="resize"][data-key="ratio"]');
      if (sel) sel.value = match;
    }
  }

  /** 刷新锁链按钮的视觉状态（锁定 = 主题色竖链；解绑 = 灰链） */
  function refreshResizeLink() {
    var btn = $('stepGroups').querySelector('[data-link="resize"]');
    if (!btn) return;
    var linked = resizeLinked();
    btn.classList.toggle('tl-link--on', linked);
    btn.title = linked ? '比例已锁定：修改宽/高会自动联动，点击解绑' : '已解绑：宽高各自独立，点击按当前比例锁定';
    var svg = btn.querySelector('svg');
    if (svg) svg.style.transform = linked ? 'rotate(-45deg)' : 'none';
  }

  /** 转分辨率专用：[画面比例 ▾] [锁链] [宽] [高] 一行排开 */
  function resizeFieldsHtml() {
    var v = state.values.resize;
    var opts = ['9:16', '16:9', '4:3', '3:4', '1:1', '自定义'].map(function (o) {
      return '<option value="' + o + '"' + (o === v.ratio ? ' selected' : '') + '>' + o + '</option>';
    }).join('');
    return '<label class="tl-field"><span class="tl-field__label">画面比例</span>'
      + '<select class="tl-sel" data-step="resize" data-key="ratio">' + opts + '</select>'
      + '<span class="tl-field__hint" title="选常用比例后，改宽/高会按比例自动联动；点锁链解绑可自由设定">'
      + '改宽/高按比例联动</span></label>'
      + '<label class="tl-field"><span class="tl-field__label">宽</span>'
      + '<input class="tl-num" type="number" data-step="resize" data-key="width" value="' + esc(v.width) + '" min="16" step="2"></label>'
      + '<button type="button" class="tl-link" data-link="resize" title="比例锁">'
      + icon('link', 13) + '</button>'
      + '<label class="tl-field"><span class="tl-field__label">高</span>'
      + '<input class="tl-num" type="number" data-step="resize" data-key="height" value="' + esc(v.height) + '" min="16" step="2"></label>';
  }

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
    var params = (step.id === 'resize') ? resizeFieldsHtml()
      : (step.schema || []).filter(function (sc) { return fieldVisible(step.id, sc); })
        .map(function (sc) { return paramField(step.id, sc); }).join('');
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
    refreshResizeLink();
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
      // 转分辨率锁链：切换"按比例联动 / 自由宽高"
      var lk = e.target.closest('[data-link="resize"]');
      if (lk) {
        state.link.resize = !state.link.resize;
        if (state.link.resize && state.values.resize.ratio !== '自定义') {
          // 重新锁定：以当前宽为基准按比例校正高
          var w = parseInt(state.values.resize.width, 10);
          if (w > 0) { state.values.resize.height = resizePairByWidth(w); syncResizeInputs(); }
        } else {
          syncResizeRatioDisplay();
        }
        refreshResizeLink();
        return;
      }
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
      // 该字段是显隐条件的依赖键 → 重渲染参数区（模式切换后只显示生效中的参数）
      var changed = null;
      (state.info.steps || []).forEach(function (x) { if (x.id === step) changed = x; });
      var dep = changed && (changed.schema || []).some(function (sc) {
        return sc.showWhen && sc.showWhen.key === key;
      });
      if (dep) rerenderStepParams(step);
      // 比例下拉变化：选「自定义」即解绑；选常用比例即锁定并按当前宽校正高
      if (step === 'resize' && key === 'ratio') {
        state.link.resize = state.values.resize.ratio !== '自定义';
        if (state.link.resize) {
          var w0 = parseInt(state.values.resize.width, 10);
          if (w0 > 0) { state.values.resize.height = resizePairByWidth(w0); syncResizeInputs(); }
        }
        refreshResizeLink();
      }
    });

  /** 把 state 里的宽高回写到输入框（联动计算后调用） */
  function syncResizeInputs() {
    var host = $('stepGroups');
    var wi = host.querySelector('input[data-step="resize"][data-key="width"]');
    var hi = host.querySelector('input[data-step="resize"][data-key="height"]');
    if (wi) wi.value = state.values.resize.width;
    if (hi) hi.value = state.values.resize.height;
  }
    host.addEventListener('input', function (e) {
      var t = e.target;
      if (!t || !t.getAttribute) return;
      var step = t.getAttribute('data-step');
      var key = t.getAttribute('data-key');
      if (!step || !key || t.getAttribute('data-bool')) return;
      state.values[step][key] = t.value;
      // 锁链开启：改宽联动高 / 改高联动宽
      if (step === 'resize' && (key === 'width' || key === 'height')) {
        var v = parseInt(t.value, 10);
        if (v > 0) {
          if (resizeLinked()) {
            // 锁链开启：改宽联动高 / 改高联动宽
            var otherKey = key === 'width' ? 'height' : 'width';
            state.values.resize[otherKey] = key === 'width' ? resizePairByWidth(v) : resizePairByHeight(v);
            var other = $('stepGroups').querySelector('input[data-step="resize"][data-key="' + otherKey + '"]');
            if (other) other.value = state.values.resize[otherKey];
          } else {
            // 锁链解绑：宽高独立，但比例显示要跟上实际宽高
            syncResizeRatioDisplay();
          }
        }
      }
    });
  }

  // ── Web 目录选择器 ──
  // 浏览器端没有本机文件对话框；系统对话框依赖本体窗口的前台状态（焦点在浏览器时
  // 会被压在后面，看起来像「点了没反应」）。改为页面内自绘选择器：
  // list_dir 只读目录名/文件名，桌面端与浏览器端体验一致。
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
      if (!api || !api.pick_directory) { toast('后端不支持目录选择', 'error'); return; }
      api.pick_directory('选择要处理的文件夹', state.root || undefined).then(function (p) {
        if (p) { state.root = p; state.files = []; $('inRoot').value = p; renderInputHint(); }
      });
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
    // 手填目录路径：**浏览器端**没有本机文件对话框可用（只能由本体代弹），
    // 因此路径栏必须可直接输入 —— 粘贴/手输后立即生效，并给出存在性反馈
    var _rootTimer = null;
    $('inRoot').addEventListener('input', function () {
      var v = String($('inRoot').value || '').trim().replace(/^"|"$/g, '');
      state.files = [];
      state.root = v;
      renderInputHint();
      clearTimeout(_rootTimer);
      if (!v) { setStatus('请选择目录，或直接粘贴路径'); return; }
      _rootTimer = setTimeout(function () {
        if (!api || !api.check_exists) return;
        api.check_exists([v]).then(function (m) {
          if (String($('inRoot').value || '').trim() !== v) return;   // 已改成别的路径
          if (m && m[v]) setStatus('目录有效：' + v);
          else toast('目录不存在：' + v, 'error');
        }).catch(function () {});
      }, 400);
    });
    $('inRecursive').addEventListener('change', function () { state.recursive = !!$('inRecursive').checked; renderInputHint(); });
    $('btnPickOutDir').addEventListener('click', function () {
      if (!api || !api.pick_directory) { toast('后端不支持目录选择', 'error'); return; }
      api.pick_directory('选择输出目录', $('outDir').value || state.root || undefined).then(function (p) {
        if (p) $('outDir').value = p;
      });
    });
    $('btnPickBackupDir').addEventListener('click', function () {
      if (!api || !api.pick_directory) { toast('后端不支持目录选择', 'error'); return; }
      api.pick_directory('选择备份目录', $('outBackupDir').value || state.defaultBackupDir || undefined).then(function (p) {
        if (p) $('outBackupDir').value = p;
      });
    });
    var obb = $('btnOpenBackupDir');
    if (obb) obb.addEventListener('click', function () {
      if (!api || !api.open_folder_select) { toast('后端不支持打开目录', 'error'); return; }
      api.open_folder_select($('outBackupDir').value.trim() || state.defaultBackupDir).then(function (r) {
        if (r && r.ok === false) { toast('打开备份目录失败：' + (r.error || '未知错误'), 'error'); return; }
        // 浏览器端由本体代开：explorer 可能被 Windows 前台锁压到后台，只在任务栏出现 —— 明确告知去哪看
        if (location.protocol.indexOf('http') === 0) toast('资源管理器已在后台打开，可从任务栏查看', 'info');
      }).catch(function (e) { toast('打开备份目录失败：' + e.message, 'error'); });
    });
    $('logHead').addEventListener('click', function () { $('logBox').classList.toggle('tl-log--open'); });
    $('btnRun').addEventListener('click', onSubmit);
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
      var schemaOf = null;
      (state.info.steps || []).forEach(function (x) { if (x.id === id) schemaOf = x.schema || []; });
      var visible = {};
      schemaOf.forEach(function (sc) { if (fieldVisible(id, sc)) visible[sc.key] = 1; });
      var dst = {};
      Object.keys(src).forEach(function (k) { if (visible[k]) dst[k] = coerce(src[k]); });
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
    if (c.error) { toast(c.error, 'error'); return; }
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
    setStatus('正在创建任务…');
    api.run_tool(spec).then(function (r) {
      setRunEnabled(true);
      if (!r || !r.ok) { toast((r && r.error) || '创建任务失败', 'error'); return; }
      state.taskId = r.taskId;
      showLogBox('任务已加入队列 · ' + r.taskId);
      setStatus('已加入执行队列（在任务列表中查看进度与结果）', 'ok');
      watchTask(r.taskId);
    }).catch(function (e) {
      setRunEnabled(true);
      toast('创建任务失败：' + ((e && e.message) || e), 'error');
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
    if (!api || !api.list_tools) { setRunEnabled(false, '后端接口不可用'); toast('后端接口不可用', 'error'); return; }
    api.list_tools().then(function (info) {
      if (!info || !info.ok) {
        setRunEnabled(false, '读取处理能力失败');
        toast((info && info.error) || '读取处理能力失败', 'error');
        return;
      }
      state.info = info;
      state.defaultBackupDir = (info.output && info.output.defaultBackupDir) || '';
      if (state.defaultBackupDir) $('outBackupDir').placeholder = state.defaultBackupDir;   // 占位符显示实际地址
      (info.steps || []).forEach(function (s) {
        state.sel[s.id] = false;
        state.values[s.id] = {};
        (s.schema || []).forEach(function (sc) {
          state.values[s.id][sc.key] = (sc.default === undefined ? (sc.type === 'bool' ? false : '') : sc.default);
        });
      });
      renderSteps();
      $('inRecursive').checked = state.recursive;
      renderInputHint();
      syncOutputRows();
      var n = (info.steps || []).length;
      if (!info.engine) {
        var w = $('envWarn');
        w.hidden = false;
        w.textContent = '程序文件不完整（缺少运行组件），无法执行处理，请重新安装或校验。';
        setRunEnabled(false, '程序文件不完整，无法执行处理');
        toast('程序文件不完整，请重新安装或校验', 'error');
      } else {
        // ★ 就绪即启用主操作按钮 —— 参数不完整时交给点击后的校验去提示，
        //   否则按钮一直灰着，用户不知道为什么不能点
        setRunEnabled(true, '');
        setStatus('就绪 —— 选好目录、勾选要做的处理后点「开始处理」');
      }
    }).catch(function (e) {
      setRunEnabled(false, '读取处理能力失败');
      toast('读取处理能力失败：' + ((e && e.message) || e), 'error');
    });
  }

  /** 主操作按钮可用态：灰显时必须给出原因（title），避免「一直灰着不知为何」 */
  function setRunEnabled(on, why) {
    var b = $('btnRun');
    b.disabled = !on;
    if (why) b.title = why; else b.removeAttribute('title');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
