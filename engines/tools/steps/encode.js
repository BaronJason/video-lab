// 步骤 · 码率控制 / 目标体积压缩
//
// 原脚本做法（scripts-archive/视频工具/重编码5000.ps1）：
//   · 码率阈值 5000 kbps —— 超过才处理；CQ 从 26 起，每次 +1，最高 40
//   · 每编一遍就测一次实际码率，达标则覆盖原文件，**到上限仍不达标则原文件保持不变**
//   · 另有一个「分辨率归位」开关：横屏归 1920×1080、竖屏归 1080×1920，不符也触发重编码
//
// ★ 这是**唯一允许多遍编码**的步骤（计划 §13.1 单列）：它必须"试编码 → 测码率 → 调 CQ"。
//   界面必须提示"会编码多次"。本步通过 decide 返回 `ramp` 把这一意图交给 pipeline 执行。
//
// 目标体积的口径：目标 MB → 码率，`kbps = 目标MB × 8192 ÷ 时长(s)`。
'use strict';

const num = (v, d) => {
  const n = Number(v);
  return isFinite(n) ? n : d;
};

/** 竖屏 → 1080×1920，横屏（含正方）→ 1920×1080（与原脚本一致） */
function canonicalRes(w, h) {
  return (Number(w) > Number(h)) ? [1920, 1080] : [1080, 1920];
}

module.exports = {
  id: 'encode',
  title: '码率控制',
  group: '编码',
  danger: '',
  schema: [
    { key: 'mode', label: '方式', type: 'select', default: '恒定质量',
      options: ['恒定质量', '码率上限', '目标体积'],
      hint: '「码率上限 / 目标体积」会**编码多次**（逐次提高 CQ 直到达标）' },
    { key: 'cq', label: 'CQ 值', type: 'number', default: 27, min: 0, max: 51,
      hint: '仅「恒定质量」模式生效；数值越大码率越低、画质越差（管线默认 27）' },
    { key: 'bitrateKbps', label: '码率上限(kbps)', type: 'number', default: 5000, min: 100, step: 100,
      hint: '仅「码率上限」模式生效；与原脚本默认阈值一致' },
    { key: 'targetMB', label: '目标体积(MB)', type: 'number', default: 0, min: 0, step: 1,
      hint: '仅「目标体积」模式生效；按片长反推码率' },
    { key: 'initialCq', label: '起始 CQ', type: 'number', default: 26, min: 0, max: 51,
      hint: '多遍模式的第一次 CQ（原脚本默认 26）' },
    { key: 'cqIncrement', label: '每次递增', type: 'number', default: 1, min: 1, max: 10,
      hint: '每编一遍不达标就把 CQ 抬这么多' },
    { key: 'maxCq', label: 'CQ 上限', type: 'number', default: 40, min: 1, max: 51,
      hint: '抬到该值仍不达标 → 放弃处理，原文件保持不变（原脚本默认 40）' },
    { key: 'snapRes', label: '分辨率归位', type: 'bool', default: false,
      hint: '横屏归 1920×1080、竖屏归 1080×1920；不符时触发重编码（原脚本开关）' },
  ],

  decide(info, params) {
    const dur = Number(info.duration) || 0;
    const mode = String(params.mode || '恒定质量');
    const snapRes = params.snapRes === true;
    const curW = Number(info.width) || 0;
    const curH = Number(info.height) || 0;
    const want = canonicalRes(curW, curH);
    const resOff = snapRes && curW > 0 && (curW !== want[0] || curH !== want[1]);

    const base = {
      mode, snapRes, snapTo: resOff ? want : null,
      curW, curH, curKbps: Math.round((Number(info.bitrate) || 0) / 1000),
    };

    const resNote = resOff ? '分辨率归位 ' + curW + '×' + curH + ' → ' + want[0] + '×' + want[1] : '';

    if (mode === '恒定质量') {
      const cq = num(params.cq, 27);
      return Object.assign(base, {
        cq,
        note: ['CQ ' + cq + '（重编码）', resNote].filter(Boolean).join('；'),
      });
    }

    const initialCq = Math.max(0, num(params.initialCq, 26));
    const cqIncrement = Math.max(1, num(params.cqIncrement, 1));
    const maxCq = Math.max(initialCq, num(params.maxCq, 40));

    let targetKbps = 0;
    let what = '';
    if (mode === '码率上限') {
      targetKbps = num(params.bitrateKbps, 5000);
      what = '码率上限 ' + Math.round(targetKbps) + ' kbps';
    } else {
      const mb = num(params.targetMB, 0);
      if (!(mb > 0)) return { skip: true, reason: '未填写目标体积，跳过' };
      if (!(dur > 0)) return { skip: true, reason: '无法读取时长，不能按体积反推码率，跳过' };
      targetKbps = (mb * 8192) / dur;
      what = '目标体积 ' + mb + ' MB（约 ' + Math.round(targetKbps) + ' kbps）';
    }
    if (!(targetKbps > 0)) return { skip: true, reason: '目标码率无效，跳过' };

    const alreadyOk = base.curKbps > 0 && base.curKbps <= targetKbps && !resOff;
    if (alreadyOk) {
      return { skip: true, reason: '当前码率 ' + base.curKbps + ' kbps 已达标（' + what + '），无需处理' };
    }

    return Object.assign(base, {
      ramp: { targetKbps, initialCq, increment: cqIncrement, maxCq },
      note: [what + '（当前 ' + (base.curKbps || '未知') + ' kbps；CQ ' + initialCq + ' 起每次 +' + cqIncrement
        + '，上限 ' + maxCq + '，**将编码多次**）', resNote].filter(Boolean).join('；'),
    });
  },

  filter(d) {
    const v = [];
    if (d.snapTo) v.push('scale=' + d.snapTo[0] + ':' + d.snapTo[1]);
    return { video: v, audio: [] };
  },
};
