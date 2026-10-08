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

  // 全局兜底统一由 log-bootstrap.js 注入（四窗口共用）；本页只挂 toast。
  // 就地 catch 请用 window.logError(where, err)（toast + 落盘一次完成）。
  window.vlToast = toast;

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
  // ── 转分辨率专用交互：常用比例 + 宽高联动 + 锁链 ──
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
   * 例：码率控制的 CQ 只在「恒定质量」模式下出现。
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
   * 1080×1920 = 9:16，但 1081×1920 就是「自定义」。
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
      input = '<label class="opt-check opt-check--nolabel"><input type="checkbox" data-step="' + stepId + '" data-key="' + sc.key + '" data-bool="1"' + (v ? ' checked' : '') + '><span class="opt-check__box"></span></label>';
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
      + '<label class="opt-check opt-check--nolabel"><input type="checkbox" data-check="' + step.id + '"' + (on ? ' checked' : '') + '><span class="opt-check__box"></span></label>'
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
        // 点标题行（复选框以外的区域）= 切换勾选；点复选框（.opt-check 区域内）由 label 原生联动
        // 触发 input 的 change，再经 change 委托走 setStepOn —— 若这里也手动切换会双重触发相互抵消
        var cb = head.querySelector('input[data-check]');
        if (cb && !e.target.closest('.opt-check')) setStepOn(cb.getAttribute('data-check'), !cb.checked);
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
      hint.textContent = '已选 ' + state.files.length + ' 个视频文件（按文件清单处理，不再按文件夹扫描）';
    } else if (state.root) {
      hint.className = 'tl-hint';
      hint.textContent = '将' + (state.recursive ? '递归' : '仅在本层') + '扫描该文件夹下的视频'
        + '（自动跳过应用自身的输出与备份文件夹）';
    } else {
      hint.className = 'tl-hint';
      hint.textContent = '请选择文件夹，或直接选择若干视频文件';
    }
    // 输入变化 → 刷新预览样本清单并自动预览一帧（folder 扫描是异步的，扫描完成后才渲，天然避免竞态）
    cvLoadSamples(true);
  }

  function syncOutputRows() {
    var dirMode = $('outMode').value === 'directory';
    $('outDirRow').classList.toggle('tl-out__row--hide', !dirMode);
    $('outNameRow').classList.toggle('tl-out__row--hide', !dirMode);
    $('outModeHint').textContent = dirMode
      ? '空文件夹 → 直接输出；已有文件 → 自动新建子文件夹'
      : '处理结果直接替换原文件（有备份可还原）';
    $('outHint').textContent = $('outBackup').checked
      ? '备份文件夹留空时落在应用数据文件夹下（源文件夹之外，不会被当成素材再次处理）'
      : '已关闭备份：覆盖后原文件不可恢复';
  }

  function bindOutputEvents() {
    $('outMode').addEventListener('change', syncOutputRows);
    $('outBackup').addEventListener('change', syncOutputRows);
    $('btnPickDir').addEventListener('click', function () {
      if (!api || !api.pick_directory) { toast('后端不支持文件夹选择', 'error'); return; }
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
      if (!v) { setStatus('请选择文件夹，或直接粘贴路径'); return; }
      _rootTimer = setTimeout(function () {
        if (!api || !api.check_exists) return;
        api.check_exists([v]).then(function (m) {
          if (String($('inRoot').value || '').trim() !== v) return;   // 已改成别的路径
          if (m && m[v]) setStatus('文件夹有效：' + v);
          else toast('文件夹不存在：' + v, 'error');
        }).catch(function () {});
      }, 400);
    });
    $('inRecursive').addEventListener('change', function () { state.recursive = !!$('inRecursive').checked; renderInputHint(); });
    $('btnPickOutDir').addEventListener('click', function () {
      if (!api || !api.pick_directory) { toast('后端不支持文件夹选择', 'error'); return; }
      api.pick_directory('选择输出文件夹', $('outDir').value || state.root || undefined).then(function (p) {
        if (p) $('outDir').value = p;
      });
    });
    $('btnPickBackupDir').addEventListener('click', function () {
      if (!api || !api.pick_directory) { toast('后端不支持文件夹选择', 'error'); return; }
      api.pick_directory('选择备份文件夹', $('outBackupDir').value || state.defaultBackupDir || undefined).then(function (p) {
        if (p) $('outBackupDir').value = p;
      });
    });
    var obb = $('btnOpenBackupDir');
    if (obb) obb.addEventListener('click', function () {
      if (!api || !api.open_folder_select) { toast('后端不支持打开文件夹', 'error'); return; }
      api.open_folder_select($('outBackupDir').value.trim() || state.defaultBackupDir).then(function (r) {
        if (r && r.ok === false) { toast('打开备份文件夹失败：' + (r.error || '未知错误'), 'error'); return; }
        // 浏览器端由本体代开：explorer 可能被 Windows 前台锁压到后台，只在任务栏出现 —— 明确告知去哪看
        if (location.protocol.indexOf('http') === 0) toast('资源管理器已在后台打开，可从任务栏查看', 'info');
      }).catch(function (e) { toast('打开备份文件夹失败：' + e.message, 'error'); });
    });
    $('logHead').addEventListener('click', function () { $('logBox').classList.toggle('tl-log--open'); });
    $('btnRun').addEventListener('click', onSubmit);
  }

  function collectSpec() {
    var stepIds = Object.keys(state.sel).filter(function (k) { return state.sel[k]; });
    if (!stepIds.length) return { error: '请至少勾选一个处理步骤' };
    if (!state.root && !state.files.length) return { error: '请选择要处理的文件夹或视频文件' };
    if ($('outMode').value === 'directory' && !$('outDir').value.trim()) return { error: '请选择输出文件夹' };
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
        + (spec.files.length ? '' : '<br><b>扫描范围：</b>' + (spec.recursive ? '含子文件夹' : '仅本层'));
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

  // ════════════ 画布合成（竖转横）：单帧预览 + 参数双向同步 ════════════
  // 舞台三层结构：背景层底图（精确渲染的纯背景）＋ 内容层（拖动期用内容原帧做本地几何变换，
  // 零延迟可跟手）＋ 覆盖层（手柄与吸附参考线）；非拖动状态显示精确合成图。
  // 数据流：参数区 ↔ cv.params ↔ 预览。拖动只改本地几何 —— 与滤镜表达式数学等价（同一套偏移/缩放
  // 公式），因此不会出现「拖动所见与出片不同」；松手后再由主进程按同一套滤镜链渲染精确帧校正
  // （圆角、边框、模糊等本地无法精确呈现的效果以精确帧为准）。
  var cv = {
    ready: false,
    params: {
      bgMode: 'dir', bgDir: '', bgPath: '', bgColor: '#000000', watermark: '',
      targetW: 1920, targetH: 1080,
      scale: 0.74, stretch: false, w: 1280, h: 720,
      posMode: 'center', dx: 0, dy: 160,
      radius: 0, borderW: 0, borderColor: '#ffffff', bgBlur: 0,
    },
    at: 0,
    duration: 0,
    samples: [], sampleIndex: 0,   // 预览样本清单（文件夹输入 = 待处理视频；文件输入 = 所选文件）
    bgIndex: 0, bgTotal: 0, bgName: '',
    box: { x: 0, y: 0, w: 0, h: 0 },   // 内容盒（画布像素；精确渲染后以服务端元数据为准）
    meta: null,
    drag: null,
    seq: 0,
    timer: 0,
    busyRetry: 0,
    syncing: false,                    // 程序性写入控件时置真，避免与用户输入形成回环
    snap: 10,                          // 吸附阈值（显示像素）
  };

  function cvCss(el, obj) { if (el) { for (var k in obj) el.style[k] = obj[k]; } }
  function cvNum(el, fallback) {
    var v = Number(el && el.value);
    return isFinite(v) ? v : fallback;
  }
  function cvCanvasW() { return Math.max(16, Number(cv.params.targetW) || 1920); }
  function cvCanvasH() { return Math.max(16, Number(cv.params.targetH) || 1080); }

  /** 画布像素 → 显示像素的比例（手柄拖动与吸附阈值换算用） */
  function cvViewScale() {
    var el = $('cvCanvas');
    if (!el) return 1;
    var r = el.getBoundingClientRect();
    return r.width > 0 ? r.width / cvCanvasW() : 1;
  }

  function cvSetBadge(text, kind) {
    var el = $('cvBadge');
    if (!el) return;
    el.textContent = text;
    el.className = 'cv-badge' + (kind ? ' cv-badge--' + kind : '');
  }

  function cvShowWarnings(list) {
    var el = $('cvWarn');
    if (!el) return;
    var arr = (list || []).filter(Boolean);
    el.textContent = arr.length ? ('· ' + arr.join('\n· ')) : '';
    el.style.whiteSpace = 'pre-line';
  }

  /** 预览源 = 当前样本（由 cvLoadSamples 维护；可用「样本 上一个/下一个」切换） */
  function cvContentPath() {
    if (!cv.samples || !cv.samples.length) return '';
    var i = Math.max(0, Math.min(cv.sampleIndex || 0, cv.samples.length - 1));
    return cv.samples[i] || '';
  }

  /** 样本信息条：显示「第 n/共 N 个 · 文件名」；有样本才显示该行 */
  function cvSetSampleInfo() {
    var el = $('cvSampleInfo');
    var bar = $('cvSampleRow');
    var n = (cv.samples || []).length;
    if (bar) bar.style.display = n ? '' : 'none';
    if (!el) return;
    if (!n) { el.textContent = '—'; el.title = ''; return; }
    var p = cvContentPath();
    el.textContent = (cv.sampleIndex + 1) + '/' + n + ' · ' + String(p || '').split(/[\\/]/).pop();
    el.title = '预览只用这一个样本；正式处理会对上方清单里的全部视频逐个合成（参数共用，背景每个视频独立随机）';
  }

  /** 刷新样本清单：文件清单优先，否则按文件夹向后端要一份（与正式处理同一套扫描规则） */
  function cvLoadSamples(andPreview) {
    if (state.files && state.files.length) {
      cv.samples = state.files.slice();
      cv.sampleIndex = 0;
      cvSetSampleInfo();
      if (andPreview) { cv.duration = 0; cvRequestPreview({ immediate: true }); }
      return;
    }
    var root = String(state.root || '').trim();
    if (!root || !api || !api.canvas_list_sources) {
      cv.samples = []; cv.sampleIndex = 0; cvSetSampleInfo(); return;
    }
    api.canvas_list_sources(root, state.recursive !== false).then(function (r) {
      cv.samples = (r && r.ok && r.list) ? r.list.map(function (x) { return x.path; }) : [];
      cv.sampleIndex = 0;
      cvSetSampleInfo();
      if (andPreview && cv.samples.length) { cv.duration = 0; cvRequestPreview({ immediate: true }); }
    }).catch(function () { cv.samples = []; cv.sampleIndex = 0; cvSetSampleInfo(); });
  }

  /** 切换样本（序号环绕）：样本换了时长就未知，时间点与内容盒都要跟着重算 */
  function cvSampleStep(step) {
    var n = (cv.samples || []).length;
    if (!n) { toast('请先在上方选择文件夹或视频文件', 'info'); return; }
    cv.sampleIndex = ((cv.sampleIndex + step) % n + n) % n;
    cv.duration = 0;
    cv.at = 0;
    cvSetSampleInfo();
    cvRequestPreview({ immediate: true });
  }

  /** 内容盒按参数推算（与滤镜表达式同一套公式，抽取自共享模块的语义） */
  function cvContentSize() {
    if (cv.params.stretch && cv.params.w && cv.params.h) {
      return { w: Math.round(cv.params.w), h: Math.round(cv.params.h) };
    }
    var srcW = (cv.meta && cv.meta.contentSrcW) || 0;
    var srcH = (cv.meta && cv.meta.contentSrcH) || 0;
    if (!srcW || !srcH) return { w: 0, h: 0 };
    var bw = cv.params.borderW > 0 ? Math.round(cv.params.borderW) : 0;
    return {
      w: Math.round(srcW * cv.params.scale) + bw * 2,
      h: Math.round(srcH * cv.params.scale) + bw * 2,
    };
  }

  /** 位置基准（偏移为 0 时的左上角坐标） */
  function cvBaseOffset(w, h) {
    var W = cvCanvasW(), H = cvCanvasH();
    switch (cv.params.posMode) {
      case 'tl': return { x: 0, y: 0 };
      case 'tr': return { x: W - w, y: 0 };
      case 'bl': return { x: 0, y: H - h };
      case 'br': return { x: W - w, y: H - h };
      case 'custom': return { x: 0, y: 0 };
      default: return { x: (W - w) / 2, y: (H - h) / 2 };
    }
  }

  function cvComputeBox() {
    var size = cvContentSize();
    if (!size.w || !size.h) return null;
    var base = cvBaseOffset(size.w, size.h);
    return { x: base.x + (Number(cv.params.dx) || 0), y: base.y + (Number(cv.params.dy) || 0), w: size.w, h: size.h };
  }

  /** 把内容盒写到 DOM（拖动期每帧调用，保证零延迟跟手） */
  function cvPaintBox() {
    var W = cvCanvasW(), H = cvCanvasH();
    var b = cv.box;
    var p = {
      left: (b.x / W * 100) + '%', top: (b.y / H * 100) + '%',
      width: (b.w / W * 100) + '%', height: (b.h / H * 100) + '%',
    };
    var vs = cvViewScale();
    var extra = { borderRadius: Math.max(0, cv.params.radius * vs) + 'px' };
    if (cv.params.borderW > 0) {
      extra.border = Math.max(1, cv.params.borderW * vs) + 'px solid ' + cv.params.borderColor;
    } else extra.border = '1px solid var(--brand-500)';
    cvCss($('cvFg'), p);
    var box = $('cvBox');
    cvCss(box, Object.assign({}, p, extra));
  }

  /** 把内容盒反解回参数（拖动结束时用；custom 模式直接写绝对坐标） */
  function cvBoxToParams(b) {
    if (cv.params.posMode === 'custom') { cv.params.dx = Math.round(b.x); cv.params.dy = Math.round(b.y); return; }
    var base = cvBaseOffset(b.w, b.h);
    cv.params.dx = Math.round(b.x - base.x);
    cv.params.dy = Math.round(b.y - base.y);
  }

  function cvWriteBackInputs(keys) {
    cv.syncing = true;
    try {
      var map = {
        scale: 'cvScaleNum', dx: 'cvDx', dy: 'cvDy', w: 'cvW', h: 'cvH',
        targetW: 'cvTW', targetH: 'cvTH', radius: 'cvRadius', borderW: 'cvBorderW', bgBlur: 'cvBgBlur',
      };
      (keys || Object.keys(map)).forEach(function (k) {
        var el = $(map[k]);
        if (!el) return;
        el.value = String(cv.params[k]);
        if (k === 'scale') { var s = $('cvScale'); if (s) s.value = String(cv.params[k]); }
        if (k === 'radius') { var rv = $('cvRadiusVal'); if (rv) rv.textContent = String(cv.params.radius); }
        if (k === 'borderW') { var bv = $('cvBorderWVal'); if (bv) bv.textContent = String(cv.params.borderW); }
        if (k === 'bgBlur') { var gv = $('cvBgBlurVal'); if (gv) gv.textContent = String(cv.params.bgBlur); }
      });
    } finally { cv.syncing = false; }
  }

  function cvSyncBgRows() {
    var m = cv.params.bgMode;
    $('cvBgDirRow').hidden = m !== 'dir';
    $('cvBgPathRow').hidden = !(m === 'image' || m === 'video');
  }

  function cvRequestPreview(opts) {
    if (cv.timer) { clearTimeout(cv.timer); cv.timer = 0; }
    var delay = (opts && opts.immediate) ? 0 : 200;
    cv.timer = setTimeout(function () { cv.timer = 0; cvDoPreview(); }, delay);
  }

  /** 预览失败提示：状态栏小字容易被忽略，补一次吐司；相同原因 4 秒内不重复弹（拖动时可能连发） */
  function cvToastError(msg) {
    var now = Date.now();
    if (cv._errMsg === msg && (now - (cv._errAt || 0)) < 4000) return;
    cv._errMsg = msg; cv._errAt = now;
    try { toast('画布预览失败：' + msg, 'error'); } catch (e) {}
  }

  function cvDoPreview() {
    if (!api || !api.canvas_preview_frame) { cvSetBadge('接口不可用', 'err'); return; }
    var contentPath = cvContentPath();
    if (!contentPath) {
      cvSetBadge('未选择视频', 'err');
      cvShowWarnings(['请先在上方选择要处理的文件夹、或直接选择若干视频文件 —— 预览取清单里的一个样本（用下方「样本 上一个/下一个」切换），正式处理会对全部视频逐个合成']);
      return;
    }
    var mySeq = ++cv.seq;
    cvSetBadge(cv.timer ? '渲染中…' : '渲染中…', '');
    var payload = {
      contentPath: contentPath,
      at: cv.at,
      bgIndex: cv.bgIndex,
      params: Object.assign({}, cv.params),
      watermarkPath: cv.params.watermark,
      previewScale: 0.5,
    };
    api.canvas_preview_frame(payload).then(function (r) {
      if (mySeq !== cv.seq) return;                    // 丢弃过期响应（拖动中会产生多份请求）
      if (!r || !r.ok) {
        if (r && String(r.error) === 'BUSY') {         // 主进程并发已满：稍后用最新参数重试
          if (cv.busyRetry < 6) { cv.busyRetry++; cvRequestPreview({ immediate: false }); }
          else { cvSetBadge('渲染繁忙', 'err'); }
          return;
        }
        cv.busyRetry = 0;
        // 时间点越界（滑块范围未及时收紧、视频短于当前值）→ 夹回时长内自动重渲，而不是停在失败态
        if (r && Number(r.duration) > 0 && cv.at > Number(r.duration) - 0.05) {
          cv.duration = Number(r.duration);
          cv.at = Math.max(0, cv.duration - 0.05);
          cvSyncAtControls();
          cvRequestPreview({ immediate: true });
          return;
        }
        cvSetBadge('预览失败', 'err');
        cvShowWarnings([(r && r.error) || '预览失败']);
        cvToastError((r && r.error) || '预览失败');
        return;
      }
      cv.busyRetry = 0;
      cvApplyResult(r);
    }).catch(function (e) {
      if (mySeq !== cv.seq) return;
      cvSetBadge('预览失败', 'err');
      cvShowWarnings([String((e && e.message) || e)]);
      cvToastError(String((e && e.message) || e));
    });
  }

  /** 把当前时间点写回两个控件，并按已知时长约束范围 —— 越界值一律夹回，避免「拖到超出时长 → 渲染取不到帧」 */
  function cvSyncAtControls() {
    var dur = cv.duration > 0 ? cv.duration : 0;
    if (dur > 0.1) cv.at = Math.max(0, Math.min(cv.at, dur - 0.05));
    var range = $('cvAtRange');
    if (range) {
      range.max = String(dur > 0.1 ? (dur - 0.05) : Math.max(0.1, cv.at));
      range.value = String(cv.at);
    }
    var atEl = $('cvAt');
    if (atEl) {
      atEl.max = String(dur > 0.1 ? (dur - 0.05) : Math.max(0.1, cv.at));
      atEl.value = cv.at.toFixed(1);
    }
  }

  function cvApplyResult(r) {
    var meta = r.meta || {};
    cv.meta = meta;
    if (meta.duration > 0) cv.duration = meta.duration;
    cvSyncAtControls();
    if (meta.contentBox) {
      cv.box = {
        x: Number(meta.contentBox.x) || 0, y: Number(meta.contentBox.y) || 0,
        w: Math.max(2, Number(meta.contentBox.w) || 0), h: Math.max(2, Number(meta.contentBox.h) || 0),
      };
    }
    var stage = $('cvCanvas');
    if (stage) {
      stage.classList.remove('cv-canvas--drag');
      stage.classList.add('cv-canvas--ready');   // 就绪后内容框可拖动（此前只在拖动中才显示 → 根本点不到）
    }
    if (r.bgOnly) $('cvBg').src = r.bgOnly;
    if (r.composed) $('cvComp').src = r.composed;
    if (r.raw) $('cvFg').src = r.raw;
    if (r.previewW && r.previewH) {
      cvCss(stage, { aspectRatio: String(cvCanvasW()) + ' / ' + String(cvCanvasH()) });
    }
    cv.bgTotal = Number(meta.bgTotal) || 0;
    cv.bgIndex = Number(meta.bgIndex) || 0;
    cv.bgName = meta.bgPath ? String(meta.bgPath).split(/[\\/]/).pop() : '';
    cvUpdateBgInfo();
    cvPaintBox();
    cvWriteBackInputs(['scale', 'dx', 'dy', 'w', 'h']);
    cvShowWarnings(meta.warnings || []);
    cvSetBadge((r.fromCache ? '已校正（缓存）' : '已校正 · ' + (r.ms || 0) + 'ms'), 'ok');
    if ($('cvShowRaw') && $('cvShowRaw').checked) stage.classList.add('cv-canvas--raw');
    else stage.classList.remove('cv-canvas--raw');
  }

  function cvUpdateBgInfo() {
    var el = $('cvBgInfo');
    if (!el) return;
    if (cv.params.bgMode === 'color') { el.textContent = '背景 纯色 ' + cv.params.bgColor; return; }
    if (cv.params.bgMode === 'dir') {
      el.textContent = cv.bgTotal
        ? ('背景 ' + (cv.bgIndex + 1) + '/' + cv.bgTotal + (cv.bgName ? ' · ' + cv.bgName : ''))
        : '背景 未扫描';
      return;
    }
    el.textContent = '背景 ' + (cv.bgName || '未选择');
  }

  // ── 拖动 / 缩放 / 拉伸（pointer 事件 + 本地几何变换）──
  function cvPointerPos(e) {
    var el = $('cvCanvas');
    var r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** 吸附：内容盒中心/边靠近画布中心、三分线与边缘时给出参考线并吸合 */
  function cvSnap(b, alt) {
    var W = cvCanvasW(), H = cvCanvasH();
    var showV = 0, showH = 0;
    if (alt) { cvDrawGuides(0, 0, false); return b; }
    var vs = cvViewScale();
    var tol = cv.snap / Math.max(0.05, vs);
    var vLines = [0, W / 3, W / 2, 2 * W / 3, W];
    var hLines = [0, H / 3, H / 2, 2 * H / 3, H];
    var targets = [
      { v: b.x, w: 0 }, { v: b.x + b.w / 2, w: b.w / 2 }, { v: b.x + b.w, w: b.w },
    ];
    for (var i = 0; i < targets.length; i++) {
      for (var j = 0; j < vLines.length; j++) {
        if (Math.abs(targets[i].v - vLines[j]) <= tol) {
          b.x += vLines[j] - targets[i].v; showV = vLines[j]; break;
        }
      }
      if (showV) break;
    }
    var t2 = [
      { v: b.y, w: 0 }, { v: b.y + b.h / 2, w: b.h / 2 }, { v: b.y + b.h, w: b.h },
    ];
    for (var k = 0; k < t2.length; k++) {
      for (var m = 0; m < hLines.length; m++) {
        if (Math.abs(t2[k].v - hLines[m]) <= tol) {
          b.y += hLines[m] - t2[k].v; showH = hLines[m]; break;
        }
      }
      if (showH) break;
    }
    cvDrawGuides(showV, showH, true);
    return b;
  }

  function cvDrawGuides(vx, hy, on) {
    var gv = $('cvGuideV'), gh = $('cvGuideH');
    if (!gv || !gh) return;
    if (!on) { gv.style.display = 'none'; gh.style.display = 'none'; return; }
    if (vx) { gv.style.display = 'block'; gv.style.left = (vx / cvCanvasW() * 100) + '%'; } else gv.style.display = 'none';
    if (hy) { gh.style.display = 'block'; gh.style.top = (hy / cvCanvasH() * 100) + '%'; } else gh.style.display = 'none';
  }

  function cvDragStart(e, mode, handle) {
    var contentPath = cvContentPath();
    if (!contentPath) { cvShowWarnings(['请先在顶部选择用于预览的视频']); return; }
    if (!cv.box.w || !cv.box.h) { cvShowWarnings(['预览尚未就绪，请稍候再拖动']); return; }
    // 原帧对照下不可拖动（要拖就得看合成结果）→ 自动退出对照模式
    var rawToggle = $('cvShowRaw');
    if (rawToggle && rawToggle.checked) {
      rawToggle.checked = false;
      $('cvCanvas').classList.remove('cv-canvas--raw');
    }
    if (mode === 'handle' && handle && handle.length === 1 && !cv.params.stretch) {
      toast('边手柄用于拉伸（非等比）。如需拉伸请先打开「拉伸」开关，或使用四角手柄等比缩放', 'info');
      return;
    }
    e.preventDefault();
    var p = cvPointerPos(e);
    cv.drag = {
      mode: mode, hd: handle || '',
      startX: p.x, startY: p.y,
      startBox: { x: cv.box.x, y: cv.box.y, w: cv.box.w, h: cv.box.h },
      startParams: { scale: cv.params.scale, w: cv.params.w, h: cv.params.h, dx: cv.params.dx, dy: cv.params.dy },
    };
    try { e.target.setPointerCapture(e.pointerId); } catch (e2) {}
    $('cvCanvas').classList.add('cv-canvas--drag');
    cvSetBadge('拖动中（近似）', 'drag');
  }

  function cvDragMove(e) {
    if (!cv.drag) return;
    var p = cvPointerPos(e);
    var vs = cvViewScale();
    var dx = (p.x - cv.drag.startX) / Math.max(0.01, vs);
    var dy = (p.y - cv.drag.startY) / Math.max(0.01, vs);
    var s = cv.drag.startBox;
    var box = { x: s.x, y: s.y, w: s.w, h: s.h };
    var ratio = s.w / Math.max(1, s.h);

    if (cv.drag.mode === 'move') {
      box.x = s.x + dx; box.y = s.y + dy;
    } else {
      var hd = cv.drag.hd;
      var corner = (hd === 'tl' || hd === 'tr' || hd === 'bl' || hd === 'br');
      if (corner) {
        // 等比缩放：以对角为固定点
        var newW = s.w;
        if (hd === 'br' || hd === 'tr') newW = s.w + dx; else newW = s.w - dx;
        newW = Math.max(16, newW);
        var newH = Math.round(newW / Math.max(0.01, ratio));
        var newScale = newW / Math.max(1, s.w) * cv.drag.startParams.scale;
        box.w = newW; box.h = newH;
        cv.params.scale = Math.round(newScale * 1000) / 1000;
        if (hd === 'tl') { box.x = s.x + (s.w - newW); box.y = s.y + (s.h - newH); }
        else if (hd === 'tr') { box.x = s.x; box.y = s.y + (s.h - newH); }
        else if (hd === 'bl') { box.x = s.x + (s.w - newW); box.y = s.y; }
        else { box.x = s.x; box.y = s.y; }
      } else {
        // 边手柄：拉伸（非等比）
        if (hd === 'l') { box.x = s.x + dx; box.w = Math.max(16, s.w - dx); }
        else if (hd === 'r') { box.w = Math.max(16, s.w + dx); }
        else if (hd === 't') { box.y = s.y + dy; box.h = Math.max(16, s.h - dy); }
        else if (hd === 'b') { box.h = Math.max(16, s.h + dy); }
        cv.params.stretch = true;
        cv.params.w = Math.round(box.w); cv.params.h = Math.round(box.h);
      }
    }
    if (cv.params.posMode !== 'custom') cvSnap(box, e.altKey);
    cv.box = box;
    cvPaintBox();
    cvBoxToParams(box);
    cvWriteBackInputs(['scale', 'dx', 'dy', 'w', 'h']);
    if (cv.params.stretch) { $('cvStretch').checked = true; $('cvStretchRow').hidden = false; }
  }

  function cvDragEnd() {
    if (!cv.drag) return;
    cv.drag = null;
    cvDrawGuides(0, 0, false);
    cvRequestPreview({ immediate: true });     // 松手后按当前参数渲染精确帧校正
  }

  // 缩放不再挂滚轮：参数页常常贴着预览，滚动查看参数时会误改缩放。
  // 缩放入口保留在参数区的「等比缩放」滑块 / 数值框（改动同样即时预览）。

  function cvBindDrag() {
    var box = $('cvBox');
    box.addEventListener('pointerdown', function (e) {
      if (e.target && e.target.className && String(e.target.className).indexOf('cv-hd') >= 0) return;
      cvDragStart(e, 'move', '');
    });
    Array.prototype.forEach.call(document.querySelectorAll('#cvBox .cv-hd'), function (h) {
      h.addEventListener('pointerdown', function (e) { cvDragStart(e, 'handle', h.getAttribute('data-hd') || ''); });
    });
    document.addEventListener('pointermove', function (e) { if (cv.drag) cvDragMove(e); });
    document.addEventListener('pointerup', function () { if (cv.drag) cvDragEnd(); });
    document.addEventListener('pointercancel', function () { if (cv.drag) cvDragEnd(); });
  }

  // ── 控件绑定（统一「输入 → 参数 → 防抖预览」，程序性写入不回环）──
  function cvBindControls() {
    function onInput(id, apply, opts) {
      var el = $(id);
      if (!el) return;
      var ev = (el.type === 'range' || el.type === 'number' || el.type === 'color') ? 'input' : 'change';
      el.addEventListener(ev, function () {
        if (cv.syncing) return;
        if (apply(el) === false) return;
        cvRequestPreview(opts);
      });
    }
    onInput('cvTW', function (el) { cv.params.targetW = Math.max(16, cvNum(el, 1920)); return true; }, { immediate: true });
    onInput('cvTH', function (el) { cv.params.targetH = Math.max(16, cvNum(el, 1080)); return true; }, { immediate: true });
    onInput('cvBgMode', function (el) { cv.params.bgMode = String(el.value); cvSyncBgRows(); return true; }, { immediate: true });
    onInput('cvBgColor', function (el) { cv.params.bgColor = String(el.value); return true; });
    onInput('cvBgDir', function (el) { cv.params.bgDir = String(el.value).trim(); cv.bgIndex = 0; return true; });
    onInput('cvBgPath', function (el) { cv.params.bgPath = String(el.value).trim(); return true; });
    onInput('cvBgBlur', function (el) { cv.params.bgBlur = Math.max(0, cvNum(el, 0)); cvWriteBackInputs(['bgBlur']); return true; });
    onInput('cvScale', function (el) { cv.params.scale = Math.min(3, Math.max(0.05, cvNum(el, 0.74))); cvWriteBackInputs(['scale']); return true; });
    onInput('cvScaleNum', function (el) { cv.params.scale = Math.min(3, Math.max(0.05, cvNum(el, 0.74))); cvWriteBackInputs(['scale']); return true; });
    onInput('cvStretch', function (el) {
      cv.params.stretch = !!el.checked;
      $('cvStretchRow').hidden = !cv.params.stretch;
      if (cv.params.stretch && (!cv.params.w || !cv.params.h)) {
        var size = cvContentSize();
        cv.params.w = Math.round(size.w || 1280); cv.params.h = Math.round(size.h || 720);
        cvWriteBackInputs(['w', 'h']);
      }
      return true;
    }, { immediate: true });
    onInput('cvW', function (el) { cv.params.w = Math.max(2, cvNum(el, 1280)); return true; });
    onInput('cvH', function (el) { cv.params.h = Math.max(2, cvNum(el, 720)); return true; });
    onInput('cvPos', function (el) { cv.params.posMode = String(el.value); return true; }, { immediate: true });
    onInput('cvDx', function (el) { cv.params.dx = Math.round(cvNum(el, 0)); return true; });
    onInput('cvDy', function (el) { cv.params.dy = Math.round(cvNum(el, 160)); return true; });
    onInput('cvRadius', function (el) { cv.params.radius = Math.max(0, cvNum(el, 0)); cvWriteBackInputs(['radius']); return true; });
    onInput('cvBorderW', function (el) { cv.params.borderW = Math.max(0, cvNum(el, 0)); cvWriteBackInputs(['borderW']); return true; });
    onInput('cvBorderColor', function (el) { cv.params.borderColor = String(el.value); return true; });
    onInput('cvWm', function (el) { cv.params.watermark = String(el.value).trim(); return true; });

    // 操作条 · 时间点：拖动即按新点重渲（防抖），松手立即渲染
    // ⚠ 一律夹到视频时长内 —— 滑块 max 在拿到时长前只是占位值，越界会让 ffmpeg 取不到帧（画面没有内容）
    $('cvAtRange').addEventListener('input', function () {
      if (cv.syncing) return;
      var v = Math.max(0, Number($('cvAtRange').value) || 0);
      if (cv.duration > 0.1) v = Math.min(v, cv.duration - 0.05);
      cv.at = v;
      $('cvAt').value = cv.at.toFixed(1);
      cvRequestPreview({ immediate: false });
    });
    $('cvAtRange').addEventListener('change', function () {
      cvSyncAtControls();
      cvRequestPreview({ immediate: true });
    });
    $('cvAt').addEventListener('change', function () {
      cv.at = Math.max(0, cvNum($('cvAt'), 0));
      cvSyncAtControls();
      cvRequestPreview({ immediate: true });
    });
    $('cvAtRandom').addEventListener('click', function () {
      var max = cv.duration > 0.2 ? cv.duration - 0.1 : 0;
      cv.at = Math.round(Math.random() * Math.max(0, max) * 10) / 10;
      cvSyncAtControls();
      cvRequestPreview({ immediate: true });
    });
    $('cvShowRaw').addEventListener('change', function () {
      var stage = $('cvCanvas');
      if (this.checked) stage.classList.add('cv-canvas--raw'); else stage.classList.remove('cv-canvas--raw');
    });
    $('cvSamplePrev').addEventListener('click', function () { cvSampleStep(-1); });
    $('cvSampleNext').addEventListener('click', function () { cvSampleStep(1); });
    $('cvBgPrev').addEventListener('click', function () { cvBgStep(-1); });
    $('cvBgNext').addEventListener('click', function () { cvBgStep(1); });
    $('cvScanBg').addEventListener('click', function () { cvScanBackgrounds(); });
    $('cvBgDir').addEventListener('change', function () { if (cv.params.bgMode === 'dir') cvScanBackgrounds(true); });
    $('cvBgPath').addEventListener('change', function () { cvRequestPreview({ immediate: true }); });

    // 选择类按钮复用主进程的既有对话框通道
    $('cvPickBgDir').addEventListener('click', function () {
      api.pick_directory('选择背景目录', cv.params.bgDir).then(function (d) {
        if (!d) return;
        cv.params.bgDir = String(d);
        $('cvBgDir').value = String(d);
        cvScanBackgrounds(true);
      }).catch(function (e) { toast('选择目录失败：' + ((e && e.message) || e), 'error'); });
    });
    $('cvPickBgPath').addEventListener('click', function () {
      api.pick_image(cv.params.bgPath).then(function (f) {
        if (!f) return;
        cv.params.bgPath = String(f);
        $('cvBgPath').value = String(f);
        cvRequestPreview({ immediate: true });
      }).catch(function (e) { toast('选择文件失败：' + ((e && e.message) || e), 'error'); });
    });
    $('cvPickWm').addEventListener('click', function () {
      api.pick_image(cv.params.watermark).then(function (f) {
        if (!f) return;
        cv.params.watermark = String(f);
        $('cvWm').value = String(f);
        cvRequestPreview({ immediate: true });
      }).catch(function (e) { toast('选择水印失败：' + ((e && e.message) || e), 'error'); });
    });

    // 预设
    $('cvPresetApply').addEventListener('click', cvApplyPreset);
    $('cvPresetSave').addEventListener('click', cvSavePreset);
    $('cvPresetDelete').addEventListener('click', cvDeletePreset);
    cvBindDrag();
  }

  function cvScanBackgrounds(auto) {
    if (!api || !api.canvas_list_backgrounds) return;
    var dir = cv.params.bgDir;
    if (!dir) { if (!auto) toast('请先选择背景目录', 'info'); return; }
    setStatus('正在扫描背景候选…');
    api.canvas_list_backgrounds(dir).then(function (r) {
      if (!r || !r.ok) { setStatus('背景扫描失败：' + ((r && r.error) || '未知原因')); return; }
      cv.bgTotal = r.matched || 0;
      cv.bgIndex = 0;
      cv.bgName = r.matched ? String(r.list[0].name || '') : '';
      setStatus('背景候选 ' + r.matched + ' / 扫描 ' + r.scanned + ' 个文件' + (r.matched ? '' : '（要求 1920×1080）'));
      cvUpdateBgInfo();
      cvRequestPreview({ immediate: true });
    }).catch(function (e) { setStatus('背景扫描失败：' + ((e && e.message) || e)); });
  }

  function cvBgStep(step) {
    if (cv.params.bgMode !== 'dir') { toast('只有「目录随机」模式支持切换背景', 'info'); return; }
    if (!cv.bgTotal) { cvScanBackgrounds(true); return; }
    cv.bgIndex = ((cv.bgIndex + step) % cv.bgTotal + cv.bgTotal) % cv.bgTotal;
    cvRequestPreview({ immediate: true });
  }

  // ── 参数预设（存设置库 app scope，双版本共用同一份）──
  function cvLoadPresets(selectName) {
    if (!api || !api.canvas_preset_list) return;
    api.canvas_preset_list().then(function (r) {
      var sel = $('cvPreset');
      if (!sel) return;
      var list = (r && r.ok && r.list) || [];
      sel.innerHTML = '<option value="">（未选择）</option>' + list.map(function (x) {
        return '<option value="' + esc(x.name) + '">' + esc(x.name) + '</option>';
      }).join('');
      if (selectName) sel.value = selectName;
    }).catch(function () {});
  }

  function cvSavePreset() {
    var name = window.prompt('预设名称（例如「带货竖版·0.74」）', '');
    if (name == null) return;
    name = String(name).trim();
    if (!name) { toast('预设名称不能为空', 'error'); return; }
    if (!api || !api.canvas_preset_save) return;
    api.canvas_preset_save(name, cv.params).then(function (r) {
      if (!r || !r.ok) { toast('保存预设失败：' + ((r && r.error) || '未知原因'), 'error'); return; }
      toast('已保存预设：' + name, 'ok');
      cvLoadPresets(name);
    }).catch(function (e) { toast('保存预设失败：' + ((e && e.message) || e), 'error'); });
  }

  function cvApplyPreset() {
    var sel = $('cvPreset');
    var name = sel ? String(sel.value || '') : '';
    if (!name) { toast('请先选择一个预设', 'info'); return; }
    api.canvas_preset_list().then(function (r) {
      var item = ((r && r.list) || []).filter(function (x) { return x.name === name; })[0];
      if (!item) { toast('预设不存在', 'error'); return; }
      cv.params = Object.assign({}, cv.params, item.params || {});
      cvApplyParamsToInputs();
      cvRequestPreview({ immediate: true });
      toast('已加载预设：' + name, 'ok');
    }).catch(function (e) { toast('加载预设失败：' + ((e && e.message) || e), 'error'); });
  }

  function cvDeletePreset() {
    var sel = $('cvPreset');
    var name = sel ? String(sel.value || '') : '';
    if (!name) { toast('请先选择要删除的预设', 'info'); return; }
    api.canvas_preset_delete(name).then(function (r) {
      if (!r || !r.ok) { toast('删除预设失败：' + ((r && r.error) || '未知原因'), 'error'); return; }
      toast('已删除预设：' + name, 'ok');
      cvLoadPresets();
    }).catch(function (e) { toast('删除预设失败：' + ((e && e.message) || e), 'error'); });
  }

  /** 把参数写回全部控件（用于预设加载与初始化） */
  function cvApplyParamsToInputs() {
    cv.syncing = true;
    try {
      var p = cv.params;
      var set = function (id, v) { var el = $(id); if (el) el.value = String(v); };
      set('cvTW', p.targetW); set('cvTH', p.targetH);
      set('cvBgMode', p.bgMode); set('cvBgColor', p.bgColor);
      set('cvBgDir', p.bgDir); set('cvBgPath', p.bgPath);
      set('cvBgBlur', p.bgBlur); set('cvBgBlurVal', p.bgBlur);
      set('cvScale', p.scale); set('cvScaleNum', p.scale);
      var st = $('cvStretch'); if (st) st.checked = !!p.stretch;
      $('cvStretchRow').hidden = !p.stretch;
      set('cvW', p.w); set('cvH', p.h);
      set('cvPos', p.posMode); set('cvDx', p.dx); set('cvDy', p.dy);
      set('cvRadius', p.radius); set('cvRadiusVal', p.radius);
      set('cvBorderW', p.borderW); set('cvBorderWVal', p.borderW);
      set('cvBorderColor', p.borderColor);
      set('cvWm', p.watermark);
    } finally { cv.syncing = false; }
    cvSyncBgRows();
  }

  function cvOnShow() {
    if (!cv.ready) return;
    // 切页时补齐样本清单（用户可能先选了文件夹再切到本页）
    if (!cv.meta) cvLoadSamples(true);      // 还没预览过 → 补齐清单并渲一帧（扫描完成后才渲）
    else cvLoadSamples(false);              // 已有预览 → 只刷新清单，不打扰
  }

  function cvInit() {
    if (cv.ready) return;
    cv.ready = true;
    cvBindControls();
    cvApplyParamsToInputs();
    cvLoadPresets();
    cvUpdateBgInfo();
    // 输入变化后的自动预览统一由 renderInputHint → cvLoadSamples(true) 负责（不再单独挂按钮监听，
    // 否则会在样本清单异步扫描完成前触发渲染，白报一次「未选择视频」）
    window.addEventListener('resize', function () { if (cv.box.w) cvPaintBox(); });
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
        if (name === 'canvas') cvOnShow();
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
    cvInit();
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
        setStatus('就绪 —— 选好文件夹、勾选要做的处理后点「开始处理」');
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
