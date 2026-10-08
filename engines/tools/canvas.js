// 画布合成（竖转横）· 参数模型与滤镜链构造
//
// 设计约束：
//   · 纯逻辑：无 IO、无子进程、不依赖 Electron —— 主进程（预览渲染）与引擎子进程（正式处理）共用
//   · 单一真相：预览与正式处理都走 buildCanvasPlan()，参数一致则表达式一致（预览所见即所得由结构保证）
//   · 滤镜一律 CPU：本模块不提供任何硬件滤镜入口（遮罩模块曾因全 GPU 管线导致成片闪烁）
//   · 内容缩放默认**等比**；拉伸为显式开关，开启时写 warnings，由前端提示画面会变形
//
// 用法：
//   const plan = buildCanvasPlan(params, src);
//   // plan.ffmpegInputs → 依次拼 -i（各输入自带前置参数，如 -loop 1 / -stream_loop -1）
//   // plan.filterComplex → -filter_complex
//   // plan.maps → { composed, bg, raw } 三个输出映射（预览取三张 PNG；正式处理只用 composed）

'use strict';

/** 参数默认值（与《竖转横-实施计划》§四 对齐：0.74 等比 + 居中 + Y 偏移 160） */
const DEFAULTS = {
  bgMode: 'dir',          // dir=背景目录随机 | image | video | color=纯色
  bgDir: '',              // 背景目录（bgMode=dir 时用于枚举候选）
  bgPath: '',             // 背景文件（bgMode=image|video 时直接指定）
  bgColor: '#000000',     // 纯色背景（bgMode=color）
  watermark: '',          // 广审 PNG，可留空
  targetW: 1920,          // 画布宽
  targetH: 1080,          // 画布高
  scale: 0.74,            // 内容等比缩放系数
  stretch: false,         // 拉伸开关（默认关；开启后按 w/h 非等比缩放）
  w: 0, h: 0,             // 拉伸目标宽高（stretch=true 时生效；为 0 表示未设置）
  posMode: 'center',      // center | tl | tr | bl | br | custom
  dx: 0,                  // 相对基准的水平偏移（像素；custom 时为绝对 X）
  dy: 160,                // 相对基准的垂直偏移（像素；custom 时为绝对 Y）
  radius: 0,              // 内容圆角半径（像素，0=直角）
  borderW: 0,             // 内容边框宽度（像素，0=无边框）
  borderColor: '#ffffff', // 边框颜色
  bgBlur: 0,              // 背景高斯模糊 sigma（0=不模糊）
};

const NUM_RANGES = {
  targetW: [16, 7680], targetH: [16, 7680],
  scale: [0.05, 3], w: [0, 7680], h: [0, 7680],
  dx: [-7680, 7680], dy: [-7680, 7680],
  radius: [0, 2000], borderW: [0, 400], bgBlur: [0, 200],
};

/** 偶数对齐：h264 要求宽高为偶数，非偶数会让正式处理失败（预览无此要求，但两处共用同一表达式） */
function evenRound(v) {
  const n = Math.round(Number(v) || 0);
  return n % 2 === 0 ? n : n + 1;
}

/** 颜色归一化为 ffmpeg 的 0xRRGGBB（非法值回退默认并记警告） */
function toFfmpegColor(v, fallback, warnings, label) {
  const s = String(v == null ? '' : v).trim();
  const m = /^#?([0-9a-fA-F]{6})$/.exec(s) || /^0x([0-9a-fA-F]{6})$/.exec(s);
  if (m) return '0x' + m[1].toLowerCase();
  if (s && warnings) warnings.push(label + '颜色格式无法识别（' + s + '），已按默认值处理');
  return '0x' + String(fallback).replace('#', '').toLowerCase();
}

/** 参数归一化与校验：越界回落默认值并累积 warnings（供前端提示，不抛异常） */
function normalizeParams(params) {
  const p = Object.assign({}, DEFAULTS, params || {});
  const warnings = [];
  for (const k of Object.keys(NUM_RANGES)) {
    const [lo, hi] = NUM_RANGES[k];
    const n = Number(p[k]);
    if (!isFinite(n)) { p[k] = DEFAULTS[k]; continue; }
    if (n < lo || n > hi) {
      warnings.push(k + ' 超出允许范围 [' + lo + ', ' + hi + ']，已按 ' + Math.min(hi, Math.max(lo, n)) + ' 处理');
      p[k] = Math.min(hi, Math.max(lo, n));
    } else p[k] = n;
  }
  const modes = ['center', 'tl', 'tr', 'bl', 'br', 'custom'];
  if (modes.indexOf(p.posMode) < 0) { warnings.push('位置模式无法识别，已按居中处理'); p.posMode = 'center'; }
  const bgModes = ['dir', 'image', 'video', 'color'];
  if (bgModes.indexOf(p.bgMode) < 0) { warnings.push('背景方式无法识别，已按纯色处理'); p.bgMode = 'color'; }
  // 画布宽高必须为偶数（编码器硬要求）：直接对齐而不是留给正式处理阶段报错
  const tw = evenRound(p.targetW), th = evenRound(p.targetH);
  if (tw !== Math.round(p.targetW) || th !== Math.round(p.targetH)) warnings.push('画布宽高已对齐为偶数（编码要求）');
  p.targetW = tw; p.targetH = th;
  p.borderColor = toFfmpegColor(p.borderColor, DEFAULTS.borderColor, warnings, '边框');
  p.bgColor = toFfmpegColor(p.bgColor, DEFAULTS.bgColor, warnings, '背景');
  // 拉伸开启但宽高未设置 → 视为未启用（避免出现 0 尺寸表达式）
  if (p.stretch && (!p.w || !p.h)) {
    warnings.push('拉伸已开启但宽高未设置，本次按等比缩放处理');
    p.stretch = false;
  }
  if (p.stretch) warnings.push('拉伸模式会改变画面比例（变形）');
  return { params: p, warnings };
}

/**
 * 内容层在画布中的左上角坐标（像素）—— 前端手柄定位与滤镜表达式**共用本函数**，
 * 保证「拖动所见」与「渲染所得」不会因两处各算一遍而漂移。
 */
function contentOffset(posMode, dx, dy, canvasW, canvasH, cw, ch) {
  const d = Number(dx) || 0, e = Number(dy) || 0;
  switch (posMode) {
    case 'tl': return { x: d, y: e };
    case 'tr': return { x: canvasW - cw + d, y: e };
    case 'bl': return { x: d, y: canvasH - ch + e };
    case 'br': return { x: canvasW - cw + d, y: canvasH - ch + e };
    case 'custom': return { x: d, y: e };
    case 'center':
    default: return { x: (canvasW - cw) / 2 + d, y: (canvasH - ch) / 2 + e };
  }
}

/** 圆角遮罩表达式（作用于 rgba 的 alpha 通道）：中心区不透明，四角按半径做圆弧判定 */
function roundRectAlpha(radius, w, h) {
  const r = Math.max(1, Math.round(radius));
  const cx = '(W-1)/2', cy = '(H-1)/2';
  const ax = 'abs(X-' + cx + ')', ay = 'abs(Y-' + cy + ')';
  const ix = '(' + w + '/2-' + r + ')', iy = '(' + h + '/2-' + r + ')';
  // 注：表达式内的逗号在 filter_complex 中必须转义为 \,
  return 'if(gt(' + ax + '\\,' + ix + ')*gt(' + ay + '\\,' + iy + ')\\,'
    + 'if(lte(pow(' + ax + '-' + ix + '\\,2)+pow(' + ay + '-' + iy + '\\,2)\\,pow(' + r + '\\,2))\\,255\\,0)\\,255)';
}

/**
 * 内容层滤镜片段（缩放 → 边框 → 圆角）。
 * @returns {{segs:string[], outW:number, outH:number}}
 */
function contentSegments(p, contentW, contentH, warnings) {
  const segs = [];
  let w, h;
  if (p.stretch) {
    w = evenRound(p.w); h = evenRound(p.h);
    segs.push('scale=' + w + ':' + h);
  } else {
    w = evenRound(contentW * p.scale);
    h = evenRound(contentH * p.scale);
    if (w < 2 || h < 2) { w = 2; h = 2; warnings.push('缩放后尺寸过小，已按最小 2×2 处理'); }
    segs.push('scale=' + w + ':' + h);
  }
  if (p.borderW > 0) {
    const b = Math.round(p.borderW);
    segs.push('pad=' + (w + 2 * b) + ':' + (h + 2 * b) + ':' + b + ':' + b + ':color=' + p.borderColor);
    w += 2 * b; h += 2 * b;
  }
  if (p.radius > 0) {
    // 圆角需要 alpha 通道；在本层内完成，最终与背景叠加时透明处自然露出背景
    segs.push('format=rgba');
    segs.push("geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='" + roundRectAlpha(p.radius, w, h) + "'");
    if (p.radius > 0) warnings.push('内容圆角为逐像素计算，正式处理长视频时耗时明显（预览不受影响）');
  }
  return { segs: segs, outW: w, outH: h };
}

/** 背景层滤镜片段：cover 裁切到画布尺寸（避免非 1920×1080 素材出现黑边），可选高斯模糊 */
function bgSegments(p, warnings) {
  const segs = [
    'scale=' + p.targetW + ':' + p.targetH + ':force_original_aspect_ratio=increase:flags=bicubic',
    'crop=' + p.targetW + ':' + p.targetH,
  ];
  if (p.bgBlur > 0) segs.push('gblur=sigma=' + p.bgBlur);
  segs.push('format=yuv420p');
  if (p.bgMode === 'video') warnings.push('背景为视频：正式处理需 -stream_loop -1 与 -shortest 成对使用，否则编码不结束');
  return segs;
}

/**
 * 组装完整合成方案（预览与正式处理共用）。
 *
 * @param {object} params 画布参数（见 DEFAULTS）
 * @param {object} src 素材信息（调用方探测后传入）
 *   @param {number} src.contentW 内容视频宽（像素）
 *   @param {number} src.contentH 内容视频高
 *   @param {string} [src.contentPath] 内容视频路径（帧预览与正式处理用）
 *   @param {string} [src.bgPath] 背景文件路径（bgMode=image|video）
 *   @param {string} [src.watermarkPath] 水印 PNG 路径
 *   @param {string} [src.bgColorValue] 纯色背景值（bgMode=color，优先于 params.bgColor）
 * @returns {{ffmpegInputs:Array, filterComplex:string, maps:object, meta:object}}
 */
function buildCanvasPlan(params, src, opts) {
  // opts（可选）—— 让**正式处理**复用同一套表达式，只换标签与出口：
  //   forEncode  : true 时只产出合成结果（不做预览用的 split 第二路出口）
  //   contentLabel / outLabel : 内容层入口标签 / 最终输出标签（正式处理由工具滤镜链传入）
  const o = opts || {};
  const forEncode = o.forEncode === true;
  const contentIn = o.contentLabel ? String(o.contentLabel) : '[0:v]';
  const finalLabel = o.outLabel ? String(o.outLabel) : '';
  const norm = normalizeParams(params);
  const p = norm.params;
  const warnings = norm.warnings.slice();
  const s = src || {};
  const contentW = Number(s.contentW) > 0 ? Number(s.contentW) : p.targetH;   // 缺省按竖版处理
  const contentH = Number(s.contentH) > 0 ? Number(s.contentH) : p.targetW;

  // ── 输入列表：0=内容（帧预览与处理的主输入）；1=背景（文件或纯色 lavfi）；2=水印（可选）──
  const ffmpegInputs = [];
  ffmpegInputs.push({ path: s.contentPath || '', args: [] });
  // 背景输入以**调用方已解析的 src.bgPath** 为准（bgMode=dir 的候选挑选在调用方完成，本模块只管表达式）；
  // 视频背景需无限循环填充 —— 正式处理时必须与 -shortest 成对，否则编码永不结束。
  const bgIsVideo = s.bgKind ? (s.bgKind === 'video') : /\.(mp4|mov|mkv|avi)$/i.test(String(s.bgPath || ''));
  // ⚠ 背景输入的可结束性由**滤镜级 shortest=1** 负责（见下方 overlay 段），这里不要再加 -t 上限：
  //   上限比内容短时会把成片截短（内容 5 分钟、上限 60 秒 → 只出 60 秒）。
  //   · 图片背景 → **单帧输入**（不加 -loop 1），靠 overlay 默认 repeatlast=1 持续贴上
  //     （与 steps/overlay.js 的既有做法一致：那里早已写明图片不该加 -loop 1）
  //   · 视频背景 → -stream_loop -1 循环填充（无限流，由 shortest=1 收尾）
  //   · 纯色背景 → lavfi 源（无限流，同上）
  if (s.bgPath) {
    ffmpegInputs.push({ path: s.bgPath, args: bgIsVideo ? ['-stream_loop', '-1'] : [] });
  } else if (p.bgMode === 'image' || p.bgMode === 'video') {
    warnings.push('背景文件未提供，已按纯色处理');
  }
  const needSolid = !s.bgPath || p.bgMode === 'color';
  if (!needSolid && p.bgMode === 'image' && bgIsVideo) warnings.push('背景方式为图片但所选文件是视频，已按视频背景处理');
  if (!needSolid && p.bgMode === 'video' && !bgIsVideo) warnings.push('背景方式为视频但所选文件不是视频，已按图片背景处理');
  if (needSolid) {
    const color = s.bgColorValue ? toFfmpegColor(s.bgColorValue, p.bgColor, warnings, '背景') : p.bgColor;
    ffmpegInputs.splice(1, ffmpegInputs.length - 1, {
      lavfi: 'color=c=' + color + ':s=' + p.targetW + 'x' + p.targetH + ':r=30',
      path: '', args: ['-f', 'lavfi'],
    });
  }
  const bgIdx = 1;
  if (s.watermarkPath) ffmpegInputs.push({ path: s.watermarkPath, args: [] });
  const wmIdx = ffmpegInputs.length - 1;
  const hasWm = !!s.watermarkPath;

  // ── 内容层 ──
  const cSeg = contentSegments(p, contentW, contentH, warnings);
  const offset = contentOffset(p.posMode, p.dx, p.dy, p.targetW, p.targetH, cSeg.outW, cSeg.outH);

  // ── 滤镜图 ──
  // 注：同一 filter 输出标签只能被消费一次 —— 背景层与内容层都要「既参与合成、又单独输出」，
  // 故各自经 split 分流（否则 -map 复用标签会报 "was already used elsewhere"）。
  const parts = [];
  const bgSegs = bgSegments(p, warnings).join(',');
  if (forEncode) {
    // 正式处理：背景与内容各只被消费一次，直接落到合成（省掉预览用的分流，也少一层拷贝）
    parts.push('[' + bgIdx + ':v]' + bgSegs + '[bg]');
    parts.push(contentIn + cSeg.segs.join(',') + '[c]');
  } else {
    // 预览：背景与内容都得「既参与合成、又单独输出一张图」，故各自 split 分流
    parts.push('[' + bgIdx + ':v]' + bgSegs + '[bgsrc]');
    parts.push('[bgsrc]split=2[bg][bgout]');
    parts.push(contentIn + 'split=2[craw][csrc]');
    parts.push('[csrc]' + cSeg.segs.join(',') + '[c]');
  }
  let composedLabel = forEncode ? (hasWm ? '[comp0]' : (finalLabel || '[comp0]')) : '[comp0]';
  // ⚠ shortest=1 让 overlay 跟随**最短输入**（内容视频）收尾 —— 纯色/视频背景是无限流，
  //   没有它输出会一直跟着背景走（成片被拉长或永不结束；输出级 -shortest 兜不住滤镜内部）。
  //   图片背景**不能设**：它是单帧输入，设了会在第 1 帧后立刻结束（靠 repeatlast=1 续帧才对）。
  const overlayShortest = (needSolid || bgIsVideo) ? ':shortest=1' : '';
  parts.push('[bg][c]overlay=' + Math.round(offset.x) + ':' + Math.round(offset.y) + ':format=auto'
    + overlayShortest + composedLabel);
  if (hasWm) {
    parts.push('[' + wmIdx + ':v]format=rgba[wm]');
    const wmOut = forEncode ? (finalLabel || '[compWm]') : '[compWm]';
    parts.push(composedLabel + '[wm]overlay=0:0:format=auto' + wmOut);
    composedLabel = wmOut;
  }

  // 越界提示：缩放系数与位置组合可能让内容超出画布（例如 1080×1920 素材按 0.74 缩放后比 1080 高的画布更高）——
  // 预览据此直接提示，避免整片跑完才发现构图被裁
  if (offset.x < 0 || offset.y < 0 || offset.x + cSeg.outW > p.targetW || offset.y + cSeg.outH > p.targetH) {
    warnings.push('内容超出画布范围，超出部分会被裁切（可减小缩放或调整位置）');
  }

  const meta = {
    canvasW: p.targetW,
    canvasH: p.targetH,
    contentBox: {
      x: Math.round(offset.x), y: Math.round(offset.y),
      w: cSeg.outW, h: cSeg.outH,
    },
    contentSrcW: contentW,
    contentSrcH: contentH,
    scaleUsed: p.stretch ? 0 : p.scale,
    stretchUsed: !!p.stretch,
    radiusUsed: p.radius > 0,
    borderWUsed: p.borderW > 0 ? Math.round(p.borderW) : 0,
    bgBlurUsed: p.bgBlur > 0 ? p.bgBlur : 0,
    bgModeUsed: needSolid ? 'color' : (bgIsVideo ? 'video' : 'image'),
    warnings: warnings,
  };

  return {
    ffmpegInputs: ffmpegInputs,
    filterComplex: parts.join(';'),
    // 单帧预览：三张图（合成 / 纯背景层 / 内容原帧）；正式处理只用 composed
    maps: { composed: composedLabel, bg: '[bgout]', raw: '[craw]' },
    meta: meta,
  };
}

module.exports = {
  DEFAULTS: DEFAULTS,
  normalizeParams: normalizeParams,
  contentOffset: contentOffset,
  buildCanvasPlan: buildCanvasPlan,
};
