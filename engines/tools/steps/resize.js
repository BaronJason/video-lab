// 步骤 · 转分辨率
//
// 来源：这个能力原先**散落在两个脚本里**没有独立出来 ——
//   `重编码5000.ps1` 的 `enableScaleCheck`（强制缩放 + 校验分辨率）、
//   `叠广审+加速3min.ps1` 里写死的 `scale=1080:1920`（第 166 行）。本步骤把它抽为可独立使用的能力。
//
// ★ 竖版缩到横版尺寸若直接 `scale=W:H` 会**拉伸变形** ——
//   等比方式必须用 `-2`（自动推算另一维，且保证偶数，h264 编码要求）。
'use strict';

module.exports = {
  id: 'resize',
  title: '转分辨率',
  group: '画面',
  danger: '',
  schema: [
    { key: 'mode', label: '方式', type: 'select', default: '固定尺寸',
      options: ['固定尺寸', '按长边等比', '按宽等比', '按高等比'],
      hint: '「等比」不会拉伸；「固定尺寸」按原样拉伸到指定宽高' },
    { key: 'width', label: '宽', type: 'number', default: 1080, min: 16 },
    { key: 'height', label: '高', type: 'number', default: 1920, min: 16 },
    { key: 'longEdge', label: '长边', type: 'number', default: 1920, min: 16,
      hint: '按长边等比时使用：横版缩放宽度、竖版缩放高度' },
  ],

  /** @returns {null|{skip?:boolean, expr?:string, note:string}} */
  decide(info, params) {
    const mode = String((params && params.mode) || '固定尺寸');
    const W = Number((params && params.width) || 1080);
    const H = Number((params && params.height) || 1920);
    const L = Number((params && params.longEdge) || 1920);
    const sw = Number((info && info.width) || 0);
    const sh = Number((info && info.height) || 0);
    if (!sw || !sh) return null;

    if (mode === '固定尺寸') {
      if (sw === W && sh === H) return { skip: true, note: '已是目标尺寸 ' + W + '×' + H };
      const deform = Math.abs((sw / sh) - (W / H)) > 0.01;
      return {
        expr: 'scale=' + W + ':' + H,
        note: '缩放至 ' + W + '×' + H + (deform ? '（会改变宽高比）' : ''),
      };
    }

    if (mode === '按长边等比') {
      const landscape = sw >= sh;
      const curLong = landscape ? sw : sh;
      if (curLong === L) return { skip: true, note: '长边已是 ' + L };
      return {
        expr: landscape ? ('scale=' + L + ':-2') : ('scale=-2:' + L),
        note: '长边 ' + curLong + ' → ' + L + '（等比，不变形）',
      };
    }

    if (mode === '按宽等比') {
      if (sw === W) return { skip: true, note: '宽度已是 ' + W };
      return { expr: 'scale=' + W + ':-2', note: '宽 ' + sw + ' → ' + W + '（等比）' };
    }

    // 按高等比
    if (sh === H) return { skip: true, note: '高度已是 ' + H };
    return { expr: 'scale=-2:' + H, note: '高 ' + sh + ' → ' + H + '（等比）' };
  },

  filter(decision) {
    if (!decision || decision.skip || !decision.expr) return { video: [], audio: [] };
    return { video: [decision.expr], audio: [] };
  },
};
