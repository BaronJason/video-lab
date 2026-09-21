// 步骤 · 音频处理
//
// 计划 §1.2 把「音量调整 / 提取音频 / 静音」一并纳入。其中：
//   · 音量 / 静音 —— 在本步实现（单条 af 即可）
//   · 提取音频 —— **暂不在本步实现**：它改变的是"产物形态"（输出音频文件而非视频），
//     与 pipeline「一条链 → 一个视频产物」的契约冲突，需先有输出类型路由。
//     已记入计划待办，不在本阶段硬塞。
'use strict';

const num = (v, d) => {
  const n = Number(v);
  return isFinite(n) ? n : d;
};

module.exports = {
  id: 'audio',
  title: '音频',
  group: '音频',
  danger: '',
  schema: [
    { key: 'mode', label: '方式', type: 'select', default: '音量调整',
      options: ['音量调整', '静音'],
      hint: '静音会保留音轨但音量置零（不是删除音轨）' },
    { key: 'volume', label: '音量倍数', type: 'number', default: 1, min: 0, max: 8, step: 0.05,
      hint: '1 = 原音量；1.5 = 放大 50%；0.5 = 减半' },
  ],

  decide(info, params) {
    if (!info.hasAudio) return { skip: true, reason: '该文件无音轨，跳过' };
    const mode = String(params.mode || '音量调整');
    if (mode === '静音') return { mode: '静音', volume: 0, note: '静音（保留音轨）' };
    const v = Math.max(0, num(params.volume, 1));
    if (Math.abs(v - 1) < 0.001) return { skip: true, reason: '音量倍数为 1，无需处理' };
    return { mode: '音量调整', volume: v, note: '音量 ×' + v };
  },

  filter(d, info) {
    if (!info.hasAudio) return { video: [], audio: [] };
    const v = Number(d.mode === '静音' ? 0 : d.volume);
    return { video: [], audio: ['volume=' + v] };
  },
};
