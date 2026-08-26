// -*- coding: utf-8 -*-
// Video Lab — 首次引导窗口（选择工作路径；水印自动配置）
'use strict';
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var api = window.txapi;

  function setStatus(msg, ok) {
    var el = $('guideStatus');
    if (!el) return;
    el.textContent = msg || '';
    if (el.classList) el.classList.toggle('is-error', !ok);
  }

  // 跳过引导：用户使用窗口自带关闭按钮（右上角 X）即可，不保存直接关闭

  // 用户主动点击按钮才弹资源管理器
  $('guidePick').addEventListener('click', function () {
    api.pick_directory('选择项目数据工作路径', '').then(function (p) {
      if (p) { $('guideRoot').value = p; setStatus('', true); }
    }).catch(function () { setStatus('选择目录失败', false); });
  });

  $('guideSave').addEventListener('click', function () {
    var root = $('guideRoot').value.trim();
    if (!root) { setStatus('请先选择工作路径', false); return; }
    $('guideSave').disabled = true;
    api.save_guide({ root: root }).then(function (r) {
      if (r && r.ok) { window.close(); return; }
      $('guideSave').disabled = false;
      setStatus('保存失败：' + ((r && r.error) || '未知错误'), false);
    }).catch(function () { $('guideSave').disabled = false; setStatus('保存失败', false); });
  });
})();