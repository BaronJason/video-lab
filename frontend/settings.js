// -*- coding: utf-8 -*-
// Video Lab — 设置窗口逻辑（通用设置 / 批量拼接 / 视频复刻）
'use strict';
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var api = window.txapi;

  var THEMES = [
    { id: 'white_blue', label: '白蓝', bg: '#F5F5F5', theme: '#4B3FE3' },
    { id: 'Black_Orange', label: '黑橙', bg: '#111113', theme: '#FF6600' },
    { id: 'Maid_Atelier', label: '深海女仆', bg: '#0e1d49', theme: '#c5a468' }
  ];
  var state = {
    batch: { max_duration: '', max_retry: '', speed_limit: '', txt_prefix: '', producer: '', suffix_mark: '' },
    replica: { max_duration: '', speed_limit: '', dedup_ratio: '' }
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

  function updatePreview() {
    var prefix = $('batchTxtPrefix').value.trim();
    var producer = $('batchProducer').value.trim();
    var suffixMark = $('batchSuffixMark').value.trim() || 'YX';
    var now = new Date();
    var datePrefix = String(now.getFullYear()).slice(2)
      + String(now.getMonth() + 1).padStart(2, '0')
      + String(now.getDate()).padStart(2, '0');
    var items = [datePrefix];
    if (producer) items.push(producer);
    if (prefix) items.push(prefix.replace(/-+$/g, ''));
    items.push('项目文件夹');
    items.push('TXT配置名');
    var name = items.join('-').replace(/-{2,}/g, '-') + '-' + suffixMark + '1.mp4';
    $('batchNamePreview').textContent = name;
  }

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
      var cbv = s.close_behavior === 'exit' ? 'exit' : 'tray';
      document.querySelectorAll('input[name="closeBehavior"]').forEach(function (r) { r.checked = r.value === cbv; });
      document.querySelectorAll('input[name="updateSource"]').forEach(function (r) { r.checked = r.value === s.update_source; });
      var um = s.update_mode === 'auto' ? 'auto' : 'notify';
      document.querySelectorAll('input[name="updateMode"]').forEach(function (r) { r.checked = r.value === um; });
      var storage = s.config_storage === 'appdata' ? 'appdata' : 'program';
      document.querySelectorAll('input[name="configStorage"]').forEach(function (r) { r.checked = r.value === storage; });
      var pp = $('cfgPathProgram'), pa = $('cfgPathAppdata');
      if (pp) pp.textContent = s.config_path_program || '';
      if (pa) pa.textContent = s.config_path_appdata || '';
      var b = s.batch || {};
      $('batchSuffixMark').value = b.suffix_mark != null ? b.suffix_mark : '';
      $('batchMaxDuration').value = b.max_duration != null ? b.max_duration : '';
      $('batchMaxRetry').value = b.max_retry != null ? b.max_retry : '';
      $('batchSpeedLimit').value = b.speed_limit != null ? b.speed_limit : '';
      $('batchTxtPrefix').value = b.txt_prefix != null ? b.txt_prefix : '';
      $('batchProducer').value = b.producer != null ? b.producer : '';
      var r = s.replica || {};
      $('replicaMaxDuration').value = r.max_duration != null ? r.max_duration : '';
      $('replicaSpeedLimit').value = r.speed_limit != null ? r.speed_limit : '';
      $('replicaDedupRatio').value = r.dedup_ratio != null ? r.dedup_ratio : '';
      updatePreview();
      captureOriginals();
      recomputeDirty();
    }).catch(function () { setStatus('读取设置失败'); });
  }

  function setStatus(msg, ok) {
    var el = $('settingsStatus');
    el.textContent = msg;
    el.classList.toggle('is-error', !ok);
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
        api.pick_directory('选择目录', cur || undefined).then(function (p) { if (p) { $(inputId).value = p; recomputeDirty(); } });
      });
    });
  }

  function bindSave() {
    $('btnSave').addEventListener('click', function () {
      state.batch.suffix_mark = $('batchSuffixMark').value.trim();
      state.batch.max_duration = $('batchMaxDuration').value.trim();
      state.batch.max_retry = $('batchMaxRetry').value.trim();
      state.batch.speed_limit = $('batchSpeedLimit').value.trim();
      state.batch.txt_prefix = $('batchTxtPrefix').value.trim();
      state.batch.producer = $('batchProducer').value.trim();
      state.replica.max_duration = $('replicaMaxDuration').value.trim();
      state.replica.speed_limit = $('replicaSpeedLimit').value.trim();
      state.replica.dedup_ratio = $('replicaDedupRatio').value.trim();

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
        close_behavior: cbEl ? cbEl.value : 'tray',
        update_source: srcEl ? srcEl.value : 'gitee',
        update_mode: umEl ? umEl.value : 'notify',
        config_storage: storageEl ? storageEl.value : 'program',
        batch: state.batch,
        replica: state.replica
      }).then(function (res) {
        if (res && res.ok) {
          setStatus('已保存', true); setTimeout(statusTimer, 2000); captureOriginals(); recomputeDirty();
          if (res.config_moved) setStatus('配置和数据位置已切换并生效，配置与 Cache 已自动迁移', true);
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

    $('btnClose').addEventListener('click', function () { window.close(); });
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
    $('batchSuffixMark').addEventListener('input', updatePreview);
    $('batchTxtPrefix').addEventListener('input', updatePreview);
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
    // 「配置和数据保存位置」行：打开当前生效的配置存储目录
    var openCfg = document.getElementById('btnOpenCfgDir');
    if (openCfg && api && api.open_path) openCfg.addEventListener('click', function () {
      var sel = document.querySelector('input[name="configStorage"]:checked');
      var isAppdata = sel && sel.value === 'appdata';
      var pp = document.getElementById('cfgPathProgram'), pa = document.getElementById('cfgPathAppdata');
      var dir = isAppdata ? (pa ? pa.textContent : '') : (pp ? pp.textContent : '');
      if (!dir) { setStatus('尚未确定保存目录', false); return; }
      api.open_path(dir).then(function (r) {
        if (!(r && r.ok)) setStatus('打开失败：' + ((r && r.error) || '路径不存在'), false);
      }).catch(function () { setStatus('打开失败', false); });
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