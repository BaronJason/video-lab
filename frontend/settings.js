// -*- coding: utf-8 -*-
// Video Lab — 设置窗口逻辑（通用设置 / 批量拼接 / 视频复刻）
'use strict';
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var api = window.txapi;

  // 数字输入框：禁用滚轮滚动改值（仅保留手动输入）
  document.addEventListener('wheel', function (ev) {
    var t = ev.target;
    if (t && t.tagName === 'INPUT' && (t.type === 'number' || t.type === 'range')) ev.preventDefault();
  }, { passive: false });

  var THEMES = [
    { id: 'white_blue', label: '白蓝', bg: '#F5F5F5', theme: '#4B3FE3' },
    { id: 'Black_Orange', label: '黑橙', bg: '#111113', theme: '#FF6600' },
    { id: 'Maid_Atelier', label: '深海女仆', bg: '#0e1d49', theme: '#c5a468' }
  ];
  var state = {
    batch: { max_duration: '', max_retry: '', speed_limit: '', txt_prefix: [], producer: '', suffix_mark: '' },
    replica: { max_duration: '', speed_limit: '', dedup_ratio: '' },
    mask: { root: '', watermark_mov: '', watermark_alpha: '' }
  };
  // 保存按钮启用跟踪：记录加载后的原始值，任意一行变动即高亮该行并启用保存
  var origValues = {};
  var originalSkin = null;

  // 轻量 Markdown 渲染（标题 / 有序无序列表 / 表格 / 引用 / 行内链接与粗体 / 代码块 / 空行）
  function renderMd(text) {
    var esc = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
    // 行内：剥离 img 标签 → 转义 → 反引号代码 / **粗体** / [text](url) / <url>
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
      // 表格：收集连续 | 行
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
      // 引用
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

  // 为每个输入框左侧插入红色 *（未保存时显示）
  function wrapAllInputs() {
    document.querySelectorAll('.form-input').forEach(function (input) {
      if (input.dataset.wrapped) return;
      // 端口/令牌输入框不参与包裹：无必填 *、不被场行强制整行宽（保持自定义宽度）
      if (input.id === 'httpPort' || input.id === 'httpToken') {
        input.dataset.wrapped = '1';
        input.addEventListener('input', recomputeDirty);
        input.addEventListener('change', recomputeDirty);
        return;
      }
      input.dataset.wrapped = '1';
      var wrap = document.createElement('div');
      wrap.className = 'field-row';
      var mark = document.createElement('span');
      mark.className = 'field-row__mark';
      mark.textContent = '*';
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(mark);
      wrap.appendChild(input);
      input.addEventListener('input', recomputeDirty);
      input.addEventListener('change', recomputeDirty);
    });
  }

  function captureOriginals() {
    origValues = {};
    document.querySelectorAll('.form-input').forEach(function (input) { origValues[input.id] = String(input.value); });
    document.querySelectorAll('input[type=checkbox]').forEach(function (input) { origValues[input.id] = input.checked; });
    // 同名 radio 视为一组，只记录组内当前选中值，避免后项覆盖导致误判
    var seenRadios = {};
    document.querySelectorAll('input[type=radio]').forEach(function (input) {
      if (seenRadios[input.name]) return;
      seenRadios[input.name] = true;
      var checked = document.querySelector('input[type=radio][name="' + input.name + '"]:checked');
      origValues['radio:' + input.name] = checked ? checked.value : '';
    });
    originalSkin = document.documentElement.getAttribute('data-skin');
  }

  function recomputeDirty() {
    var dirty = false;
    document.querySelectorAll('.form-input').forEach(function (input) {
      var group = input.closest('.form-group');
      var changed = origValues[input.id] !== undefined && String(input.value) !== origValues[input.id];
      if (changed) dirty = true;
      if (group) group.classList.toggle('is-dirty', changed);
    });
    document.querySelectorAll('input[type=checkbox]').forEach(function (input) {
      var group = input.closest('.form-group');
      var changed = origValues[input.id] !== undefined && input.checked !== origValues[input.id];
      if (changed) dirty = true;
      if (group) group.classList.toggle('is-dirty', changed);
    });
    var seenRadios = {};
    document.querySelectorAll('input[type=radio]').forEach(function (input) {
      if (seenRadios[input.name]) return;
      seenRadios[input.name] = true;
      var group = input.closest('.form-group');
      var checked = document.querySelector('input[type=radio][name="' + input.name + '"]:checked');
      var changed = origValues['radio:' + input.name] !== undefined && (checked ? checked.value : '') !== origValues['radio:' + input.name];
      if (changed) dirty = true;
      if (group) group.classList.toggle('is-dirty', changed);
    });
    var themeGroup = $('themeRow') ? $('themeRow').closest('.form-group') : null;
    if (themeGroup) {
      var skinChanged = document.documentElement.getAttribute('data-skin') !== originalSkin;
      if (skinChanged) dirty = true;
      themeGroup.classList.toggle('is-dirty', skinChanged);
    }
    $('btnSave').disabled = false; // 保存按钮任何时候可用
    if (api && api.notify_dirty) api.notify_dirty(dirty);
  }

  function setSkin(id) {
    document.documentElement.setAttribute('data-skin', THEMES.some(function (t) { return t.id === id; }) ? id : THEMES[0].id);
    var items = document.querySelectorAll('#themeRow .theme-item');
    items.forEach(function (it) { it.classList.toggle('is-active', it.dataset.theme === id); });
  }

  function buildThemeRow() {
    var row = $('themeRow');
    THEMES.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'theme-item';
      b.dataset.theme = t.id;
      b.innerHTML = '<span class="theme-item__swatch"><i class="theme-item__bg" style="background:' + t.bg + '"></i><i class="theme-item__theme" style="background:' + t.theme + '"></i></span>' + t.label;
      b.addEventListener('click', function () { setSkin(t.id); recomputeDirty(); });
      row.appendChild(b);
    });
  }

  // 兼容旧单值（字符串）与新多值（数组）：字符串按分号/换行拆多值，否则单元素数组
  function toArr(v) {
    if (Array.isArray(v)) return v.map(function (x) { return String(x).trim(); }).filter(Boolean);
    var s = String(v == null ? '' : v).trim();
    if (!s) return [];
    return s.split(/[;\n]/).map(function (x) { return x.trim(); }).filter(Boolean);
  }

  // 多值输入（提取前缀/后缀）：回车添加 → tags 列表展示，可拖拽排序（顺序即成片名前后顺序），点击删除。
  // 列表默认折叠：输入框兼作折叠开关 —— 点击输入框/箭头展开，点击两者之外折叠；
  // 折叠态下 placeholder 显示已设项摘要，因此不展开也能看清配了什么。
  // storeRef 传「取数组的函数」（如 function () { return state.batch.txt_prefix; }）或直接传数组。
  // ⚠ 必须按函数取最新引用：loadSettings / bindSave 会整份替换 state.batch.txt_prefix 的引用，
  // 若此处捕获旧引用，渲染读到的会是空数组（已存项不显示），输入的新值也 push 进废弃数组（存不进去）。
  function setupMultiTags(inputId, listId, storeRef, onChange, caretId) {
    var input = $(inputId);
    var list = $(listId);
    if (!input || !list) return;
    var getStore = (typeof storeRef === 'function') ? storeRef : function () { return storeRef; };
    // 幂等：本函数在两条初始化流程中各被调用一次，重复绑定会让回车/失焦处理各跑两遍；
    // 但第二次仍需重新渲染 —— 配置可能在这两次调用之间才加载完，直接 return 会让已设项不显示
    if (input.dataset.mtBound === '1') { if (input._mtRender) input._mtRender(); return; }
    input.dataset.mtBound = '1';
    var caret = caretId ? $(caretId) : null;
    var group = input.closest ? input.closest('.form-group') : null;
    var expanded = false; // 默认折叠

    var summarize = function () {
      var store = getStore();
      if (!store.length) return '输入后回车添加，可添加多个';
      return '已设 ' + store.length + ' 项，点击可调整前后顺序';
    };
    var applyFold = function () {
      list.hidden = !expanded;
      if (caret) caret.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      if (group) group.classList.toggle('is-tags-open', expanded);
      input.placeholder = !getStore().length ? '输入后回车添加，可添加多个' : (expanded ? '回车继续添加…' : summarize());
    };
    var render = function () {
      var store = getStore(); // 每次渲染都取最新引用
      list.innerHTML = '';
      store.forEach(function (v, i) {
        var row = document.createElement('div');
        row.className = 'multi-tags__row';
        row.draggable = true;
        row.dataset.idx = i;
        row.innerHTML = '<span class="multi-tags__drag">&#9776;</span><span class="multi-tags__text" title="' + v.replace(/"/g, '&quot;') + '">' + v + '</span><button type="button" class="multi-tags__del" title="删除该项">&#10005;</button>';
        // 拖拽排序：行可拖，落到其它行前/后交换位置（顺序即成片名顺序）
        row.addEventListener('dragstart', function (e) { e.dataTransfer.setData('text/plain', String(i)); row.classList.add('multi-tags__row--drag'); });
        row.addEventListener('dragend', function () { row.classList.remove('multi-tags__row--drag'); });
        row.addEventListener('dragover', function (e) { e.preventDefault(); });
        row.addEventListener('drop', function (e) {
          e.preventDefault();
          var from = parseInt(e.dataTransfer.getData('text/plain'), 10);
          if (Number.isNaN(from) || from === i) return;
          var arr = getStore();
          var moved = arr.splice(from, 1)[0];
          arr.splice(i, 0, moved);
          render();
          if (onChange) onChange();
        });
        row.querySelector('.multi-tags__del').addEventListener('click', function () {
          getStore().splice(i, 1);
          render();
          if (onChange) onChange();
        });
        list.appendChild(row);
      });
      applyFold();
    };
    var expand = function (focusInput) {
      if (!expanded) { expanded = true; render(); }
      if (focusInput && document.activeElement !== input) input.focus();
    };
    var collapse = function () { if (expanded) { expanded = false; render(); } };

    input.addEventListener('mousedown', function () { expand(false); });
    input.addEventListener('focus', function () { expand(false); });
    if (caret) {
      caret.addEventListener('mousedown', function (e) { e.preventDefault(); }); // 不让箭头抢走输入焦点
      caret.addEventListener('click', function () { if (expanded) collapse(); else expand(true); });
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        var v = input.value.trim();
        var arr = getStore();
        if (v && arr.indexOf(v) === -1) { arr.push(v); input.value = ''; expanded = true; render(); if (onChange) onChange(); }
        else if (!v) { render(); }
      }
    });
    input.addEventListener('blur', function () {
      var v = input.value.trim();
      var arr = getStore();
      if (v && arr.indexOf(v) === -1) { arr.push(v); input.value = ''; render(); if (onChange) onChange(); }
    });
    // 点击输入框与列表之外的区域折叠；列表内部的拖拽/删除不触发，否则无法连续操作
    document.addEventListener('mousedown', function (e) {
      if (!expanded) return;
      var t = e.target;
      if (input.contains(t) || list.contains(t) || (caret && caret.contains(t))) return;
      collapse();
    });
    input._mtRender = render; // 供重复调用时刷新（见上方幂等分支）
    render();
  }

  function updatePreview() {
    // 预览里只用占位符「前缀」表示该段：实际命中哪几个前缀要到运行时才判定
    // （多命中会按设置顺序全部写入、以 - 分隔），此处展开真实值反而误导
    var prefixCount = toArr(state.batch.txt_prefix).length;
    var producer = $('batchProducer').value.trim();
    var suffixMark = String(state.batch.suffix_mark || '');
    var now = new Date();
    var datePrefix = String(now.getFullYear()).slice(2)
      + String(now.getMonth() + 1).padStart(2, '0')
      + String(now.getDate()).padStart(2, '0');
    var items = [datePrefix];
    if (producer) items.push(producer);
    if (prefixCount) items.push('前缀');
    items.push('项目文件夹');
    items.push('TXT配置名');
    var name = items.join('-').replace(/-{2,}/g, '-') + '-' + suffixMark + '1.mp4';
    $('batchNamePreview').textContent = name;
  }

  // 多值标签（提取前缀 / 后缀）增删或改序后：刷新成片名预览并重算「未保存」标记。
  // ⚠ 必须定义在顶层：loadSettings 的回调与 bindSave 两处都要引用它 ——
  // 曾误定义在 bindSave 内部，导致 loadSettings 回调求值该标识符时抛 ReferenceError，
  // 被外层 .catch 捕获后报「读取设置失败」，且整个设置页只加载到一半。
  function onBatchTagsChanged() { updatePreview(); recomputeDirty(); }

  // 每日定时检查更新时间下拉：24 小时制整点选项（默认 9:00）
  function fillCheckUpdateHourOptions() {
    var sel = $('checkUpdateHour');
    if (!sel || sel.options.length > 0) return;
    for (var i = 0; i < 24; i++) {
      var o = document.createElement('option');
      o.value = i;
      o.textContent = i + ':00';
      if (i === 9) o.selected = true;
      sel.appendChild(o);
    }
  }

  function loadSettings() {
    fillCheckUpdateHourOptions();
    api.get_settings().then(function (s) {
      if (!s) return;
      setSkin(s.skin);
      $('cfgRoot').value = s.root || '';
      var chk = $('autoCheckUpdate');
      if (chk) chk.checked = s.auto_check_update !== false;
      var cd = $('checkUpdateDaily');
      if (cd) cd.checked = s.check_update_daily === true;
      var ch = $('checkUpdateHour');
      if (ch) ch.value = (s.check_update_hour >= 0 && s.check_update_hour <= 23) ? s.check_update_hour : 9;
      var as = $('autoStart');
      if (as) as.checked = s.autostart === true;
      var nte = $('notifyTaskEnd');
      if (nte) nte.checked = s.notify_task_end !== false;   // 默认开启
      var bd = $('backupDir');
      if (bd) {
        bd.value = s.backup_dir || '';
        // 占位符直接显示实际默认地址（比文字解释更直观）
        if (s.backup_dir_effective) bd.placeholder = s.backup_dir_effective;
      }
      var bac = $('backupAutoClean');
      if (bac) bac.checked = s.backup_auto_clean === true;
      var bkd = $('backupKeepDays');
      if (bkd) bkd.value = String(s.backup_keep_days || 7);
      var cbv = s.close_behavior === 'exit' ? 'exit' : 'tray';
      document.querySelectorAll('input[name="closeBehavior"]').forEach(function (r) { r.checked = r.value === cbv; });
      document.querySelectorAll('input[name="updateSource"]').forEach(function (r) { r.checked = r.value === s.update_source; });
      var um = s.update_mode === 'auto' ? 'auto' : 'notify';
      document.querySelectorAll('input[name="updateMode"]').forEach(function (r) { r.checked = r.value === um; });
      var storage = s.config_storage === 'appdata' ? 'appdata' : 'program';
      document.querySelectorAll('input[name="configStorage"]').forEach(function (r) { r.checked = r.value === storage; });
      var hp = $('httpPort'); if (hp) hp.value = s.http_port || 9527;
      var htk = $('httpToken');
      if (htk) htk.value = s.http_token || '';
      // 访问链接：可点击直访（a 标签），随端口/token 变化实时重建
      function refreshHttpUrl() {
        var hu = $('httpUrl');
        if (!hu) return;
        var port = parseInt(($('httpPort') || {}).value, 10) || 9527;
        var tk = (($('httpToken') || {}).value || '').trim() || (s.http_token || '');
        if (tk) {
          hu.textContent = 'http://localhost:' + port + '/?token=' + tk;
          hu.href = hu.textContent;
          hu.title = '点击在浏览器中打开该访问地址';
        } else {
          hu.textContent = '浏览器访问地址待生成';
          hu.href = '#';
          hu.title = '保存后生成浏览器访问地址';
        }
      }
      refreshHttpUrl();
      var hpInp = $('httpPort'); if (hpInp) hpInp.addEventListener('input', refreshHttpUrl);
      var tkInp = $('httpToken'); if (tkInp) tkInp.addEventListener('input', refreshHttpUrl);
      // 点击访问链接：浏览器侧直接新标签打开；本体用 open_external
      var urlLink = $('httpUrl');
      if (urlLink) urlLink.addEventListener('click', function (e) {
        var href = urlLink.getAttribute('href');
        if (!href || href === '#') { e.preventDefault(); setStatus('浏览器访问地址尚未生成', false); return; }
        e.preventDefault();
        if (location.protocol.startsWith('http')) { try { window.open(href); } catch (err) {} return; }
        if (api && api.open_external) api.open_external(href).catch(function () {});
        else try { window.open(href); } catch (err) {}
      });
      // 随机生成令牌：32 位十六进制（与后端生成规则一致），并重建链接
      var genBtn = $('btnGenToken');
      if (genBtn) genBtn.addEventListener('click', function () {
        var bytes = [];
        for (var i2 = 0; i2 < 16; i2++) bytes.push(Math.floor(Math.random() * 256));
        var hex = bytes.map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
        if (htk) { htk.value = hex; }
        refreshHttpUrl();
        recomputeDirty();
      });
      var pp = $('cfgPathProgram'), pa = $('cfgPathAppdata');
      if (pp) pp.textContent = s.config_path_program || '';
      if (pa) pa.textContent = s.config_path_appdata || '';
      var ld = $('logDirPath');
      if (ld) ld.textContent = s.log_dir || '';
      var cdp = $('cfgDirPath');
      if (cdp) cdp.textContent = s.config_path || '';
      // 「维护」板块可见性：config.json 的 show_maintenance（用户侧默认关闭；本机可置 true）
      var mtOn = s.show_maintenance === true;
      var mtNav = document.querySelector('.settings-nav__item[data-view="maintenance"]');
      var mtView = $('view-maintenance');
      if (mtNav) mtNav.style.display = mtOn ? '' : 'none';
      if (mtView) mtView.style.display = mtOn ? '' : 'none';
      var b = s.batch || {};
      $('batchSuffixMark').value = b.suffix_mark != null ? b.suffix_mark : '';
      $('batchMaxDuration').value = b.max_duration != null ? b.max_duration : '';
      $('batchMaxRetry').value = b.max_retry != null ? b.max_retry : '';
      $('batchSpeedLimit').value = b.speed_limit != null ? b.speed_limit : '';
      state.batch.txt_prefix = toArr(b.txt_prefix);
      $('batchProducer').value = b.producer != null ? b.producer : '';
      var r = s.replica || {};
      $('replicaMaxDuration').value = r.max_duration != null ? r.max_duration : '';
      $('replicaSpeedLimit').value = r.speed_limit != null ? r.speed_limit : '';
      $('replicaDedupRatio').value = r.dedup_ratio != null ? r.dedup_ratio : '';
      var mk = s.mask || {};
      $('maskRoot').value = mk.root || '';
      $('maskWatermark').value = mk.watermark_mov || '';
      $('maskAlpha').value = mk.watermark_alpha != null && String(mk.watermark_alpha).trim() !== '' ? mk.watermark_alpha : '';
      setupMultiTags('batchTxtPrefix', 'batchTxtPrefixTags', function () { return state.batch.txt_prefix; }, onBatchTagsChanged, 'batchTxtPrefixCaret');
      updatePreview();
      captureOriginals();
      recomputeDirty();
    }).catch(function (e) { setStatus('读取设置失败：' + ((e && e.message) || e), false); });
  }

  // 轻量角落提示（toast）：仅告知、无需操作，自动消失。type：ok/error/info/warn
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
    el.querySelector('.toast__text').textContent = String(message || '');
    host.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('toast--show'); });
    setTimeout(function () {
      el.classList.remove('toast--show');
      setTimeout(function () { try { el.remove(); } catch (e) {} }, 300);
    }, 3200);
  }
  function setStatus(msg, ok) {
    var el = $('settingsStatus');
    var s = String(msg || '');
    // 过程提示（「正在…」）只写状态栏小字；结果提示只走 toast —— 同一件事不再双份提示
    var isProgress = /^正在/.test(s) || /…$/.test(s) || /\.\.\.$/.test(s);
    if (isProgress) {
      el.textContent = s;
      el.classList.toggle('is-error', !ok);
      return;
    }
    el.textContent = '';
    el.classList.remove('is-error');
    // ⚠ ok 必须显式传：省略会被当作成功（走 'ok' 样式），错误提示务必传 false
    if (s) toast(s, ok === false ? 'error' : 'ok');
  }
  function statusTimer() { setStatus('', true); }

  var btnSave = $('btnSave');
  if (btnSave) btnSave.disabled = false; // 保存按钮任何时候可用

  function bindNav() {
    var changelogLoaded = false;
    var changelogLoading = false;
    function loadChangelog() {
      if (changelogLoaded || changelogLoading) return;
      changelogLoading = true;
      var hint = $('changelogHint');
      if (hint) hint.textContent = '正在加载…';
      api.get_changelog().then(function (r) {
        changelogLoading = false;
        if (!r || !r.ok) {
          if (hint) hint.textContent = '更新日志加载失败：' + ((r && r.error) || '未知错误');
          return;
        }
        changelogLoaded = true;
        var box = $('changelogBox');
        if (box) { box.innerHTML = ''; var frag = document.createElement('div'); frag.innerHTML = renderMd(r.content || ''); box.appendChild(frag); }
        if (hint) hint.parentNode && hint.parentNode.removeChild(hint);
      }).catch(function (e) {
        changelogLoading = false;
        if (hint) hint.textContent = '更新日志加载失败：' + e.message;
      });
    }
    var aboutLoaded = false;
    var aboutLoading = false;
    function loadAbout() {
      if (aboutLoaded || aboutLoading) return;
      aboutLoading = true;
      var hint = $('aboutHint');
      if (hint) hint.textContent = '正在加载…';
      api.get_readme().then(function (r) {
        aboutLoading = false;
        if (!r || !r.ok) {
          if (hint) hint.textContent = '内容加载失败：' + ((r && r.error) || '未知错误');
          return;
        }
        aboutLoaded = true;
        var box = $('aboutBox');
        if (box) { box.innerHTML = ''; var frag = document.createElement('div'); frag.innerHTML = renderMd(r.content || ''); box.appendChild(frag); }
        if (hint) hint.parentNode && hint.parentNode.removeChild(hint);
      }).catch(function (e) {
        aboutLoading = false;
        if (hint) hint.textContent = '内容加载失败：' + e.message;
      });
    }
    document.querySelectorAll('.settings-nav__item').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.settings-nav__item').forEach(function (x) { x.classList.remove('is-active'); });
        document.querySelectorAll('.settings-view').forEach(function (v) { v.classList.remove('is-active'); });
        btn.classList.add('is-active');
        var view = $('view-' + btn.dataset.view);
        if (view) view.classList.add('is-active');
        if (btn.dataset.view === 'changelog') loadChangelog();
        else if (btn.dataset.view === 'about') loadAbout();
      });
    });
    document.querySelectorAll('[data-dir]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var inputId = btn.dataset.dir;
        var cur = $(inputId).value.trim();
        // 输入框留空时，以 placeholder 显示的实际默认地址作为对话框初始位置（而非无关的工作路径）
        var startAt = cur || $(inputId).placeholder || undefined;
        api.pick_directory('选择目录', startAt).then(function (p) { if (p) { $(inputId).value = p; recomputeDirty(); } });
      });
    });
    // 遮罩固定水印：选择 mov 文件
    var mw = $('btnMaskWatermark');
    if (mw) mw.addEventListener('click', function () {
      var cur = $('maskWatermark').value.trim();
      api.choose_mask_file(cur || undefined).then(function (r) {
        if (r && r.ok && r.path) { $('maskWatermark').value = r.path; recomputeDirty(); }
      }).catch(function () {});
    });
  }

  function bindSave() {
    $('btnSave').addEventListener('click', function () {
      state.batch.max_duration = $('batchMaxDuration').value.trim();
      state.batch.max_retry = $('batchMaxRetry').value.trim();
      state.batch.speed_limit = $('batchSpeedLimit').value.trim();
      state.batch.txt_prefix = (state.batch.txt_prefix || []).slice();
      state.batch.producer = $('batchProducer').value.trim();
      state.batch.suffix_mark = $('batchSuffixMark').value.trim();
      state.replica.max_duration = $('replicaMaxDuration').value.trim();
      state.replica.speed_limit = $('replicaSpeedLimit').value.trim();
      state.replica.dedup_ratio = $('replicaDedupRatio').value.trim();
      state.mask.root = $('maskRoot').value.trim();
      state.mask.watermark_mov = $('maskWatermark').value.trim();
      state.mask.watermark_alpha = $('maskAlpha').value.trim();

      var missing = [];
      var bn = ['max_duration', 'max_retry', 'speed_limit'];
      for (var i = 0; i < bn.length; i++) if (!(parseFloat(state.batch[bn[i]]) > 0)) missing.push('批量拼接·' + ({ max_duration: '最大时长', max_retry: '重试次数', speed_limit: '倍速阈值' })[bn[i]]);
      if (!state.batch.producer.trim()) missing.push('批量拼接·创作者名');
      
      var rn = ['max_duration', 'speed_limit', 'dedup_ratio'];
      for (var j = 0; j < rn.length; j++) if (!(parseFloat(state.replica[rn[j]]) > 0)) missing.push('视频复刻·' + ({ max_duration: '最大时长', speed_limit: '倍速阈值', dedup_ratio: '去重阈值' })[rn[j]]);
      if (missing.length) { setStatus('参数未设置：' + missing.join('、'), false); return; }

      var skin = document.documentElement.getAttribute('data-skin') || THEMES[0].id;
      var storageEl = document.querySelector('input[name="configStorage"]:checked');
      var srcEl = document.querySelector('input[name="updateSource"]:checked');
      var umEl = document.querySelector('input[name="updateMode"]:checked');
      var cbEl = document.querySelector('input[name="closeBehavior"]:checked');
      api.save_settings({
        skin: skin,
        root: $('cfgRoot').value.trim(),
        auto_check_update: !!$('autoCheckUpdate').checked,
        check_update_daily: !!$('checkUpdateDaily').checked,
        check_update_hour: parseInt($('checkUpdateHour').value, 10) || 9,
        autostart: !!$('autoStart').checked,
        notify_task_end: !!$('notifyTaskEnd').checked,
        backup_dir: ($('backupDir') && $('backupDir').value.trim()) || '',
        backup_auto_clean: !!($('backupAutoClean') && $('backupAutoClean').checked),
        backup_keep_days: parseInt(($('backupKeepDays') && $('backupKeepDays').value) || '7', 10) || 7,
        close_behavior: cbEl ? cbEl.value : 'tray',
        update_source: srcEl ? srcEl.value : 'gitee',
        update_mode: umEl ? umEl.value : 'notify',
        config_storage: storageEl ? storageEl.value : 'program',
        http_port: parseInt($('httpPort').value, 10) || 9527,
        http_token: (($('httpToken') || {}).value || '').trim(),
        batch: state.batch,
        replica: state.replica,
        mask: state.mask
      }).then(function (res) {
        if (res && res.ok) {
          setStatus('已保存', true); setTimeout(statusTimer, 2000); captureOriginals(); recomputeDirty();
          if (res.config_moved) setStatus('配置和数据位置已切换并生效，配置与缓存库已自动迁移', true);
        }
        else setStatus('保存失败', false);
      }).catch(function () { setStatus('保存失败', false); });
    });

    // 手动检查更新：发现新版本时在设置页内弹二次确认（是否下载）；下载进度/完成在主窗口体现
    var cu = $('btnCheckUpdate');
    var _confirmInfo = null;
    function showUpdateConfirm(info) {
      _confirmInfo = info;
      var t = $('updateConfirmTitle'), d = $('updateConfirmDesc');
      if (t) t.textContent = '发现新版本 v' + ((info && info.latest) || '');
      if (d) d.textContent = '是否立即下载更新？下载完成后可在主窗口继续操作。';
      var m = $('updateConfirmMask');
      if (m) m.style.display = 'flex';
    }
    function hideUpdateConfirm() { var m = $('updateConfirmMask'); if (m) m.style.display = 'none'; }
    if (cu) cu.addEventListener('click', function () {
      setStatus('正在检查更新…', true);
      api.check_update(false).then(function (info) {
        if (!info) { setStatus('检查更新失败', false); return; }
        if (info.busy) { setStatus('已有更新操作进行中，请稍候', true); return; }
        if (info.hasUpdate) {
          if (info.autoDownload) setStatus('发现新版本 v' + info.latest + '，已自动开始下载，进度见主窗口状态栏', true);
          else showUpdateConfirm(info);
        }
        else if (info.ok) setStatus('已是最新版本 v' + info.current, true);
        else setStatus('检查更新失败：' + (info.error || '未知错误'), false);
      }).catch(function () { setStatus('检查更新失败', false); });
    });
    var mCancel = $('updateConfirmCancel');
    if (mCancel) mCancel.addEventListener('click', function () { hideUpdateConfirm(); setStatus('已取消更新', true); });
    var mGo = $('updateConfirmGo');
    if (mGo) mGo.addEventListener('click', function () {
      hideUpdateConfirm();
      setStatus('已开始下载更新，进度见主窗口状态栏', true);
      if (api && api.start_update) api.start_update().then(function (r) {
        if (r && r.busy) { setStatus('已有更新操作进行中，请稍候', true); return; }
        if (r && !r.ok) setStatus((r.error) || '启动更新失败', false);
      }).catch(function () { setStatus('下载更新失败', false); });
    });
    var mConfirmMask = $('updateConfirmMask');
    if (mConfirmMask) mConfirmMask.addEventListener('click', function (e) { if (e.target === mConfirmMask) hideUpdateConfirm(); });

    $('btnClose').addEventListener('click', function () {
      // iframe 内嵌模态（浏览器侧打开设置）：通知父窗口关闭模态；本体直接关窗口
      if (window.self !== window.top) { try { window.parent.postMessage({ type: 'vl-close-settings' }, '*'); } catch (e) {} return; }
      window.close();
    });
    // 未保存修改时关闭的二级确认浮层：取消返回设置，确认放弃修改直接关闭
    var discardPop = $('discardPop');
    var btnDiscardCancel = $('discardCancel');
    var btnDiscardConfirm = $('discardConfirm');
    function showDiscardPop() { if (discardPop) discardPop.style.display = ''; }
    function hideDiscardPop() { if (discardPop) discardPop.style.display = 'none'; }
    if (btnDiscardCancel) btnDiscardCancel.addEventListener('click', hideDiscardPop);
    if (btnDiscardConfirm) btnDiscardConfirm.addEventListener('click', function () {
      if (api && api.force_close_settings) api.force_close_settings();
    });
    if (api && api.on_confirm_discard) api.on_confirm_discard(showDiscardPop);
    document.addEventListener('mousedown', function (e) {
      if (discardPop && discardPop.style.display !== 'none' && !discardPop.contains(e.target)) hideDiscardPop();
    });
    setupMultiTags('batchTxtPrefix', 'batchTxtPrefixTags', function () { return state.batch.txt_prefix; }, onBatchTagsChanged, 'batchTxtPrefixCaret');
    $('batchSuffixMark').addEventListener('input', updatePreview);
    $('batchProducer').addEventListener('input', updatePreview);
  }

  function flashCloseButton() {
    var s = $('settingsStatus');
    if (!s) return;
    s.textContent = '有未保存的修改，请先保存';
    s.classList.remove('is-flash');
    void s.offsetWidth;
    s.classList.add('is-flash');
    setTimeout(function () { s.classList.remove('is-flash'); s.textContent = ''; }, 1600);
  }
  function init() {
    wrapAllInputs();
    // 勾选框/单选切换也参与未保存修改标记（保存按钮始终可用，此项用于关闭确认与高亮）
    document.querySelectorAll('input[type=checkbox], input[type=radio]').forEach(function (input) {
      input.addEventListener('change', recomputeDirty);
    });
    buildThemeRow();
    bindNav();
    bindSave();
    if (api && api.on_settings_flash_close) api.on_settings_flash_close(flashCloseButton);
    // 右上角 GitHub 按钮：打开主仓库主页
    var gh = document.getElementById('btnGitHub');
    if (gh && api && api.open_external) gh.addEventListener('click', function () {
      api.open_external('https://github.com/BaronJason/video-lab').catch(function () {});
    });
    // 「维护」区：重建预检测缓存（低频兜底操作）。两段式确认，避免误触这个耗时动作
    var brp = document.getElementById('btnRebuildPrecheck');
    if (brp && api && api.reset_precheck) brp.addEventListener('click', function () {
      if (brp.dataset.armed !== '1') {
        brp.dataset.armed = '1';
        brp.textContent = '再次点击确认重建';
        setStatus('将清空并重新检测全部素材，视频较多时较耗时', true);
        setTimeout(function () { if (brp.dataset.armed === '1') { brp.dataset.armed = '0'; brp.textContent = '重建'; } }, 4000);
        return;
      }
      brp.dataset.armed = '0';
      brp.disabled = true;
      brp.textContent = '重建中…';
      setStatus('正在重建预检测缓存…', true);
      api.reset_precheck().then(function (r) {
        brp.disabled = false;
        brp.textContent = '重建';
        setStatus('预检测缓存已重建：检测 ' + ((r && r.total) || 0) + ' 个视频，合规 ' + ((r && r.valid) || 0) + ' 个', true);
      }).catch(function (e) {
        brp.disabled = false;
        brp.textContent = '重建';
        setStatus('重建失败：' + ((e && e.message) || e), false);
      });
    });
    // 「配置和数据保存位置」行：打开当前生效的配置存储目录
    var openCfg = document.getElementById('btnOpenCfgDir');
    if (openCfg && api && api.open_path) openCfg.addEventListener('click', function () {
      var sel = document.querySelector('input[name="configStorage"]:checked');
      var isAppdata = sel && sel.value === 'appdata';
      var pp = document.getElementById('cfgPathProgram'), pa = document.getElementById('cfgPathAppdata');
      var dir = isAppdata ? (pa ? pa.textContent : '') : (pp ? pp.textContent : '');
      if (!dir) { setStatus('尚未确定保存目录', false); return; }
      api.open_path(dir).then(function (r) {
        if (!(r && r.ok)) toast('打开失败：' + ((r && r.error) || '路径不存在'), true);
      }).catch(function (e) { toast('打开失败：' + e.message, true); });
    });
    // 「运行日志」行：打开日志目录（排查时先找到文件）
    var openLog = document.getElementById('btnOpenLogDir');
    if (openLog && api && api.open_path) openLog.addEventListener('click', function () {
      var el = document.getElementById('logDirPath');
      var dir = el ? el.textContent : '';
      if (!dir) { setStatus('日志目录尚未就绪', false); return; }
      api.open_path(dir).then(function (r) {
        if (!(r && r.ok)) toast('打开失败：' + ((r && r.error) || '路径不存在'), true);
      }).catch(function () { setStatus('打开失败', false); });
    });
    // 复制浏览器访问地址（带安全令牌，供用户手动填入其他设备/分享）
    var btnCopyUrl = document.getElementById('btnOpenBrowserUrl');
    if (btnCopyUrl) btnCopyUrl.addEventListener('click', function () {
      var hu = document.getElementById('httpUrl');
      var url = hu ? hu.value : '';
      if (!url) { setStatus('浏览器访问地址尚未就绪', false); return; }
      function copyVia(txt) {
        var ta = document.createElement('textarea');
        ta.value = txt;
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () { setStatus('已复制浏览器访问地址', true); }).catch(function () { copyVia(url); setStatus('已复制浏览器访问地址', true); });
      } else { copyVia(url); setStatus('已复制浏览器访问地址', true); }
    });
    loadSettings();
    // 文档内 http 链接统一用系统默认浏览器打开（README/更新日志里的外部链接）
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href^="http"]') : null;
      if (!a) return;
      e.preventDefault();
      if (api && api.open_external) api.open_external(a.getAttribute('href')).catch(function () {});
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();