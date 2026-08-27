// -*- coding: utf-8 -*-
// 自制窗口标题栏（方案A）：标题居中 + 最小化/最大化/关闭控制
// 依赖 preload 暴露的 txapi.window_* 系列；无 txapi（纯浏览器预览）时按钮静默无操作。
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function applyCaps() {
    var bar = $('winTitlebar');
    if (!bar || !window.txapi || !txapi.window_caps) return;
    txapi.window_caps().then(function (caps) {
      caps = caps || {};
      var min = bar.querySelector('[data-wctl="min"]');
      var max = bar.querySelector('[data-wctl="max"]');
      var close = bar.querySelector('[data-wctl="close"]');
      if (min) min.style.display = caps.minimizable ? '' : 'none';
      if (max) max.style.display = caps.maximizable ? '' : 'none';
      if (close) close.style.display = caps.closable ? '' : 'none';
      var title = bar.querySelector('.win-titlebar__title');
      if (title) title.textContent = String(document.title || '').replace(/^Video Lab\s*-\s*/, '') || 'Video Lab';
    }).catch(function () {});
  }
  function syncMaxIcon() {
    var bar = $('winTitlebar');
    if (!bar) return;
    var max = bar.querySelector('[data-wctl="max"]');
    if (!max) return;
    var active = !!(bar.getAttribute('data-max') === '1');
    // 最大/还原：切换 svg 图形
    var svg = max.querySelector('.win-titlebar__svg-max');
    var svgR = max.querySelector('.win-titlebar__svg-restore');
    if (svg) svg.style.display = active ? 'none' : '';
    if (svgR) svgR.style.display = active ? '' : 'none';
  }
  function init() {
    var bar = $('winTitlebar');
    if (!bar) return;
    bar.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-wctl]');
      if (!btn || !window.txapi) return;
      var c = btn.getAttribute('data-wctl');
      if (c === 'min' && txapi.window_minimize) txapi.window_minimize();
      else if (c === 'max' && txapi.window_toggle_maximize) txapi.window_toggle_maximize();
      else if (c === 'close' && txapi.window_close) txapi.window_close();
    });
    // 双击空白区最大化/还原（按钮 no-drag 不受影响）
    bar.addEventListener('dblclick', function (e) {
      if (bcloseBtn(e.target)) return;
      if (window.txapi && txapi.window_toggle_maximize) txapi.window_toggle_maximize();
    });
    function bcloseBtn(el) { return !!(el && el.closest && el.closest('[data-wctl]')); }
    if (window.txapi && txapi.on_window_max_changed) {
      txapi.on_window_max_changed(function (m) {
        if (m) bar.setAttribute('data-max', '1'); else bar.removeAttribute('data-max');
        syncMaxIcon();
      });
    }
    applyCaps();
    syncMaxIcon();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();