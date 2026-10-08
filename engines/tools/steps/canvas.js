// 步骤 · 画布合成（竖转横）
//
// 与「画布合成」预览页**共用** engines/tools/canvas.js 的 buildCanvasPlan()：
// 参数同源、表达式同源，「预览所见即所得」由结构保证，而不是靠两处各写一遍去对齐。
//
// 接进工具链的四个要点：
//   · 主输入 0 = 待处理视频，正好就是内容层。其余步骤（裁剪 / 去黑屏 / 转分辨率 / 叠加…）
//     先作用于它，本步骤拿到的是滤镜链**尾流** —— 与注册表里 canvas 排在画面组末位的位次一致
//     （即「先把内容处理成想要的样子，最后合成到画布」）。
//   · 背景作为额外输入：图片 `-loop 1`、视频 `-stream_loop -1`、纯色用 lavfi 源；
//     输入级选项经 chain.addInput 的第二参传入（必须排在该输入的 -i 之前）。
//   · 输出级必须补 `-shortest`（chain.outArg）：循环背景是无限流，不加则**编码永不结束**
//     （不是报错，是一直跑）。
//   · 音频仍取 `[0:a]`（内容视频），背景音轨丢弃 —— 与原脚本 `-map 2:a?` 语义一致。
//
// 背景为「目录随机」时**每个视频独立随机取一张**（原脚本 横版.ps1 的 Get-Random 语义）；
// 候选清单优先采用前端随参数传来的一份（= 预览页枚举出的同一批），保证「预览看到什么范围、
// 处理就用什么范围」；未传时回退目录枚举。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const canvas = require('../canvas');

const IMG_RE = /\.(png|jpg|jpeg|webp|bmp)$/i;
const VID_RE = /\.(mp4|mov|mkv|avi|m4v|webm)$/i;

const exists = (p) => {
  try { return !!p && fs.existsSync(p); } catch (e) { return false; }
};

/** 背景目录兜底枚举（两层内，按路径稳定排序）：候选清单未随参数传下来时才用 */
function listBackgrounds(dir) {
  const out = [];
  const walk = (d, depth) => {
    if (out.length >= 500 || depth > 2) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (IMG_RE.test(e.name) || VID_RE.test(e.name)) out.push(p);
    }
  };
  walk(dir, 0);
  return out.sort();
}

module.exports = {
  id: 'canvas',
  title: '画布合成（竖转横）',
  group: '画面',
  danger: '',
  // 参数由「画布合成」页的专属面板提供（那里带单帧预览），此处不重复渲染表单
  schema: [],

  decide(info, params) {
    const p = Object.assign({}, params || {});
    const cw = Number(info.width) || 0, ch = Number(info.height) || 0;
    if (!(cw > 0 && ch > 0)) return { skip: true, reason: '无法读取分辨率，跳过画布合成' };

    const bgMode = String(p.bgMode || 'dir');
    let bgPath = '', bgPick = '';
    if (bgMode === 'color') {
      bgPick = '纯色 ' + String(p.bgColor || '#000000');
    } else if (bgMode === 'image' || bgMode === 'video') {
      bgPath = String(p.bgPath || '').trim();
      if (!exists(bgPath)) return { skip: true, reason: '背景文件不存在：' + (bgPath || '(未指定)') };
      bgPick = '指定 ' + path.basename(bgPath);
    } else {
      let cands = Array.isArray(p.bgList) ? p.bgList.map(String).filter(exists) : [];
      if (!cands.length) {
        const dir = String(p.bgDir || '').trim();
        if (!exists(dir)) return { skip: true, reason: '未选择背景目录' };
        cands = listBackgrounds(dir);
      }
      if (!cands.length) return { skip: true, reason: '背景目录里没有可用素材（图片或视频）' };
      const k = Math.floor(Math.random() * cands.length);
      bgPath = cands[k];
      bgPick = '随机 ' + (k + 1) + '/' + cands.length + ' · ' + path.basename(bgPath);
    }

    const wm = String(p.watermark || '').trim();
    return {
      params: p,
      bgPath: bgPath,
      bgKind: VID_RE.test(bgPath) ? 'video' : 'image',
      wmPath: exists(wm) ? wm : '',
      contentW: cw, contentH: ch,
      duration: Number(info.duration) || 0,
      note: '画布合成 → ' + bgPick + (exists(wm) ? '，含水印' : ''),
    };
  },

  filter(d, info, chain) {
    if (!d || d.skip || !chain) return { video: [], audio: [] };

    // 占位标签：plan 产出后再替换成滤镜链的尾流 / 输出标签（归一化与表达式完全复用预览那一套）
    const plan = canvas.buildCanvasPlan(d.params, {
      contentW: d.contentW, contentH: d.contentH,
      bgPath: d.bgPath, bgKind: d.bgKind,
      watermarkPath: d.wmPath, bgColorValue: d.params.bgColor,
      duration: Number(info.duration) || 0,   // 背景输入按时长设上限（无界背景会让编码永不结束）
    }, { forEncode: true, contentLabel: '__CONTENT__', outLabel: '__OUT__' });

    // 输入装配顺序 = 标签序号（1 = 背景、2 = 水印），与 plan 内的假设一致
    const inputs = plan.ffmpegInputs || [];
    const bgIn = inputs[1];
    if (!bgIn || !(bgIn.lavfi || bgIn.path)) return { video: [], audio: [], note: '背景输入缺失，跳过画布合成' };
    const bgIdx = chain.addInput(bgIn.lavfi || bgIn.path, bgIn.args || []);
    if (bgIdx !== 1) return { video: [], audio: [], note: '输入序号异常，跳过画布合成' };
    const wmIn = d.wmPath ? inputs[2] : null;
    if (wmIn && wmIn.path) chain.addInput(wmIn.path, wmIn.args || []);

    // 背景可能是循环 / 无限流（视频 -stream_loop -1、纯色 lavfi）→ 输出级用 `-t` **精确截到内容时长**：
    // 比 -shortest 确定 —— 后者在「overlay 输出跟着长流走」时兜不住（实测成片被拉长到背景长度）。
    // 若 canvas 之后还有变速等步骤，作用于的正是这 dur 秒合成画面，语义仍然正确。
    chain.outArg('-shortest');
    if (d.duration > 0) chain.outArg('-t', String(d.duration));

    chain.afterVideo(function (tail, out) {
      return String(plan.filterComplex || '')
        .split('__CONTENT__').join('[' + tail + ']')
        .split('__OUT__').join('[' + out + ']');
    });
    return { video: [], audio: [] };
  },
};
