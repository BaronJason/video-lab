// 步骤 · 叠加图片
//
// 原脚本做法（scripts-archive/视频工具/叠广审+加速3min.ps1）：
//   把 PNG 作为**额外输入**，用 `[outv]overlay=0:0[wateredv]` 贴在画面左上角。
//   （原脚本用 txt 选片只是从批量拼接脚本继承下来的历史形态 —— 用户定案：
//     它本质上只是"额外叠加一张图片"，见计划 §1.4）
//
// 透明度用 `colorchannelmixer=aa=<alpha>`（与遮罩模块同一手法，计划 §附录 B）——
// 不另找办法，避免"叠加 + 透明度"两处实现不一致。
//
// ★ 单张图片作为输入即可：overlay 默认 repeatlast=1，会把最后（唯一）一帧持续贴上，
//   不需要 `-loop 1`（后者会引入无界帧流，反而要配 -shortest）。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);
const num = (v, d) => {
  const n = Number(v);
  return isFinite(n) ? n : d;
};

module.exports = {
  id: 'overlay',
  title: '叠加图片',
  group: '画面',
  danger: '',
  schema: [
    { key: 'image', label: '图片路径', type: 'file', default: '', fileTypes: ['png', 'jpg', 'jpeg', 'webp', 'bmp'],
      hint: '要叠加到画面上的图片（多为 PNG，建议尺寸与视频一致）' },
    { key: 'x', label: '横向位置', type: 'number', default: 0,
      hint: '左上角为 0；支持负数（图片宽度内偏移）' },
    { key: 'y', label: '纵向位置', type: 'number', default: 0,
      hint: '左上角为 0' },
    { key: 'alpha', label: '不透明度', type: 'number', default: 1, min: 0, max: 1, step: 0.05,
      hint: '1 = 完全不透明；叠加半透明图片时用' },
  ],

  decide(info, params) {
    const p = String(params.image || '').trim();
    if (!p) return { skip: true, reason: '未选择图片，跳过' };
    if (!fs.existsSync(p)) return { skip: true, reason: '图片不存在：' + p };
    const ext = path.extname(p).toLowerCase();
    if (!IMG_EXTS.has(ext)) return { skip: true, reason: '不支持的图片格式：' + ext };
    const alpha = Math.max(0, Math.min(1, num(params.alpha, 1)));
    return {
      image: p,
      x: Math.round(num(params.x, 0)),
      y: Math.round(num(params.y, 0)),
      alpha,
      note: '叠加 ' + path.basename(p) + ' 于 ' + Math.round(num(params.x, 0)) + ':' + Math.round(num(params.y, 0))
        + (alpha < 1 ? ('（不透明度 ' + alpha + '）') : ''),
    };
  },

  /** 需要额外输入 + 消费视频尾流，因此走 chain 的 afterVideo 通道 */
  filter(d, info, chain) {
    if (!chain) return { video: [], audio: [], note: '缺少滤镜链上下文，跳过叠加' };
    const idx = chain.addInput(d.image);
    const pos = d.x + ':' + d.y;
    const alpha = Number(d.alpha);
    chain.afterVideo((tail, out) => {
      if (!(alpha >= 0) || alpha >= 0.999) {
        return '[' + tail + '][' + idx + ':v]overlay=' + pos + '[' + out + ']';
      }
      return '[' + idx + ':v]format=rgba,colorchannelmixer=aa=' + alpha + '[wm];'
        + '[' + tail + '][wm]overlay=' + pos + '[' + out + ']';
    });
    return { video: [], audio: [] };
  },
};
