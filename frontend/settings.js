// -*- coding: utf-8 -*-
// Video Lab — 设置窗口逻辑（通用设置 / 批量拼接 / 视频复刻）
'use strict';
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var api = window.txapi;

  var THEMES = [
    { id: 'white_blue', label: '白蓝', bg: '#F5F5F5', theme: '#4B3FE3' },
    { id: 'Black_Orange', label: '黑橙', bg: '#111113', theme: '#FF6600' },
    { id: 'Gray_Orange', label: '灰橙', bg: '#424247', theme: '#FF9500' }
  ];
  var state = {
    batch: { max_duration: '', max_retry: '', speed_limit: '', txt_prefix: '', producer: '', suffix_mark: '' },
    replica: { max_duration: '', speed_limit: '', dedup_ratio: '' }
  };
  // 保存按钮启用跟踪：记录加载后的原始值，任意一行变动即高亮该行并启用保存
  var origValues = {};
  var originalSkin = null;

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
    var themeGroup = $('themeRow') ? $('themeRow').closest('.form-group') : null;
    if (themeGroup) {
      var skinChanged = document.documentElement.getAttribute('data-skin') !== originalSkin;
      if (skinChanged) dirty = true;
      themeGroup.classList.toggle('is-dirty', skinChanged);
    }
    $('btnSave').disabled = !dirty;
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

  function loadSettings() {
    api.get_settings().then(function (s) {
      if (!s) return;
      setSkin(s.skin);
      $('cfgRoot').value = s.root || '';
      $('cfgWatermark').value = s.watermark_dir || '';
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

  function bindNav() {
    document.querySelectorAll('.settings-nav__item').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.settings-nav__item').forEach(function (x) { x.classList.remove('is-active'); });
        document.querySelectorAll('.settings-view').forEach(function (v) { v.classList.remove('is-active'); });
        btn.classList.add('is-active');
        var view = $('view-' + btn.dataset.view);
        if (view) view.classList.add('is-active');
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
      api.save_settings({
        skin: skin,
        root: $('cfgRoot').value.trim(),
        watermark_dir: $('cfgWatermark').value.trim(),
        batch: state.batch,
        replica: state.replica
      }).then(function (res) {
        if (res && res.ok) { setStatus('已保存', true); setTimeout(statusTimer, 2000); captureOriginals(); recomputeDirty(); }
        else setStatus('保存失败', false);
      }).catch(function () { setStatus('保存失败', false); });
    });

    $('btnClose').addEventListener('click', function () { window.close(); });
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
    buildThemeRow();
    bindNav();
    bindSave();
    if (api && api.on_settings_flash_close) api.on_settings_flash_close(flashCloseButton);
    loadSettings();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();